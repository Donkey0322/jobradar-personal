import { promises as fs } from "node:fs";

import { ARCHIVE_PATH, OPPORTUNITIES_PATH } from "@/constants";

import type { Job } from "@/types";

import { persistAnalyzedJobs } from "./sync/shared";
import { loadUpstreamOpportunities } from "./sync/shared/upstream";

import {
  loadUpstreamQueue,
  matchUpstreamWaits,
  saveUpstreamQueue,
} from "@/modules/postings/upstream-queue";
import { getJobKey } from "@/utils/job-key";
import { logger } from "@/utils/logger";
import { listArchiveParts } from "@/utils/ndjson-archive";

export default async function applyUpstreamQueue() {
  const commit = process.env.UPSTREAM_COMMIT;

  if (!commit) {
    throw new Error("UPSTREAM_COMMIT is not set. Pass the public repo commit before syncing.");
  }

  const queue = await loadUpstreamQueue();

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
  const queue = await loadUpstreamQueue();
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

  await saveUpstreamQueue({ commit, jobs: pending });

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

  const parts = await listArchiveParts(ARCHIVE_PATH, "opportunities");
  const files = [...parts.map((part) => part.filePath), OPPORTUNITIES_PATH];
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
