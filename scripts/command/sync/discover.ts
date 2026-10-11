import "dotenv/config";
import { ALLOWED_COUNTRIES } from "@/constants";

import {
  classifyUnknownJobs,
  loadUpstreamOpportunities,
  takeUpstreamWork,
} from "./shared/upstream";
import discoverJobs from "./discover-jobs";
import { createSyncContext, processJobs } from "./shared";

import { logger } from "@/utils/logger";

export default async function syncDiscover() {
  logger.info({ AI_MODE: process.env.AI_MODE }, "🔍 Discovering jobs...");

  const context = await createSyncContext();
  const upstream = await loadUpstreamOpportunities();
  const inherited = await takeUpstreamWork(context, upstream);

  const jobs = await discoverJobs();
  await classifyUnknownJobs(jobs, upstream);

  await processJobs({
    jobs: [...inherited, ...jobs],
    upstream,
    ...context,

    filter(job) {
      if (ALLOWED_COUNTRIES.size > 0 && job.country && !ALLOWED_COUNTRIES.has(job.country)) {
        logger.info(
          {
            company: job.company,
            role: job.role,
            url: job.link,
            location: job.location,
            country: job.country,
          },
          "⏭️ Skipped by location filter"
        );

        return true;
      }

      return false;
    },
  });
}
