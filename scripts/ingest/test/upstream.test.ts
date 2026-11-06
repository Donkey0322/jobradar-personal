import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobCategory } from "@/constants/job-category";

import type { JD, Job } from "@/types";

import { loadUpstreamOpportunities, resolveUpstreamCommit } from "../upstream";

import { getJobKey } from "@/modules/ats/job-key";
import {
  indexJobs,
  isSelfAnalyzedCountry,
  releaseSeenLinks,
  selectUpstreamWork,
} from "@/modules/posting/upstream";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: null,
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

function job(
  id: string,
  extras: Partial<Job> & { postedAt?: string } = {}
): Job & { postedAt?: string } {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    postedAt: new Date().toISOString(),
    ...extras,
  };
}

describe("selectUpstreamWork", () => {
  it("reuses a public JD and keeps Singapore or Taiwan rows that still need analysis", () => {
    const parsed = job("parsed", { jd, country: "USA" });
    const waiting = job("usa", { country: "USA" });
    const singapore = job("sg", { country: "Singapore", location: "Singapore" });
    const taiwan = job("tw", { country: "Taiwan", location: "Taipei, Taiwan" });
    const localParsed = new Set([getJobKey(parsed.link)]);

    const work = selectUpstreamWork([parsed, waiting, singapore, taiwan], localParsed);

    expect(work.map((item) => item.link)).toEqual([singapore.link, taiwan.link]);
  });

  it("adopts a public JD the local store does not have yet", () => {
    const ready = job("ready", { jd, country: "USA" });

    expect(selectUpstreamWork([ready], new Set())).toEqual([ready]);
  });

  it("leaves a public JD written before the lookback", () => {
    const stale = job("stale", {
      jd,
      country: "USA",
      postedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const undated = job("undated", { jd, country: "USA", postedAt: undefined });

    expect(selectUpstreamWork([stale, undated], new Set())).toEqual([]);
  });

  it("uses the Monday discovery lookback for a weekend public JD", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T07:17:00.000Z"));

    const saturday = job("weekend", {
      jd,
      country: "USA",
      postedAt: "2026-08-15T07:00:00.000Z",
    });

    vi.stubEnv("DISCOVERY_LOOKBACK_DAYS", "1");
    expect(selectUpstreamWork([saturday], new Set())).toEqual([]);

    vi.stubEnv("DISCOVERY_LOOKBACK_DAYS", "3");
    expect(selectUpstreamWork([saturday], new Set())).toEqual([saturday]);

    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
});

describe("releaseSeenLinks", () => {
  it("drops cached links so a later JD can be applied", () => {
    const ready = job("ready", { jd });
    const urls = new Set([ready.link, "https://job-boards.greenhouse.io/acme/jobs/other"]);
    const keys = new Set([
      getJobKey(ready.link),
      getJobKey("https://job-boards.greenhouse.io/acme/jobs/other"),
    ]);

    releaseSeenLinks(urls, keys, [ready]);

    expect(urls.has(ready.link)).toBe(false);
    expect(keys.has(getJobKey(ready.link))).toBe(false);
    expect(urls.size).toBe(1);
    expect(keys.size).toBe(1);
  });
});

describe("indexJobs", () => {
  it("keeps the parsed row when the same link appears twice", () => {
    const bare = job("1", { country: "USA" });
    const parsed = job("1", { jd, country: "USA" });

    expect(indexJobs([bare, parsed]).get(getJobKey(bare.link))?.jd).toEqual(jd);
    expect(indexJobs([parsed, bare]).get(getJobKey(bare.link))?.jd).toEqual(jd);
  });
});

describe("isSelfAnalyzedCountry", () => {
  it("is only Singapore and Taiwan", () => {
    expect(isSelfAnalyzedCountry("Singapore")).toBe(true);
    expect(isSelfAnalyzedCountry("Taiwan")).toBe(true);
    expect(isSelfAnalyzedCountry("USA")).toBe(false);
    expect(isSelfAnalyzedCountry(undefined)).toBe(false);
  });
});

describe("loadUpstreamOpportunities", () => {
  const previous = process.env.UPSTREAM_DATA_PATH;

  afterEach(() => {
    if (previous === undefined) delete process.env.UPSTREAM_DATA_PATH;
    else process.env.UPSTREAM_DATA_PATH = previous;
  });

  it("requires the workflow checkout path", async () => {
    delete process.env.UPSTREAM_DATA_PATH;

    await expect(loadUpstreamOpportunities()).rejects.toThrow(/UPSTREAM_DATA_PATH/);
  });

  it("reads opportunities from that directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "upstream-test-"));
    const row = job("1", { jd, country: "USA" });

    await writeFile(path.join(dir, "opportunities.ndjson"), `${JSON.stringify(row)}\n`);
    process.env.UPSTREAM_DATA_PATH = dir;

    try {
      const index = await loadUpstreamOpportunities();
      expect(index.get(getJobKey(row.link))?.jd).toEqual(jd);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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

async function commitRepo(dir: string, file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "public\n");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", path.relative(dir, file)]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "snapshot"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("resolveUpstreamCommit", () => {
  const previousData = process.env.UPSTREAM_DATA_PATH;
  const previousCommit = process.env.UPSTREAM_COMMIT;
  const previousCwd = process.cwd();
  const temps: string[] = [];

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousData === undefined) delete process.env.UPSTREAM_DATA_PATH;
    else process.env.UPSTREAM_DATA_PATH = previousData;
    if (previousCommit === undefined) delete process.env.UPSTREAM_COMMIT;
    else process.env.UPSTREAM_COMMIT = previousCommit;
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uses an independent checkout SHA instead of a stale commit or the personal HEAD", async () => {
    const personal = await mkdtemp(path.join(os.tmpdir(), "jobradar-personal-"));
    const upstream = await mkdtemp(path.join(os.tmpdir(), "jobradar-upstream-"));
    temps.push(personal, upstream);
    const personalSha = await commitRepo(personal, path.join(personal, "README"));
    const upstreamSha = await commitRepo(upstream, path.join(upstream, "data", "opportunities.ndjson"));

    process.chdir(personal);
    process.env.UPSTREAM_DATA_PATH = path.join(upstream, "data");
    process.env.UPSTREAM_COMMIT = "stale-ls-remote";

    const resolved = await resolveUpstreamCommit();

    expect(resolved).toBe(upstreamSha);
    expect(resolved).not.toBe(personalSha);
    expect(resolved).not.toBe("stale-ls-remote");
  });

  it("uses UPSTREAM_COMMIT when the data directory is only a folder in the personal repo", async () => {
    const personal = await mkdtemp(path.join(os.tmpdir(), "jobradar-personal-"));
    temps.push(personal);
    const personalSha = await commitRepo(personal, path.join(personal, "README"));
    const copied = path.join(personal, "copied-public");
    await mkdir(copied, { recursive: true });
    await writeFile(path.join(copied, "opportunities.ndjson"), "{}\n");

    process.chdir(personal);
    process.env.UPSTREAM_DATA_PATH = copied;
    process.env.UPSTREAM_COMMIT = "public-sha-from-workflow";

    const resolved = await resolveUpstreamCommit();

    expect(resolved).toBe("public-sha-from-workflow");
    expect(resolved).not.toBe(personalSha);
  });
});
