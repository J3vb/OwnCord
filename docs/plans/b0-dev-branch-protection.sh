#!/usr/bin/env bash
# G-03 / RL-14: make `dev` PR-only so every integration commit gets CI.
#
# Today `.github/workflows/ci.yml` triggers on `push: [main]` and
# `pull_request: [main, dev]`. A direct push to `dev` with no open PR runs
# nothing at all — which is why the audited head 5cc08889 has no CI evidence.
# Requiring a PR routes every dev commit through the existing pull_request
# trigger, with no workflow change and no duplicated runs.
#
# Run this yourself: Claude Code's sandbox blocks repo-settings writes.
#   bash docs/plans/b0-dev-branch-protection.sh
#
# Choices worth knowing:
#   required_approving_review_count: 0
#       A PR is required, but you can merge your own without a second person.
#       Anything above 0 would lock a solo maintainer out entirely.
#   enforce_admins: true
#       Applies to you too. With `false` an admin silently bypasses the PR
#       requirement, which on a solo-admin repo makes the whole guard
#       decorative. Toggle it off any time if you need an emergency push.
#   required_status_checks
#       Pinned 2026-08-25 (HP-0 step 2). The names below were read off a live
#       dev-targeted PR with `gh pr checks <n>`, NOT inferred from ci.yml --
#       three of them exist in no workflow file at all, because CodeQL runs
#       from GitHub default setup configured in repository settings.
#
#       Repository Hygiene added 2026-08-26 (B1-3). Same rule: the name was read
#       off PR #1414 after the job reported `pass`, not copied out of ci.yml.
#       This is the half of S-05 that makes the gate a gate -- a check that is
#       present but unpinned lets a formatting regression merge.
#
#       Docs & Ledger Consistency added 2026-08-27 (B1-6). Name read off PR #1418
#       after the job reported `success`. Unpinned it was harmless while the job
#       only validated the ledger's JSON schema. B1-6 made it also reject a
#       ledger that fails to render, and L-07's closure evidence is "CI rejects
#       generation failure or drift" -- rejecting requires pinning.
#
#       Deliberately NOT pinned, and why:
#         Server Docker Build (verify)  reports "skipping" on a dev PR
#                                       (if: ref_name=='main' || base_ref=='main')
#         Tauri Full Build (...)        reports "skipping" on a dev PR, under the
#                                       UNEXPANDED matrix name -- the job is
#                                       skipped before matrix expansion
#         Admin Panel E2E               continue-on-error: true, so it reports
#                                       success unconditionally; requiring it is
#                                       theatre (that is R-01, B10 work)
#         CodeQL                        default-setup aggregate over the three
#                                       Analyze jobs; pinning those is enough
#
#       A required check that never reports blocks every PR forever. Re-read the
#       list before changing it:
#           gh pr checks <a recent dev PR>
#
# To undo:
#   gh api -X DELETE repos/J3vb/OwnCord/branches/dev/protection
set -euo pipefail

REPO="${REPO:-J3vb/OwnCord}"

gh api -X PUT "repos/${REPO}/branches/dev/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Server Build & Test (ubuntu-latest)",
      "Server Build & Test (windows-latest)",
      "Client Static Checks",
      "Client Unit Tests",
      "Rust Unit Tests",
      "Repository Hygiene",
      "Docs & Ledger Consistency",
      "Client E2E (Playwright)",
      "Client E2E (parity subset, blocking)",
      "Analyze (go)",
      "Analyze (javascript-typescript)",
      "Analyze (actions)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "required_linear_history": false
}
JSON

echo
echo "Applied. Verifying:"
gh api "repos/${REPO}/branches/dev/protection" -q '
  "  PR required:      " + ((.required_pull_request_reviews != null)|tostring),
  "  approvals needed: " + (.required_pull_request_reviews.required_approving_review_count|tostring),
  "  applies to admins:" + (.enforce_admins.enabled|tostring),
  "  force pushes:     " + (.allow_force_pushes.enabled|tostring),
  "  required checks:  " + ((.required_status_checks.contexts // []) | length | tostring)'
