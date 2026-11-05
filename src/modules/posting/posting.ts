import type { PostingAnalysisResult } from "./analysis/analyze";
import type { JDFetchResult } from "./jd";
import type { JD, Job } from "@/types";

import { analyzePosting, extractQualifications } from "./analysis/analyze";
import { createJDFetchSignal } from "./jd/signal";
import { fetchPostingJD } from "./jd";
import {
  eligibilityFor,
  isNotifyCandidate,
  isTarget,
  notificationDecision,
  shouldBatchAnalyze,
  withinDays,
} from "./screening";

import { CONFIG } from "@/config";
import { getJobKey, isKnownJob } from "@/modules/ats/job-key";
import { isAIEnabled } from "@/utils/ai/enabled";
import { logger } from "@/utils/logger";

export type PostingDate = string | number | null | undefined;

export class Posting implements Job {
  company: string;
  role: string;
  link: string;
  location: string;

  declare id?: number;
  declare country?: Job["country"];
  declare jd?: JD | null;

  #dates: PostingDate[];

  constructor(job: Job, dates: PostingDate | readonly PostingDate[] = []) {
    this.company = job.company;
    this.role = job.role;
    this.link = job.link;
    this.location = job.location;
    this.#dates = Array.isArray(dates) ? [...dates] : [dates];

    if (job.id !== undefined) this.id = job.id;
    if (job.country !== undefined) this.country = job.country;
    if (job.jd !== undefined) this.jd = job.jd;
  }

  static from(job: Job, dates?: PostingDate | readonly PostingDate[]): Posting {
    if (job instanceof Posting && dates === undefined) return job;
    return new Posting(job, dates);
  }

  key(): string {
    return getJobKey(this.link);
  }

  isTarget(): boolean {
    return isTarget(this.role);
  }

  isKnown(knownKeys: ReadonlySet<string>): boolean {
    return isKnownJob(this.link, knownKeys);
  }

  isRecent(days = 1): boolean {
    return this.#dates.some((date) => withinDays(date, days));
  }

  shouldBatchAnalyze(): boolean {
    return shouldBatchAnalyze(this.role);
  }

  setJD(jd: JD | null): this {
    this.jd = jd;
    return this;
  }

  async getRawJD(signal: AbortSignal = createJDFetchSignal()): Promise<JDFetchResult> {
    return fetchPostingJD(this.link, signal);
  }

  async analyze(options: PostingAnalyzeOptions = {}): Promise<PostingAnalysisResult> {
    const fetched =
      options.fetched ?? (await this.getRawJD(options.signal ?? createJDFetchSignal()));
    const result = await analyzePosting(this.toJob(), fetched);
    this.setJD(result.jd);
    const added = await this.addQualifications(result.rawJD);

    return {
      ...result,
      jd: this.jd ?? null,
      cost: result.cost + added.cost,
    };
  }

  /**
   * Ask for qualifications when this screened posting still needs them.
   * A skipped call costs nothing. A failed extraction keeps the screened JD and
   * still returns the model cost.
   */
  async addQualifications(rawJD: string): Promise<{ cost: number }> {
    if (!this.jd || !this.needsQualifications()) {
      return { cost: 0 };
    }

    const qualificationResult = await extractQualifications(rawJD);

    if (qualificationResult.qualifications) {
      this.setJD({
        ...this.jd,
        qualifications: qualificationResult.qualifications,
      });
    }

    return { cost: qualificationResult.cost };
  }

  isEligible(): readonly [eligible: boolean, reason: string | null] {
    return eligibilityFor(this.requireJD(), CONFIG);
  }

  needsQualifications(): boolean {
    const jd = this.requireJD();

    if (jd.qualifications != null) return false;

    const [eligible] = this.isEligible();
    if (!eligible) return false;

    // A bare link has no role, so eligibility alone decides.
    return !this.role || isNotifyCandidate(this.role);
  }

  decideNotification() {
    return notificationDecision({ role: this.role, jd: this.requireJD() }, CONFIG);
  }

  toJob(): Job {
    const job: Job = {
      company: this.company,
      role: this.role,
      link: this.link,
      location: this.location,
    };

    if (this.id !== undefined) job.id = this.id;
    if (this.country !== undefined) job.country = this.country;
    if (this.jd !== undefined) job.jd = this.jd;

    return job;
  }

  private requireJD(): JD {
    if (!this.jd) {
      throw new Error("Posting must be analyzed before checking eligibility");
    }

    return this.jd;
  }
}

export const LINK_ANALYSIS_TIMEOUT_MS = 5000;

export interface PostingAnalyzeOptions {
  fetched?: JDFetchResult;
  signal?: AbortSignal;
}

export async function analyzeLink(link: string): Promise<JD | null> {
  if (!isAIEnabled()) {
    logger.info({ url: link }, "⏭️ AI is disabled; skipping link analysis");
    return null;
  }

  const posting = Posting.from({
    company: "",
    role: "",
    link,
    location: "",
  });
  const result = await posting.analyze({
    signal: AbortSignal.timeout(LINK_ANALYSIS_TIMEOUT_MS),
  });
  return result.jd;
}
