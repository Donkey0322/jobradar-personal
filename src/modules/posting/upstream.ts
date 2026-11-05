import type { UpstreamQueueFile } from "@/store/upstream-queue";
import type { Job } from "@/types";

import { withinDays } from "./screening";

import { getJobKey } from "@/modules/ats/job-key";

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

/** Add a job once. A second sighting of the same link leaves the queue unchanged. */
export function addWaitingJob(
  queue: UpstreamQueueFile,
  job: Job
): { queue: UpstreamQueueFile; added: boolean } {
  const key = getJobKey(job.link);

  if (queue.jobs.some((waiting) => getJobKey(waiting.link) === key)) {
    return { queue, added: false };
  }

  return {
    added: true,
    queue: {
      ...queue,
      jobs: [
        ...queue.jobs,
        {
          company: job.company,
          role: job.role,
          link: job.link,
          location: job.location,
          country: job.country,
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

    if (cached?.jd) {
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

    if (!current || (!current.jd && job.jd)) {
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
