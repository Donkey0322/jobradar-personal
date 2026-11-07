import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { JD, Job } from "@/types";

import { readJsonFile } from "./json";
import { UPSTREAM_QUEUE_PATH } from "./paths";

export type UpstreamWaitSource = "confirmed" | "estimated";

export interface UpstreamWaitAttempt {
  id: string;
  at: string;
  round: number;
  failure: {
    stage: "fetch" | "ai";
    error?: {
      code: number;
      desc: string;
      retryAfterMs?: number;
      failure?: string;
    };
    reason?: "empty" | "invalid" | "unparseable";
  };
}

/**
 * A queued listing plus the wait clock and self-analysis state.
 * Every added field is optional so a queue written before this policy still loads.
 */
export interface UpstreamWait extends Job {
  waitedSince?: string;
  waitedSinceSource?: UpstreamWaitSource;
  status?: "waiting" | "failed";
  /** Completed manual retry rounds. Attempt ids stay; only this round counts toward the limit. */
  manualRetries?: number;
  nextAttemptAt?: string;
  attempts?: UpstreamWaitAttempt[];
  /** Analysis already paid for. Replay this JD instead of fetching or calling the model again. */
  pendingResult?: {
    jd: JD;
    cost: number;
    attemptId: string;
  };
}

export interface UpstreamQueueFile {
  /** Public commit already compared against this queue. */
  commit: string | null;
  jobs: UpstreamWait[];
}

function isUpstreamWait(value: unknown): value is UpstreamWait {
  if (!value || typeof value !== "object") return false;

  const job = value as Partial<UpstreamWait>;

  return (
    typeof job.company === "string" &&
    typeof job.role === "string" &&
    typeof job.link === "string" &&
    typeof job.location === "string"
  );
}

export function emptyUpstreamQueue(): UpstreamQueueFile {
  return { commit: null, jobs: [] };
}

function queueError(reason: string, cause?: unknown): Error {
  return new Error(`Upstream queue ${reason}: ${UPSTREAM_QUEUE_PATH}`, { cause });
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pendingResultLegal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;

  const pending = value as { jd?: unknown; cost?: unknown; attemptId?: unknown };

  return (
    !!pending.jd &&
    typeof pending.jd === "object" &&
    typeof pending.cost === "number" &&
    Number.isFinite(pending.cost) &&
    typeof pending.attemptId === "string" &&
    pending.attemptId.length > 0
  );
}

/** Old queues only have the listing. Present wait fields must keep their stored shape. */
function waitFieldsLegal(job: UpstreamWait): boolean {
  if (job.waitedSince !== undefined && typeof job.waitedSince !== "string") return false;
  if (
    job.waitedSinceSource !== undefined &&
    job.waitedSinceSource !== "confirmed" &&
    job.waitedSinceSource !== "estimated"
  ) {
    return false;
  }
  if (job.status !== undefined && job.status !== "waiting" && job.status !== "failed") return false;
  if (
    job.manualRetries !== undefined &&
    (typeof job.manualRetries !== "number" || !Number.isInteger(job.manualRetries))
  ) {
    return false;
  }
  if (job.nextAttemptAt !== undefined && typeof job.nextAttemptAt !== "string") return false;
  if (job.attempts !== undefined && !Array.isArray(job.attempts)) return false;
  if (job.pendingResult !== undefined && !pendingResultLegal(job.pendingResult)) return false;

  return true;
}

function parseUpstreamQueue(parsed: unknown): UpstreamQueueFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw queueError("must be a JSON object");
  }

  const record = parsed as { commit?: unknown; jobs?: unknown };

  if (record.commit !== undefined && record.commit !== null && typeof record.commit !== "string") {
    throw queueError("commit must be a string or null");
  }

  if (!Array.isArray(record.jobs)) {
    throw queueError("jobs must be an array");
  }

  const jobs = record.jobs.map((job, index) => {
    if (!isUpstreamWait(job) || !waitFieldsLegal(job)) {
      throw queueError(`jobs[${index}] is not a valid wait`);
    }

    return job;
  });

  return {
    commit: typeof record.commit === "string" ? record.commit : null,
    jobs,
  };
}

export async function loadUpstreamQueue(): Promise<UpstreamQueueFile> {
  let parsed: unknown;

  try {
    parsed = await readJsonFile<unknown>(UPSTREAM_QUEUE_PATH);
  } catch (error) {
    if (isMissingFile(error)) return emptyUpstreamQueue();

    if (error instanceof SyntaxError) {
      throw queueError("is not valid JSON", error);
    }

    throw queueError("could not be read", error);
  }

  return parseUpstreamQueue(parsed);
}

export async function saveUpstreamQueue(queue: UpstreamQueueFile): Promise<void> {
  const directory = path.dirname(UPSTREAM_QUEUE_PATH);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(UPSTREAM_QUEUE_PATH)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );

  try {
    await fs.writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, "utf-8");
    await fs.rename(temporary, UPSTREAM_QUEUE_PATH);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export const upstreamQueue = {
  load: loadUpstreamQueue,
  save: saveUpstreamQueue,
};
