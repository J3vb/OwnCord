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
#   required_status_checks: null
#       Deliberately not set yet. Requiring check names that never report
#       deadlocks every PR, so pin them only after confirming the exact job
#       names from a green run:
#           gh api repos/J3vb/OwnCord/commits/dev/check-runs \
#             -q '.check_runs[].name'
#
# To undo:
#   gh api -X DELETE repos/J3vb/OwnCord/branches/dev/protection
set -euo pipefail

REPO="${REPO:-J3vb/OwnCord}"

gh api -X PUT "repos/${REPO}/branches/dev/protection" --input - <<'JSON'
{
  "required_status_checks": null,
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
  "  force pushes:     " + (.allow_force_pushes.enabled|tostring)'
