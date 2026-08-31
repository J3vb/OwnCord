#!/usr/bin/env bash
# Integration evidence for a dev squash commit (G-03 as amended 2026-08-31).
#
# dev is squash-merge-only and its pushes deliberately run no ci.yml matrix
# (the pull_request trigger already ran it on the PR head), so the squash
# commit itself carries only CodeQL runs. What makes the PR-head evidence
# transfer to the squash commit is required_status_checks.strict: an
# up-to-date PR's head names the same tree the squash commit lands. This
# script turns that construction into a per-commit statement a phase-exit or
# hold-point evidence block can cite as a command with output, instead of an
# assumption:
#
#   bash scripts/verify-integration-tree.sh <squash-sha> [<squash-sha>...]
#
# For each squash commit: parse the pull-request number from the "(#N)"
# subject suffix every squash merge carries, fetch refs/pull/N/head from
# origin, and assert both commits name the same git tree. Exits non-zero if
# any commit fails. Needs network access to origin; verify-gate-evidence.mjs
# --selftest is what keeps the strict flag itself pinned.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: bash scripts/verify-integration-tree.sh <squash-sha> [<squash-sha>...]" >&2
  exit 2
fi

fail=0
for sha in "$@"; do
  if ! subject=$(git log -1 --format=%s "$sha" 2>/dev/null); then
    echo "FAIL ${sha}: unknown commit (fetch the branch that carries it first)" >&2
    fail=1
    continue
  fi
  if [[ "$subject" =~ \(#([0-9]+)\)$ ]]; then
    pr="${BASH_REMATCH[1]}"
  else
    echo "FAIL ${sha}: subject does not end in (#N), so it is not the squash of a PR: ${subject}" >&2
    fail=1
    continue
  fi
  git fetch -q --no-tags origin "refs/pull/${pr}/head"
  head_tree=$(git rev-parse "FETCH_HEAD^{tree}")
  squash_tree=$(git rev-parse "${sha}^{tree}")
  if [ "$head_tree" = "$squash_tree" ]; then
    echo "PASS ${sha} (PR #${pr}): squash tree == PR head tree ${head_tree}"
  else
    echo "FAIL ${sha} (PR #${pr}): squash tree ${squash_tree} != PR head tree ${head_tree} — the merged tree was never CI-tested as-is" >&2
    fail=1
  fi
done
exit "$fail"
