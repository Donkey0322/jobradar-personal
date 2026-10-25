import { describe, expect, it } from "vitest";

import type { JD, Job } from "@/types";

import { matchUpstreamWaits } from "../upstream-queue";

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
