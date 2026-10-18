# no-mistakes in Claude cloud sessions

The optional `.claude/skills/ship-cloud/SKILL.md` adapter runs no-mistakes inside
the same Linux cloud session that authored an OwnCord change. The old Firstmate
VM and its daemon are not required. Nothing is installed automatically at
session startup, and local Windows work is unaffected.

Run `node scripts/no-mistakes-cloud.mjs --setup`, then
`node scripts/no-mistakes-cloud.mjs --intent-file <private intent file>` after
committing on a feature branch. PRs target `dev`. The pinned release is v1.84.0
(source `4822244e763fd4c3d7f48be6433f92df10bb5b33`); the archive is checked against
its published SHA-256 before extracting its one executable. Upgrading the pin
and checksum requires a reviewed change.

The adapter supplies `--no-publish-intent`: the private input file is not
permission to publish the user's full request. Generated public PR summaries
still need to follow the repository's neutral security-wording policy.

Prerequisites are x64 Linux, `CLAUDE_CODE_REMOTE=true`, GitHub CLI authentication,
and an authenticated Claude CLI that the cloud session may launch. Codex CLI is
neither invoked nor required by this adapter. A
Claude Projects subscription/session does not itself prove that a child CLI can
authenticate. Setup runs the pinned binary's `doctor` before initialization.
Confirm an actual cloud session completes validation before treating this as a
working author-side integration. The beta cloud runtime was not accessible for
an end-to-end test when this adapter was prepared.

The adapter gives no-mistakes its own short temporary `NM_HOME`, avoiding Unix
socket path-length problems and preserving the user's existing global profile.
It sets `agent: [claude]`, allows three eligible repair attempts, and
sets `ci.revalidate_repairs: true`. Repo settings are resolved by no-mistakes'
normal trusted-default-branch rules; `--base-branch dev` is supplied explicitly.
Codex review happens on the published GitHub PR through `@codex review`, not
inside the cloud session. The shipping skill requests review once per final
head, avoiding requests when that head already has a running/completed review.
The separately deployed GitHub controller handles Codex quota or missing results
with Claude review; the cloud adapter does not switch to Codex CLI.

An older Codex-enabled temporary profile is rejected for setup and execution.
Finish or inspect its active pipeline using the matching older adapter first;
then start a fresh cloud session and set up the Claude-only profile. Existing
profile contents and active daemon state are never silently overwritten.

Each call waits at most sixty seconds. Use `--status` and `--reattach` to drive
an active run. The adapter never supplies blanket `--yes` consent: the bounded
`auto_fix` profile owns eligible corrections, and ask-user findings must be
escalated. It is not authority to override weakened tests or a policy exception. The adapter
exposes no skip or blanket approval option. The upstream skill installed by
`init` owns the detailed gate protocol.

Use `--fix-findings <ids>` for an eligible correction or an explicitly
authorized fix. The adapter keeps the isolated binary on the daemon/worker
PATH; gate responses should use this adapter rather than a global installation.

The daemon is session-local. GitHub Actions remains the authoritative durable CI
service, and the separately deployed App review controller owns automated final
integration. A PR-body no-mistakes attestation is useful provenance but cannot
replace its authenticated checks. Do not point a required check solely at a
public attestation an author can edit.

This integration and the controller can be reviewed independently. Neither PR
enables live branch-protection changes. The cloud authoring adapter should be
enabled through project instructions after its prerequisites are confirmed;
the controller needs its one-time App installation and shadow deployment.
