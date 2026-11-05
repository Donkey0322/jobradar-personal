import { JobCategory } from "@/constants/job-category";

import type { Config } from "@/config";
import type { JD } from "@/types";

import { CONFIG } from "@/config";
import { escapeRegExp } from "@/utils/url";

const ENGINEERING_WORDS = [
  "dev",
  "develop",
  "developer",
  "development",
  "eng.",
  "engr",
  "engr.",
  "engineer",
  "engineering",
  "swe",
  "sde",
  "fde",
  "programmer",
  "researcher",
  "scientist",
  "analyst",
];

function cleanWords(words: readonly string[] | undefined) {
  return (words ?? []).map((word) => word.trim()).filter((word) => word.length > 0);
}

const PRIORITY_WORDS = cleanWords(CONFIG.target.priorityKeywords);
const TECH_DOMAIN_WORDS = [
  ...new Set([
    ...cleanWords(CONFIG.target.keywords ?? ["software", "swe", "fde"]),
    ...PRIORITY_WORDS,
  ]),
];
const EXCLUDE_WORDS = cleanWords(CONFIG.target.excludeKeywords);

const INTERN_WORDS = ["intern", "internship", "co-op", "student"];

const ENTRY_LEVEL_WORDS = [
  "junior",
  "entry",
  "early-career",
  "new-grad",
  "new-graduate",
  "graduate",
  "1",
  "i",
  "amts",
  "l1",
  "l2",
];

const MID_LEVEL_WORDS = ["2", "ii", "mid-level"];

const SENIOR_LEVEL_WORDS = [
  "3",
  "iii",
  "senior",
  "sr.",
  "staff",
  "principal",
  "architect",
  "manager",
  "director",
  "distinguished",
  "lead",
  "head",
  "vp",
  "vice-president",
];

const NON_TECH_WORDS = [
  "recruiter",
  "sales",
  "marketing",
  "customer-success",
  "business-analyst",
  "finance",
  "account-executive",
  "operations",
  "program-manager",
  "product-marketing",
  "administrative",
  "support-specialist",
  "partner-manager",
];

/**
 * Whole-word, case-insensitive matchers.
 * A space and a hyphen are the same separator, so word lists use hyphens.
 * `new-grad` matches "new grad", "new-grad", and "newgrad".
 */
function buildPatterns(words: string[]) {
  return words.map((word) => {
    const escaped = escapeRegExp(word).replace(/[-\s]+/g, "[-\\s]*");

    return new RegExp(`(^|\\W)${escaped}($|\\W)`, "i");
  });
}

const ENGINEERING_PATTERNS = buildPatterns(ENGINEERING_WORDS);
const TECH_DOMAIN_PATTERNS = buildPatterns(TECH_DOMAIN_WORDS);
const PRIORITY_PATTERNS = buildPatterns(PRIORITY_WORDS);
const EXCLUDE_PATTERNS = buildPatterns(EXCLUDE_WORDS);

const INTERN_PATTERNS = buildPatterns(INTERN_WORDS);
const ENTRY_LEVEL_PATTERNS = buildPatterns(ENTRY_LEVEL_WORDS);
const MID_LEVEL_PATTERNS = buildPatterns(MID_LEVEL_WORDS);
const SENIOR_LEVEL_PATTERNS = buildPatterns(SENIOR_LEVEL_WORDS);

const NON_TECH_PATTERNS = buildPatterns(NON_TECH_WORDS);

function hasPattern(patterns: RegExp[], text: string) {
  return patterns.some((regex) => regex.test(text));
}

function normalize(title: string) {
  return title.toLowerCase().trim();
}

function isEngineering(title: string) {
  return hasPattern(ENGINEERING_PATTERNS, title);
}

function isTechDomain(title: string) {
  return hasPattern(TECH_DOMAIN_PATTERNS, title);
}

function isPriority(title: string) {
  return hasPattern(PRIORITY_PATTERNS, title);
}

function isExcluded(title: string) {
  return hasPattern(EXCLUDE_PATTERNS, title);
}

function isTech(title: string) {
  if (!isEngineering(title)) return false;
  if (isPriority(title)) return true;
  if (isExcluded(title)) return false;

  return isTechDomain(title);
}

function isNonTech(title: string) {
  return hasPattern(NON_TECH_PATTERNS, title);
}

function isIntern(title: string) {
  return hasPattern(INTERN_PATTERNS, title);
}

function isEntry(title: string) {
  return hasPattern(ENTRY_LEVEL_PATTERNS, title);
}

function isMid(title: string) {
  return hasPattern(MID_LEVEL_PATTERNS, title);
}

function isSenior(title: string) {
  return hasPattern(SENIOR_LEVEL_PATTERNS, title);
}

export function isTechIntern(title: string) {
  const t = normalize(title);

  if (!isTech(t)) return false;
  if (isNonTech(t)) return false;

  return isIntern(t);
}

export function isTechEntryLevel(title: string) {
  const t = normalize(title);

  if (!isTech(t)) return false;
  if (isNonTech(t)) return false;
  if (isIntern(t)) return false;
  if (isMid(t) || isSenior(t)) return false;

  return isEntry(t);
}

export function isTechMidLevel(title: string) {
  const t = normalize(title);

  if (!isTech(t)) return false;
  if (isNonTech(t)) return false;
  if (isIntern(t)) return false;

  return isMid(t);
}

export function isTechSeniorLevel(title: string) {
  const t = normalize(title);

  if (!isTech(t)) return false;
  if (isNonTech(t)) return false;
  if (isIntern(t)) return false;

  return isSenior(t);
}

/**
 * Owner-only. Omitted from the setup issue form, so template installs stay hybrid.
 * When true, every discovered target is queued for batch analysis.
 */
export function usesBatchOnly() {
  return CONFIG.dashboard?.batchOnly === true;
}

/**
 * Tech role with no intern / entry / mid / senior signal in the title.
 * These are queued for batch analysis instead of real-time notify.
 */
export function isUnspecifiedTechLevel(title: string) {
  const t = normalize(title);

  if (!isTech(t)) return false;
  if (isNonTech(t)) return false;
  if (isIntern(t) || isEntry(t) || isMid(t) || isSenior(t)) return false;

  return true;
}

/**
 * Titles that can produce email notify: configured intern/full-time titles,
 * plus unspecified-level tech titles whose JD may later match config.
 */
export function isNotifyCandidate(title: string, target: Config["target"] = CONFIG.target) {
  return isNotifyTarget(title, target) || isUnspecifiedTechLevel(title);
}

/**
 * Listing / discovery filter.
 * Keep notify titles and unspecified-level tech titles.
 * Mid/senior stay off unless those categories are configured.
 */
export function isTarget(title: string) {
  return isNotifyCandidate(title);
}

/**
 * Real-time vs batch routing after discovery.
 * Hybrid: notify titles stay on the real-time path, unspecified titles batch.
 * Batch-only dashboards queue every target title.
 */
export function shouldBatchAnalyze(title: string, batchOnly = usesBatchOnly()) {
  if (!isNotifyCandidate(title)) return false;
  if (batchOnly) return true;

  return !isNotifyTarget(title);
}

/**
 * Notification-priority heuristic from title + configured intern/full-time
 * categories. Only explicit level signals count; unspecified titles are not
 * treated as a match. In hybrid mode, matching jobs stay on the real-time path.
 */
export function isNotifyTarget(title: string, target: Config["target"] = CONFIG.target) {
  const status =
    (target?.intern?.includes(JobCategory.SUMMER_INTERN) && isTechIntern(title)) ||
    (target?.intern?.includes(JobCategory.OFF_SEASON_INTERN) && isTechIntern(title)) ||
    (target?.["full-time"]?.includes(JobCategory.ENTRY_LEVEL) && isTechEntryLevel(title)) ||
    (target?.["full-time"]?.includes(JobCategory.MID_LEVEL) && isTechMidLevel(title)) ||
    (target?.["full-time"]?.includes(JobCategory.SENIOR_LEVEL) && isTechSeniorLevel(title));

  if (status === undefined) {
    return true;
  }

  return status;
}

function getDiscoveryLookbackDays() {
  const days = Number(process.env.DISCOVERY_LOOKBACK_DAYS ?? 2);

  return Number.isInteger(days) && days >= 1 && days <= 7 ? days : 1;
}

export function withinDays(date: string | number | undefined | null, days = 1) {
  if (date === "" || date === null || date === undefined) return false;

  const value =
    typeof date === "number"
      ? date < 1e12
        ? date * 1000
        : date
      : /^\d+$/.test(date)
        ? Number(date) < 1e12
          ? Number(date) * 1000
          : Number(date)
        : date;

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) return false;

  const lookbackDays = Math.max(days, getDiscoveryLookbackDays());
  const daysAgo = new Date();
  daysAgo.setDate(daysAgo.getDate() - lookbackDays);

  return parsedDate >= daysAgo;
}

function allowedCountries(config: Config): Set<JD["country"]> {
  return config.target.countries.length > 0
    ? new Set<JD["country"]>([...config.target.countries, "Unsure"])
    : new Set();
}

/** Same eligibility rules as `Posting.isEligible`, against an explicit config. */
export function eligibilityFor(jd: JD, config: Config): readonly [boolean, string | null] {
  const countries = allowedCountries(config);
  const filters = config.target.filter;

  if (countries.size > 0 && !countries.has(jd.country)) {
    return [false, `${jd.country} is not in the allowed countries`];
  }

  const allowedCategories = new Set([
    ...(config.target.intern ?? []),
    ...(config.target["full-time"] ?? []),
  ]);

  if (jd.category && !allowedCategories.has(jd.category)) {
    return [false, `${jd.category} is not in the allowed categories`];
  }

  if (!filters) {
    return [true, null];
  }

  const rules = [];

  if (jd.country === "Unsure") {
    for (const country of config.target.countries) {
      const rule = filters[country];
      if (rule) rules.push(rule);
    }
  } else {
    const rule = filters[jd.country];
    if (rule) rules.push(rule);
  }

  for (const rule of rules) {
    if (rule.allow_citizenship_required === false && jd.citizenship === true) {
      return [false, "citizenship is required"];
    }

    if (rule.allow_no_sponsorship === false && jd.sponsorship === false) {
      return [false, "sponsorship is not available"];
    }
  }

  return [true, null];
}

/** Same notify/skip decision as `Posting.decideNotification`, against an explicit config. */
export function notificationDecision(job: { role: string; jd: JD }, config: Config) {
  const [eligible, reason] = eligibilityFor(job.jd, config);

  if (!eligible) {
    return {
      action: "skip" as const,
      kind: "ineligible" as const,
      reason,
    };
  }

  if (!isNotifyCandidate(job.role, config.target)) {
    return {
      action: "skip" as const,
      kind: "dashboard" as const,
      reason: null,
    };
  }

  return { action: "notify" as const, kind: null, reason: null };
}
