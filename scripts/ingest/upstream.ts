import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { PostingAnalysisFailure } from "@/modules/posting/analysis/analyze";
import type { UpstreamQueueFile, UpstreamWait } from "@/store/upstream-queue";
import type { JD, Job } from "@/types";

import { persistAnalyzedJobs } from "./index";

import { getJobKey } from "@/modules/ats/job-key";
import { Posting } from "@/modules/posting";
import { classifyLocations } from "@/modules/posting/analysis/location";
import {
  addWaitingJob,
  applyWaitFailure,
  enqueueTimesFromLog,
  indexJobs,
  legalPublicJd,
  matchUpstreamWaits,
  migrateWaitTimes,
  publicStopKind,
  releaseSeenLinks,
  retryFailedWaits,
  selectSelfAnalysis,
  selectUpstreamWork,
  UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_RETRY_COMMAND,
  upstreamWorkDue,
  waitingKeys,
} from "@/modules/posting/upstream";
import * as store from "@/store";
import { isAIEnabled } from "@/utils/ai/enabled";
import { logger } from "@/utils/logger";
import { listArchiveParts, loadNdjsonPartitions } from "@/utils/ndjson-archive";

const execFileAsync = promisify(execFile);

export async function enqueueUpstreamWaits(jobs: readonly Job[]): Promise<void> {
  if (jobs.length === 0) return;

  let queue = await store.upstreamQueue.load();
  let changed = false;

  for (const job of jobs) {
    const next = addWaitingJob(queue, job);
    if (!next.added) continue;
    queue = next.queue;
    changed = true;
  }

  if (changed) await store.upstreamQueue.save(queue);
}

export async function takeUpstreamWork(
  context: { urls: Set<string>; keys: Set<string> },
  upstream: ReadonlyMap<string, Job>
): Promise<Job[]> {
  const parsed = new Set<string>();

  for (const opportunity of await store.opportunities.load()) {
    if (opportunity.jd) parsed.add(getJobKey(opportunity.link));
  }

  const waiting = waitingKeys(await store.upstreamQueue.load());
  const work = selectUpstreamWork(upstream.values(), parsed).filter(
    (job) => !waiting.has(getJobKey(job.link))
  );
  releaseSeenLinks(context.urls, context.keys, work);

  logger.info(
    {
      upstream: upstream.size,
      waiting: waiting.size,
      reuse: work.filter((job) => job.jd).length,
      analyze: work.filter((job) => !job.jd).length,
    },
    "📥 Upstream cache"
  );

  return work;
}

/**
 * Copy a country or JD the public repo already stored, and classify only the
 * listings it has not seen.
 */
export async function classifyUnknownJobs(
  jobs: Job[],
  upstream: ReadonlyMap<string, Job>
): Promise<void> {
  const unknown: Job[] = [];

  for (const job of jobs) {
    const cached = upstream.get(getJobKey(job.link));

    const jd = legalPublicJd(cached);

    if (cached?.country && !job.country) job.country = cached.country;
    if (jd && !job.jd) job.jd = jd;
    if (!job.country) unknown.push(job);
  }

  if (unknown.length === 0) return;

  const locations = await classifyLocations(unknown);

  for (let index = 0; index < unknown.length; index++) {
    const country = locations[index];
    if (country) unknown[index]!.country = country;
  }
}

export async function loadUpstreamOpportunities(): Promise<Map<string, Job>> {
  const dataPath = process.env.UPSTREAM_DATA_PATH;

  if (!dataPath) {
    throw new Error(
      "UPSTREAM_DATA_PATH is not set. Check out the public opportunities before scanning."
    );
  }

  const root = path.resolve(dataPath);
  logger.info({ path: root }, "📥 Reading public opportunities");

  const jobs = await loadNdjsonPartitions<Job>(
    path.join(root, "opportunities.ndjson"),
    path.join(root, "archive"),
    "opportunities"
  );

  if (jobs.length === 0) {
    throw new Error(
      `No public opportunities found at ${root}. Refusing to analyze without that cache.`
    );
  }

  return indexJobs(jobs);
}

/**
 * Public commit this checkout actually contains. A stale `UPSTREAM_COMMIT`
 * must not win over the upstream checkout HEAD. A data directory copied into
 * the personal repo is not that checkout, so its HEAD is left unused.
 */
export async function resolveUpstreamCommit(): Promise<string> {
  const dataPath = process.env.UPSTREAM_DATA_PATH;

  if (dataPath) {
    const sha = await readCheckoutSha(path.resolve(dataPath));
    if (sha) return sha;
  }

  const commit = process.env.UPSTREAM_COMMIT?.trim();

  if (!commit) {
    throw new Error("UPSTREAM_COMMIT is not set. Pass the public repo commit before syncing.");
  }

  return commit;
}

export async function retryFailedUpstreamWaits(): Promise<number> {
  const queue = await store.upstreamQueue.load();
  const retried = retryFailedWaits(queue.jobs);

  if (retried.retried === 0) {
    logger.info("No failed upstream waits to retry");
    return 0;
  }

  await store.upstreamQueue.save({ ...queue, jobs: retried.jobs });
  logger.info(
    { retried: retried.retried },
    `Returned failed upstream waits for another ${UPSTREAM_MAX_ATTEMPTS} attempts. Run \`pnpm jobctl upstream\` to process them.`
  );

  return retried.retried;
}

export default async function applyUpstreamQueue() {
  const commit = await resolveUpstreamCommit();
  const queue = await store.upstreamQueue.load();

  if (queue.jobs.length === 0) {
    logger.info("No jobs waiting for a public JD");
    return;
  }

  const stamped = await stampQueue(queue);

  if (!upstreamWorkDue(stamped, commit, Date.now())) {
    logger.info({ commit }, "Public snapshot already checked");
    return;
  }

  await reconcileUpstreamQueue(commit, await loadUpstreamOpportunities());
}

export async function reconcileUpstreamQueue(commit: string, upstream: ReadonlyMap<string, Job>) {
  const loaded = await store.upstreamQueue.load();

  if (loaded.jobs.length === 0) {
    logger.info("No jobs waiting for a public JD");
    return;
  }

  const queue = await stampQueue(loaded);

  if (!upstreamWorkDue(queue, commit, Date.now())) {
    logger.info({ commit }, "Public snapshot already checked");
    return;
  }

  logPublicStops(queue.jobs, upstream);

  const { ready, pending, released } = matchUpstreamWaits(queue.jobs, upstream);

  try {
    await persistReady(ready, upstream);
  } catch (error) {
    logger.error({ err: error }, "Public JD apply failed; the wait stays queued");
    throw error;
  }

  const corrected = await correctOpportunityCountries(releasedCountries(released, upstream));
  let jobs = pending;
  await store.upstreamQueue.save({ commit, jobs });

  const replayed = await replayPending(jobs, commit);
  if (replayed.halt) return;
  jobs = replayed.jobs;

  const analyzed = await analyzeDue(jobs, commit, new Date().toISOString());
  if (analyzed.halt) return;
  jobs = analyzed.jobs;

  await store.upstreamQueue.save({ commit, jobs });

  logger.info(
    {
      commit,
      ready: ready.length,
      released: released.length,
      corrected,
      pending: jobs.length,
    },
    "📥 Applied public JDs for queued jobs"
  );
}

/**
 * First-add time of each URL in git history for `data/upstream/queue.json`.
 * Personal `postedAt` is refreshed on every sighting, and the public
 * `postedAt` is when that repo wrote the row, so neither is a first enqueue.
 * A shallow checkout shows the boundary commit as adding the whole file, so
 * that time is not confirmed. Deepen once when a remote can supply the missing
 * parents; otherwise the caller stamps one estimated time.
 */
export async function readConfirmedEnqueueTimes(
  repo = process.cwd(),
  file = "data/upstream/queue.json"
): Promise<Map<string, string>> {
  try {
    if (!(await queueHistoryTrustworthy(repo, file))) {
      logger.warn(
        { repo, file },
        "Upstream queue history is shallow; missing wait times will be estimated"
      );
      return new Map();
    }

    const stdout = await gitOutput(repo, [
      "log",
      "--reverse",
      "-p",
      "--format=COMMIT %cI",
      "--",
      file,
    ]);

    return enqueueTimesFromLog(stdout);
  } catch (error) {
    logger.warn(
      { err: error, repo, file },
      "Could not read upstream queue history; missing wait times will be estimated"
    );
    return new Map();
  }
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-pager", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  return stdout;
}

/**
 * The oldest commit that touches the queue must have its parents on disk.
 * A root commit has none. A shallow boundary names a parent that is absent,
 * and its patch looks like the file was created there.
 */
async function introducingCommitIsComplete(repo: string, file: string): Promise<boolean> {
  const oldest = (await gitOutput(repo, ["log", "--reverse", "--format=%H", "--", file]))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]{40}$/i.test(line));

  if (!oldest) return true;

  // `git log` hides the parents of a shallow boundary. The commit object still names them.
  const parents: string[] = [];
  for (const line of (await gitOutput(repo, ["cat-file", "-p", oldest])).split("\n")) {
    if (line === "") break;
    if (line.startsWith("parent ")) parents.push(line.slice("parent ".length).trim());
  }

  for (const parent of parents) {
    try {
      await gitOutput(repo, ["cat-file", "-e", `${parent}^{commit}`]);
    } catch {
      return false;
    }
  }

  return true;
}

async function queueHistoryTrustworthy(repo: string, file: string): Promise<boolean> {
  if (await introducingCommitIsComplete(repo, file)) return true;

  const shallow = (await gitOutput(repo, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  if (!shallow) return false;

  const remote = (await gitOutput(repo, ["remote"]))
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!remote) return false;

  try {
    await gitOutput(repo, ["fetch", "--unshallow", remote]);
  } catch (error) {
    logger.warn(
      { err: error, repo, remote },
      "Could not deepen the shallow upstream queue history"
    );
    return false;
  }

  return introducingCommitIsComplete(repo, file);
}

async function stampQueue(queue: UpstreamQueueFile): Promise<UpstreamQueueFile> {
  const needsHistory = queue.jobs.some((job) => !job.waitedSince || !isStamped(job));
  if (!needsHistory) return queue;

  const confirmed = new Map<string, string>();

  if (isTrackedQueueFile()) {
    for (const [link, time] of await readConfirmedEnqueueTimes()) {
      const key = getJobKey(link);
      if (!confirmed.has(key)) confirmed.set(key, time);
    }
  }

  const migrated = migrateWaitTimes(queue.jobs, confirmed, new Date().toISOString());
  const next = { ...queue, jobs: migrated.jobs };

  if (migrated.changed) await store.upstreamQueue.save(next);

  return next;
}

function isStamped(job: UpstreamWait): boolean {
  return job.waitedSinceSource === "confirmed" || job.waitedSinceSource === "estimated";
}

function isTrackedQueueFile(): boolean {
  try {
    return (
      realpathSync(store.UPSTREAM_QUEUE_PATH) ===
      realpathSync(path.resolve("data/upstream/queue.json"))
    );
  } catch {
    return false;
  }
}

function logPublicStops(jobs: readonly UpstreamWait[], upstream: ReadonlyMap<string, Job>): void {
  for (const job of jobs) {
    const stop = publicStopKind(upstream.get(getJobKey(job.link)));
    if (!stop) continue;

    logger.info(
      { company: job.company, url: job.link, stop },
      "Public stop is diagnostic and does not end the wait"
    );
  }
}

async function persistReady(
  ready: readonly UpstreamWait[],
  upstream: ReadonlyMap<string, Job>
): Promise<void> {
  const analyzed: Array<{ job: Job; jd: JD; cost: number }> = [];

  for (const job of ready) {
    const cached = upstream.get(getJobKey(job.link));
    const jd = legalPublicJd(cached);
    if (!jd) continue;

    analyzed.push({
      job: { ...job, country: cached?.country ?? job.country },
      jd,
      cost: 0,
    });
  }

  if (analyzed.length > 0) await persistAnalyzedJobs(analyzed);
}

async function replayPending(
  jobs: readonly UpstreamWait[],
  commit: string
): Promise<{ jobs: UpstreamWait[]; halt: boolean }> {
  let current = [...jobs];

  for (const job of jobs) {
    if (!job.pendingResult) continue;

    try {
      await persistAnalyzedJobs([{ job, jd: job.pendingResult.jd, cost: job.pendingResult.cost }]);
    } catch (error) {
      logger.error(
        { err: error, url: job.link },
        "Saved self-analysis result could not be written to jobs; it stays queued"
      );
      await store.upstreamQueue.save({ commit, jobs: current });
      return { jobs: current, halt: true };
    }

    current = withoutJob(current, job.link);
    await store.upstreamQueue.save({ commit, jobs: current });
  }

  return { jobs: current, halt: false };
}

async function analyzeDue(
  jobs: readonly UpstreamWait[],
  commit: string,
  now: string
): Promise<{ jobs: UpstreamWait[]; halt: boolean }> {
  const due = selectSelfAnalysis(jobs, Date.parse(now));

  if (due.length === 0) return { jobs: [...jobs], halt: false };

  if (!isAIEnabled()) {
    logger.warn({ due: due.length }, "AI is disabled, so expired public JD waits stay queued");
    return { jobs: [...jobs], halt: false };
  }

  let current = [...jobs];

  for (const job of due) {
    const outcome = await analyzeOne(current, job, commit, now);
    current = outcome.jobs;
    if (outcome.halt) return { jobs: current, halt: true };
  }

  return { jobs: current, halt: false };
}

async function analyzeOne(
  jobs: UpstreamWait[],
  job: UpstreamWait,
  commit: string,
  now: string
): Promise<{ jobs: UpstreamWait[]; halt: boolean }> {
  const posting = Posting.from(job);
  const fetched = await posting.getRawJD();

  if (!fetched.jd) {
    return recordFailure(jobs, job, { stage: "fetch", error: fetched.error }, commit, now);
  }

  const result = await posting.analyze({ fetched });

  if (!result.jd || result.failure) {
    const failure = result.failure ?? { stage: "ai" as const, reason: "empty" as const };
    return recordFailure(jobs, job, failure, commit, now);
  }

  const pending: UpstreamWait = {
    ...job,
    status: "waiting",
    pendingResult: {
      jd: result.jd,
      cost: result.cost,
      attemptId: `self:${randomUUID()}`,
    },
  };
  let current = replaceJob(jobs, pending);
  await store.upstreamQueue.save({ commit, jobs: current });

  try {
    await persistAnalyzedJobs([{ job: pending, jd: result.jd, cost: result.cost }]);
  } catch (error) {
    logger.error(
      { err: error, url: job.link, attemptId: pending.pendingResult?.attemptId },
      "Saved the self-analysis result and left the wait queued"
    );
    return { jobs: current, halt: true };
  }

  current = withoutJob(current, job.link);

  try {
    await store.upstreamQueue.save({ commit, jobs: current });
  } catch (error) {
    logger.error(
      { err: error, url: job.link },
      "The analyzed job is stored; the wait stays queued until it can be removed"
    );
    return { jobs: replaceJob(jobs, pending), halt: true };
  }

  return { jobs: current, halt: false };
}

async function recordFailure(
  jobs: readonly UpstreamWait[],
  job: UpstreamWait,
  failure: PostingAnalysisFailure,
  commit: string,
  now: string
): Promise<{ jobs: UpstreamWait[]; halt: boolean }> {
  const applied = applyWaitFailure(job, failure, now, `self:${randomUUID()}`);

  if (applied.action === "gone") {
    logger.info(
      {
        company: job.company,
        url: job.link,
        code: failure.stage === "fetch" ? failure.error.code : undefined,
      },
      "Posting is gone, so the public JD wait ended"
    );
    const current = withoutJob(jobs, job.link);
    await store.upstreamQueue.save({ commit, jobs: current });
    return { jobs: current, halt: false };
  }

  if (applied.action === "failed") {
    logger.error(
      { company: job.company, url: job.link, attempts: applied.job.attempts?.length ?? 0 },
      `Self-analysis stopped. Retry with \`${UPSTREAM_RETRY_COMMAND}\``
    );
  } else {
    logger.warn(
      { company: job.company, url: job.link, nextAttemptAt: applied.job.nextAttemptAt },
      "Self-analysis will retry on a later run"
    );
  }

  const current = replaceJob(jobs, applied.job);
  await store.upstreamQueue.save({ commit, jobs: current });
  return { jobs: current, halt: false };
}

function replaceJob(jobs: readonly UpstreamWait[], job: UpstreamWait): UpstreamWait[] {
  const key = getJobKey(job.link);

  return jobs.map((item) => (getJobKey(item.link) === key ? job : item));
}

function withoutJob(jobs: readonly UpstreamWait[], link: string): UpstreamWait[] {
  const key = getJobKey(link);

  return jobs.filter((item) => getJobKey(item.link) !== key);
}

function releasedCountries(
  released: readonly Job[],
  upstream: ReadonlyMap<string, Job>
): Map<string, NonNullable<Job["country"]>> {
  const updates = new Map<string, NonNullable<Job["country"]>>();

  for (const job of released) {
    const country = upstream.get(getJobKey(job.link))?.country;

    if (country) updates.set(getJobKey(job.link), country);
  }

  return updates;
}

async function correctOpportunityCountries(
  updates: ReadonlyMap<string, NonNullable<Job["country"]>>
): Promise<number> {
  if (updates.size === 0) return 0;

  const parts = await listArchiveParts(store.ARCHIVE_PATH, "opportunities");
  const files = [...parts.map((part) => part.filePath), store.OPPORTUNITIES_PATH];
  let corrected = 0;

  for (const filePath of files) {
    let text: string;

    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }

    let changed = false;
    const lines = text.split("\n").map((line) => {
      if (!line.trim()) return line;

      const row = JSON.parse(line) as { link?: string; country?: string };
      if (!row.link) return line;

      const country = updates.get(getJobKey(row.link));
      if (!country || row.country === country) return line;

      changed = true;
      corrected += 1;
      return JSON.stringify({ ...row, country });
    });

    if (changed) {
      await fs.writeFile(filePath, lines.join("\n"), "utf-8");
    }
  }

  return corrected;
}

async function readCheckoutSha(dataPath: string): Promise<string | null> {
  const checkout = await gitText(dataPath, ["rev-parse", "--show-toplevel"]);
  if (!checkout) return null;

  const personal = await gitText(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (personal && samePath(checkout, personal)) return null;

  const sha = await gitText(checkout, ["rev-parse", "HEAD"]);
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
