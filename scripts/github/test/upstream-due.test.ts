import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { UpstreamWait } from "@/store/upstream-queue";
import type { JD } from "@/types";

import {
  UPSTREAM_WAIT_MS as SCRIPT_WAIT_MS,
  upstreamJobActionable,
  upstreamShouldRun,
} from "../../../.github/scripts/upstream-due.mjs";

import { UPSTREAM_WAIT_MS, upstreamJobActionable as actionable } from "@/modules/posting/upstream";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: null,
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const YOUNG = "2026-01-09T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function job(id: string, extra: Partial<UpstreamWait> = {}): UpstreamWait {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    waitedSince: OLD,
    waitedSinceSource: "confirmed",
    ...extra,
  };
}

describe("upstream due gate", () => {
  it("uses the same wait window as the TypeScript policy", () => {
    expect(SCRIPT_WAIT_MS).toBe(UPSTREAM_WAIT_MS);
  });

  it("matches the TypeScript decision for the same queue row", () => {
    const rows = [
      job("young", { waitedSince: YOUNG }),
      job("old"),
      job("unstamped", { waitedSince: undefined, waitedSinceSource: undefined }),
      job("failed", { status: "failed" }),
      job("later", { nextAttemptAt: "2026-01-10T00:01:00.000Z" }),
      job("saved", { pendingResult: { jd, cost: 0, attemptId: "self:1" } }),
    ];

    for (const row of rows) {
      expect(upstreamJobActionable(row, NOW), row.link).toBe(actionable(row, NOW));
    }
  });

  it("skips an unchanged snapshot with nothing due and runs when work is due", () => {
    const sha = "a".repeat(40);
    const young = { commit: sha, jobs: [job("young", { waitedSince: YOUNG })] };

    expect(
      upstreamShouldRun({ remoteSha: sha, storedCommit: sha, queue: young, now: NOW })
    ).toEqual({
      changed: false,
      actionable: false,
      run: false,
    });
    expect(
      upstreamShouldRun({
        remoteSha: sha,
        storedCommit: sha,
        queue: { commit: sha, jobs: [job("old")] },
        now: NOW,
      }).run
    ).toBe(true);
    expect(
      upstreamShouldRun({
        remoteSha: "b".repeat(40),
        storedCommit: sha,
        queue: young,
        now: NOW,
      })
    ).toMatchObject({ changed: true, run: true });
    expect(
      upstreamShouldRun({
        remoteSha: sha,
        storedCommit: null,
        queue: { commit: null, jobs: [] },
        now: NOW,
      }).run
    ).toBe(false);
  });

  it("writes GitHub outputs for the workflow gate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jobradar-upstream-due-"));
    const queuePath = path.join(dir, "queue.json");
    const outputPath = path.join(dir, "output.txt");
    const sha = "c".repeat(40);
    writeFileSync(queuePath, JSON.stringify({ commit: sha, jobs: [job("old")] }));

    const result = spawnSync("node", [path.resolve(".github/scripts/upstream-due.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        QUEUE_PATH: queuePath,
        REMOTE_SHA: sha,
        NOW_MS: String(NOW),
        GITHUB_OUTPUT: outputPath,
      },
    });

    expect(result.status).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain(`sha=${sha}`);
    expect(output).toContain("changed=false");
    expect(output).toContain("actionable=true");
    expect(output).toContain("run=true");
    expect(output).toContain("due=true");
  });
});
