# Maintainer guide

For the people who cut releases. Everyone else wants
[Contributing](contributing.md).

The Linux checks every release must pass are in the
[Linux release checklist](linux-release-checklist.md).

## Release procedure

This is the end-to-end procedure for cutting a release. Every step runs on
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
