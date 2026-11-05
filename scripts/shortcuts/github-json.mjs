import { readFileSync } from "node:fs";

const command = process.argv[2] ?? "";
const data = JSON.parse(readFileSync(0, "utf8"));

if (command === "run-id") {
  const runId = data.workflow_run_id;
  if (!Number.isInteger(runId) || runId <= 0) {
    process.stderr.write("Missing workflow_run_id\n");
    process.exit(1);
  }
  process.stdout.write(`${runId}\n`);
  process.exit(0);
}

if (command === "run-state") {
  const expected = Number(process.env.EXPECTED_RUN_ID);
  if (data.id !== expected) {
    process.stdout.write("mismatch\n");
    process.exit(0);
  }
  if (typeof data.status !== "string" || data.status.length === 0) {
    process.stderr.write("Missing run status\n");
    process.exit(1);
  }
  const conclusion = data.conclusion || "-";
  process.stdout.write(`${data.status}:${conclusion}\n`);
  process.exit(0);
}

process.stderr.write(`Unknown JSON command: ${command}\n`);
process.exit(1);
