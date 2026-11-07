import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { UpstreamWait } from "@/store/upstream-queue";
import type { JD, Job } from "@/types";

const root = await vi.hoisted(async () => {
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(nodePath.join(nodeOs.tmpdir(), "jobradar-wait-"));
});

const ai = vi.hoisted(() => ({
  prompts: [] as string[],
  result: null as string | null,
  cost: 0.01,
}));

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

vi.mock("@/utils/ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    default: async (prompt: string) => {
      ai.prompts.push(prompt);
      return { result: ai.result, cost: ai.cost };
    },
  };
});

import applyUpstreamQueue, {
  readConfirmedEnqueueTimes,
  reconcileUpstreamQueue,
  retryFailedUpstreamWaits,
} from "../upstream";

import { getJobKey } from "@/modules/ats/job-key";
import { migrateWaitTimes, UPSTREAM_RETRY_COMMAND } from "@/modules/posting/upstream";
import { jobs, opportunities, UPSTREAM_QUEUE_PATH, upstreamQueue } from "@/store";
import { logger } from "@/utils/logger";

const START = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SHA = "public-1";

const analyzed: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: ["Bachelor's degree in Computer Science"],
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

const fetches: string[] = [];
let respond: (url: string) => Response = (url) =>
  http(url, 200, JSON.stringify({ content: "Build reliable services" }));

function listing(id: string, country: Job["country"] = "USA"): Job {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    country,
  };
}

function waiting(id: string, waitedSince: string): UpstreamWait {
  return {
    ...listing(id),
    waitedSince,
    waitedSinceSource: "confirmed",
    status: "waiting",
  };
}

function http(
  url: string,
  status: number,
  body: string,
  headers?: Record<string, string>
): Response {
  const response = new Response(body, { status, statusText: String(status), headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function notificationCount(): number {
  return vi
    .mocked(logger.info)
    .mock.calls.filter((call) => String(call.at(-1)).includes("notification")).length;
}

async function storedSeason(link: string): Promise<string | undefined> {
  const row = (await opportunities.load()).find((item) => item.link === link);

  return row?.jd?.season;
}

async function snapshot() {
  return {
    jobs: await jobs.load(),
    opportunities: await opportunities.load(),
    notifications: notificationCount(),
    prompts: ai.prompts.length,
    fetches: fetches.length,
  };
}

function apiUrl(id: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`;
}

async function queueFile(): Promise<{ commit: string | null; jobs: UpstreamWait[] }> {
  return upstreamQueue.load();
}

async function reconcile(commit: string, rows: Array<Job & { stop?: { reason: string } }> = []) {
  await reconcileUpstreamQueue(commit, new Map(rows.map((job) => [getJobKey(job.link), job])));
}

describe("public JD wait", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    ai.prompts.length = 0;
    ai.result = JSON.stringify(analyzed);
    ai.cost = 0.01;
    fetches.length = 0;
    respond = (url) => http(url, 200, JSON.stringify({ content: "Build reliable services" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetches.push(url);
      return respond(url);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("does not analyze before three days, then analyzes on the same public SHA", async () => {
    const job = waiting("young", START.toISOString());
    await upstreamQueue.save({ commit: SHA, jobs: [job] });
    await reconcile(SHA, [listing("young")]);

    expect(fetches).toEqual([]);
    expect(ai.prompts).toEqual([]);
    expect((await queueFile()).jobs.map((item) => item.link)).toEqual([job.link]);

    vi.setSystemTime(new Date(START.getTime() + 3 * DAY));
    await reconcile(SHA, [listing("young")]);

    expect(fetches).toEqual([apiUrl("young")]);
    expect(ai.prompts).toHaveLength(1);
    expect(ai.prompts[0]).toContain("Build reliable services");
    const stored = await jobs.load();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(1);
    expect(stored[0]?.jd?.country).toBe("USA");
    expect(await queueFile()).toEqual({ commit: SHA, jobs: [] });
  });

  it("prefers a public JD before and after the deadline without calling AI", async () => {
    const young = waiting("before", START.toISOString());
    const expired = waiting("after", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({ commit: "old", jobs: [young] });

    await reconcile("public-2", [{ ...young, jd: analyzed }]);

    expect(ai.prompts).toEqual([]);
    expect(fetches).toEqual([]);
    expect((await jobs.load()).map((item) => item.link)).toEqual([young.link]);
    expect(await queueFile()).toEqual({ commit: "public-2", jobs: [] });

    await upstreamQueue.save({ commit: SHA, jobs: [expired] });
    await reconcile(SHA, [{ ...expired, jd: analyzed }]);

    expect(ai.prompts).toEqual([]);
    expect(fetches).toEqual([]);
    expect((await jobs.load()).map((item) => item.link).sort()).toEqual(
      [expired.link, young.link].sort()
    );
    expect((await queueFile()).jobs).toEqual([]);
  });

  it("backfills a historical 2025 Summer JD before and after the deadline, then a rerun adds nothing", async () => {
    const past = {
      ...analyzed,
      category: JobCategory.SUMMER_INTERN,
      season: "2025 Summer" as JD["season"],
    };
    const young = waiting("past-young", START.toISOString());
    const expired = waiting("past-old", new Date(START.getTime() - 4 * DAY).toISOString());

    await upstreamQueue.save({ commit: "old", jobs: [young] });
    await reconcile("public-2", [{ ...young, jd: past }]);

    expect(fetches).toEqual([]);
    expect(ai.prompts).toEqual([]);
    expect(await storedSeason(young.link)).toBe("2025 Summer");
    const youngSnapshot = await snapshot();

    await reconcile("public-2", [{ ...young, jd: past }]);
    expect(await snapshot()).toEqual(youngSnapshot);

    await upstreamQueue.save({ commit: SHA, jobs: [expired] });
    await reconcile(SHA, [{ ...expired, jd: past }]);

    expect(fetches).toEqual([]);
    expect(ai.prompts).toEqual([]);
    expect(await storedSeason(expired.link)).toBe("2025 Summer");
    const expiredSnapshot = await snapshot();

    await reconcile(SHA, [{ ...expired, jd: past }]);
    expect(await snapshot()).toEqual(expiredSnapshot);
  });

  it("rejects intern season conflicts and incomplete stored JDs, and normalizes other seasons to None", async () => {
    const summerFall = waiting("summer-fall", START.toISOString());
    const offSummer = waiting("off-summer", START.toISOString());
    const broken = waiting("broken", START.toISOString());
    const leveled = waiting("leveled", new Date(START.getTime() - 4 * DAY).toISOString());

    await upstreamQueue.save({ commit: SHA, jobs: [summerFall, offSummer, broken, leveled] });
    const rows = [
      {
        ...summerFall,
        jd: {
          ...analyzed,
          category: JobCategory.SUMMER_INTERN,
          season: "2025 Fall" as JD["season"],
        },
      },
      {
        ...offSummer,
        jd: {
          ...analyzed,
          category: JobCategory.OFF_SEASON_INTERN,
          season: "2025 Summer" as JD["season"],
        },
      },
      { ...broken, jd: { country: "USA" } as JD },
      { ...leveled, jd: { ...analyzed, season: "2025 Summer" as JD["season"] } },
    ];

    await reconcile(SHA, rows);

    expect(fetches).toEqual([]);
    expect(ai.prompts).toEqual([]);
    expect((await queueFile()).jobs.map((item) => item.link).sort()).toEqual(
      [summerFall.link, offSummer.link, broken.link].sort()
    );
    expect(await storedSeason(leveled.link)).toBe("None");
    const saved = await snapshot();

    await reconcile(SHA, rows);
    expect(await snapshot()).toEqual(saved);
  });

  it("analyzes only five expired jobs when the same snapshot has more", async () => {
    const due = ["1", "2", "3", "4", "5", "6"].map((id) =>
      waiting(id, new Date(START.getTime() - 4 * DAY).toISOString())
    );
    await upstreamQueue.save({ commit: SHA, jobs: due });

    await reconcile(
      SHA,
      due.map((job) => ({ ...job }))
    );

    expect(fetches).toEqual(["1", "2", "3", "4", "5"].map((id) => apiUrl(id)));
    expect(ai.prompts).toHaveLength(5);
    expect((await jobs.load()).map((item) => item.link).sort()).toEqual(
      due
        .slice(0, 5)
        .map((item) => item.link)
        .sort()
    );
    const left = (await queueFile()).jobs;
    expect(left.map((item) => item.link)).toEqual([due[5]!.link]);
    expect(left[0]?.waitedSince).toBe(due[5]!.waitedSince);
  });

  it("does not restart the wait clock when a key is queued again or the run repeats", async () => {
    const { addWaitingJob } = await import("@/modules/posting/upstream");
    const first = addWaitingJob(
      { commit: SHA, jobs: [] },
      listing("again"),
      "2026-01-01T00:00:00.000Z"
    );
    const second = addWaitingJob(first.queue, listing("again"), "2026-02-01T00:00:00.000Z");

    expect(second.queue.jobs[0]?.waitedSince).toBe("2026-01-01T00:00:00.000Z");
    await upstreamQueue.save(second.queue);
    await reconcile(SHA, [listing("again")]);
    vi.setSystemTime(new Date(START.getTime() + DAY));
    await reconcile(SHA, [listing("again")]);

    expect((await queueFile()).jobs[0]?.waitedSince).toBe("2026-01-01T00:00:00.000Z");
    expect(fetches).toEqual([]);
    expect(ai.prompts).toEqual([]);
  });

  it("keeps a Retry-After delay, then succeeds without fetching early", async () => {
    const job = waiting("rate", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({ commit: SHA, jobs: [job] });
    respond = (url) => http(url, 429, "slow", { "retry-after": "60" });

    await reconcile(SHA, [listing("rate")]);

    expect(fetches).toEqual([apiUrl("rate")]);
    const delayed = (await queueFile()).jobs[0];
    expect(delayed?.status).toBe("waiting");
    expect(delayed?.attempts).toHaveLength(1);
    expect(delayed?.nextAttemptAt).toBe(new Date(START.getTime() + 60_000).toISOString());
    expect(delayed?.waitedSince).toBe(job.waitedSince);

    vi.setSystemTime(new Date(START.getTime() + 1000));
    await reconcile(SHA, [listing("rate")]);
    expect(fetches).toEqual([apiUrl("rate")]);

    vi.setSystemTime(new Date(START.getTime() + 60_000));
    respond = (url) => http(url, 200, JSON.stringify({ content: "Build reliable services" }));
    await reconcile(SHA, [listing("rate")]);

    expect(fetches).toEqual([apiUrl("rate"), apiUrl("rate")]);
    expect(ai.prompts).toHaveLength(1);
    expect(await queueFile()).toEqual({ commit: SHA, jobs: [] });
  });

  it("stops after three temporary failures and resumes only through the retry command", async () => {
    const job = waiting("down", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({ commit: SHA, jobs: [job] });
    respond = (url) => http(url, 503, "unavailable");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconcile(SHA, [listing("down")]);
    }

    const stopped = (await queueFile()).jobs[0];
    expect(stopped?.status).toBe("failed");
    expect(stopped?.attempts).toHaveLength(3);
    expect(stopped?.waitedSince).toBe(job.waitedSince);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ url: job.link }),
      expect.stringContaining(UPSTREAM_RETRY_COMMAND)
    );
    const fetchesAfterStop = fetches.length;
    await reconcile(SHA, [listing("down")]);
    expect(fetches).toHaveLength(fetchesAfterStop);
    expect(ai.prompts).toEqual([]);

    expect(await retryFailedUpstreamWaits()).toBe(1);
    const retried = (await queueFile()).jobs[0];
    expect(retried).toMatchObject({
      status: "waiting",
      manualRetries: 1,
      waitedSince: job.waitedSince,
    });
    expect(retried?.attempts).toHaveLength(3);

    respond = (url) => http(url, 200, JSON.stringify({ content: "Build reliable services" }));
    await reconcile(SHA, [listing("down")]);
    expect(ai.prompts).toHaveLength(1);
    expect(await queueFile()).toEqual({ commit: SHA, jobs: [] });
    expect(await jobs.load()).toHaveLength(1);
  });

  it("ends the wait for an explicit 404 or 410, and keeps 403 and a synthetic 404", async () => {
    const gone = waiting("missing", new Date(START.getTime() - 4 * DAY).toISOString());
    const removed = waiting("removed", new Date(START.getTime() - 4 * DAY).toISOString());
    const forbidden = waiting("forbidden", new Date(START.getTime() - 4 * DAY).toISOString());
    const synthetic = waiting("empty", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({ commit: SHA, jobs: [gone, removed, forbidden, synthetic] });
    respond = (url) => {
      if (url === apiUrl("missing") || url === gone.link) return http(url, 404, "missing");
      if (url === apiUrl("removed") || url === removed.link) return http(url, 410, "gone");
      if (url === apiUrl("forbidden") || url === forbidden.link) return http(url, 403, "no");
      if (url === apiUrl("empty")) return http(url, 200, "null");
      return http(url, 200, "<html></html>");
    };

    await reconcile(SHA, [
      listing("missing"),
      listing("removed"),
      listing("forbidden"),
      listing("empty"),
    ]);

    const left = await queueFile();
    expect(left.jobs.map((item) => item.link).sort()).toEqual(
      [forbidden.link, synthetic.link].sort()
    );
    expect(left.jobs.every((item) => item.status === "failed" && item.attempts?.length === 1)).toBe(
      true
    );
    expect(ai.prompts).toEqual([]);
    expect(await jobs.load()).toEqual([]);
  });

  it("logs public stop values and still waits, including an expired gone row", async () => {
    const youngGone = waiting("stop-gone", START.toISOString());
    const youngExhausted = waiting("stop-exhausted", START.toISOString());
    const youngUnknown = waiting("stop-unknown", START.toISOString());
    const expiredGone = waiting("stop-due", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({
      commit: SHA,
      jobs: [youngGone, youngExhausted, youngUnknown, expiredGone],
    });

    await reconcile(SHA, [
      { ...listing("stop-gone"), stop: { reason: "gone" } },
      { ...listing("stop-exhausted"), stop: { reason: "exhausted" } },
      { ...listing("stop-unknown"), stop: { reason: "undetermined" } },
      { ...listing("stop-due"), stop: { reason: "gone" } },
    ]);

    for (const stop of ["gone", "exhausted", "undetermined"]) {
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stop }),
        "Public stop is diagnostic and does not end the wait"
      );
    }
    expect(fetches).toEqual([apiUrl("stop-due")]);
    expect(ai.prompts).toHaveLength(1);
    const left = (await queueFile()).jobs.map((item) => item.link).sort();
    expect(left).toEqual([youngExhausted.link, youngGone.link, youngUnknown.link].sort());
  });

  it("replays a saved analysis without fetching or calling AI when the job write failed first", async () => {
    const job = waiting("saved", new Date(START.getTime() - 4 * DAY).toISOString());
    await upstreamQueue.save({ commit: SHA, jobs: [job] });
    const realSave = upstreamQueue.save.bind(upstreamQueue);
    let saves = 0;
    vi.spyOn(upstreamQueue, "save").mockImplementation(async (queue) => {
      saves += 1;
      if (saves === 3) throw new Error("disk");
      await realSave(queue);
    });

    await reconcile(SHA, [listing("saved")]);

    const pending = await queueFile();
    expect(pending.jobs[0]?.pendingResult?.jd.country).toBe("USA");
    expect(pending.jobs[0]?.pendingResult?.cost).toBe(0.01);
    const stored = await jobs.load();
    expect(stored).toHaveLength(1);
    const id = stored[0]?.id;
    const prompts = ai.prompts.length;
    const fetched = fetches.length;

    vi.mocked(upstreamQueue.save).mockRestore();
    await reconcile(SHA, [listing("saved")]);

    expect(ai.prompts).toHaveLength(prompts);
    expect(fetches).toHaveLength(fetched);
    const replayed = await jobs.load();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.id).toBe(id);
    expect(await queueFile()).toEqual({ commit: SHA, jobs: [] });
  });

  it("runs applyUpstreamQueue for due work on an unchanged commit and skips a young queue", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "jobradar-public-wait-"));
    const previousData = process.env.UPSTREAM_DATA_PATH;
    const previousCommit = process.env.UPSTREAM_COMMIT;
    const job = waiting("apply", START.toISOString());

    try {
      await writeFile(
        path.join(cache, "opportunities.ndjson"),
        `${JSON.stringify(listing("apply"))}\n`
      );
      await upstreamQueue.save({ commit: SHA, jobs: [job] });
      process.env.UPSTREAM_DATA_PATH = cache;
      process.env.UPSTREAM_COMMIT = SHA;

      await applyUpstreamQueue();
      expect(fetches).toEqual([]);
      expect(ai.prompts).toEqual([]);

      vi.setSystemTime(new Date(START.getTime() + 3 * DAY));
      await applyUpstreamQueue();
      expect(fetches).toEqual([apiUrl("apply")]);
      expect(ai.prompts).toHaveLength(1);
      expect(await queueFile()).toEqual({ commit: SHA, jobs: [] });
    } finally {
      if (previousData === undefined) delete process.env.UPSTREAM_DATA_PATH;
      else process.env.UPSTREAM_DATA_PATH = previousData;
      if (previousCommit === undefined) delete process.env.UPSTREAM_COMMIT;
      else process.env.UPSTREAM_COMMIT = previousCommit;
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("does not replace a damaged queue that still holds a paid JD", async () => {
    const job = {
      ...waiting("paid", START.toISOString()),
      pendingResult: { jd: analyzed, cost: 0.42, attemptId: "self:paid" },
    };
    await upstreamQueue.save({ commit: SHA, jobs: [job] });
    const original = await readFile(UPSTREAM_QUEUE_PATH, "utf8");
    const damaged = original.slice(0, -8);
    await writeFile(UPSTREAM_QUEUE_PATH, damaged);
    const previousCommit = process.env.UPSTREAM_COMMIT;
    process.env.UPSTREAM_COMMIT = SHA;

    try {
      await expect(applyUpstreamQueue()).rejects.toThrow(
        `Upstream queue is not valid JSON: ${UPSTREAM_QUEUE_PATH}`
      );
      expect(await readFile(UPSTREAM_QUEUE_PATH, "utf8")).toBe(damaged);
      expect(damaged).toContain("self:paid");
      expect(fetches).toEqual([]);
      expect(ai.prompts).toEqual([]);
    } finally {
      if (previousCommit === undefined) delete process.env.UPSTREAM_COMMIT;
      else process.env.UPSTREAM_COMMIT = previousCommit;
    }
  });
});

describe("confirmed enqueue history", () => {
  it("uses the first commit that added the URL and ignores a later rewrite", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "jobradar-queue-history-"));
    const queuePath = path.join(repo, "data/upstream/queue.json");
    const link = listing("history").link;
    const first = "2026-01-02T03:04:05Z";
    const later = "2026-03-04T05:06:07Z";

    try {
      await mkdir(path.dirname(queuePath), { recursive: true });
      await writeFile(
        queuePath,
        `${JSON.stringify({ commit: null, jobs: [listing("history")] }, null, 2)}\n`
      );
      gitInit(repo);
      commitAt(repo, first, "add");
      await writeFile(
        queuePath,
        `${JSON.stringify({ commit: null, jobs: [{ ...listing("history"), role: "Rewritten" }] }, null, 2)}\n`
      );
      commitAt(repo, later, "rewrite");

      const times = await readConfirmedEnqueueTimes(repo);
      expect(Date.parse(times.get(link) ?? "")).toBe(Date.parse(first));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("deepens a depth-1 clone and does not move a confirmed wait onto a later commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jobradar-queue-shallow-"));
    const bare = path.join(root, "remote.git");
    const source = path.join(root, "source");
    const shallow = path.join(root, "shallow");
    const early = "2026-01-02T03:04:05Z";
    const later = "2026-03-04T05:06:07Z";
    const kept = "2025-12-01T00:00:00.000Z";
    const earlyJob = listing("early");
    const keptJob = {
      ...listing("kept"),
      waitedSince: kept,
      waitedSinceSource: "confirmed" as const,
    };

    try {
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: gitEnv() });
      execFileSync("git", ["clone", bare, source], { env: gitEnv() });
      await mkdir(path.join(source, "data", "upstream"), { recursive: true });
      await writeFile(
        path.join(source, "data", "upstream", "queue.json"),
        `${JSON.stringify({ commit: null, jobs: [earlyJob, keptJob] }, null, 2)}\n`
      );
      commitAll(source, early, "enqueue");
      await writeFile(path.join(source, "README.md"), "unrelated\n");
      commitAll(source, later, "unrelated");
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: source, env: gitEnv() });
      execFileSync("git", ["clone", "--depth", "1", "--no-local", bare, shallow], { env: gitEnv() });

      const times = await readConfirmedEnqueueTimes(shallow);
      expect(Date.parse(times.get(earlyJob.link) ?? "")).toBe(Date.parse(early));
      expect(
        execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
          cwd: shallow,
          encoding: "utf8",
        }).trim()
      ).toBe("false");

      const migrated = migrateWaitTimes(
        [earlyJob, keptJob],
        confirmedByKey(times),
        "2026-08-01T00:00:00.000Z"
      );
      expect(migrated.jobs[0]).toMatchObject({
        waitedSince: times.get(earlyJob.link),
        waitedSinceSource: "confirmed",
      });
      expect(Date.parse(migrated.jobs[0]?.waitedSince ?? "")).toBe(Date.parse(early));
      expect(migrated.jobs[1]).toMatchObject({
        waitedSince: kept,
        waitedSinceSource: "confirmed",
      });

      await writeFile(path.join(shallow, "NOTES.md"), "later still\n");
      commitAll(shallow, "2026-04-05T06:07:08Z", "another unrelated");
      const again = await readConfirmedEnqueueTimes(shallow);
      expect(again.get(earlyJob.link)).toBe(times.get(earlyJob.link));
      const frozen = migrateWaitTimes(
        migrated.jobs,
        confirmedByKey(again),
        "2026-09-01T00:00:00.000Z"
      );
      expect(frozen.changed).toBe(false);
      expect(frozen.jobs.map((job) => job.waitedSince)).toEqual([times.get(earlyJob.link), kept]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("estimates a fixed time when a depth-1 clone cannot be deepened", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jobradar-queue-estimate-"));
    const bare = path.join(root, "remote.git");
    const source = path.join(root, "source");
    const shallow = path.join(root, "shallow");
    const early = "2026-01-02T03:04:05Z";
    const later = "2026-03-04T05:06:07Z";
    const estimatedAt = "2026-06-01T00:00:00.000Z";
    const earlyJob = listing("early");
    const keptJob = {
      ...listing("kept"),
      waitedSince: early,
      waitedSinceSource: "confirmed" as const,
    };

    try {
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: gitEnv() });
      execFileSync("git", ["clone", bare, source], { env: gitEnv() });
      await mkdir(path.join(source, "data", "upstream"), { recursive: true });
      await writeFile(
        path.join(source, "data", "upstream", "queue.json"),
        `${JSON.stringify({ commit: null, jobs: [earlyJob, keptJob] }, null, 2)}\n`
      );
      commitAll(source, early, "enqueue");
      await writeFile(path.join(source, "README.md"), "unrelated\n");
      commitAll(source, later, "unrelated");
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: source, env: gitEnv() });
      execFileSync("git", ["clone", "--depth", "1", "--no-local", bare, shallow], { env: gitEnv() });
      execFileSync("git", ["remote", "remove", "origin"], { cwd: shallow, env: gitEnv() });

      const times = await readConfirmedEnqueueTimes(shallow);
      expect(times.size).toBe(0);

      const migrated = migrateWaitTimes([earlyJob, keptJob], confirmedByKey(times), estimatedAt);
      expect(migrated.jobs[0]).toMatchObject({
        waitedSince: estimatedAt,
        waitedSinceSource: "estimated",
      });
      expect(migrated.jobs[1]).toMatchObject({
        waitedSince: early,
        waitedSinceSource: "confirmed",
      });
      const frozen = migrateWaitTimes(migrated.jobs, times, "2026-09-01T00:00:00.000Z");
      expect(frozen.changed).toBe(false);
      expect(frozen.jobs[0]?.waitedSince).toBe(estimatedAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function confirmedByKey(times: ReadonlyMap<string, string>): Map<string, string> {
  const confirmed = new Map<string, string>();

  for (const [link, time] of times) {
    const key = getJobKey(link);
    if (!confirmed.has(key)) confirmed.set(key, time);
  }

  return confirmed;
}

function gitEnv(date?: string) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
}

function gitInit(repo: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, env: gitEnv() });
}

function commitAll(repo: string, date: string, message: string) {
  const env = gitEnv(date);
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd: repo, env }
  );
}

function commitAt(repo: string, date: string, message: string) {
  const env = gitEnv(date);
  execFileSync("git", ["add", "data/upstream/queue.json"], { cwd: repo, env });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    {
      cwd: repo,
      env,
    }
  );
}
