/**
 * Same-SHA gate for the public JD wait queue.
 *
 * Keep this in step with `upstreamJobActionable` and `upstreamWorkDue` in
 * `src/modules/posting/upstream.ts`. The workflow gate runs before pnpm
 * install, so it cannot import that module.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const UPSTREAM_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

export function upstreamJobActionable(job, now = Date.now()) {
  if (!job || typeof job !== "object") return false;
  if (job.pendingResult) return true;
  if (!isStamped(job)) return true;
  if (job.status === "failed") return false;

  const next = typeof job.nextAttemptAt === "string" ? Date.parse(job.nextAttemptAt) : NaN;
  if (Number.isFinite(next) && next > now) return false;

  const since = Date.parse(job.waitedSince);
  return Number.isFinite(since) && now - since >= UPSTREAM_WAIT_MS;
}

export function upstreamShouldRun({ remoteSha, storedCommit, queue, now = Date.now() }) {
  const jobs = Array.isArray(queue?.jobs) ? queue.jobs : [];
  const changed = jobs.length > 0 && (!remoteSha || remoteSha !== (storedCommit ?? ""));
  const actionable = jobs.some((job) => upstreamJobActionable(job, now));

  return {
    changed,
    actionable,
    run: changed || actionable,
  };
}

function isStamped(job) {
  return (
    typeof job.waitedSince === "string" &&
    (job.waitedSinceSource === "confirmed" || job.waitedSinceSource === "estimated")
  );
}

function readQueue(queuePath) {
  if (!existsSync(queuePath)) return { commit: null, jobs: [] };

  const parsed = JSON.parse(readFileSync(queuePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return { commit: null, jobs: [] };

  return parsed;
}

function main() {
  const queuePath = process.env.QUEUE_PATH ?? "data/upstream/queue.json";
  const remoteSha = process.env.REMOTE_SHA ?? "";
  const now = process.env.NOW_MS ? Number(process.env.NOW_MS) : Date.now();
  const queue = readQueue(queuePath);
  const storedCommit = typeof queue.commit === "string" ? queue.commit : null;
  const result = upstreamShouldRun({ remoteSha, storedCommit, queue, now });
  const output = process.env.GITHUB_OUTPUT;

  if (output) {
    appendFileSync(
      output,
      [
        `sha=${remoteSha}`,
        `changed=${result.changed}`,
        `actionable=${result.actionable}`,
        `run=${result.run}`,
        `due=${result.run}`,
        "",
      ].join("\n")
    );
  }

  if (result.changed) {
    process.stdout.write(
      `Public snapshot changed: ${storedCommit ?? "<none>"} -> ${remoteSha || "<none>"}\n`
    );
  } else if (remoteSha) {
    process.stdout.write(`Public snapshot ${remoteSha} was already checked.\n`);
  }

  process.stdout.write(
    `${
      result.actionable
        ? "Expired, retryable, or unsaved upstream work is due."
        : "No expired, retryable, or unsaved upstream work."
    }\n`
  );
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) main();
