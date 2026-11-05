import { promises as fs } from "node:fs";
import path from "node:path";

import type { Job } from "@/types";

import { readJsonFile } from "./json";
import { UPSTREAM_QUEUE_PATH } from "./paths";

export interface UpstreamQueueFile {
  /** Public commit already compared against this queue. */
  commit: string | null;
  jobs: Job[];
}

export function emptyUpstreamQueue(): UpstreamQueueFile {
  return { commit: null, jobs: [] };
}

export async function loadUpstreamQueue(): Promise<UpstreamQueueFile> {
  try {
    const parsed = await readJsonFile<Partial<UpstreamQueueFile>>(UPSTREAM_QUEUE_PATH);

    return {
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return emptyUpstreamQueue();
  }
}

export async function saveUpstreamQueue(queue: UpstreamQueueFile): Promise<void> {
  await fs.mkdir(path.dirname(UPSTREAM_QUEUE_PATH), { recursive: true });
  await fs.writeFile(UPSTREAM_QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");
}

export const upstreamQueue = {
  load: loadUpstreamQueue,
  save: saveUpstreamQueue,
};
