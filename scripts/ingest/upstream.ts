import { promises as fs } from "node:fs";
import path from "node:path";

import type { Job } from "@/types";

import { persistAnalyzedJobs } from "./index";

import { getJobKey } from "@/modules/ats/job-key";
import { classifyLocations } from "@/modules/posting/analysis/location";
import {
  addWaitingJob,
  indexJobs,
  matchUpstreamWaits,
  releaseSeenLinks,
  selectUpstreamWork,
  waitingKeys,
} from "@/modules/posting/upstream";
import * as store from "@/store";
import { logger } from "@/utils/logger";
import { listArchiveParts, loadNdjsonPartitions } from "@/utils/ndjson-archive";

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

    if (cached?.country && !job.country) job.country = cached.country;
    if (cached?.jd && !job.jd) job.jd = cached.jd;
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

export default async function applyUpstreamQueue() {
  const commit = process.env.UPSTREAM_COMMIT;

  if (!commit) {
    throw new Error("UPSTREAM_COMMIT is not set. Pass the public repo commit before syncing.");
  }

  const queue = await store.upstreamQueue.load();

  if (queue.jobs.length === 0) {
    logger.info("No jobs waiting for a public JD");
    return;
  }

  if (queue.commit === commit) {
    logger.info({ commit }, "Public snapshot already checked");
    return;
  }

  await reconcileUpstreamQueue(commit);
}

export async function reconcileUpstreamQueue(commit: string) {
  const queue = await store.upstreamQueue.load();
  const upstream = await loadUpstreamOpportunities();
  const { ready, pending, released } = matchUpstreamWaits(queue.jobs, upstream);

  const analyzed = ready.flatMap((job) => {
    const cached = upstream.get(getJobKey(job.link));

    if (!cached?.jd) return [];

    return [
      {
        job: {
          ...job,
          country: cached.country ?? job.country,
        },
        jd: cached.jd,
        cost: 0,
      },
    ];
  });

  if (analyzed.length > 0) {
    await persistAnalyzedJobs(analyzed);
  }

  const corrected = await correctOpportunityCountries(releasedCountries(released, upstream));

  await store.upstreamQueue.save({ commit, jobs: pending });

  logger.info(
    { commit, ready: ready.length, released: released.length, corrected, pending: pending.length },
    "📥 Applied public JDs for queued jobs"
  );
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
