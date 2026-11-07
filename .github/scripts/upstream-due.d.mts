export const UPSTREAM_WAIT_MS: number;

export interface UpstreamDueJob {
  pendingResult?: unknown;
  waitedSince?: string;
  waitedSinceSource?: string;
  status?: string;
  nextAttemptAt?: string;
}

export interface UpstreamDueDecision {
  changed: boolean;
  actionable: boolean;
  run: boolean;
}

export function upstreamJobActionable(job: UpstreamDueJob, now?: number): boolean;

export function upstreamShouldRun(input: {
  remoteSha: string;
  storedCommit: string | null;
  queue: { commit?: string | null; jobs?: UpstreamDueJob[] };
  now?: number;
}): UpstreamDueDecision;
