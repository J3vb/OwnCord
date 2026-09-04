#!/usr/bin/env bash
# Exercises the auto-loop classifier: for a given PR state, does it choose the
# right action? Every branch of handle_pr, the counters that must survive a
# subshell, and every merge refusal.
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
AUTO_TRUSTED_AUTHOR="testuser"          # keeps the sourced script off the network
# shellcheck source=/dev/null
. "$HERE/loop.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"; LOCKS="$STATE/locks"; ATTEMPTS="$STATE/attempts"; LOGS="$STATE/logs"
COUNTERS="$STATE/counters"
JOURNAL="$STATE/journal.md"; STUCK="$STATE/STUCK.md"; CURSOR="$STATE/cursor"
mkdir -p "$LOCKS" "$ATTEMPTS" "$LOGS" "$COUNTERS"
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

reset_state() {
  rm -rf "${LOCKS:?}"/* "${COUNTERS:?}"/* 2>/dev/null
  mkdir -p "$LOCKS" "$COUNTERS"
}

# handle_pr <pr> <branch> <draft> <mergeable> <title> <base>
run_case() {
  ACTED=""
  reset_state
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
check "out of fix attempts, red -> stuck" "stuck:9" "$(run_case 9 auto/x false MERGEABLE t dev)"

# A fixer that disputes a comment leaves CI green and the thread live. Without
# the second stuck clause this PR is relaunched every tick forever.
CI_STATE="GREEN"; THREADS="1	2	1	$old_commit"
echo "$MAX_FIX_ATTEMPTS" > "$ATTEMPTS/14"
check "out of fix attempts, green but thread live -> stuck" "stuck:14" "$(run_case 14 auto/x false MERGEABLE t dev)"

# A draft is only picked up once it has sat still for STALE_DRAFT_TICKS.
CI_STATE="GREEN"; THREADS="0	0	0	$old_commit"
ACTED=""; reset_state
handle_pr 10 auto/x true MERGEABLE t dev >/dev/null 2>&1
first="${ACTED# }"
handle_pr 10 auto/x true MERGEABLE t dev >/dev/null 2>&1
check "abandoned draft: waits one tick, then resumes" "|worker:coder" "$first|${ACTED# }"

echo "state that must outlive a subshell"

# The bug this guards: handle_pr runs in a subshell per PR, so anything a
# worker records in a shell variable is discarded on return — silently
# disabling the session cap, the failure stop, and draft resumption.
reset_state
( counter_bump sessions >/dev/null; counter_bump sessions >/dev/null )
check "session count survives a subshell" "2" "$(counter_get sessions)"

reset_state
( counter_bump failures >/dev/null )
( counter_zero failures )
check "failure count survives a subshell" "0" "$(counter_get failures)"

reset_state
CI_STATE="GREEN"; THREADS="0	0	0	$old_commit"
( handle_pr 15 auto/x true MERGEABLE t dev >/dev/null 2>&1 )
check "draft sighting survives a subshell" "1" "$(counter_get draft-15)"

echo "rehearsal leaves no trace"

reset_state; rm -f "$ATTEMPTS/16" "$ATTEMPTS/16.runs"
DRY=1
CI_STATE="FAIL"; FAILED_RUNS="99016"; THREADS="0	0	0	$old_commit"
run_case 16 auto/x false MERGEABLE t dev >/dev/null
check "--dry-run does not consume the CI rerun" "" "$(cat "$ATTEMPTS/16.runs" 2>/dev/null)"
check "--dry-run does not bump the fix count"   "0" "$(attempts_of 16)"
DRY=0

echo "merge guard"
# The real merge_pr, in a fresh subshell, with only the outside world stubbed.
# author: whichever login gh should claim the PR belongs to.
merge_guard() {
  ( pr="$1"; br="$2"; base="$3"; author="$4"
    AUTO_LOOP_SOURCED=1; AUTO_TRUSTED_AUTHOR="testuser"
    set --                      # loop.sh parses "$@"; ours are args, not its flags
    # shellcheck source=/dev/null
    . "$HERE/loop.sh"
    DRY=0; JOURNAL="$TMP/j"; CURSOR="$TMP/c"; ATTEMPTS="$TMP/a"; mkdir -p "$TMP/a"
    gh_q() { case "$*" in *author*) echo "$author" ;; esac; return 0; }
    worktree_drop() { :; }
    if merge_pr "$pr" title "$br" "$base" >/dev/null 2>&1; then echo allowed; else echo refused; fi )
}
check "refuses a base that is not dev"        "refused" "$(merge_guard 11 auto/x main testuser)"
check "refuses a branch outside the prefix"   "refused" "$(merge_guard 12 hotfix/x dev testuser)"
check "refuses a PR by anyone else"           "refused" "$(merge_guard 13 auto/x dev stranger)"
check "allows own auto/ branch into dev"      "allowed" "$(merge_guard 17 auto/x dev testuser)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
