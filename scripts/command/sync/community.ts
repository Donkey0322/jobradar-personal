import { SOURCES } from "@/constants";

import type { Job } from "@/types";

import {
  classifyUnknownJobs,
  loadUpstreamOpportunities,
  takeUpstreamWork,
} from "./shared/upstream";
import { createSyncContext, processJobs } from "./shared";

import { Posting } from "@/modules/posting";
import fetchSource from "@/modules/source";
import { logger } from "@/utils/logger";

export default async function syncCommunity() {
  logger.info("🔍 Syncing community...");

  const context = await createSyncContext();
  const upstream = await loadUpstreamOpportunities();
  const inherited = await takeUpstreamWork(context, upstream);

  const jobs: Job[] = [];

  for (const source of SOURCES.filter((source) => !source.disabled)) {
    logger.info({ url: source.url }, `🔍 Fetching community: ${source.name}`);
    const fetched = await fetchSource(source);
    const matched = fetched
      .map((job) => Posting.from(job))
      .filter((posting) => posting.isTarget() && !posting.isKnown(context.keys))
      .map((posting) => posting.toJob());

    logger.info(
      { fetched: fetched.length, matched: matched.length },
      `📋 Filtered community: ${source.name}`
    );

    jobs.push(...matched);
  }

  await classifyUnknownJobs(jobs, upstream);

  await processJobs({
    jobs: [...inherited, ...jobs],
    upstream,
    ...context,
  });
}
