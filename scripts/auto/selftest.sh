#!/usr/bin/env bash
# Exercises the auto-loop classifier: for a given PR state, does it choose the
# right action? Every branch of handle_pr, plus the two merge refusals.
#
# No network, no model, no git. Run it after editing loop.sh:
#     bash scripts/auto/selftest.sh
#
# shellcheck disable=SC2034,SC2317
# Variables here are read by the sourced loop.sh, and the stub functions are
# called from it — shellcheck follows neither, so both look unused.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTO_LOOP_SOURCED=1
# shellcheck source=/dev/null
. "$HERE/loop.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"; LOCKS="$STATE/locks"; ATTEMPTS="$STATE/attempts"; LOGS="$STATE/logs"
JOURNAL="$STATE/journal.md"; STUCK="$STATE/STUCK.md"; CURSOR="$STATE/cursor"
mkdir -p "$LOCKS" "$ATTEMPTS" "$LOGS"
DRY=0

# ---- stubs: everything that would reach the network, git, or a model -------
ACTED=""
CI_STATE="GREEN"; THREADS="0	0	0	2020-01-01T00:00:00Z"; FAILED_RUNS=""
pr_ci() { echo "$CI_STATE"; }
pr_threads() { printf '%s\n' "$THREADS"; }
pr_failed_runs() { printf '%s\n' "$FAILED_RUNS"; }
worktree_for() { echo "$TMP/wt"; }
run_worker() { ACTED="$ACTED worker:$1"; return 0; }
merge_pr() { ACTED="$ACTED merge:$1"; return 0; }
mark_stuck() { ACTED="$ACTED stuck:$1"; return 0; }
gh_q() { ACTED="$ACTED gh:$1-$2"; return 0; }

PASS=0; FAIL=0
check() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s\n       want [%s]\n       got  [%s]\n' "$name" "$want" "$got"
  fi
}

# handle_pr <pr> <branch> <draft> <mergeable> <title> <base>
run_case() {
  ACTED=""
  DRAFT_SEEN=()
  rm -rf "${LOCKS:?}"/*; mkdir -p "$LOCKS"
  handle_pr "$@" >/dev/null 2>&1
  echo "${ACTED# }"
}

old_commit="2020-01-01T00:00:00Z"
new_commit="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "classifier"

CI_STATE="PENDING"; THREADS="0	0	0	$old_commit"
check "checks still running -> nothing" "" "$(run_case 1 auto/x false MERGEABLE t dev)"

CI_STATE="FAIL"; FAILED_RUNS="99001"; THREADS="0	0	0	$old_commit"
check "red CI, not yet retried -> rerun, no worker" "gh:run-rerun" "$(run_case 2 auto/x false MERGEABLE t dev)"

CI_STATE="FAIL"; FAILED_RUNS="99001"
echo 99001 > "$ATTEMPTS/3.runs"
check "red CI, already retried -> fixer" "worker:fixer" "$(run_case 3 auto/x false MERGEABLE t dev)"

CI_STATE="GREEN"; FAILED_RUNS=""; THREADS="0	0	0	$old_commit"
check "conflict -> fixer" "worker:fixer" "$(run_case 4 auto/x false CONFLICTING t dev)"

CI_STATE="GREEN"; THREADS="2	5	1	$old_commit"
check "live unresolved threads -> fixer" "worker:fixer" "$(run_case 5 auto/x false MERGEABLE t dev)"

CI_STATE="GREEN"; THREADS="0	0	0	$old_commit"
check "green, nobody reviewed -> reviewer" "worker:reviewer" "$(run_case 6 auto/x false MERGEABLE t dev)"

CI_STATE="GREEN"; THREADS="0	3	1	$old_commit"
check "green, threads all settled, quiet -> merge" "merge:7" "$(run_case 7 auto/x false MERGEABLE t dev)"

CI_STATE="GREEN"; THREADS="0	3	1	$new_commit"
check "green but just pushed -> hold, no merge" "" "$(run_case 8 auto/x false MERGEABLE t dev)"

CI_STATE="FAIL"; FAILED_RUNS=""; THREADS="0	0	0	$old_commit"
echo "$MAX_FIX_ATTEMPTS" > "$ATTEMPTS/9"
check "out of fix attempts -> stuck" "stuck:9" "$(run_case 9 auto/x false MERGEABLE t dev)"

# A draft is only picked up once it has sat still for STALE_DRAFT_TICKS.
CI_STATE="GREEN"; THREADS="0	0	0	$old_commit"
ACTED=""; DRAFT_SEEN=()
handle_pr 10 auto/x true MERGEABLE t dev >/dev/null 2>&1
first="${ACTED# }"
handle_pr 10 auto/x true MERGEABLE t dev >/dev/null 2>&1
check "abandoned draft: waits one tick, then resumes" "|worker:coder" "$first|${ACTED# }"

echo "merge guard"
# The real merge_pr, in a fresh subshell, with only the outside world stubbed.
merge_guard() {
  ( pr="$1"; br="$2"; base="$3"
    AUTO_LOOP_SOURCED=1
    set --                      # loop.sh parses "$@"; ours are args, not its flags
    # shellcheck source=/dev/null
    . "$HERE/loop.sh"
    DRY=0; JOURNAL="$TMP/j"; CURSOR="$TMP/c"; ATTEMPTS="$TMP/a"; mkdir -p "$TMP/a"
    gh_q() { return 0; }
    worktree_drop() { :; }
    if merge_pr "$pr" title "$br" "$base" >/dev/null 2>&1; then echo allowed; else echo refused; fi )
}
check "refuses a base that is not dev" "refused" "$(merge_guard 11 auto/x main)"
check "allows base dev"                "allowed" "$(merge_guard 12 auto/x dev)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
