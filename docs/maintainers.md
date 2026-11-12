# Maintainer guide

For the people who cut releases. Everyone else wants
[Contributing](contributing.md).

The Linux checks every release must pass are in the
[Linux release checklist](linux-release-checklist.md).

## Fix-only period (2.9.x)

From 2.9.0 until the owner says the beta label can go, `main` takes **only
fixes**. Releases in this period are patch releases cut from `main`: 2.9.1,
2.9.2 and so on. `dev` keeps taking features as usual, but no `dev` → `main`
feature release happens until the owner gives the go. The owner's server runs
the 2.9.x line for two weeks before that decision.

What counts as a fix:

- a change that makes a shipped feature work as it should;
- a security fix (neutral wording, as everywhere else);
- a change the release pipeline needs to publish a patch release, such as a
  supply-chain scan baseline entry for an advisory published after 2.9.0;
- a dependency update that closes a security advisory.

What does not: new features, new settings, refactors, new database migrations,
protocol changes and test-only or tooling work. If a fix cannot be made without
a migration or a protocol change, the owner decides whether it goes on `main`.

Every fix lands on `dev` first, as a normal PR. The same change then goes to
`main` in the next patch release (see
[Patch release from `main`](#patch-release-from-main)). So a fix is made twice;
the `main` copy is a cherry-pick of the `dev` commit, not a new version of it.

## Release procedure

This is the end-to-end procedure for cutting a feature release from `dev`.
During the [fix-only period](#fix-only-period-29x) use
[Patch release from `main`](#patch-release-from-main) instead. Every step runs on
`main` or against it. The order matters, because the release workflow
(`release.yml`) stops on any missing input. In the examples below,
`vX.Y.Z` stands for the version you are releasing. From 2.5.0 on, versions
carry no `-beta.N` suffix: a release with new features bumps the minor number,
a fixes-only release bumps the patch number. The project is still a beta; the
release notes say so.

1. **Reconcile `main` into `dev` first, if the last release was squashed.**
   A release PR that was squash-merged makes `dev` and `main` drift apart. You
   can tell because `git merge-tree origin/main origin/dev` reports conflicts.
   Fix it with a real merge commit that has `main` as a parent, not a squash.
   Earlier examples: #1425 and #1809.

2. **Set the same version in the three client manifests.**
   - `Client/src-tauri/tauri.conf.json` (`version`)
   - `Client/package.json` (`version`)
   - `Client/src-tauri/Cargo.toml` (`version`)

   `release.yml`'s `verify-versions` job compares each one with the tag. Any
   mismatch fails the whole run. Make this edit at release time, not earlier.

3. **Write the release notes under the tag heading in `CHANGELOG.md`.**
   `release.yml` finds the `## vX.Y.Z` heading (a title may follow the
   tag) and copies everything up to the next `## ` heading. If that section is
   missing or empty, it stops the publish. Normally you rename
   `## Unreleased` to the tag, then start a fresh `## Unreleased` above it.

   **This section becomes the GitHub release page, word for word.** Nothing
   rewrites it, so write it for end users:
   - one short paragraph saying what this release gives them;
   - then **Highlights**, **Added**, **Changed**, **Fixed** and
     **Known issues**, in plain language, without walls of PR numbers;
   - internal, CI and test-only changes in a short **Under the hood** list at
     the end.

   The "How to write an entry" rules in `CHANGELOG.md` still apply. One early
   beta's release page had to be rewritten after publishing because its
   section was internal prose. This step stops that from happening again.

   **Record the release in [`docs/STATUS.md`](STATUS.md)** in the same PR.
   Update "Current release" and add a row to its Releases table.
   `release.yml`'s `release-status` job refuses a version with no row there.
   Docs & Ledger Consistency also fails a PR whose client version has no row.

4. **Update user-facing status text if it changed.** If the release changes
   what platforms are published or the project stage, update the platform
   table in `docs/quick-start.md` and the status wording in the README badge
   and text, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md` and `docs/summaries/product.md`. The
   hobby-project disclaimer stays.

5. **Open the release PR from `dev` into `main`.** Every CI job runs on a PR
   into `main`, because a skipped check would block the release. This is the
   first full Tauri build of the frozen tree.

6. **Merge the release PR with a merge commit.** Squash-merging `dev` into
   `main` causes the drift from step 1 at every release. A merge commit keeps
   `dev` and `main` sharing history. Squash is still the rule for PRs into
   `dev`.

7. **Run the Linux checklist and check the nightly, then tag on `main`.** Cut the tag (`vX.Y.Z`) on
   the merge commit.
   - The release ruleset forbids deleting a tag. So a failed first run costs
     you the next version number, not a rewrite.
   - The release is a **full release**, not a pre-release. `gh release create`
     runs without `--prerelease`, so existing servers' `/releases/latest`
     updater still sees it.
   - Before tagging, check that the latest nightly `upgrade-rehearsal.yml` run
     is green. `release.yml`'s `nightly-drills` job refuses the release if the
     latest scheduled run is not `success` or is more than 72 hours old. The
     release's own rehearsal skips the failure and recovery drills, so the
     nightly is the only place they run.
   - Before tagging, the [Linux release checklist](linux-release-checklist.md)
     must pass on all three sessions: X11, GNOME Wayland (48 or newer) and KDE
     Plasma Wayland. If any item fails on any session, do not tag. Keep the
     filled-in tables with the release PR.
   - Emergency override: set the `RELEASE_ALLOW_RED_NIGHTLY` repository
     variable to `true` before tagging, and remove it afterwards. A dry run
     uses the `allow_red_nightly` input instead. The job then passes with a
     warning. Only scheduled runs count, so after a fix for a red nightly
     merges, wait for the next nightly rather than using the override.

8. **Approve the two `environment: release` stops.** The
   `release-server-docker` and `publish` jobs each wait for the required
   reviewer. Record who approved and when. Nothing is pushed to `ghcr.io` or
   published until both pass.

9. **Verify the published files from another machine.** Run the
   [Verifying a download](hosting/reference.md#verifying-a-download) commands from a
   machine that is not the CI runner: checksums, minisign on the server
   files, and `gh attestation verify` for the files and the container image.
   - The Windows client installers are **unsigned**. Code signing was declined
     for the beta. So first launch shows the SmartScreen "Windows protected
     your PC" prompt, and the quick-start note covers it for users.
   - The server files and every provenance and SBOM attestation are still
     signed and must verify.

Two rules are easy to get wrong, so they are written down here on purpose:

- `dev` → `main` release PRs use a **merge commit** (step 6).
- The release is a **full release, not a pre-release** (step 7).

A major version bump does not change protocol compatibility. Compatibility is
keyed on `protocol_epoch` in `protocol/schema.json` (still **1**), never on the
version string. So a `2.x` client speaks the same epoch as the
`1.2.0-alpha.*` releases, and the epoch-1 fixtures keep replaying.

Background: the merge-commit and full-release rules are owner decisions D-13
and D-14, and the unsigned installers are decision D-08.

### Patch release from `main`

A patch release ships fixes that are already on `dev`, without anything else
from `dev`. It is cut from `main`, never from `dev`. Steps 7 to 9 of the
release procedure above (Linux checklist and nightly, tag, the two approvals,
verifying the files) apply unchanged; what differs is how the commit you tag
is made.

1. **Land each fix on `dev` first.** A normal PR into `dev`, squash merged.
   Note the squash commit; that is what goes to `main`.

2. **Cut a release branch from `main`.**

   ```
   git fetch origin main
   git switch -c release/vX.Y.Z origin/main
   git cherry-pick -x <dev squash commit>   # once per fix, oldest first
   ```

   `-x` records which `dev` commit each one came from. If a cherry-pick does
   not apply cleanly because `dev` has moved on, adapt it by hand and keep the
   change to what the fix needs. A `CHANGELOG.md` conflict is expected: put the
   fix's line under `## Unreleased` on this branch.

3. **Add the release commit on the same branch.** Exactly as in steps 2 and 3
   of the release procedure: the version in the three client manifests,
   rename `## Unreleased` to `## vX.Y.Z` in `CHANGELOG.md` and write it for end
   users (a patch release is usually a short **Fixed** list plus
   **Known issues**), and a row for the version in `docs/STATUS.md`. Then
   refresh the changelog the admin panel shows:
   `cd Server && go test ./admin -run TestBundledChangelog -update-changelog`.

4. **Open a PR from `release/vX.Y.Z` into `main`.** A PR into `main` runs every
   CI job, including the full desktop builds, so this is the first full check
   of the patch. List the `dev` PRs it carries in the description. Merge it
   with a **merge commit**, like every PR into `main`.

5. **Wait for `main`'s own CI on the merge commit, then dry run.** The push to
   `main` runs the full CI again on the merge commit, and release.yml's
   `gate-evidence` job only accepts a commit that has a green push-to-`main`
   run for every required check. Tagging before that run finishes fails the
   release and costs the version number. Then dispatch release.yml on `main`
   with the version (no leading `v`) as a dry run.

6. **Tag the merge commit and publish** (steps 7 to 9 above).

7. **Bring `main` back into `dev`.** Open a PR from a branch off `dev` that
   merges `origin/main` with a real merge commit, as in step 1 of the release
   procedure. This carries the version bump, the `## vX.Y.Z` section and the
   `docs/STATUS.md` row to `dev`. The cherry-picked fixes are already on `dev`;
   where they conflict, keep `dev`'s side. Remove the shipped fixes' lines
   from `dev`'s `## Unreleased` so the next feature release does not list them
   again. Doing this after every patch release keeps the two branches from
   drifting, so the next `dev` → `main` release merges cleanly.

If a new advisory turns the supply-chain scan red on `main` before you tag, fix
it on the release branch (or a new one off `main`) through a PR into `main`,
and make the same change on `dev`.

### README screenshots

Before a release that changes what the app looks like, retake the README
images on the frozen `dev` head with `npm run screenshots:readme` (from
`Client/`) and land them in a PR to `dev` before the release PR. The run starts
a real server in a temporary folder, seeds a demo community through the normal
HTTP and WebSocket routes, and writes `Client.png`, `loginpage.png` and
`Admin_Panel.png` at 1440x900 in the default dark theme.

### Update signing keys

The desktop app and the server use separate update signing keys. A release
needs these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`

To rotate the server update key, update
[Server/updater/server_update_public_key.txt](../Server/updater/server_update_public_key.txt).
Roll it over in stages so running servers keep accepting updates.
