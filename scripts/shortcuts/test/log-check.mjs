import { readFileSync } from "node:fs";
import process from "node:process";

const command = process.argv[2];
const logPath = process.argv[3];
const rows = readFileSync(logPath, "utf8")
  .split("\n")
  .filter((line) => line)
  .map((line) => JSON.parse(line));

if (command === "requests") {
  for (const row of rows) {
    process.stdout.write(`${row.method}\t${row.url}\t${row.data || ""}\n`);
  }
  process.exit(0);
}

if (command !== "chain") {
  process.stderr.write(`Unknown log command: ${command}\n`);
  process.exit(1);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const posts = rows
  .filter((row) => row.method === "POST")
  .map((row) => [row.url, JSON.parse(row.data)]);
const gets = rows.filter((row) => row.method === "GET").map((row) => row.url);

if (posts.length !== 2) fail(`expected 2 posts, got ${JSON.stringify(posts)}`);
if (!posts[0][0].endsWith("/JobRadar-AI/actions/workflows/jobs.yml/dispatches")) {
  fail(`public dispatch url ${posts[0][0]}`);
}
if (!posts[1][0].endsWith("/jobradar-personal/actions/workflows/jobs.yml/dispatches")) {
  fail(`personal dispatch url ${posts[1][0]}`);
}
const scanPayload = { ref: "main", inputs: { task: "scan" }, return_run_details: true };
if (JSON.stringify(posts[0][1]) !== JSON.stringify(scanPayload)) fail("public payload");
if (JSON.stringify(posts[1][1]) !== JSON.stringify(posts[0][1])) fail("personal payload");
if (rows.some((row) => row.url.includes("batch.yml"))) fail("batch workflow was dispatched");
if (rows.length === 0) fail("no requests");
if (!rows.some((row) => row.headers.includes("Authorization: Bearer fake-token"))) {
  fail("missing token header");
}
const versions = rows.flatMap((row) =>
  row.headers.filter((header) => header.startsWith("X-GitHub-Api-Version:"))
);
if (versions.length === 0 || versions.some((header) => header !== "X-GitHub-Api-Version: 2022-11-28")) {
  fail(`api version headers ${JSON.stringify(versions)}`);
}
const urls = [...gets, ...posts.map(([url]) => url)];
if (urls.some((url) => url.includes("workflow_runs") || url.includes("batch-analysis") || url.includes("ats-discovery"))) {
  fail("unexpected legacy url");
}

const scanGets = rows.flatMap((row, index) =>
  row.method === "GET" && row.url.endsWith("/JobRadar-AI/actions/runs/101") ? [index] : []
);
const personalGets = rows.flatMap((row, index) =>
  row.method === "GET" && row.url.endsWith("/jobradar-personal/actions/runs/303") ? [index] : []
);
if (scanGets.length !== 3) fail(`scan polls ${scanGets.length}`);
if (personalGets.length !== 1) fail(`personal polls ${personalGets.length}`);
const personalPost = rows.findIndex(
  (row) => row.method === "POST" && row.url.includes("jobradar-personal")
);
if (!(scanGets[scanGets.length - 1] < personalPost && personalPost < personalGets[0])) {
  fail("dispatch order");
}
