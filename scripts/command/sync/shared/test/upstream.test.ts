import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JD, Job } from "@/types";

import {
  indexJobs,
  isSelfAnalyzedCountry,
  loadUpstreamOpportunities,
  releaseSeenLinks,
  selectUpstreamWork,
} from "../upstream";

import { getJobKey } from "@/utils/job-key";
import { JobCategory } from "@/validation/config";

const jd: JD = {
  citizenship: null,
  sponsorship: null,
  qualifications: null,
  country: "USA",
  location: "Austin, TX, USA",
  category: JobCategory.ENTRY_LEVEL,
  season: "None",
};

function job(id: string, extras: Partial<Job> = {}): Job {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
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
