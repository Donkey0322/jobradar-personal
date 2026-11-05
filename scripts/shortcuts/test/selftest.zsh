#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT/../node.zsh"
NODE_BIN="$(jobscan_resolve_node "$ROOT/..")" || {
  printf 'FAIL node lookup\n' >&2
  exit 1
}
JOBSCAN="${JOBSCAN_BIN:-$(cd "$ROOT/.." && pwd)/jobscan.zsh}"
FAKE="$ROOT/fake-curl.mjs"
NOTIFY="$ROOT/fake-osascript.zsh"
SECURITY="$ROOT/fake-security.zsh"
LOG_CHECK="$ROOT/log-check.mjs"
PASS=0

fail_test() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local name="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || fail_test "$name: expected [$expected] got [$actual]"
}

assert_status() {
  local name="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || fail_test "$name: exit $actual, expected $expected"
}

new_case() {
  JOBSCAN_NODE_CASE=""
  CASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jobscan-test-XXXXXX")"
  LOG="$CASE_DIR/requests.jsonl"
  NOTES="$CASE_DIR/notes"
  SECURITY_LOG="$CASE_DIR/security"
  : >"$LOG"
  : >"$NOTES"
  : >"$SECURITY_LOG"
}

run_stage() {
  local scenario="$1"
  shift
  local stdout_file="$CASE_DIR/stdout" stderr_file="$CASE_DIR/stderr"
  local exit_code=0
  local -a node_env=()
  if [[ -n "${JOBSCAN_NODE_CASE:-}" ]]; then
    node_env=("JOBSCAN_NODE=$JOBSCAN_NODE_CASE")
  fi
  env "${node_env[@]}" \
  JOBSCAN_TOKEN="fake-token" \
  JOBSCAN_CURL="$FAKE" \
  JOBSCAN_OSASCRIPT="$NOTIFY" \
  JOBSCAN_SECURITY="$SECURITY" \
  JOBSCAN_FAKE_LOG="$LOG" \
  JOBSCAN_FAKE_STATE="$CASE_DIR/state.json" \
  JOBSCAN_FAKE_SCENARIO="$scenario" \
  JOBSCAN_NOTIFY_LOG="$NOTES" \
  JOBSCAN_SECURITY_LOG="$SECURITY_LOG" \
  JOBSCAN_POLL_SECONDS="${JOBSCAN_POLL_SECONDS_CASE:-0}" \
  JOBSCAN_DEADLINE_SECONDS="${JOBSCAN_DEADLINE_CASE:-30}" \
    "$JOBSCAN" "$@" >"$stdout_file" 2>"$stderr_file" || exit_code=$?
  STAGE_STATUS="$exit_code"
  STAGE_STDOUT="$(<"$stdout_file")"
  STAGE_STDERR="$(<"$stderr_file")"
}

requests() {
  "$NODE_BIN" "$LOG_CHECK" requests "$LOG"
}

note_text() {
  cat "$NOTES"
}

# ---------------------------------------------------------------- chain

new_case
JOBSCAN_POLL_SECONDS_CASE=0
JOBSCAN_DEADLINE_CASE=30
run_stage chain start
assert_status "start exit" "$STAGE_STATUS" 0
assert_eq "start stdout" "$STAGE_STDOUT" "101"
PUBLIC_ID="$STAGE_STDOUT"

run_stage chain discovery "$PUBLIC_ID"
assert_status "discovery exit" "$STAGE_STATUS" 0
assert_eq "discovery stdout" "$STAGE_STDOUT" "success"
[[ "$STAGE_STDOUT" != *$'\n'* ]] || fail_test "discovery stdout has a newline"
DISCOVERY_STDERR="$STAGE_STDERR"

REQUESTS_BEFORE_BATCH="$(wc -l <"$LOG" | tr -d ' ')"
run_stage chain batch "$STAGE_STDOUT"
assert_status "batch exit" "$STAGE_STATUS" 0
assert_eq "batch stdout" "$STAGE_STDOUT" "GO"
REQUESTS_AFTER_BATCH="$(wc -l <"$LOG" | tr -d ' ')"
assert_eq "batch made no request" "$REQUESTS_BEFORE_BATCH" "$REQUESTS_AFTER_BATCH"

run_stage chain personal "$STAGE_STDOUT"
assert_status "personal exit" "$STAGE_STATUS" 0
assert_eq "personal stdout" "$STAGE_STDOUT" "303"

run_stage chain personal_wait "$STAGE_STDOUT"
assert_status "personal_wait exit" "$STAGE_STATUS" 0
assert_eq "personal_wait stdout" "$STAGE_STDOUT" "Job Scan completed successfully!"

"$NODE_BIN" "$LOG_CHECK" chain "$LOG" || fail_test "chain requests"

[[ -z "$(cat "$SECURITY_LOG")" ]] || fail_test "keychain was read"
printf '%s' "$(note_text)" | grep -q "Public jobs pipeline started" || fail_test "missing discovery notification"
printf '%s' "$(note_text)" | grep -q "Batch included in the jobs pipeline" || fail_test "missing batch notification"
printf '%s' "$(note_text)" | grep -q "Job Scan completed successfully!" || fail_test "missing final notification"
[[ "$STAGE_STDOUT" != *queued* ]] || fail_test "status leaked to stdout"
[[ "$DISCOVERY_STDERR" == *"queued"* && "$DISCOVERY_STDERR" == *"in_progress"* ]] || fail_test "discovery did not wait through the queue"
PASS=$((PASS + 1))
printf 'ok chain\n'

# ---------------------------------------------------------------- no data

new_case
run_stage nodata start
run_stage nodata discovery "$STAGE_STDOUT"
assert_status "nodata discovery" "$STAGE_STATUS" 0
assert_eq "nodata token" "$STAGE_STDOUT" "success"
run_stage nodata batch success
assert_status "nodata batch" "$STAGE_STATUS" 0
assert_eq "nodata go" "$STAGE_STDOUT" "GO"
PASS=$((PASS + 1))
printf 'ok nodata\n'

# ---------------------------------------------------------------- batch stage does not dispatch

new_case
run_stage drained batch success
assert_status "batch stage exit" "$STAGE_STATUS" 0
assert_eq "batch stage stdout" "$STAGE_STDOUT" "GO"
[[ ! -s "$LOG" ]] || fail_test "batch stage called GitHub"
[[ "$(note_text)" == *"Batch included in the jobs pipeline"* ]] || fail_test "batch notification"
PASS=$((PASS + 1))
printf 'ok batch-stage\n'

# ---------------------------------------------------------------- failure

new_case
run_stage failure discovery 101
assert_status "failure exit" "$STAGE_STATUS" 1
assert_eq "failure stdout" "$STAGE_STDOUT" ""
[[ "$STAGE_STDERR" == *"Public jobs failed: failure"* ]] || fail_test "failure stderr: $STAGE_STDERR"
[[ "$(note_text)" == *"Public jobs failed: failure"* ]] || fail_test "failure notification"
[[ "$(requests)" != *batch.yml* ]] || fail_test "failure dispatched batch"
PASS=$((PASS + 1))
printf 'ok failure\n'

# ---------------------------------------------------------------- cancelled is not empty data

new_case
run_stage cancelled discovery 101
assert_status "cancelled exit" "$STAGE_STATUS" 1
assert_eq "cancelled stdout" "$STAGE_STDOUT" ""
[[ "$STAGE_STDERR" == *"Public jobs cancelled"* ]] || fail_test "cancelled stderr: $STAGE_STDERR"
[[ "$(note_text)" == *"Public jobs cancelled"* ]] || fail_test "cancelled notification"
[[ "$STAGE_STDOUT" != "GO" && "$STAGE_STDOUT" != "success" ]] || fail_test "cancelled continued"
run_stage cancelled batch "cancelled:99"
assert_status "old cancelled token" "$STAGE_STATUS" 1
[[ "$(requests)" != *batch.yml* ]] || fail_test "cancelled token dispatched batch"
PASS=$((PASS + 1))
printf 'ok cancelled\n'

# ---------------------------------------------------------------- timeout while queued

new_case
JOBSCAN_POLL_SECONDS_CASE=1
JOBSCAN_DEADLINE_CASE=1
run_stage timeout discovery 101
assert_status "timeout exit" "$STAGE_STATUS" 1
assert_eq "timeout stdout" "$STAGE_STDOUT" ""
[[ "$STAGE_STDERR" == *"Public jobs timed out"* ]] || fail_test "timeout stderr: $STAGE_STDERR"
[[ "$(note_text)" == *"Public jobs timed out"* ]] || fail_test "timeout notification"
[[ "$(requests)" == *"actions/runs/101"* ]] || fail_test "timeout never polled"
[[ "$STAGE_STDERR" == *"queued"* ]] || fail_test "timeout did not see queued"
PASS=$((PASS + 1))
printf 'ok timeout\n'

# ---------------------------------------------------------------- run id mismatch

new_case
JOBSCAN_POLL_SECONDS_CASE=0
JOBSCAN_DEADLINE_CASE=30
run_stage mismatch discovery 101
assert_status "mismatch exit" "$STAGE_STATUS" 1
assert_eq "mismatch stdout" "$STAGE_STDOUT" ""
[[ "$STAGE_STDERR" == *"Public jobs run ID mismatch"* ]] || fail_test "mismatch stderr: $STAGE_STDERR"
[[ "$(note_text)" == *"run ID mismatch"* ]] || fail_test "mismatch notification"
[[ "$STAGE_STDOUT" != "GO" ]] || fail_test "mismatch continued"
PASS=$((PASS + 1))
printf 'ok mismatch\n'

# ---------------------------------------------------------------- rejected handoff does not dispatch personal

new_case
run_stage chain personal "success"
assert_status "personal gate" "$STAGE_STATUS" 1
[[ "$(requests)" != *jobradar-personal* ]] || fail_test "personal started early"
run_stage chain personal_wait "GO"
assert_status "personal_wait gate" "$STAGE_STATUS" 1
PASS=$((PASS + 1))
printf 'ok handoff\n'

# ---------------------------------------------------------------- missing node

new_case
JOBSCAN_NODE_CASE="/no/such/jobscan-node"
run_stage chain start
assert_status "missing node exit" "$STAGE_STATUS" 1
[[ "$STAGE_STDERR" == *"JOBSCAN_NODE is not executable"* ]] || fail_test "missing node stderr: $STAGE_STDERR"
[[ "$(requests)" != *dispatches* ]] || fail_test "missing node dispatched"
PASS=$((PASS + 1))
printf 'ok missing-node\n'

# ---------------------------------------------------------------- shortcut PATH uses .nvmrc when node is absent

new_case
resolved="$(PATH="/usr/bin:/bin:/usr/sbin:/sbin" NVM_DIR="${NVM_DIR:-$HOME/.nvm}" jobscan_resolve_node "$ROOT/..")" \
  || fail_test "nvmrc node lookup"
[[ -x "$resolved" ]] || fail_test "nvmrc node is not executable: $resolved"
version="$(tr -d '[:space:]' <"$(cd "$ROOT/../../.." && pwd)/.nvmrc")"
version="${version#v}"
[[ "$resolved" == */versions/node/v${version}/bin/node ]] || fail_test "nvmrc node path: $resolved"
hidden="$(mktemp -d "${TMPDIR:-/tmp}/jobscan-no-nvm-XXXXXX")"
if PATH="/usr/bin:/bin:/usr/sbin:/sbin" NVM_DIR="$hidden" jobscan_resolve_node "$ROOT/.." >/dev/null 2>"$CASE_DIR/node-err"; then
  fail_test "empty nvm dir still resolved node"
fi
[[ "$(<"$CASE_DIR/node-err")" == *"Node was not found on PATH"* ]] || fail_test "empty nvm stderr: $(<"$CASE_DIR/node-err")"
PASS=$((PASS + 1))
printf 'ok node-lookup\n'

printf '%s passed\n' "$PASS"
