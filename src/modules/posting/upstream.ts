import type { PostingAnalysisFailure } from "./analysis/analyze";
import type {
  UpstreamQueueFile,
  UpstreamWait,
  UpstreamWaitAttempt,
  UpstreamWaitSource,
} from "@/store/upstream-queue";
import type { JD, Job } from "@/types";

import { parseStoredJD } from "./analysis/validation/ai";
import { withinDays } from "./screening";

import { getJobKey } from "@/modules/ats/job-key";

/** A public JD must arrive within this window before this repo analyzes the posting itself. */
export const UPSTREAM_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/** Self-analysis starts per run. Public JD applies and already-saved results do not consume it. */
export const UPSTREAM_SELF_ANALYZE_LIMIT = 5;

/** Total model or fetch attempts in one manual round. A retry command starts a new round. */
export const UPSTREAM_MAX_ATTEMPTS = 3;

export const UPSTREAM_RETRY_COMMAND = "pnpm jobctl upstream --retry-failed";

export type PublicStopKind = "gone" | "exhausted" | "undetermined";
export type WaitDisposition = "gone" | "retry" | "terminal";

/**
 * Countries this repo analyzes itself. The public repo drops them before JD
 * analysis, so a missing public JD is not a reason to wait.
 */
const SELF_ANALYZED_COUNTRIES = new Set<NonNullable<Job["country"]>>(["Singapore", "Taiwan"]);

/**
 * Countries the public repo still fetches a JD for. Any other country on a
 * public row will not gain a JD, so a queued job can stop waiting.
 */
const PUBLIC_JD_COUNTRIES = new Set<NonNullable<Job["country"]>>(["USA", "Unsure"]);

export function isSelfAnalyzedCountry(country: Job["country"]): boolean {
  return country != null && SELF_ANALYZED_COUNTRIES.has(country);
}

export function awaitsPublicJd(country: Job["country"]): boolean {
  return country != null && PUBLIC_JD_COUNTRIES.has(country);
}

export function waitingKeys(queue: UpstreamQueueFile): Set<string> {
  return new Set(queue.jobs.map((job) => getJobKey(job.link)));
}

/**
 * Add a job once. A new row clears the checked public SHA so that snapshot is
 * compared again. A second sighting of the same link leaves the queue unchanged.
 */
export function addWaitingJob(
  queue: UpstreamQueueFile,
  job: Job,
  now = new Date().toISOString()
): { queue: UpstreamQueueFile; added: boolean } {
  const key = getJobKey(job.link);

  if (queue.jobs.some((waiting) => getJobKey(waiting.link) === key)) {
    return { queue, added: false };
  }

  return {
    added: true,
    queue: {
      ...queue,
      commit: null,
      jobs: [
        ...queue.jobs,
        {
          company: job.company,
          role: job.role,
          link: job.link,
          location: job.location,
          country: job.country,
          waitedSince: now,
          waitedSinceSource: "confirmed",
          status: "waiting",
        },
      ],
    },
  };
}

export function matchUpstreamWaits(
  jobs: readonly Job[],
  upstream: ReadonlyMap<string, Job>
): { ready: Job[]; pending: Job[]; released: Job[] } {
  const ready: Job[] = [];
  const pending: Job[] = [];
  const released: Job[] = [];

  for (const job of jobs) {
    const cached = upstream.get(getJobKey(job.link));

    if (legalPublicJd(cached)) {
      ready.push(job);
    } else if (cached?.country && !awaitsPublicJd(cached.country)) {
      released.push(job);
    } else {
      pending.push(job);
    }
  }

  return { ready, pending, released };
}

export function indexJobs(jobs: readonly Job[]): Map<string, Job> {
  const index = new Map<string, Job>();

  for (const job of jobs) {
    const key = getJobKey(job.link);
    const current = index.get(key);

    if (!current || (!legalPublicJd(current) && legalPublicJd(job))) {
      index.set(key, job);
    }
  }

  return index;
}

function publicPostedAt(job: Job): string | undefined {
  const postedAt = (job as Job & { postedAt?: unknown }).postedAt;

  return typeof postedAt === "string" ? postedAt : undefined;
}

/**
 * Public rows this repo still needs to apply.
 * Parsed JDs are reused. Singapore and Taiwan without a JD are analyzed here.
 * Only rows written inside the discovery lookback are eligible, so a local
 * clean cannot pull the public archive back in.
 */
export function selectUpstreamWork(
  upstream: Iterable<Job>,
  localParsedKeys: ReadonlySet<string>
): Job[] {
  const work: Job[] = [];

  for (const job of upstream) {
    if (localParsedKeys.has(getJobKey(job.link))) continue;
    if (!withinDays(publicPostedAt(job))) continue;

    const jd = legalPublicJd(job);

    if (jd) {
      work.push({ ...job, jd });
    } else if (isSelfAnalyzedCountry(job.country)) {
      work.push(job);
    }
  }

  return work;
}

export function releaseSeenLinks(urls: Set<string>, keys: Set<string>, jobs: readonly Job[]): void {
  const release = new Set(jobs.map((job) => getJobKey(job.link)));

  for (const url of [...urls]) {
    if (release.has(getJobKey(url))) urls.delete(url);
  }

  for (const key of release) keys.delete(key);
}

/**
 * A public JD already stored by that repo. `parseStoredJD` keeps a past season
 * such as `2025 Summer`, normalizes a non-intern season to `None`, and rejects
 * an intern season conflict or a row missing fields. A new model answer still
 * goes through `JDResponseSchema`.
 */
export function legalPublicJd(job: { jd?: unknown } | undefined): JD | null {
  return parseStoredJD(job?.jd);
}

/**
 * Optional public `stop` is diagnostic. It does not end the wait and it does
 * not count as this repo observing a takedown.
 */
export function publicStopKind(job: object | undefined): PublicStopKind | null {
  if (!job || !("stop" in job)) return null;

  const stop = (job as { stop?: unknown }).stop;
  if (!stop || typeof stop !== "object") return null;

  const reason = (stop as { reason?: unknown }).reason;
  if (reason === "gone" || reason === "exhausted" || reason === "undetermined") return reason;

  return "undetermined";
}

/**
 * How a self-analysis failure affects the wait. A 403, a synthetic 404
 * (`failure: "closed"`), and an invalid URL stay queued for a person. Only an
 * explicit 404 or 410 ends the wait. `isRetryableJDFetch` still decides HTML
 * fallback inside `fetchPostingJD`.
 */
export function waitDisposition(failure: PostingAnalysisFailure): WaitDisposition {
  if (failure.stage === "ai") return "retry";

  const error = failure.error;
  if (error.failure === "closed" || error.failure === "invalid") return "terminal";
  if (error.code === 404 || error.code === 410) return "gone";
  if (error.code === 403) return "terminal";
  if (
    error.code === 429 ||
    error.code === 0 ||
    error.code === 408 ||
    (error.code >= 500 && error.code < 600)
  ) {
    return "retry";
  }

  return "terminal";
}

export function enqueueTimesFromLog(log: string): Map<string, string> {
  const times = new Map<string, string>();
  let current = "";

  for (const line of log.split("\n")) {
    if (line.startsWith("COMMIT ")) {
      current = line.slice("COMMIT ".length).trim();
      continue;
    }

    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    const match = line.match(/"link"\s*:\s*"(https?:[^"\\]+)"/);
    const link = match?.[1];
    if (link && current && !times.has(link)) times.set(link, current);
  }

  return times;
}

/**
 * Fill a missing first-wait time once. A time from `confirmed` is the first
 * commit that added the URL. Anything else is marked estimated and then left
 * alone, including on later runs that pass a different clock or map.
 */
export function migrateWaitTimes(
  jobs: readonly UpstreamWait[],
  confirmed: ReadonlyMap<string, string>,
  now: string
): { jobs: UpstreamWait[]; changed: boolean } {
  let changed = false;

  const next = jobs.map((job) => {
    if (job.waitedSince && isWaitSource(job.waitedSinceSource)) return job;

    changed = true;
    const proven = confirmed.get(getJobKey(job.link));

    if (proven && !job.waitedSince) {
      return stamped(job, proven, "confirmed");
    }

    if (job.waitedSince) {
      return { ...job, waitedSinceSource: "estimated" as const };
    }

    if (proven) return stamped(job, proven, "confirmed");

    return stamped(job, now, "estimated");
  });

  return { jobs: next, changed };
}

export function selfAnalysisDue(job: UpstreamWait, nowMs: number): boolean {
  if (job.status === "failed" || job.pendingResult) return false;
  if (!job.waitedSince || !isWaitSource(job.waitedSinceSource)) return false;

  const since = Date.parse(job.waitedSince);
  if (!Number.isFinite(since) || nowMs - since < UPSTREAM_WAIT_MS) return false;

  if (job.nextAttemptAt) {
    const next = Date.parse(job.nextAttemptAt);
    if (Number.isFinite(next) && next > nowMs) return false;
  }

  return true;
}

/** True when this checkout still has a public JD to apply, a clock to stamp, or due self-analysis. */
export function upstreamJobActionable(job: UpstreamWait, nowMs: number): boolean {
  if (job.pendingResult) return true;
  if (!job.waitedSince || !isWaitSource(job.waitedSinceSource)) return true;

  return selfAnalysisDue(job, nowMs);
}

export function upstreamWorkDue(
  queue: { commit: string | null; jobs: readonly UpstreamWait[] },
  commit: string,
  nowMs: number
): boolean {
  if (queue.jobs.length === 0) return false;
  if (queue.commit !== commit) return true;

  return queue.jobs.some((job) => upstreamJobActionable(job, nowMs));
}

export function selectSelfAnalysis(
  jobs: readonly UpstreamWait[],
  nowMs: number,
  limit = UPSTREAM_SELF_ANALYZE_LIMIT
): UpstreamWait[] {
  const selected: UpstreamWait[] = [];

  for (const job of jobs) {
    if (selected.length >= limit) break;
    if (selfAnalysisDue(job, nowMs)) selected.push(job);
  }

  return selected;
}

export function applyWaitFailure(
  job: UpstreamWait,
  failure: PostingAnalysisFailure,
  now: string,
  attemptId: string
): { job: UpstreamWait; action: "gone" | "retry" | "failed" } {
  const attempt = {
    id: attemptId,
    at: now,
    round: job.manualRetries ?? 0,
    failure: serializeFailure(failure),
  };
  const attempts = [...(job.attempts ?? []), attempt];
  const disposition = waitDisposition(failure);

  if (disposition === "gone") {
    return { job: { ...job, attempts }, action: "gone" };
  }

  const roundCount = attempts.filter((item) => item.round === (job.manualRetries ?? 0)).length;

  if (disposition === "terminal" || roundCount >= UPSTREAM_MAX_ATTEMPTS) {
    const failed = { ...job, attempts, status: "failed" as const };
    delete failed.nextAttemptAt;

    return { job: failed, action: "failed" };
  }

  const retryAfter = failure.stage === "fetch" ? failure.error.retryAfterMs : undefined;
  const waiting = { ...job, attempts, status: "waiting" as const };

  if (retryAfter && retryAfter > 0) {
    waiting.nextAttemptAt = new Date(Date.parse(now) + retryAfter).toISOString();
  } else {
    delete waiting.nextAttemptAt;
  }

  return { job: waiting, action: "retry" };
}

export function retryFailedWaits(jobs: readonly UpstreamWait[]): {
  jobs: UpstreamWait[];
  retried: number;
} {
  let retried = 0;

  const next = jobs.map((job) => {
    if (job.status !== "failed") return job;

    retried += 1;
    const waiting = {
      ...job,
      status: "waiting" as const,
      manualRetries: (job.manualRetries ?? 0) + 1,
    };
    delete waiting.nextAttemptAt;

    return waiting;
  });

  return { jobs: next, retried };
}

function isWaitSource(value: unknown): value is UpstreamWaitSource {
  return value === "confirmed" || value === "estimated";
}

function stamped(job: UpstreamWait, waitedSince: string, source: UpstreamWaitSource): UpstreamWait {
  return { ...job, waitedSince, waitedSinceSource: source };
}

function serializeFailure(failure: PostingAnalysisFailure): UpstreamWaitAttempt["failure"] {
  if (failure.stage === "ai") {
    return { stage: "ai", reason: failure.reason };
  }

  return {
    stage: "fetch",
    error: {
      code: failure.error.code,
      desc: failure.error.desc,
      ...(failure.error.retryAfterMs !== undefined
        ? { retryAfterMs: failure.error.retryAfterMs }
        : {}),
      ...(failure.error.failure ? { failure: failure.error.failure } : {}),
    },
  };
}
