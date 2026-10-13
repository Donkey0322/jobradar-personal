import { persistAnalyzedJobs } from "./sync/shared";
import { loadUpstreamOpportunities } from "./sync/shared/upstream";

import {
  loadUpstreamQueue,
  matchUpstreamWaits,
  saveUpstreamQueue,
} from "@/modules/postings/upstream-queue";
import { getJobKey } from "@/utils/job-key";
import { logger } from "@/utils/logger";

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

  const upstream = await loadUpstreamOpportunities();
  const { ready, pending } = matchUpstreamWaits(queue.jobs, upstream);

  const analyzed = ready.flatMap((job) => {
    const cached = upstream.get(getJobKey(job.link));

    if (!cached?.jd) return [];

    return [
      {
        job: {
          ...job,
          country: job.country ?? cached.country,
        },
        jd: cached.jd,
        cost: 0,
      },
    ];
  });

  if (analyzed.length > 0) {
    await persistAnalyzedJobs(analyzed);
  }

  await saveUpstreamQueue({ commit, jobs: pending });

  logger.info(
    { commit, ready: ready.length, pending: pending.length },
    "📥 Applied public JDs for queued jobs"
  );
}
