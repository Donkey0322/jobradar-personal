#!/bin/zsh
set -euo pipefail
zmodload zsh/datetime

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Shortcut stages, in order. Each stage prints one token on stdout and the
# next stage receives that token as $2. Diagnostics stay on stderr.
#   start           -> <public jobs run id>
#   discovery <id>  -> success
#   batch success   -> GO
#   personal GO     -> <personal jobs run id>
#   personal_wait <id> -> "Job Scan completed successfully!"
#
# Jobs Pipeline includes scan, publish, and batch. The batch stage does not
# dispatch another workflow. API version 2022-11-28 returns workflow_run_id
# only when return_run_details is true (HTTP 200).

ROOT="https://api.github.com/repos/Donkey0322"

PUBLIC_SCAN_DISPATCH="$ROOT/JobRadar-AI/actions/workflows/jobs.yml/dispatches"
PERSONAL_SCAN_DISPATCH="$ROOT/jobradar-personal/actions/workflows/jobs.yml/dispatches"

SCAN_PAYLOAD='{"ref":"main","inputs":{"task":"scan"},"return_run_details":true}'

# One jobs run covers fetch, publish, batch submit, and batch collect, plus
# time spent queued behind job-data-sync.
SCAN_DEADLINE_SECONDS="${JOBSCAN_SCAN_DEADLINE_SECONDS:-18000}"
PERSONAL_DEADLINE_SECONDS="${JOBSCAN_PERSONAL_DEADLINE_SECONDS:-18000}"
POLL_SECONDS="${JOBSCAN_POLL_SECONDS:-15}"

if [[ -n "${JOBSCAN_DEADLINE_SECONDS:-}" ]]; then
  SCAN_DEADLINE_SECONDS="$JOBSCAN_DEADLINE_SECONDS"
  PERSONAL_DEADLINE_SECONDS="$JOBSCAN_DEADLINE_SECONDS"
fi

notify() {
  "${JOBSCAN_OSASCRIPT:-osascript}" \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title "Job Scan"' \
    -e 'end run' \
    "$1" >/dev/null 2>&1 || true
}

fail() {
  notify "$1"
  printf 'Job Scan: %s\n' "$1" >&2
  exit 1
}

SCRIPT_DIR="${${0:A}:h}"
source "$SCRIPT_DIR/node.zsh"
if ! NODE="$(jobscan_resolve_node "$SCRIPT_DIR" 2>&1)"; then
  fail "$NODE"
fi
GITHUB_JSON="$SCRIPT_DIR/github-json.mjs"

if [[ -n "${JOBSCAN_TOKEN:-}" ]]; then
  TOKEN="$JOBSCAN_TOKEN"
else
  TOKEN=$("${JOBSCAN_SECURITY:-security}" find-generic-password \
    -a "$USER" \
    -s "JobScan-GitHub" \
    -w 2>/dev/null) || fail "GitHub Token not found in Keychain"
fi

api() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local raw code body

  local -a args=(
    -sS
    --connect-timeout 15
    --max-time 60
    -X "$method"
    -H "Authorization: Bearer $TOKEN"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
  )

  if [[ -n "$payload" ]]; then
    args+=(
      -H "Content-Type: application/json"
      -d "$payload"
    )
  fi

  local curl_bin="${JOBSCAN_CURL:-curl}"
  if [[ -n "${JOBSCAN_CURL:-}" ]]; then
    raw=$(PATH="${NODE:h}:$PATH" "$curl_bin" "${args[@]}" \
      -w $'\n%{http_code}' "$url") || {
      printf 'GitHub network error\n' >&2
      return 1
    }
  else
    raw=$(curl "${args[@]}" \
      -w $'\n%{http_code}' "$url") || {
      printf 'GitHub network error\n' >&2
      return 1
    }
  fi

  code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"

  if [[ "$code" != 2* ]]; then
    printf '%s\n' "$body" >&2
    printf 'GitHub API returned %s\n' "$code" >&2
    return 1
  fi

  printf '%s\n' "$body"
}

parse_run_id() {
  "$NODE" "$GITHUB_JSON" run-id
}

# stdout is "<status>:<conclusion>" for the requested run, or "mismatch".
parse_run_state() {
  local expected="$1"

  EXPECTED_RUN_ID="$expected" "$NODE" "$GITHUB_JSON" run-state
}

trim_input() {
  local value="${1:-}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  printf '%s' "$value"
}

dispatch_run() {
  local url="$1"
  local payload="$2"
  local label="$3"
  local response

  response=$(api POST "$url" "$payload") || fail "GitHub API error"
  DISPATCHED_RUN_ID=$(printf '%s\n' "$response" | parse_run_id) \
    || fail "Cannot retrieve $label run ID"
  printf 'dispatched %s run %s\n' "$label" "$DISPATCHED_RUN_ID" >&2
}

# Poll one run until it completes or the deadline passes.
# queued and in_progress stay in this wait. A different run id is not accepted.
wait_run() {
  local repo="$1"
  local run_id="$2"
  local label="$3"
  local deadline_seconds="$4"
  local deadline_at=$((EPOCHSECONDS + deadline_seconds))
  local result run_status conclusion remain pause

  while true; do
    if ((EPOCHSECONDS >= deadline_at)); then
      fail "$label timed out"
    fi

    result=$(api GET "$ROOT/$repo/actions/runs/$run_id" | parse_run_state "$run_id") \
      || fail "$label could not read run $run_id"

    if [[ "$result" == "mismatch" ]]; then
      fail "$label run ID mismatch"
    fi

    run_status="${result%%:*}"
    conclusion="${result#*:}"
    printf '%s run %s %s\n' "$label" "$run_id" "$run_status" >&2

    if [[ "$run_status" == "completed" ]]; then
      break
    fi

    case "$run_status" in
      queued | in_progress | pending | waiting | requested | action_required) ;;
      *) fail "$label unexpected status: $run_status" ;;
    esac

    if ((EPOCHSECONDS >= deadline_at)); then
      fail "$label timed out"
    fi

    remain=$((deadline_at - EPOCHSECONDS))
    pause="$POLL_SECONDS"
    if ((pause > remain)); then
      pause="$remain"
    fi
    if ((pause > 0)); then
      sleep "$pause"
    fi
  done

  if [[ "$conclusion" == "cancelled" ]]; then
    fail "$label cancelled"
  fi

  [[ "$conclusion" == "success" ]] || fail "$label failed: $conclusion"
}

case "${1:-}" in

  start)
    dispatch_run "$PUBLIC_SCAN_DISPATCH" "$SCAN_PAYLOAD" "Public jobs"
    notify "Public jobs pipeline started"
    printf '%s' "$DISPATCHED_RUN_ID"
    ;;

  discovery)
    run_id=$(trim_input "${2:-}")
    [[ "$run_id" =~ '^[0-9]+$' ]] || fail "Invalid Discovery input"

    wait_run "JobRadar-AI" "$run_id" "Public jobs" "$SCAN_DEADLINE_SECONDS"
    notify "Public jobs pipeline finished"
    printf '%s' "success"
    ;;

  batch)
    [[ "$(trim_input "${2:-}")" == "success" ]] || fail "Invalid Batch input"

    notify "Batch included in the jobs pipeline"
    printf '%s' "GO"
    ;;

  personal)
    [[ "$(trim_input "${2:-}")" == "GO" ]] || fail "Previous stage not completed"

    dispatch_run "$PERSONAL_SCAN_DISPATCH" "$SCAN_PAYLOAD" "Personal jobs"
    notify "Personal jobs pipeline started"
    printf '%s' "$DISPATCHED_RUN_ID"
    ;;

  personal_wait)
    run_id=$(trim_input "${2:-}")
    [[ "$run_id" =~ '^[0-9]+$' ]] || fail "Invalid Personal Run ID"

    notify "Waiting for the personal jobs pipeline"
    wait_run "jobradar-personal" "$run_id" "Personal jobs" "$PERSONAL_DEADLINE_SECONDS"
    notify "Job Scan completed successfully!"
    printf '%s\n' "Job Scan completed successfully!"
    ;;

  *)
    fail "Unknown command: ${1:-empty}"
    ;;

esac
