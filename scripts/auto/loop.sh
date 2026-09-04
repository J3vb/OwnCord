#!/usr/bin/env bash
# OwnCord auto-loop — unattended overnight PR pipeline.
#
# A dumb poller. It spends no model tokens itself: it asks `gh` what changed
# and launches short-lived `claude -p` workers only when something needs doing.
# Design and rationale: docs/plans/auto-loop-2026-09-04.md
#
#   bash scripts/auto/loop.sh              run it
#   bash scripts/auto/loop.sh --dry-run    classify and print, launch nothing
#   bash scripts/auto/loop.sh --once       a single tick, then exit
#
# Deliberately NOT `set -e`: a failure on one PR must never kill the loop.
set -uo pipefail

# ---------------------------------------------------------------- config ----
REPO="J3vb/OwnCord"
BASE="dev"                      # the only branch this may ever merge into
BRANCH_PREFIX="auto/"           # the only PRs this may ever touch
POLL_SECONDS=300
WINDOW_START=22                 # local hour it wakes up
WINDOW_END=9                    # local hour it stops
MAX_WORKERS=3                   # concurrent claude sessions
MAX_SESSIONS=50                 # per night, then it stops itself
MAX_FIX_ATTEMPTS=3              # then the PR is abandoned as stuck
MAX_CONSECUTIVE_FAILURES=5      # then the night is over
MERGE_QUIET_MINUTES=15          # let Codex review a push before merging
STALE_DRAFT_TICKS=2             # an untouched draft = a coder that died
MODEL_CODER="opus"
MODEL_FIXER="opus"
MODEL_REVIEWER="sonnet"
STUCK_LABEL="auto: stuck"

# ----------------------------------------------------------------- paths ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPTS="$SCRIPT_DIR/prompts"
STATE="$ROOT/.claude/auto"
LOCKS="$STATE/locks"
LOGS="$STATE/logs"
ATTEMPTS="$STATE/attempts"
WORKTREES="$ROOT/.claude/worktrees"
CURSOR="$STATE/cursor"
JOURNAL="$STATE/journal.md"
STUCK="$STATE/STUCK.md"
STOP="$STATE/STOP"

DRY=0
ONCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --once) ONCE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOCKS" "$LOGS" "$ATTEMPTS" "$WORKTREES"
[ -f "$CURSOR" ] || echo "B5-PLAN" > "$CURSOR"

# The only PR author whose branches this loop will touch. This repository is
# public, so the `auto/` branch prefix alone is not a boundary — anyone can
# name a branch that. Derived from the signed-in account rather than
# hard-coded, and fatal if it cannot be established: an empty value here would
# widen the filter to everybody.
TRUSTED_AUTHOR="${AUTO_TRUSTED_AUTHOR:-$(gh api user --jq .login 2>/dev/null)}"
if [ -z "$TRUSTED_AUTHOR" ]; then
  echo "refusing to start: could not determine the signed-in GitHub user." >&2
  echo "run 'gh auth login', or set AUTO_TRUSTED_AUTHOR explicitly." >&2
  exit 3
fi

# Counters live on disk, not in variables. Each PR is handled in a subshell so
# one bad PR cannot take the loop down, and a subshell's variable writes are
# discarded on return — which would silently disable the session cap, the
# consecutive-failure stop and draft resumption.
COUNTERS="$STATE/counters"
mkdir -p "$COUNTERS"
echo 0 > "$COUNTERS/sessions"
echo 0 > "$COUNTERS/failures"
rm -f "${COUNTERS:?}"/draft-*

# An empty file is not zero: `cat` succeeds and prints nothing, so the `||`
# never fires and the caller compares "" with an integer.
counter_get() { local v; v="$(cat "$COUNTERS/$1" 2>/dev/null)"; echo "${v:-0}"; }
counter_bump() {
  local n; n=$(( $(counter_get "$1") + 1 ))
  echo "$n" > "$COUNTERS/$1"; echo "$n"
}
counter_zero() { echo 0 > "$COUNTERS/$1"; }

# ------------------------------------------------------------- utilities ----
# Goes to stderr on purpose: several helpers return a value on stdout via
# command substitution, and a log line landing in there would corrupt it.
say() {
  local line
  line="$(date +%H:%M)  $*"
  echo "$line" >&2
  [ "$DRY" = 1 ] || echo "$line" >> "$JOURNAL"
}

# Every `gh` call goes through here so a network blip is a skip, not a crash.
gh_q() { gh "$@" 2>/dev/null; }

in_window() {
  local h; h=10#$(date +%H)
  if [ "$WINDOW_START" -gt "$WINDOW_END" ]; then
    [ "$h" -ge "$WINDOW_START" ] || [ "$h" -lt "$WINDOW_END" ]
  else
    [ "$h" -ge "$WINDOW_START" ] && [ "$h" -lt "$WINDOW_END" ]
  fi
}

# Locks are mkdir-based: atomic on Windows, unlike a test-then-touch.
# A lock whose pid is gone is stale — the worker died, so reclaim it.
lock_take() {
  local pr="$1"
  if mkdir "$LOCKS/$pr" 2>/dev/null; then
    echo $$ > "$LOCKS/$pr/pid"; return 0
  fi
  local pid; pid="$(cat "$LOCKS/$pr/pid" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
  say "reclaimed a stale lock on #$pr"
  echo $$ > "$LOCKS/$pr/pid"; return 0
}
lock_free() { rm -rf "${LOCKS:?}/$1"; }
workers_busy() {
  local n=0 d pid
  for d in "$LOCKS"/*/; do
    [ -d "$d" ] || continue
    pid="$(cat "$d/pid" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then n=$((n + 1)); fi
  done
  echo "$n"
}

# A rehearsal must not consume the real run's allowances: without the DRY
# guards, --dry-run would burn the one permitted CI rerun and walk the PR
# towards the stuck threshold without a worker ever running.
attempts_of() { cat "$ATTEMPTS/$1" 2>/dev/null || echo 0; }
attempts_bump() { [ "$DRY" = 1 ] && return 0; echo $(( $(attempts_of "$1") + 1 )) > "$ATTEMPTS/$1"; }
retried_already() { grep -qx "$2" "$ATTEMPTS/$1.runs" 2>/dev/null; }
retried_mark() { [ "$DRY" = 1 ] && return 0; echo "$2" >> "$ATTEMPTS/$1.runs"; }

mark_stuck() {
  local pr="$1" why="$2"
  say "STUCK  #$pr  $why"
  [ "$DRY" = 1 ] && return 0
  gh_q label create "$STUCK_LABEL" -R "$REPO" --color EEEEEE --description "auto-loop gave up" >/dev/null
  gh_q pr edit "$pr" -R "$REPO" --add-label "$STUCK_LABEL" >/dev/null
  {
    echo "- **#$pr** — $why  _( $(date '+%Y-%m-%d %H:%M') )_"
    echo "  https://github.com/$REPO/pull/$pr"
  } >> "$STUCK"
}

# ------------------------------------------------------------- gh queries ----
# One GraphQL round-trip gives everything the classifier needs about review
# state. A thread that is unresolved but OUTDATED means the code under it
# changed — the fixer addressed it — so only fresh unresolved threads block.
pr_threads() {
  # shellcheck disable=SC2016  # GraphQL and jq, not shell — the $vars are theirs
  gh_q api graphql -f query='
    query($o:String!,$r:String!,$n:Int!){
      repository(owner:$o,name:$r){
        pullRequest(number:$n){
          reviewThreads(first:100){ totalCount nodes{ isResolved isOutdated } }
          reviews(first:1){ totalCount }
          commits(last:1){ nodes{ commit{ committedDate } } }
        }}}' \
    -F o="${REPO%%/*}" -F r="${REPO##*/}" -F n="$1" \
    --jq '.data.repository.pullRequest
          | [ (.reviewThreads.nodes | map(select(.isResolved == false and .isOutdated == false)) | length)
            , .reviewThreads.totalCount
            , .reviews.totalCount
            , (.commits.nodes[0].commit.committedDate // "")
            ] | @tsv'
}

pr_ci() {
  # shellcheck disable=SC2016  # jq program, not shell
  gh_q pr view "$1" -R "$REPO" --json statusCheckRollup \
    --jq '[ .statusCheckRollup[]? | (.conclusion // .state // "PENDING") ] as $c
          | if ($c | length) == 0 then "NONE"
            elif ($c | map(select(. == "FAILURE" or . == "TIMED_OUT" or . == "CANCELLED"
                                  or . == "STARTUP_FAILURE" or . == "ERROR")) | length) > 0 then "FAIL"
            elif ($c | map(select(. == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED")) | length) == ($c | length) then "GREEN"
            else "PENDING" end'
}

pr_failed_runs() {
  # shellcheck disable=SC2016  # jq program, not shell
  gh_q pr view "$1" -R "$REPO" --json statusCheckRollup \
    --jq '.statusCheckRollup[]? | select(((.conclusion // .state) // "") as $x
          | $x == "FAILURE" or $x == "TIMED_OUT" or $x == "CANCELLED"
            or $x == "STARTUP_FAILURE" or $x == "ERROR") | .detailsUrl' \
    | sed -n 's#.*/actions/runs/\([0-9][0-9]*\).*#\1#p' | sort -u
}

# ---------------------------------------------------------------- workers ----
# Every worker is a fresh `claude -p` in its own git worktree. Nothing is
# resumed, so nothing accumulates confusion. Output is JSON so the cost and
# any usage-limit message can be read back.
run_worker() {
  local role="$1" model="$2" workdir="$3" prompt_file="$4" context="$5" tag="$6"
  local logfile
  logfile="$LOGS/$(date +%Y%m%d-%H%M%S)-$role-$tag.json"

  if [ "$DRY" = 1 ]; then
    say "DRY    would run $role ($model) on $tag in $workdir"
    return 0
  fi

  local prompt
  prompt="$(cat "$PROMPTS/rules.md" "$prompt_file")
$context"

  local used; used="$(counter_bump sessions)"
  say "$role  $tag  starting ($model, session $used/$MAX_SESSIONS)"

  ( cd "$workdir" && claude -p "$prompt" \
      --model "$model" \
      --permission-mode bypassPermissions \
      --output-format json \
      --fallback-model "$model" ) > "$logfile" 2>&1
  local rc=$?

  # A usage limit is not a failure to retry — it is a wall. Sleep past it.
  if grep -qiE 'usage limit|rate limit|too many requests|resets at' "$logfile"; then
    local until_h nap=1800
    until_h="$(grep -oiE 'resets? at [0-9]{1,2}' "$logfile" | grep -oE '[0-9]+' | head -1)"
    if [ -n "$until_h" ]; then
      local now_h delta
      now_h=10#$(date +%H)
      delta=$(( (until_h - now_h + 24) % 24 ))
      nap=$(( delta * 3600 + 300 ))
      say "usage limit hit — sleeping until ~${until_h}:00"
    else
      say "usage limit hit — sleeping 30m"
    fi
    sleep "$nap"
    return 1
  fi

  local cost
  cost="$(grep -oE '"total_cost_usd":[0-9.]+' "$logfile" | head -1 | cut -d: -f2)"
  if [ "$rc" -ne 0 ]; then
    counter_bump failures >/dev/null
    say "$role  $tag  FAILED (rc=$rc) — see $logfile"
    return 1
  fi
  counter_zero failures
  say "$role  $tag  done${cost:+ (~\$$cost)}"
  return 0
}

# One worktree per BRANCH, never per role. A coder and the fixer that follows
# it work the same branch, and git refuses to check a branch out twice — the
# second caller would land on a detached `origin/<branch>` and its push would
# fail with "You are not currently on a branch", losing the work while still
# burning an attempt.
# printf, not echo: echo's trailing newline becomes a trailing '-' under tr.
# No extra prefix either — BRANCH_PREFIX already makes the name distinctive.
worktree_path() { printf '%s/%s\n' "$WORKTREES" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')"; }

worktree_for() {
  local branch="$1" new="$2"
  local wt; wt="$(worktree_path "$branch")"

  # Already checked out somewhere? Use that, wherever it is.
  local existing
  existing="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
              | awk -v b="refs/heads/$branch" '
                  /^worktree /{p=substr($0,10)} /^branch /{if(substr($0,8)==b) print p}' \
              | head -1)"
  if [ -n "$existing" ] && [ -d "$existing" ]; then echo "$existing"; return 0; fi
  if [ -d "$wt" ]; then echo "$wt"; return 0; fi

  # A rehearsal must leave nothing behind — no worktree, no branch.
  if [ "$DRY" = 1 ]; then
    say "DRY    would create a worktree at $wt on $branch ($new)"
    echo "$wt"; return 0
  fi

  if [ "$new" = new ]; then
    git -C "$ROOT" fetch origin "$BASE" --quiet
    git -C "$ROOT" worktree add -b "$branch" "$wt" "origin/$BASE" --quiet 2>/dev/null
  else
    git -C "$ROOT" fetch origin "$branch" --quiet
    # -B so the local branch is created or reset to the remote tip, and the
    # worktree is always ON a branch that can be pushed.
    git -C "$ROOT" worktree add -B "$branch" "$wt" "origin/$branch" --quiet 2>/dev/null
  fi
  [ -d "$wt" ] && echo "$wt"
}

worktree_drop() {
  local wt; wt="$(worktree_path "$1")"
  [ -d "$wt" ] || return 0
  git -C "$ROOT" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
}

# ----------------------------------------------------------------- merging ----
# The shell merges. No model can reach this, by construction.
merge_pr() {
  local pr="$1" title="$2" branch="$3" base="$4"

  if [ "$base" != "$BASE" ]; then
    say "REFUSED merging #$pr — base is '$base', not '$BASE'"
    return 1
  fi
  if [ "${branch#"$BRANCH_PREFIX"}" = "$branch" ]; then
    say "REFUSED merging #$pr — branch '$branch' is not a $BRANCH_PREFIX branch"
    return 1
  fi

  # Re-checked here rather than trusted from the listing: this is the one
  # irreversible step, and it is worth one extra API call to be sure.
  local who
  who="$(gh_q pr view "$pr" -R "$REPO" --json author --jq '.author.login')"
  if [ "$who" != "$TRUSTED_AUTHOR" ]; then
    say "REFUSED merging #$pr — author is '${who:-unknown}', not '$TRUSTED_AUTHOR'"
    return 1
  fi

  if [ "$DRY" = 1 ]; then say "DRY    would merge #$pr into $base"; return 0; fi

  if gh_q pr merge "$pr" -R "$REPO" --squash --delete-branch --subject "$title (#$pr)"; then
    say "MERGED #$pr  $title"
    # The coder recorded the next task in its PR body; the shell just copies it.
    local next
    next="$(gh_q pr view "$pr" -R "$REPO" --json body \
            --jq '.body' | sed -n 's/^ *Next-Cursor: *\([A-Za-z0-9._-]*\).*/\1/p' | head -1)"
    if [ -n "$next" ]; then
      echo "$next" > "$CURSOR"
      say "cursor -> $next"
    fi
    worktree_drop "$branch"
    rm -f "$ATTEMPTS/$pr" "$ATTEMPTS/$pr.runs"
    return 0
  fi
  say "merge of #$pr was refused by GitHub — leaving it"
  return 1
}

# ------------------------------------------------------------ the coder ----
start_coder() {
  local task wt slug branch
  task="$(tr -d ' \r\n' < "$CURSOR")"
  [ -n "$task" ] || { say "cursor is empty — nothing to do"; return 1; }

  slug="$(echo "$task" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-*$//')"
  branch="${BRANCH_PREFIX}${slug}"

  lock_take "coder-$slug" || return 1
  wt="$(worktree_for "$branch" new)"
  if [ -z "$wt" ]; then
    say "could not make a worktree for $branch"
    lock_free "coder-$slug"; return 1
  fi

  run_worker coder "$MODEL_CODER" "$wt" "$PROMPTS/coder.md" \
"## Your assignment
Repository: $REPO
Task from the cursor: **$task**
Branch (already checked out for you): $branch
Base branch for the PR: $BASE" "$task"

  lock_free "coder-$slug"
}

# --------------------------------------------------------- one open PR ----
handle_pr() {
  local pr="$1" branch="$2" draft="$3" mergeable="$4" title="$5" base="$6"
  local ci threads blocking total_threads total_reviews last_commit wt tries

  tries="$(attempts_of "$pr")"
  ci="$(pr_ci "$pr")"
  threads="$(pr_threads "$pr")"
  IFS=$'\t' read -r blocking total_threads total_reviews last_commit <<< "$threads"
  blocking="${blocking:-0}"; total_threads="${total_threads:-0}"
  total_reviews="${total_reviews:-0}"

  local draft_note=""
  [ "$draft" = true ] && draft_note=" [draft]"
  say "look   #$pr  ci=$ci threads=$blocking/$total_threads reviews=$total_reviews tries=$tries$draft_note"

  # --- given up on already -------------------------------------------------
  # Both things a fixer is called for count. A fixer that disputes a review
  # thread it cannot address leaves CI green and the thread live, and without
  # the second clause it would be relaunched every tick forever.
  if [ "$tries" -ge "$MAX_FIX_ATTEMPTS" ]; then
    if [ "$ci" != GREEN ]; then
      mark_stuck "$pr" "still not green after $tries fix attempts"
      return 0
    fi
    if [ "$blocking" -gt 0 ]; then
      mark_stuck "$pr" "$blocking review thread(s) unaddressed after $tries fix attempts"
      return 0
    fi
  fi

  # --- a conflict, or red CI ----------------------------------------------
  if [ "$ci" = FAIL ] || [ "$mergeable" = CONFLICTING ]; then
    if [ "$ci" = FAIL ]; then
      # This repo's commonest CI failures are environmental, not code:
      # the Windows -race runtime fault, the lint schema fetch, the apt hang.
      # Rerun once before spending a session on them.
      local rid fresh=0
      for rid in $(pr_failed_runs "$pr"); do
        if ! retried_already "$pr" "$rid"; then
          retried_mark "$pr" "$rid"; fresh=1
          if [ "$DRY" = 1 ]; then say "DRY    would rerun failed jobs of run $rid on #$pr"
          else gh_q run rerun "$rid" -R "$REPO" --failed >/dev/null && say "rerun  #$pr  run $rid (likely a known flake)"; fi
        fi
      done
      [ "$fresh" = 1 ] && return 0
    fi

    lock_take "$pr" || return 0
    wt="$(worktree_for "$branch" existing)"
    if [ -n "$wt" ]; then
      attempts_bump "$pr"
      run_worker fixer "$MODEL_FIXER" "$wt" "$PROMPTS/fixer.md" \
"## Your assignment
Repository: $REPO
Pull request: #$pr — $title
Branch (already checked out for you): $branch
Why you were called: CI is $ci, mergeable is $mergeable.
Read the failing job logs with: gh run view --log-failed
This is fix attempt $(attempts_of "$pr") of $MAX_FIX_ATTEMPTS." "pr$pr"
    else
      say "could not make a worktree for #$pr"
    fi
    lock_free "$pr"
    return 0
  fi

  # --- somebody is waiting on an answer -----------------------------------
  if [ "$blocking" -gt 0 ]; then
    lock_take "$pr" || return 0
    wt="$(worktree_for "$branch" existing)"
    if [ -n "$wt" ]; then
      attempts_bump "$pr"
      run_worker fixer "$MODEL_FIXER" "$wt" "$PROMPTS/fixer.md" \
"## Your assignment
Repository: $REPO
Pull request: #$pr — $title
Branch (already checked out for you): $branch
Why you were called: $blocking review thread(s) are unresolved and still
apply to the current code. Read them with:
  gh api graphql -f query='query{repository(owner:\"${REPO%%/*}\",name:\"${REPO##*/}\"){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body}}}}}}}'
Do not resolve threads yourself — reply, fix, and let the reviewer resolve." "pr$pr"
    fi
    lock_free "$pr"
    return 0
  fi

  # Nothing below this line acts on a PR whose checks have not finished.
  if [ "$ci" = PENDING ] || [ "$ci" = NONE ]; then
    return 0
  fi

  # --- a draft nobody is working on = a coder that died --------------------
  if [ "$draft" = true ]; then
    local seen; seen="$(counter_bump "draft-$pr")"
    if [ "$seen" -ge "$STALE_DRAFT_TICKS" ]; then
      lock_take "$pr" || return 0
      wt="$(worktree_for "$branch" existing)"
      if [ -n "$wt" ]; then
        counter_zero "draft-$pr"
        run_worker coder "$MODEL_CODER" "$wt" "$PROMPTS/coder.md" \
"## Your assignment
Repository: $REPO
You are RESUMING abandoned work on pull request #$pr — $title
Branch (already checked out for you): $branch
Read the '## Progress' block in the PR description first — a previous coder
wrote it for you:  gh pr view $pr --json body
Continue from 'Next'. Do not redo what 'Done' lists. Honour 'Decided'." "pr$pr"
      fi
      lock_free "$pr"
    fi
    return 0
  fi

  # --- green, but nobody has said a word ----------------------------------
  if [ "$total_threads" = 0 ] && [ "$total_reviews" = 0 ]; then
    lock_take "$pr" || return 0
    wt="$(worktree_for "$branch" existing)"
    if [ -n "$wt" ]; then
      run_worker reviewer "$MODEL_REVIEWER" "$wt" "$PROMPTS/reviewer.md" \
"## Your assignment
Repository: $REPO
Pull request: #$pr — $title
Branch (already checked out for you): $branch
Read the diff with: gh pr diff $pr" "pr$pr"
    fi
    lock_free "$pr"
    return 0
  fi

  # --- green, clean, and quiet: merge it ----------------------------------
  if [ -n "$last_commit" ]; then
    local age=$(( ($(date -u +%s) - $(date -u -d "$last_commit" +%s 2>/dev/null || echo 0)) / 60 ))
    if [ "$age" -lt "$MERGE_QUIET_MINUTES" ]; then
      say "hold   #$pr  green but only ${age}m old — giving reviewers time"
      return 0
    fi
  fi
  merge_pr "$pr" "$title" "$branch" "$base"
}

# -------------------------------------------------------------- the tick ----
tick() {
  local rows rc any_open=0

  # Sweep up branches whose PR has closed since we last looked.
  local br
  while read -r br; do
    [ -n "$br" ] || continue
    case "$(gh_q pr list -R "$REPO" --state all --head "$br" --limit 1 --json state --jq '.[0].state')" in
      MERGED|CLOSED) worktree_drop "$br"; say "cleaned up the worktree for $br" ;;
    esac
  done < <(git -C "$ROOT" worktree list --porcelain 2>/dev/null \
           | sed -n "s#^branch refs/heads/\(${BRANCH_PREFIX}.*\)#\1#p")

  # `--author` is the security boundary, not a convenience. This repository is
  # public: without it, anyone may open a PR from a branch called `auto/…`
  # against `dev`, and the loop would run a permission-bypassed model over
  # their code and then merge it.
  rows="$(gh pr list -R "$REPO" --state open --base "$BASE" --author "$TRUSTED_AUTHOR" --limit 30 \
          --json number,headRefName,isDraft,mergeable,title,baseRefName,author,labels \
          --jq '.[] | select(.headRefName | startswith("'"$BRANCH_PREFIX"'"))
                | select([.labels[]?.name] | index("'"$STUCK_LABEL"'") | not)
                | select(.author.login == "'"$TRUSTED_AUTHOR"'")
                | [.number,.headRefName,(.isDraft|tostring),.mergeable,.baseRefName,.title] | @tsv' 2>/dev/null)"
  rc=$?

  # An empty list and a failed call look identical. Treating a network or auth
  # blip as "no PRs open" would start a second coder on top of a live one.
  if [ "$rc" -ne 0 ]; then
    say "could not list PRs (gh exit $rc) — skipping this tick rather than guessing"
    return 0
  fi

  while IFS=$'\t' read -r n branch draft mergeable base title; do
    [ -n "${n:-}" ] || continue
    any_open=1
    if [ "$(workers_busy)" -ge "$MAX_WORKERS" ]; then
      say "at the worker limit — #$n waits for the next tick"
      continue
    fi
    # A subshell: one broken PR must not take the loop down with it.
    ( handle_pr "$n" "$branch" "$draft" "$mergeable" "$title" "$base" )
  done <<< "$rows"

  # One coder task at a time. Roadmap tasks share schema and audit contracts,
  # so two coders would produce colliding migrations.
  if [ "$any_open" = 0 ]; then
    say "no open $BRANCH_PREFIX PRs — starting the next roadmap task"
    start_coder
  fi
}

# -------------------------------------------------------------- the loop ----
# selftest.sh sources this file to exercise the classifier, and must not
# start polling when it does.
if [ "${AUTO_LOOP_SOURCED:-0}" = 1 ]; then return 0; fi

say "auto-loop up — repo=$REPO base=$BASE author=$TRUSTED_AUTHOR window=${WINDOW_START}:00-${WINDOW_END}:00 dry=$DRY"
say "cursor is at $(cat "$CURSOR")"

while true; do
  if [ -f "$STOP" ]; then say "STOP file found — shutting down"; exit 0; fi

  # Read back from disk: the workers that increment these run in subshells.
  if [ "$(counter_get sessions)" -ge "$MAX_SESSIONS" ]; then
    say "session cap ($MAX_SESSIONS) reached — done for the night"; exit 0
  fi
  if [ "$(counter_get failures)" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
    say "$(counter_get failures) workers failed in a row — stopping, see $LOGS"; exit 1
  fi

  if [ "$DRY" = 1 ] || [ "$ONCE" = 1 ] || in_window; then
    tick
  else
    say "outside the run window — idling"
  fi

  if [ "$DRY" = 1 ] || [ "$ONCE" = 1 ]; then
    say "single pass complete"; exit 0
  fi
  sleep "$POLL_SECONDS"
done
