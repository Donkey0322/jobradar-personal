import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { JD, Job } from "@/types";

const root = await vi.hoisted(async () => {
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(nodePath.join(nodeOs.tmpdir(), "jobradar-upstream-"));
});

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

import applyUpstreamQueue from "../upstream";

import { getJobKey } from "@/modules/ats/job-key";
import { jobs, opportunities, UPSTREAM_QUEUE_PATH, upstreamQueue } from "@/store";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: ["Bachelor's degree in Computer Science"],
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

function listing(id: string, country: Job["country"]): Job {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    country,
  };
}

describe("applyUpstreamQueue", () => {
  const previousData = process.env.UPSTREAM_DATA_PATH;
  const previousCommit = process.env.UPSTREAM_COMMIT;

  afterEach(async () => {
    if (previousData === undefined) delete process.env.UPSTREAM_DATA_PATH;
    else process.env.UPSTREAM_DATA_PATH = previousData;
    if (previousCommit === undefined) delete process.env.UPSTREAM_COMMIT;
    else process.env.UPSTREAM_COMMIT = previousCommit;
    await rm(root, { recursive: true, force: true });
  });

  it("applies one public JD, keeps the unfinished wait, and does not duplicate it", async () => {
    const ready = listing("ready", "USA");
    const waiting = listing("waiting", "USA");
    const released = listing("released", "USA");
    const cache = await mkdtemp(path.join(os.tmpdir(), "jobradar-public-"));

    await writeFile(
      path.join(cache, "opportunities.ndjson"),
      [
        JSON.stringify({ ...ready, jd }),
        JSON.stringify(waiting),
        JSON.stringify({ ...released, country: "India" }),
      ].join("\n") + "\n"
    );
    await upstreamQueue.save({
      commit: null,
      jobs: [ready, waiting, released],
    });
    await opportunities.append([released]);

    process.env.UPSTREAM_DATA_PATH = cache;
    process.env.UPSTREAM_COMMIT = "public-1";

    try {
      await applyUpstreamQueue();

      const stored = await jobs.load();
      expect(stored.filter((job) => getJobKey(job.link) === getJobKey(ready.link))).toHaveLength(1);
      expect(stored[0]?.jd).toEqual(jd);

      const queue = await upstreamQueue.load();
      expect(queue.commit).toBe("public-1");
      expect(queue.jobs.map((job) => job.link)).toEqual([waiting.link]);

      const corrected = (await opportunities.load()).find(
        (job) => getJobKey(job.link) === getJobKey(released.link)
      );
      expect(corrected?.country).toBe("India");

      await applyUpstreamQueue();
      expect(await jobs.load()).toHaveLength(stored.length);
      expect(JSON.parse(await readFile(UPSTREAM_QUEUE_PATH, "utf8")).jobs).toHaveLength(1);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
