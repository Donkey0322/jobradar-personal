import { describe, expect, it } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { JD, Job } from "@/types";

import {
  addWaitingJob,
  applyWaitFailure,
  enqueueTimesFromLog,
  legalPublicJd,
  matchUpstreamWaits,
  migrateWaitTimes,
  publicStopKind,
  retryFailedWaits,
  selectSelfAnalysis,
  UPSTREAM_WAIT_MS,
  upstreamWorkDue,
  waitDisposition,
} from "../upstream";

import { getJobKey } from "@/modules/ats/job-key";
import { emptyUpstreamQueue } from "@/store/upstream-queue";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: null,
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

function job(id: string, country: Job["country"] = "USA"): Job {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    country,
  };
}

describe("matchUpstreamWaits", () => {
  it("keeps a queued job pending until the public row has a JD", () => {
    const waiting = job("1");
    const ready = job("2");
    const upstream = new Map<string, Job>([
      [getJobKey(waiting.link), waiting],
      [getJobKey(ready.link), { ...ready, jd }],
    ]);

    expect(matchUpstreamWaits([waiting, ready], upstream)).toEqual({
      ready: [ready],
      pending: [waiting],
      released: [],
    });
  });

  it("releases a queued job when the public country will not get a JD", () => {
    const india = job("1", "USA");
    const unsure = job("2", "USA");
    const missing = job("3");
    const upstream = new Map<string, Job>([
      [getJobKey(india.link), { ...india, country: "India" }],
      [getJobKey(unsure.link), { ...unsure, country: "Unsure" }],
    ]);

    expect(matchUpstreamWaits([india, unsure, missing], upstream)).toEqual({
      ready: [],
      pending: [unsure, missing],
      released: [india],
    });
  });
});

describe("addWaitingJob", () => {
  it("stores one row per link", () => {
    const first = addWaitingJob(emptyUpstreamQueue(), job("1"));
    const second = addWaitingJob(first.queue, { ...job("1"), role: "Again" });

    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.queue.jobs).toEqual([
      expect.objectContaining({ link: job("1").link, role: "Junior Software Engineer" }),
    ]);
  });

  it("clears the checked snapshot for a new job and keeps it for a repeat", () => {
    const remembered = { commit: "snapshot-a", jobs: [job("1")] };
    const repeat = addWaitingJob(remembered, { ...job("1"), role: "Again" });

    expect(repeat.added).toBe(false);
    expect(repeat.queue).toEqual(remembered);
    expect(repeat.queue.commit).toBe("snapshot-a");

    const added = addWaitingJob(remembered, job("2"));

    expect(added.added).toBe(true);
    expect(added.queue.commit).toBeNull();
    expect(added.queue.jobs.map((waiting) => waiting.link)).toEqual([job("1").link, job("2").link]);
    expect(remembered.commit).toBe("snapshot-a");
  });

  it("keeps the first wait time when the same key is queued again", () => {
    const first = addWaitingJob(emptyUpstreamQueue(), job("1"), "2026-01-01T00:00:00.000Z");
    const second = addWaitingJob(first.queue, job("1"), "2026-02-01T00:00:00.000Z");

    expect(first.queue.jobs[0]).toMatchObject({
      waitedSince: "2026-01-01T00:00:00.000Z",
      waitedSinceSource: "confirmed",
    });
    expect(second.added).toBe(false);
    expect(second.queue.jobs[0]?.waitedSince).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("public JD wait policy", () => {
  const started = "2026-01-01T00:00:00.000Z";

  function waiting(id: string, waitedSince = started) {
    return {
      ...job(id),
      waitedSince,
      waitedSinceSource: "confirmed" as const,
      status: "waiting" as const,
    };
  }

  it("accepts a stored public JD, including a past intern season, and rejects a bad one", () => {
    const pastSummer = {
      ...jd,
      category: JobCategory.SUMMER_INTERN,
      season: "2025 Summer" as JD["season"],
    };
    const leveled = { ...jd, season: "2025 Summer" as JD["season"] };

    expect(legalPublicJd({ ...job("1"), jd })).toEqual(jd);
    expect(legalPublicJd({ ...job("1"), jd: pastSummer })).toEqual(pastSummer);
    expect(legalPublicJd({ ...job("1"), jd: leveled })).toEqual(jd);
    expect(leveled.season).toBe("2025 Summer");
    expect(
      legalPublicJd({
        ...job("1"),
        jd: { ...pastSummer, season: "2025 Fall" as JD["season"] },
      })
    ).toBeNull();
    expect(
      legalPublicJd({
        ...job("1"),
        jd: {
          ...jd,
          category: JobCategory.OFF_SEASON_INTERN,
          season: "2025 Summer" as JD["season"],
        },
      })
    ).toBeNull();
    expect(legalPublicJd({ ...job("1"), jd: { country: "USA" } })).toBeNull();
    expect(
      matchUpstreamWaits(
        [job("1"), job("2")],
        new Map([
          [getJobKey(job("1").link), { ...job("1"), jd: { country: "USA" } as never }],
          [getJobKey(job("2").link), { ...job("2"), jd: pastSummer }],
        ])
      )
    ).toMatchObject({
      ready: [job("2")],
      pending: [job("1")],
    });
  });

  it("uses a proven enqueue time once, then keeps an estimate fixed", () => {
    const key = getJobKey(job("1").link);
    const proven = migrateWaitTimes(
      [job("1")],
      new Map([[key, "2026-01-02T03:04:05.000Z"]]),
      started
    );

    expect(proven.changed).toBe(true);
    expect(proven.jobs[0]).toMatchObject({
      waitedSince: "2026-01-02T03:04:05.000Z",
      waitedSinceSource: "confirmed",
    });

    const again = migrateWaitTimes(
      proven.jobs,
      new Map([[key, "2026-03-01T00:00:00.000Z"]]),
      "2026-04-01T00:00:00.000Z"
    );
    expect(again.changed).toBe(false);
    expect(again.jobs[0]?.waitedSince).toBe("2026-01-02T03:04:05.000Z");

    const estimated = migrateWaitTimes([job("2")], new Map(), started);
    expect(estimated.jobs[0]).toMatchObject({
      waitedSince: started,
      waitedSinceSource: "estimated",
    });
    const frozen = migrateWaitTimes(
      estimated.jobs,
      new Map([[getJobKey(job("2").link), started]]),
      "2026-08-01T00:00:00.000Z"
    );
    expect(frozen.changed).toBe(false);
    expect(frozen.jobs[0]?.waitedSinceSource).toBe("estimated");
  });

  it("reads the first added link from a queue history patch", () => {
    const log = [
      "COMMIT 2026-01-02T03:04:05Z",
      "+++ b/data/upstream/queue.json",
      `+      "link": "${job("1").link}"`,
      "COMMIT 2026-02-01T00:00:00Z",
      `+      "link": "${job("1").link}"`,
      `+      "link": "${job("2").link}"`,
    ].join("\n");

    expect(enqueueTimesFromLog(log)).toEqual(
      new Map([
        [job("1").link, "2026-01-02T03:04:05Z"],
        [job("2").link, "2026-02-01T00:00:00Z"],
      ])
    );
  });

  it("distinguishes public stop values without treating them as a decision", () => {
    expect(publicStopKind({ stop: { reason: "gone" } })).toBe("gone");
    expect(publicStopKind({ stop: { reason: "exhausted" } })).toBe("exhausted");
    expect(publicStopKind({ stop: { reason: "undetermined" } })).toBe("undetermined");
    expect(publicStopKind({ stop: { reason: "other" } })).toBe("undetermined");
    expect(publicStopKind(job("1"))).toBeNull();
  });

  it("keeps 403 and synthetic 404 open, and ends the wait only for an explicit removal", () => {
    expect(waitDisposition({ stage: "fetch", error: { code: 404, desc: "Not Found" } })).toBe(
      "gone"
    );
    expect(waitDisposition({ stage: "fetch", error: { code: 410, desc: "Gone" } })).toBe("gone");
    expect(waitDisposition({ stage: "fetch", error: { code: 403, desc: "Forbidden" } })).toBe(
      "terminal"
    );
    expect(
      waitDisposition({
        stage: "fetch",
        error: { code: 404, desc: "No data in response", failure: "closed" },
      })
    ).toBe("terminal");
    expect(
      waitDisposition({
        stage: "fetch",
        error: { code: 429, desc: "Too Many Requests", retryAfterMs: 1000 },
      })
    ).toBe("retry");
    expect(waitDisposition({ stage: "fetch", error: { code: 503, desc: "unavailable" } })).toBe(
      "retry"
    );
    expect(waitDisposition({ stage: "fetch", error: { code: 0, desc: "network" } })).toBe("retry");
    expect(
      waitDisposition({ stage: "fetch", error: { code: 0, desc: "timed out", failure: "timeout" } })
    ).toBe("retry");
    expect(waitDisposition({ stage: "ai", reason: "empty" })).toBe("retry");
  });

  it("runs for a new snapshot, an unstamped row, a saved result, or due work on the same snapshot", () => {
    const young = { commit: "sha", jobs: [waiting("1")] };
    const now = Date.parse(started);

    expect(upstreamWorkDue(young, "sha", now)).toBe(false);
    expect(upstreamWorkDue(young, "other", now)).toBe(true);
    expect(upstreamWorkDue({ commit: "sha", jobs: [job("1")] }, "sha", now)).toBe(true);
    expect(
      upstreamWorkDue(
        {
          commit: "sha",
          jobs: [{ ...waiting("1"), pendingResult: { jd, cost: 0, attemptId: "self:1" } }],
        },
        "sha",
        now
      )
    ).toBe(true);
    expect(
      upstreamWorkDue(
        { commit: "sha", jobs: [waiting("1", "2025-12-01T00:00:00.000Z")] },
        "sha",
        now
      )
    ).toBe(true);
    expect(
      upstreamWorkDue(
        {
          commit: "sha",
          jobs: [
            {
              ...waiting("1", "2025-12-01T00:00:00.000Z"),
              nextAttemptAt: new Date(now + 60_000).toISOString(),
            },
          ],
        },
        "sha",
        now
      )
    ).toBe(false);
    expect(
      upstreamWorkDue(
        {
          commit: "sha",
          jobs: [{ ...waiting("1", "2025-12-01T00:00:00.000Z"), status: "failed" }],
        },
        "sha",
        now
      )
    ).toBe(false);
  });

  it("selects at most five due jobs and leaves the rest in order", () => {
    const jobs = ["1", "2", "3", "4", "5", "6"].map((id) =>
      waiting(id, "2025-12-01T00:00:00.000Z")
    );
    const now = Date.parse(started);

    expect(selectSelfAnalysis(jobs, now).map((item) => item.link)).toEqual(
      jobs.slice(0, 5).map((item) => item.link)
    );
    expect(selectSelfAnalysis([waiting("1")], now)).toEqual([]);
    expect(now - Date.parse("2025-12-01T00:00:00.000Z")).toBeGreaterThan(UPSTREAM_WAIT_MS);
  });

  it("retries temporary failures with Retry-After, then keeps a terminal row for a manual round", () => {
    const first = applyWaitFailure(
      waiting("1", "2025-12-01T00:00:00.000Z"),
      { stage: "fetch", error: { code: 429, desc: "Too Many Requests", retryAfterMs: 60_000 } },
      started,
      "self:1"
    );

    expect(first.action).toBe("retry");
    expect(first.job.nextAttemptAt).toBe("2026-01-01T00:01:00.000Z");
    expect(first.job.attempts).toHaveLength(1);
    expect(first.job.waitedSince).toBe("2025-12-01T00:00:00.000Z");

    const second = applyWaitFailure(
      first.job,
      { stage: "fetch", error: { code: 503, desc: "down" } },
      started,
      "self:2"
    );
    const third = applyWaitFailure(second.job, { stage: "ai", reason: "empty" }, started, "self:3");

    expect(third.action).toBe("failed");
    expect(third.job.status).toBe("failed");
    expect(third.job.attempts?.map((attempt) => attempt.id)).toEqual([
      "self:1",
      "self:2",
      "self:3",
    ]);
    expect(third.job.nextAttemptAt).toBeUndefined();

    const retried = retryFailedWaits([third.job]);
    expect(retried.retried).toBe(1);
    expect(retried.jobs[0]).toMatchObject({
      status: "waiting",
      manualRetries: 1,
      waitedSince: "2025-12-01T00:00:00.000Z",
    });
    expect(retried.jobs[0]?.attempts).toHaveLength(3);
    expect(retried.jobs[0]?.nextAttemptAt).toBeUndefined();
  });
});
