import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { JD, Job } from "@/types";

const root = await vi.hoisted(async () => {
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(nodePath.join(nodeOs.tmpdir(), "jobradar-backfill-"));
});

const fetchEmployerJobs = vi.hoisted(() =>
  vi.fn(async () => ({ jobs: [], slow: [], failed: [] }))
);
const fetchSource = vi.hoisted(() => vi.fn(async () => []));

vi.mock("@/store/paths", async () => {
  const nodePath = await import("node:path");
  const data = () => nodePath.join(root, "data");

  return {
    get DATA_PATH() {
      return data();
    },
    get URLS_PATH() {
      return nodePath.join(data(), "urls.json");
    },
    get JOB_PATH() {
      return nodePath.join(data(), "jobs.ndjson");
    },
    get OPPORTUNITIES_PATH() {
      return nodePath.join(data(), "opportunities.ndjson");
    },
    get ARCHIVE_PATH() {
      return nodePath.join(data(), "archive");
    },
    get COMPANY_PATH() {
      return nodePath.join(data(), "company.json");
    },
    get ERROR_LOG_PATH() {
      return nodePath.join(data(), "discover-errors.log");
    },
    get BATCH_PATH() {
      return nodePath.join(data(), "batch");
    },
    get BATCH_QUEUE_PATH() {
      return nodePath.join(data(), "batch", "queue.ndjson");
    },
    get BATCH_INFLIGHT_PATH() {
      return nodePath.join(data(), "batch", "inflight.json");
    },
    get UPSTREAM_QUEUE_PATH() {
      return nodePath.join(data(), "upstream", "queue.json");
    },
    JOB_ARCHIVE_CHUNK: 1000,
    OPPORTUNITY_ARCHIVE_CHUNK: 5000,
  };
});

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/modules/employer/discover", () => ({
  fetchEmployerJobs,
}));

vi.mock("@/modules/source", () => ({
  default: fetchSource,
  SOURCES: [
    {
      name: "Stand-in",
      url: "https://example.test/jobs",
      format: "markdown",
      disabled: false,
    },
  ],
}));

import { enqueueUpstreamWaits } from "../../ingest/upstream";
import syncDiscover from "../scan";
import syncCommunity from "../sync";

import { getJobKey } from "@/modules/ats/job-key";
import { Posting } from "@/modules/posting";
import { jobs, opportunities, upstreamQueue } from "@/store";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: ["Bachelor's degree in Computer Science"],
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

function listing(company: string, id: string): Job {
  return {
    company,
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/${company.toLowerCase()}/jobs/${id}`,
    location: "Austin, TX",
    country: "USA",
  };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

describe("queued public JDs are applied before scan and sync", () => {
  const previousData = process.env.UPSTREAM_DATA_PATH;
  const previousCommit = process.env.UPSTREAM_COMMIT;
  const checkouts: string[] = [];
  let analyze: { mockRestore: () => void } | undefined;

  afterEach(async () => {
    analyze?.mockRestore();
    analyze = undefined;
    vi.restoreAllMocks();
    fetchEmployerJobs.mockClear();
    fetchSource.mockClear();
    if (previousData === undefined) delete process.env.UPSTREAM_DATA_PATH;
    else process.env.UPSTREAM_DATA_PATH = previousData;
    if (previousCommit === undefined) delete process.env.UPSTREAM_COMMIT;
    else process.env.UPSTREAM_COMMIT = previousCommit;
    await rm(root, { recursive: true, force: true });
    await Promise.all(checkouts.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function seedCheckout() {
    const ready = [listing("AMD", "1001"), listing("ASM", "2002")];
    const waiting = listing("Acme", "3003");
    const checkout = await mkdtemp(path.join(os.tmpdir(), "jobradar-public-"));
    checkouts.push(checkout);
    const data = path.join(checkout, "data");
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(data, "opportunities.ndjson"),
      [
        ...ready.map((job) => JSON.stringify({ ...job, jd, postedAt: new Date().toISOString() })),
        JSON.stringify({ ...waiting, postedAt: new Date().toISOString() }),
      ].join("\n") + "\n"
    );
    git(checkout, ["init", "-b", "main"]);
    git(checkout, ["add", "data/opportunities.ndjson"]);
    git(checkout, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "public",
    ]);
    await upstreamQueue.save({ commit: null, jobs: [...ready, waiting] });
    process.env.UPSTREAM_DATA_PATH = data;
    process.env.UPSTREAM_COMMIT = "stale-ls-remote";
    return { ready, waiting, sha: git(checkout, ["rev-parse", "HEAD"]) };
  }

  async function writtenRecords() {
    return {
      jobs: await jobs.load(),
      opportunities: await opportunities.load(),
      queue: await upstreamQueue.load(),
    };
  }

  it.each([
    ["scan", syncDiscover],
    ["sync", syncCommunity],
  ] as const)(
    "writes queued JDs during %s when discovery finds nothing, then ignores the same snapshot",
    async (task, run) => {
      analyze = vi.spyOn(Posting.prototype, "analyze");
      const { ready, waiting, sha } = await seedCheckout();

      await run();

      const first = await writtenRecords();
      expect(first.jobs.map((job) => getJobKey(job.link)).sort()).toEqual(
        ready.map((job) => getJobKey(job.link)).sort()
      );
      expect(first.jobs.every((job) => job.jd && typeof job.id === "number")).toBe(true);
      expect(first.opportunities.map((job) => getJobKey(job.link)).sort()).toEqual(
        ready.map((job) => getJobKey(job.link)).sort()
      );
      expect(first.queue.commit).toBe(sha);
      expect(first.queue.commit).not.toBe("stale-ls-remote");
      expect(first.queue.jobs.map((job) => job.link)).toEqual([waiting.link]);
      expect(analyze).not.toHaveBeenCalled();
      if (task === "scan") {
        expect(fetchEmployerJobs).toHaveBeenCalled();
        expect(fetchSource).not.toHaveBeenCalled();
      } else {
        expect(fetchSource).toHaveBeenCalled();
      }

      await run();

      const second = await writtenRecords();
      expect(second.jobs).toEqual(first.jobs);
      expect(second.opportunities).toEqual(first.opportunities);
      expect(second.queue).toEqual(first.queue);
      expect(analyze).not.toHaveBeenCalled();
    }
  );

  it("applies a job queued after snapshot A was checked, then does not write it again", async () => {
    analyze = vi.spyOn(Posting.prototype, "analyze");
    const { ready, waiting, sha } = await seedCheckout();
    const late = ready[0]!;
    await writeFile(
      path.join(process.env.UPSTREAM_DATA_PATH ?? "", "opportunities.ndjson"),
      [
        JSON.stringify({ ...late, jd, postedAt: new Date().toISOString() }),
        JSON.stringify({ ...waiting, postedAt: new Date().toISOString() }),
      ].join("\n") + "\n"
    );
    await upstreamQueue.save({ commit: sha, jobs: [waiting] });
    await enqueueUpstreamWaits([late]);

    const opened = await upstreamQueue.load();
    expect(opened.commit).toBeNull();
    expect(opened.jobs.map((job) => job.link)).toEqual([waiting.link, late.link]);

    await syncDiscover();

    const first = await writtenRecords();
    expect(first.jobs.map((job) => getJobKey(job.link))).toEqual([getJobKey(late.link)]);
    expect(first.jobs[0]?.jd).toEqual(jd);
    expect(typeof first.jobs[0]?.id).toBe("number");
    expect(first.opportunities.map((job) => getJobKey(job.link))).toEqual([getJobKey(late.link)]);
    expect(first.queue.commit).toBe(sha);
    expect(first.queue.jobs.map((job) => job.link)).toEqual([waiting.link]);
    expect(analyze).not.toHaveBeenCalled();

    await syncDiscover();

    const second = await writtenRecords();
    expect(second.jobs).toEqual(first.jobs);
    expect(second.opportunities).toEqual(first.opportunities);
    expect(second.queue).toEqual(first.queue);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("keeps the queued JD when the job file cannot be written", async () => {
    analyze = vi.spyOn(Posting.prototype, "analyze");
    const { ready, waiting } = await seedCheckout();
    const queued = [...ready, waiting];
    const append = vi.spyOn(jobs, "append").mockRejectedValue(new Error("ENOSPC"));

    await expect(syncDiscover()).rejects.toThrow("ENOSPC");

    expect(await jobs.load()).toEqual([]);
    expect(await opportunities.load()).toEqual([]);
    const queue = await upstreamQueue.load();
    expect(queue.commit).toBeNull();
    expect(queue.jobs.map((job) => job.link)).toEqual(queued.map((job) => job.link));
    expect(analyze).not.toHaveBeenCalled();
    append.mockRestore();
  });
});
