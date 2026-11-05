#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const VALUE_FLAGS = new Set(["-X", "-d", "-H", "-w", "--connect-timeout", "--max-time"]);

const SEQUENCES = {
  chain: {
    101: ["queued", "in_progress", "completed:success"],
    303: ["completed:success"],
  },
  nodata: {
    101: ["completed:success"],
    202: ["completed:success"],
  },
  drained: {
    202: ["completed:success"],
  },
  failure: {
    101: ["completed:failure"],
  },
  cancelled: {
    101: ["completed:cancelled"],
  },
  timeout: {
    101: ["queued"],
  },
  mismatch: {
    101: ["mismatch"],
  },
};

function parseArgs(argv) {
  let method = "GET";
  let data = null;
  const headers = [];
  let url = "";
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (VALUE_FLAGS.has(arg) && index + 1 < argv.length) {
      const value = argv[index + 1];
      if (arg === "-X") method = value;
      else if (arg === "-d") data = value;
      else if (arg === "-H") headers.push(value);
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    url = arg;
    index += 1;
  }

  return { method, url, data, headers };
}

function loadCounts(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function step(scenario, runId) {
  const sequence = SEQUENCES[scenario][runId];
  const path = process.env.JOBSCAN_FAKE_STATE;
  const counts = loadCounts(path);
  const key = `${scenario}:${runId}`;
  const index = counts[key] ?? 0;
  counts[key] = index + 1;
  writeFileSync(path, JSON.stringify(counts));
  const item = sequence[Math.min(index, sequence.length - 1)];

  if (item === "mismatch") {
    return { id: 999, status: "completed", conclusion: "success" };
  }

  const splitAt = item.indexOf(":");
  const status = splitAt === -1 ? item : item.slice(0, splitAt);
  const conclusion = splitAt === -1 ? null : item.slice(splitAt + 1);
  return { id: Number(runId), status, conclusion: conclusion || null };
}

function dispatchId(url) {
  if (url.endsWith("/JobRadar-AI/actions/workflows/jobs.yml/dispatches")) return 101;
  if (url.endsWith("/JobRadar-AI/actions/workflows/batch.yml/dispatches")) return 202;
  if (url.endsWith("/jobradar-personal/actions/workflows/jobs.yml/dispatches")) return 303;
  return null;
}

function writeResult(body, code) {
  process.stdout.write(`${body}\n${code}`);
}

const { method, url, data, headers } = parseArgs(process.argv.slice(2));
appendFileSync(
  process.env.JOBSCAN_FAKE_LOG,
  `${JSON.stringify({ method, url, data, headers })}\n`
);

if (method === "POST") {
  const runId = dispatchId(url);
  if (runId === null) {
    writeResult("{}", 404);
    process.exit(0);
  }
  writeResult(JSON.stringify({ workflow_run_id: runId, run_url: url, html_url: url }), 200);
  process.exit(0);
}

if (method === "GET" && url.includes("/actions/runs/")) {
  const parts = url.replace(/\/+$/, "").split("/");
  const runId = parts[parts.length - 1];
  const scenario = process.env.JOBSCAN_FAKE_SCENARIO;
  const sequence = SEQUENCES[scenario] ?? {};
  if (!Object.prototype.hasOwnProperty.call(sequence, runId)) {
    writeResult("{}", 404);
    process.exit(0);
  }
  writeResult(JSON.stringify(step(scenario, runId)), 200);
  process.exit(0);
}

writeResult("{}", 404);
