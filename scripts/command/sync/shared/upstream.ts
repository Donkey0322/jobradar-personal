import path from "node:path";

import type { Job } from "@/types";

import { classifyLocations } from "@/modules/postings/location";
import { loadOpportunities } from "@/utils/data";
import { getJobKey } from "@/utils/job-key";
import { logger } from "@/utils/logger";
import { loadNdjsonPartitions } from "@/utils/ndjson-archive";

/**
 * Countries the public repo drops before JD analysis. This repo analyzes those
 * itself. USA and every other country wait for the public JD.
 */
const SELF_ANALYZED_COUNTRIES = new Set<NonNullable<Job["country"]>>(["Singapore", "Taiwan"]);

export function isSelfAnalyzedCountry(country: Job["country"]): boolean {
  return country != null && SELF_ANALYZED_COUNTRIES.has(country);
}

export function indexJobs(jobs: readonly Job[]): Map<string, Job> {
  const index = new Map<string, Job>();

  for (const job of jobs) {
    const key = getJobKey(job.link);
    const current = index.get(key);

    if (!current || (!current.jd && job.jd)) {
      index.set(key, job);
    }
  }

  return index;
}

/**
 * Public rows this repo still needs to apply.
 * Parsed JDs are reused. Singapore and Taiwan without a JD are analyzed here.
 */
export function selectUpstreamWork(
  upstream: Iterable<Job>,
  localParsedKeys: ReadonlySet<string>
): Job[] {
  const work: Job[] = [];

  for (const job of upstream) {
    if (localParsedKeys.has(getJobKey(job.link))) continue;

    if (job.jd || isSelfAnalyzedCountry(job.country)) {
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

export async function takeUpstreamWork(
  context: { urls: Set<string>; keys: Set<string> },
  upstream: ReadonlyMap<string, Job>
): Promise<Job[]> {
  const parsed = new Set<string>();

  for (const opportunity of await loadOpportunities()) {
    if (opportunity.jd) parsed.add(getJobKey(opportunity.link));
  }

  const work = selectUpstreamWork(upstream.values(), parsed);
  releaseSeenLinks(context.urls, context.keys, work);

  logger.info(
    {
      upstream: upstream.size,
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
