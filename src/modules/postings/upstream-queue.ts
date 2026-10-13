import { promises as fs } from "node:fs";
import path from "node:path";

import { UPSTREAM_QUEUE_PATH } from "@/constants";

import type { Job } from "@/types";

import { getJobKey } from "@/utils/job-key";

export interface UpstreamQueue {
  /** Public commit already compared against this queue. */
  commit: string | null;
  jobs: Job[];
}

export function emptyUpstreamQueue(): UpstreamQueue {
  return { commit: null, jobs: [] };
}

export function matchUpstreamWaits(
  jobs: readonly Job[],
  upstream: ReadonlyMap<string, Job>
): { ready: Job[]; pending: Job[] } {
  const ready: Job[] = [];
  const pending: Job[] = [];

  for (const job of jobs) {
    const cached = upstream.get(getJobKey(job.link));

    if (cached?.jd) {
      ready.push(job);
    } else {
      pending.push(job);
    }
  }

  return { ready, pending };
}

export async function loadUpstreamQueue(): Promise<UpstreamQueue> {
  try {
    const text = await fs.readFile(UPSTREAM_QUEUE_PATH, "utf-8");
    const parsed = JSON.parse(text) as Partial<UpstreamQueue>;

    return {
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return emptyUpstreamQueue();
  }
}

export async function saveUpstreamQueue(queue: UpstreamQueue): Promise<void> {
  await fs.mkdir(path.dirname(UPSTREAM_QUEUE_PATH), { recursive: true });
  await fs.writeFile(UPSTREAM_QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");
}

export async function enqueueUpstreamWait(job: Job): Promise<void> {
  const queue = await loadUpstreamQueue();
  const key = getJobKey(job.link);

  if (queue.jobs.some((waiting) => getJobKey(waiting.link) === key)) {
    return;
  }

  queue.jobs.push({
    company: job.company,
    role: job.role,
    link: job.link,
    location: job.location,
    country: job.country,
  });

  await saveUpstreamQueue(queue);
}

export function waitingKeys(queue: UpstreamQueue): Set<string> {
  return new Set(queue.jobs.map((job) => getJobKey(job.link)));
}
