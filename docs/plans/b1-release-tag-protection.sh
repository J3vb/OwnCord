#!/usr/bin/env bash
# R-09 / RL-16, second limb: make a release tag hard to create by accident, and
# put a human between a green tag and a published artifact.
#
# B1-7 landed the first limb in the workflow itself: `gate-evidence` in
# release.yml refuses to build or publish unless every required check was green
# on the exact tagged commit. That closes the "published from a red commit"
# hole — v1.2.0-alpha.3 really did ship from a commit whose
# `Server Build & Test (windows-latest)` had failed.
#
# What a workflow file cannot do is stop the tag existing, or require a person
# to approve the publish. Both are repository settings. That is this script.
#
# Run this yourself: Claude Code's sandbox blocks repo-settings writes.
#   bash docs/plans/b1-release-tag-protection.sh
#
# Choices worth knowing:
#   Two independent controls, deliberately.
#       The ruleset stops a tag appearing by mistake. The environment stops a
#       tag that does exist from publishing without a person. Either alone
#       leaves a gap: a ruleset does not review, and an environment does not
#       prevent a bad tag from starting three build jobs first.
#   Ruleset, not the legacy tag-protection endpoint.
#       `repos/{owner}/{repo}/tags/protection` is deprecated. Rulesets are the
#       supported form and can additionally block update and delete, which
#       matters here: the Release workflow's own concurrency comment records a
#       tag being deleted and re-pushed, so "the tagged commit" has not always
#       been a stable referent.
#   bypass_actors: [] — nobody bypasses, including you.
#       Same reasoning as enforce_admins in b0-dev-branch-protection.sh. On a
#       solo-admin repo a bypass makes the guard decorative. Add yourself back
#       temporarily if a release genuinely needs it; that is a deliberate act
#       rather than a silent default.
#   The `release` environment has NO wait timer.
#       The point is a person looking, not a delay. A timer without a reviewer
#       is theatre; a reviewer without a timer is the control.
#
# AFTER RUNNING THIS, one more edit is needed and it is NOT done here:
#   add `environment: release` to the `release-server-docker` and `publish`
#   jobs in .github/workflows/release.yml. That is deliberately left out of
#   B1-7 — an `environment:` key naming an environment that does not exist yet
#   stalls the next release. Create the environment first, then add the key.
#
# To undo:
#   gh api -X DELETE "repos/J3vb/OwnCord/rulesets/<id>"   # id from the list call below
#   gh api -X DELETE "repos/J3vb/OwnCord/environments/release"
set -euo pipefail

REPO="${REPO:-J3vb/OwnCord}"
OWNER="${REPO%%/*}"

# ── 1. Protect refs/tags/v* ──────────────────────────────────────────────────
# creation is allowed (you still need to cut releases); update and deletion are
# not, so a published tag cannot be quietly re-pointed at a different commit.
gh api -X POST "repos/${REPO}/rulesets" --input - <<'JSON'
{
  "name": "Release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "update" },
    { "type": "deletion" }
  ]
}
JSON

# ── 2. A reviewed environment for the publishing jobs ────────────────────────
# Required reviewers gate the job at the point it would push to GHCR or create
# the Release — after the gate-evidence job has already proved the commit is
# green, so the reviewer is confirming intent, not re-checking CI.
gh api -X PUT "repos/${REPO}/environments/release" --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [
    { "type": "User", "id": $(gh api "users/${OWNER}" -q .id) }
  ],
  "deployment_branch_policy": null
}
JSON

echo
echo "Applied. Verifying:"
gh api "repos/${REPO}/rulesets" -q '
  .[] | select(.name == "Release tags") |
  "  ruleset:          " + .name + " (" + .enforcement + ", target " + .target + ")"'
gh api "repos/${REPO}/environments/release" -q '
  "  environment:      " + .name,
  "  reviewers:        " + ((.protection_rules[]? | select(.type=="required_reviewers") | .reviewers | length) // 0 | tostring),
  "  wait timer:       " + ((.protection_rules[]? | select(.type=="wait_timer") | .wait_timer) // 0 | tostring)'
echo
echo "Next: add 'environment: release' to release-server-docker and publish in"
echo ".github/workflows/release.yml. Not before — the key stalls a release if"
echo "the environment does not exist."
