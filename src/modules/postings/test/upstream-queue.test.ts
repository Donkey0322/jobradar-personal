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

function job(id: string): Job {
  return {
    company: "Acme",
    role: "Junior Software Engineer",
    link: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: "Austin, TX",
    country: "USA",
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
    });
  });
});
