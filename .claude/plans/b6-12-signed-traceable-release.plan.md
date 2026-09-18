# Plan: B6-12 — Signed, traceable release inputs and outputs

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-12 — Signed, traceable release inputs and outputs (roadmap workstreams 11 and 15; audit rows R-07 and RL-18)
**Satisfies**: the HP-6 exit-gate line "Release inputs and outputs are traceable and signed" and its required evidence "SBOM, provenance, signatures, checksums, and source snapshot"; the PRD "Satisfied preconditions" sentence "B6-12 rehearses one tag against [`gate-evidence` and `environment: release`]; it does not build them"; and the 2026-09-11 decision that B6-1 stays `in-progress` until a tag run proves its three unchecked acceptance rows — that tag run is this milestone's rehearsal
**Complexity**: Medium
**Drafted**: 2026-09-15 at `dev` `96258158`; B6-10 (`feat/b6-10-operational-measurements`) and B6-11 (planned) are in flight. Neither touches `release.yml`, `Server/Dockerfile`, `.github/dependabot.yml` or `scripts/check-release-environment.mjs`; B6-11 edits `upgrade-rehearsal.yml`, which this plan only calls. `docs/deployment.md` lines are cited from the B6-10 working tree (dev + 5 lines after `:738`). Revised 2026-09-18 at `dev` `bfee436f`: owner decisions applied. B6-10 (PR #1601, merged 2026-09-16) and B6-11 (PR #1603, merged 2026-09-17; close-out #1613 on 2026-09-18) are both merged, so every line cite in this file was re-derived against `bfee436f`, and every outside value (image digests, action SHAs, tool versions) was re-resolved on 2026-09-18

**Executor rule**: Where this plan proposes a default for an open question, apply that default unless the owner has overridden it in this file. Where a step needs hardware, a human, a network, or a merged PR that is not available to you, do not guess and do not invent a value: mark the row `unverified`, state what was missing in the PR description, and continue with the next step. Never leave a `<placeholder>` in committed text.

## Summary

Most of what the roadmap row asks for already exists in some form and is
simply unsigned or unpinned. The release workflow already produces a source
snapshot, a checksum file and minisign signatures for the Windows binaries; the
gate and the reviewed environment already exist; every action is already
SHA-pinned and Dependabot already reviews every dependency root including
Docker and GitHub Actions. What is missing is narrow: the two container base
images float on tags, no SBOM is produced anywhere, nothing attests provenance,
and the checksum file and source tarball are published with nothing binding
them to the commit and the run that made them.

Everything here is **GitHub-native or already-installed tooling, and one tag
run**. Signing is Sigstore through GitHub's own attestation actions (OIDC, no
new key to hold), SBOMs come from the Go toolchain and BuildKit, and the
"rehearsed tag" is the next real alpha tag cut from `main` — the pipeline has
no dry-run, and a throwaway tag would go live to every auto-updating server
(see the refuted claim below).

The row's clauses, what is built for each, and the instrument:

| #   | Roadmap says                         | What is built                                                                                                                                                                                                                                                                                                                                                                                       | Instrument                                                                                    |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | containers pinned or auto-reviewed   | `golang:1.26-bookworm` and `gcr.io/distroless/static-debian12` pinned by `tag@sha256` so Dependabot's existing `docker` block bumps the digest; `livekit/livekit-server:v1` in compose pinned to the version the server itself downloads                                                                                                                                                            | `Server/Dockerfile`, `Server/docker-compose.yml`, a `docker-compose` Dependabot block         |
| 2   | build inputs pinned or auto-reviewed | Nine Dependabot blocks (seven today, plus the `docker-compose` and `rust-toolchain` ones this plan adds), every remote `uses:` SHA-pinned, lockfiles authoritative — recorded, not rebuilt. Rust is **pinned** by `Client/src-tauri/rust-toolchain.toml` and auto-reviewed; the Go patch **floats by owner decision** and is recorded in the SBOM, which names the Go version that built each asset | `.github/dependabot.yml`, `Client/src-tauri/rust-toolchain.toml`, the SBOM's `metadata.tools` |
| 3   | SBOM                                 | One CycloneDX document per server asset, produced by `cyclonedx-gomod` from the exact build; BuildKit's own SPDX SBOM attached to the pushed image                                                                                                                                                                                                                                                  | `go run …cyclonedx-gomod@v1.12.0` in `release-server`; `sbom: true` on the push               |
| 4   | provenance                           | GitHub build-provenance attestation (SLSA v1 predicate, Sigstore-signed with the run's OIDC identity) over every release asset and over the pushed image digest                                                                                                                                                                                                                                     | `actions/attest-build-provenance`, `gh attestation verify`                                    |
| 5   | checksums signed                     | `checksums.sha256` itself is an attestation subject — signing the file signs every hash in it, and the updater keeps reading the plain file unchanged                                                                                                                                                                                                                                               | same attestation step                                                                         |
| 6   | source snapshot signed               | `owncord-src-<tag>.tar.gz` (already produced by `git archive`) is an attestation subject                                                                                                                                                                                                                                                                                                            | same attestation step                                                                         |
| 7   | one tag rehearsed                    | The next alpha tag runs `gate-evidence`, waits at `environment: release` for the owner, publishes with attestations, and the run id + `gh attestation verify` output are recorded in the PRD; B6-1's three rows flip on the same evidence                                                                                                                                                           | `release.yml`, the PRD, `docs/deployment.md`                                                  |

**Nothing is claimed signed that `gh attestation verify` did not verify in
the run.** The publish job verifies its own attestations before
`gh release create`, the same fail-closed shape the minisign step already has.

## Verify before you implement

Facts established from source at `96258158`. Rows marked **Refuted**,
**Corrected** or **Unknown** contradict something the roadmap, the audit, the
PRD or an obvious first design would assume, and the plan is built on the
correction.

| Claim                                                                             | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A source snapshot has to be introduced                                            | **Refuted**   | `release.yml:656-660` already runs `git archive --format=tar.gz --prefix="OwnCord-${VERSION}/"` at `HEAD`; it is checksummed at `:670` and uploaded at `:782`. It is **unsigned** — nothing binds it to the run. "Signed source snapshot" is one more subject on the attestation, not a new artifact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Checksums exist and cover every asset                                             | **Confirmed** | `release.yml:665-670` — `sha256sum` over `windows/`, `linux/` and the source tarball, bare filenames (the v1.0.0 updater's exact-match rule, `:662-664`). Unsigned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Every release asset is signed today                                               | **Refuted**   | `release.yml:713-715` minisigns only `windows/chatserver*.exe` and `server-update-manifest.json`; the Linux archives are bound only through the manifest's sha256 (`:687-691`) and `checksums.sha256`; the client bundles carry Tauri updater `.sig`s (`:204-205`, `:392-393`). The source tarball and the checksum file have no signature of any kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Something in the repo produces an SBOM or provenance                              | **Refuted**   | Repo-wide grep for `sbom`, `provenance`, `attest`, `cosign`, `sigstore`, `syft`, `slsa`: only prose (roadmap, audit, PRD) and comments. No workflow declares `attestations:`; the only `id-token: write` is `claude.yml:52`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The container base images are pinned                                              | **Refuted**   | `Server/Dockerfile:8` `golang:1.26-bookworm`, `:38` `gcr.io/distroless/static-debian12` — tags only, exactly the RL-18 audit finding (`docs/audit-2026-08-23-repository-layout.md:105` "runtime/build containers use mutable tags"). Resolved 2026-09-15: `golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81`, `static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2`                                                                                                                                                                                                                                                                                                                                                                        |
| Dependabot does not cover Docker or GitHub Actions                                | **Refuted**   | `.github/dependabot.yml:65-83` `docker` on `/Server`; `:189-207` `github-actions`; gomod, three npm roots and cargo besides. B1-4 closed RL-18's automation half; only the mutable-tag half is open. A `tag@sha256` pin is what lets the `docker` block bump digests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The compose file's LiveKit image is reviewed by that `docker` block               | **Corrected** | `Server/docker-compose.yml:69` `livekit/livekit-server:v1` is a floating major tag (the plan drafted `:66`; `:69` is where it actually is), and GitHub documents `docker-compose` as its **own** package ecosystem, separate from `docker`. The server's own download pins `DefaultLiveKitVersion = "1.13.5"` (`Server/ws/livekit_download.go:32`, "bump deliberately with releases"); compose disagrees with it                                                                                                                                                                                                                                                                                                                                                                                                           |
| Every `uses:` is pinned by commit SHA                                             | **Confirmed** | 98 of the 99 `uses:` lines across `.github/workflows/*.yml` carry a 40-hex SHA plus a `# vX.Y.Z` comment; the one exception is the local `workflow_call` (`release.yml:500` `uses: ./.github/workflows/upgrade-rehearsal.yml`, same commit by construction); the one binary installed from a URL is checked by digest (`ci.yml:431-439`, actionlint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Build toolchains are pinned                                                       | **Corrected** | Go: `release.yml:261` `go-version: "1.26"` floats to the newest patch; `Server/go.mod:5` `toolchain go1.26.7` is a **floor**, not a pin. Rust: `dtolnay/rust-toolchain@… # stable` (`release.yml:97,164,355`) resolves whatever `stable` is that day; no `rust-toolchain.toml` existed at draft time. Neither is auto-reviewable. **Decided 2026-09-18:** Rust is pinned by `Client/src-tauri/rust-toolchain.toml` (`channel = "1.98.1"`, `components = ["clippy", "rustfmt"]`, no `targets` key — the union of the six `dtolnay/rust-toolchain` steps sets none), which rustup applies to every cargo invocation under `Client/src-tauri`, and a new `rust-toolchain` Dependabot block reviews it. Go stays floating, and the SBOM records the Go version actually used, which is what "traceable" can honestly mean here |
| Release binaries are the plain build                                              | **Confirmed** | `release.yml:277,284` and `Server/Dockerfile:21` build with no `-tags`; `-tags otel,wazero` variants exist only in CI (`ci.yml:130-136`). The SBOM therefore describes the shipped, plugin-less binary — which is the honest one to publish (B2-7 trust-model note)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gate-evidence` exists and reads the required set from one source                 | **Confirmed** | `release.yml:32-47`; `scripts/verify-gate-evidence.mjs:23-37` parses the `contexts` array out of `docs/plans/b0-dev-branch-protection.sh:61-77` (15 contexts); `skipped` is not success (`nightly-docker-smoke.yml:9-11`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `environment: release` gates every publishing job                                 | **Confirmed** | `release.yml:514` (`release-server-docker`), `:603` (`publish`); `scripts/check-release-environment.mjs:28` derives gated jobs from `push: true` / `gh release create`, run in the hygiene gate (`scripts/run.mjs:201-207`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| That guard would notice an attestation pushed to the registry from an ungated job | **Corrected** | `PUBLISH_MARKERS` at `check-release-environment.mjs:28` matches `^\s*push:\s*true` and `gh release create` only; `push-to-registry: true` (the attest action's input) matches neither. One marker and one test row close it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The tag ruleset prevents a bad tag                                                | **Corrected** | `docs/plans/b1-release-tag-protection.sh:52-72` blocks `update` and `deletion` of `refs/tags/v*`, **not creation** (`:53` "creation is allowed"). The environment's reviewer is the human gate (`:74-86`). A tag that exists always starts the build jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A rehearsal tag can be a throwaway                                                | **Refuted**   | `Server/updater/updater.go:226` polls `releases/latest`; `gh release create` at `release.yml:783` passes no `--prerelease`, so every `v*` release (all alphas so far: `git tag` → `v1.2.0-alpha.4` newest) is "latest" to every auto-updating server; `type=raw,value=latest` (`:546`) moves the Docker tag on every tag. **The rehearsed tag is the next real alpha**, not a `v0.0.0-rehearsal`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B6-1 has rows only a tag run can prove                                            | **Confirmed** | `.claude/plans/b6-1-standalone-release-assets.plan.md:220,223,224` — four assets build/smoke/upload; manifest and checksums cover all four; signed assets verify. PRD `:225-231` ties the flip to B6-12's tag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B6-2 left a digest question to B6-12                                              | **Confirmed** | `.claude/plans/b6-2-docker-images.plan.md:190` "a smoked digest ≠ pushed … B6-12 replaces this with a digest pin". The smoke builds with `load: true` (`release.yml:460-469`); the push rebuilds from the GHA cache (`:554-566`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The smoked image and the pushed image are byte-identical                          | **Unknown**   | Same commit, same cache scopes, but BuildKit stamps `created` into the image config, so the per-arch config digests differ across two builds unless `SOURCE_DATE_EPOCH` is set. Task 4 measures: smoke `imageid` vs the pushed manifest's per-platform config digest, with `SOURCE_DATE_EPOCH` from the commit; equal → proven; unequal → written limitation                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The pushed image already carries BuildKit provenance                              | **Unknown**   | `docker/build-push-action` v6 attaches a `mode=min` provenance attestation by default on a registry push from the container driver, and nothing in `release.yml` disables it. Check `docker buildx imagetools inspect ghcr.io/j3vb/owncord-server:1.2.0-alpha.4 --format '{{json .Provenance}}'`. Either way it is not GitHub-signed and `gh attestation verify` cannot see it; Task 3 adds the signed one                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Docs tell an owner how to verify a download                                       | **Refuted**   | `docs/deployment.md:833-835` describes what the **updater** verifies (the plan drafted `:780-782`; B6-10 and B6-11 merged and moved the whole file by +58); `README.md:63` lists "checksums, signatures, and a full source snapshot"; no page shows `sha256sum -c`, `minisign -V` or any manual step. Task 5 adds one section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A Dockerfile change is built on every PR                                          | **Corrected** | `ci.yml:666-668` — the `server-docker-build` **job**, re-checked 2026-09-18 (the plan drafted `:656-657`) — runs only when `github.ref_name == 'main' \|\| github.base_ref == 'main'`; on a dev PR it is skipped (`docs/contributing.md:210-212`). The digest pin is proven by `nightly-docker-smoke.yml:64-78` on `dev` or a local `docker build`, not by the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Windows code signing is in scope                                                  | **Refuted**   | `docs/security.md:317` records Authenticode/SmartScreen as "separate work"; BPR-005 (`beta-product-requirements-2026-08-23.md:27`) says timestamped platform signatures need not be reproducible. Out of scope, unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `.claude/plans/` is tracked and Prettier-gated                                    | **Confirmed** | `.gitignore` whitelist; PRD decision 2026-09-08 at `prd.md:242-246` (the plan drafted `:232-236`, which now holds a later 2026-09-18 decision)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### What the corrections change

- **The rehearsal is a real release.** There is no dry-run path and adding one
  would be plumbing whose first real execution is at tag time — the exact
  trap `release.yml:27-31` warns about. The rehearsed tag is the next alpha,
  cut from `main` after this PR and B6-1's assets are on `main`; the owner's
  click at `environment: release` **is** the rehearsal of that gate.
- **"Signed" means a GitHub attestation, not a second key.** The minisign key
  stays for the updater (it is what the deployed binaries pin,
  `Server/updater/server_update_public_key.txt`); everything else is
  Sigstore-signed with the run's OIDC identity. No secret is added, nothing
  can leak, and verification is `gh attestation verify --repo J3vb/OwnCord`.
- **The SBOM comes from the toolchain already on the runner.**
  `cyclonedx-gomod` is a Go module run with a pinned version and checked by
  the Go checksum database — the same shape as
  `go install golang.org/x/vuln/cmd/govulncheck@v1.1.4` (`ci.yml:140`). No
  third-party scanner action for the binaries; BuildKit's own `sbom: true` for
  the image.
- **The digest pin is measured before it is claimed.** B6-2's "the layers are
  identical" is an argument; Task 4 turns it into a comparison that fails the
  push if it is wrong, or a written limitation if the comparison cannot be
  made equal.
- **Toolchain drift is recorded, not fought — for Go only.** The Go patch
  floats by owner decision (2026-09-18): CI and the release build move with it,
  and the SBOM names the Go version that built each asset, so the input is
  traceable even though it is not pinned. Rust is pinned instead (question 2),
  so the release build's `stable` is a named version a toolchain file states.

## Patterns to Mirror

| Category                     | Source                                        | Pattern                                                                                                                                                      |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action pin                   | every `uses:` in `release.yml`                | 40-hex commit SHA plus `# vX.Y.Z` comment; Dependabot's `github-actions` block keeps both current                                                            |
| Pinned Go tool               | `.github/workflows/ci.yml:151`                | `go install <module>@vX.Y.Z` — exact version, sumdb-verified, no action                                                                                      |
| Digest-checked download      | `.github/workflows/ci.yml:441-451`            | version + sha256 in `env:`, `sha256sum -c` before use, comment saying why                                                                                    |
| Verify what you just signed  | `.github/workflows/release.yml:717-729`       | sign, then verify against the **pinned** public material, fail closed before `gh release create`                                                             |
| Publish-marker guard         | `scripts/check-release-environment.mjs:26-28` | a job is gated if its body contains a publish marker; extend the marker list, never a job-name list                                                          |
| Dependabot block             | `.github/dependabot.yml:61-83`                | one block per root, `target-branch: dev`, grouped, majors ignored, a comment naming the coupling                                                             |
| Assets from disk, not a list | `.github/workflows/release.yml:673-696`       | "Built from the files on disk, not a hard-coded list" (comment at `:676-679`) — the attestation subjects are globs over the staging dirs for the same reason |
| Operator recipe              | `docs/deployment.md:509-531`                  | numbered shell steps with a comment per line saying why, `--format '{{index .RepoDigests 0}}'` shape                                                         |
| Evidence in the PRD          | `prd.md:225-231`                              | a dated decision line naming the PR/run that proved the row                                                                                                  |
| Pinned runtime download      | `Server/ws/livekit_download.go:30-32`         | one named constant, "bump deliberately with releases" — the compose tag follows it                                                                           |

## Files to Change

| File                                                         | Action | Why                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server/Dockerfile`                                          | UPDATE | `:8` and `:38` become `tag@sha256:` pins with a comment saying Dependabot bumps the digest                                                                                                                                                                                              |
| `Server/docker-compose.yml`                                  | UPDATE | `:66` `livekit/livekit-server:v1` → `:v1.13.5`, the value of `DefaultLiveKitVersion`                                                                                                                                                                                                    |
| `.github/dependabot.yml`                                     | UPDATE | a `docker-compose` block on `/Server` and a `rust-toolchain` block on `/Client/src-tauri`, each the same shape as the existing `docker` and `cargo` blocks                                                                                                                              |
| `Client/src-tauri/rust-toolchain.toml`                       | CREATE | `channel = "1.98.1"`, `components = ["clippy", "rustfmt"]`, no `targets` key; rustup applies it to every cargo invocation under `Client/src-tauri`                                                                                                                                      |
| `.github/workflows/release.yml`                              | UPDATE | SBOM step in `release-server`; `SOURCE_DATE_EPOCH` + `imageid` outputs in `smoke-server-docker`; `sbom`/`provenance`, digest compare and image attestation in `release-server-docker`; asset attestation + verify in `publish`; `id-token`/`attestations` permissions on those two jobs |
| `scripts/check-release-environment.mjs` (+ `.test.mjs`)      | UPDATE | `push-to-registry: true` joins `PUBLISH_MARKERS`; one fixture row                                                                                                                                                                                                                       |
| `docs/deployment.md`                                         | UPDATE | "Verifying a download" section: checksums, minisign, `gh attestation verify` for files and the image, where the SBOM is                                                                                                                                                                 |
| `README.md`                                                  | UPDATE | `:63` names attestations and SBOMs beside checksums and signatures                                                                                                                                                                                                                      |
| `docs/quick-start.md`                                        | UPDATE | `:13-18` "Linux ARM64 — Not published yet" → published from the rehearsed tag (Task 6); no other plan owns this row                                                                                                                                                                     |
| `docs/plans/b6-server-deployment-operations-capacity.prd.md` | UPDATE | B6-12 row → `in-progress` now; after the tag: `complete` with run id, and B6-1's row → `complete` with the same evidence                                                                                                                                                                |
| `CHANGELOG.md`                                               | UPDATE | one contributor-facing block at the end of Unreleased: releases now carry attestations and SBOMs, how to verify                                                                                                                                                                         |

No new secret, no new key, no new workflow, no new required check. Two
first-party actions (`actions/attest-build-provenance`, `actions/attest-sbom`)
are added SHA-pinned; Dependabot's `github-actions` block picks them up on the
next Monday.

## Tasks

### Task 0: Branch, PRD row, and the boundary with B6-10/B6-11

- **Action**: branch `feat/b6-12-signed-traceable-release` from `dev`. Flip
  the PRD row to `in-progress` with this plan linked. **The boundary check is
  moot:** B6-10 (PR #1601) merged 2026-09-16 and B6-11 (PR #1603) merged
  2026-09-17, so there is no in-flight branch left to diff against. The
  overlap this plan had with B6-10 (`docs/deployment.md`, the PRD) landed
  before this branch was cut, and every line cite below is re-derived from the
  merged tree at `dev` `bfee436f`. Read B6-11's plan for
  `upgrade-rehearsal.yml` — this plan does not edit that file,
  `release.yml:497-502` only calls it.
- **Why**: three B6 branches in flight. `release.yml` is edited only here.
  `docs/deployment.md` is shared: Task 5 adds "Verifying a download" after
  the Auto-Update section, B6-13 Task 6 adds "If the update fails" inside
  that same section, and B6-11 adds Restore and Health paragraphs above it.
  Adjacent hunks, not the same lines — whichever lands second rebases and
  re-reads the section once.
- **Validate**: `npm run format` clean; PRD row renders.

### Task 1: Pin the containers, review the compose file

- **Action**:
  1. `Server/Dockerfile:8` →
     `FROM --platform=$BUILDPLATFORM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS builder`
     (the line already carries `--platform=$BUILDPLATFORM` and `AS builder`,
     so replace all of it) and `:38` →
     `FROM gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2`.
     Both digests were re-resolved 2026-09-18 and are **unchanged**:
     `docker buildx imagetools inspect golang:1.26-bookworm --format '{{.Manifest.Digest}}'`
     and the same for `gcr.io/distroless/static-debian12`. They are
     manifest-list digests, so `--platform` selection still works. One comment
     above each: the tag is for humans, the digest is what builds, Dependabot's
     `docker` block moves both together (`dependabot.yml:61-64` already says
     the builder tracks `go.mod` and `setup-go`).
  2. `Server/docker-compose.yml:69` → `image: livekit/livekit-server:v1.13.5`
     (the plan drafted `:66`; the image line is at `:69` — `:66` is a
     `networks:` entry and editing it blindly would corrupt the file)
     with a comment pointing at `Server/ws/livekit_download.go:32` — the two
     must move together, and the compose file is the one an operator runs
     without the server's own pin.
  3. `.github/dependabot.yml`: a `docker-compose` block for `/Server`, copied
     from the `docker` block (`:65-83`), label `docker`, grouped, majors
     ignored, with a comment that it exists because GitHub treats compose as a
     separate ecosystem. `Server/docker-compose.otel.yml`'s `:latest` images
     (`:17,29`) are dev-only tracing sidecars and are left alone — say so in
     the comment.
  4. `Client/src-tauri/rust-toolchain.toml` — CREATE, and the Dependabot block
     that reviews it (owner decision 2026-09-18, question 2; summary row 2 and
     the acceptance box are no longer "partial"):
     - the file is three lines of TOML — `[toolchain]`,
       `channel = "1.98.1"`, `components = ["clippy", "rustfmt"]`. `1.98.1` is
       current stable, read 2026-09-18 from
       `https://static.rust-lang.org/dist/channel-rust-stable.toml`
       (`[pkg.rust]` → `version = "1.98.1 (48a229cea 2026-09-01)"`). The
       component list is the **union** of the six `dtolnay/rust-toolchain`
       steps (`release.yml:97,164,355`; `ci.yml:522,766,851`): `clippy,
rustfmt` in `rust-tests`, `clippy` in `tauri-build`, none in the other
       four. No step sets `targets:`, so the file carries **no** `targets` key.
     - `channel` is the version, **not** `Cargo.toml`'s
       `rust-version = "1.77.2"` (`Client/src-tauri/Cargo.toml:8`) — that is a
       floor inherited from Tauri 2.11 and stays where it is.
     - leave all six action steps **unchanged**. `dtolnay/rust-toolchain`
       reads only its own `@rev` and its `toolchain` input; it never reads the
       toml. The file takes effect through **rustup**, which is what must be
       verified, and the only way to verify it is
       `( cd Client/src-tauri && rustup show active-toolchain )` — it must
       print the pinned version and name `rust-toolchain.toml`.
     - `.github/dependabot.yml`: a second new block, `package-ecosystem:
rust-toolchain`, `directory: /Client/src-tauri`, same shape as the
       `cargo` block (`:156-186`) — weekly, `target-branch: dev`, prefix
       `chore(deps):`, label `rust`, grouped, majors ignored.
- **Why**: summary rows 1 and 2; RL-18's open half.
- **Gotcha**: the PR's CI does not build the Dockerfile (`ci.yml:666-668` — it
  is the `server-docker-build` **job**, not a step, and its `if:` is
  `github.ref_name == 'main' || github.base_ref == 'main'`, so it is skipped
  on a dev PR). Prove the pin with a local `docker build --platform linux/amd64
Server/` on both digests and, after merge to `dev`,
  `gh workflow run nightly-docker-smoke.yml` (`nightly-docker-smoke.yml:21`
  has `workflow_dispatch`).
- **Validate**: `docker build --platform linux/amd64 Server/` succeeds;
  `docker compose -f Server/docker-compose.yml config` shows the pinned
  LiveKit tag; `( cd Client/src-tauri && rustup show active-toolchain )` prints
  `1.98.1` and names `rust-toolchain.toml`;
  `npm run check:hygiene` (actionlint and Prettier over the YAML).

### Task 2: An SBOM per server asset, and one on the image

- **Action**:
  1. In `release-server` (`release.yml:231-322`), after the smoke step
     (`:297-303`) and before the tar/upload steps, on both OSes:

     ```yaml
     # Module inventory of the binary that just passed the smoke. Pinned the
     # way govulncheck is in ci.yml and checked by the Go checksum database,
     # so no scanner action or download is involved.
     - name: Generate SBOM (CycloneDX, modules compiled into this binary)
       shell: bash
       working-directory: Server
       run: go run github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@v1.12.0 app -json -main . -output "${{ matrix.asset }}.cdx.json"
     ```

     `v1.12.0` is the newest v1.x, re-checked 2026-09-18 with
     `( cd Server && go list -m -versions github.com/CycloneDX/cyclonedx-gomod )`
     — it is still `v1.12.0` — and is written literally, exactly as
     `govulncheck@v1.1.4` is at
     `ci.yml:151`. `app`
     mode lists only modules reachable from `main`, so the document describes
     the shipped binary (no `wazero`, no `otel`). On Linux the archive step
     (`:305-308`) stays as is; the SBOM is uploaded as a second path on the
     same artifact, so it lands in `windows/` or `linux/` beside its asset at
     publish time (`:636-648`) and is picked up by the checksum step
     (`:668-669`), the attestation glob and `gh release create` (`:783`) with
     no further wiring. **This is a change, not an existing fact:** both
     upload steps currently carry a single scalar `path:` — `path: Server/${{ matrix.asset }}`
     at `:315` and `path: ${{ matrix.asset }}` at `:322` — and a scalar is not
     a list, so each must become a YAML list holding the asset and its
     `.cdx.json`. The manifest loop globs `chatserver*.exe` and
     `chatserver-linux-*.tar.gz` (`:688`) and is untouched; the checksum step's
     `sha256sum -- *` (`:668`) therefore picks the SBOMs up automatically.

  2. In `release-server-docker`'s build step (`:554-566`) add
     `sbom: true` and `provenance: mode=max`. BuildKit attaches an SPDX SBOM
     and a full provenance document to the image index. Not on the smoke
     builds: attestations need the OCI exporter and `load: true` (`:465`)
     uses the docker exporter.
- **Why**: summary row 3. Roadmap 11 says "produce"; the audit's R-07 asks
  for a documented cadence, which Dependabot plus a per-release SBOM is.
- **Gotcha**: `cyclonedx-gomod app` builds the package to resolve the
  reachable set; on the Windows runners this is a second compile of a few
  seconds. Client bundles get **no** SBOM here — roadmap workstream 6 hands
  the signed client bundle to B8, and a Rust+npm SBOM is a different tool.
- **Validate**: the four `*.cdx.json` are in the release; each parses
  (`jq .metadata.component.name`), lists `modernc.org/sqlite` and carries the
  Go version under `metadata.tools`; the image's SBOM shows in
  `docker buildx imagetools inspect <tag> --format '{{json .SBOM}}'`.

### Task 3: Attest everything, verify before publishing

- **Action**:
  1. `publish` (`:589-785`): add `id-token: write` and `attestations: write`
     to its permissions (`:604-605`). After the minisign verification step
     (`:721-729`) and before the release-notes step:

     ```yaml
     - name: Attest build provenance (every asset, the checksums, the source snapshot)
       uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
       with:
         subject-path: |
           windows/*
           linux/*
           checksums.sha256
           owncord-src-*.tar.gz
     - name: Attest SBOMs
       uses: actions/attest-sbom@c604332985a26aa8cf1bdc465b92731239ec6b9e # v4.1.0
       with:
         subject-path: |
           windows/chatserver*.exe
           linux/chatserver-linux-*.tar.gz
         sbom-path: windows/chatserver.exe.cdx.json # four steps, one per asset/SBOM pair; the action takes a single sbom-path
     - name: Verify attestations against this repository
       env:
         GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       run: |
         for f in windows/* linux/* checksums.sha256 owncord-src-*.tar.gz; do
           gh attestation verify "$f" --repo "$GITHUB_REPOSITORY"
         done
     ```

     Subjects are globs over the staging directories, for the reason
     `:676-679` gives — an asset added to the matrix must not be publishable
     unattested. `windows/*` and `linux/*` include the `.sig` files and the
     manifest, which is intended: the minisign signature files are then
     themselves bound to the run. The two SHAs are the `v4.2.2` and `v4.1.0`
     tag commits, pinned like every other `uses:`, and re-resolved 2026-09-18 —
     both are **unchanged** (`4d101475d8b20a2381f78447822ac1eab6504dd8` and
     `c604332985a26aa8cf1bdc465b92731239ec6b9e`), and both are `commit`
     objects, not annotated tags, so no dereference was needed. `v4.2.2` and
     `v4.1.0` are the newest tags of each action's newest major — there is no
     v5 to consider as of 2026-09-18.

  2. `release-server-docker` (`:504-587`): add the same two permissions;
     after the manifest verification step (`:570-587`):

     ```yaml
     - name: Lower-case the image owner (GHCR rejects `J3vb`)
       id: owner
       run: echo "lower=${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_OUTPUT"
     - name: Attest image provenance
       uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
       with:
         subject-name: ghcr.io/${{ steps.owner.outputs.lower }}/owncord-server
         subject-digest: ${{ steps.build.outputs.digest }}
         push-to-registry: true
     - name: Verify the image attestation
       env:
         GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       run: gh attestation verify "oci://ghcr.io/${{ steps.owner.outputs.lower }}/owncord-server@${{ steps.build.outputs.digest }}" --repo "$GITHUB_REPOSITORY"
     ```

     The build step gains `id: build`; `subject-name` must be lower-case for
     GHCR, so `github.repository_owner` (`J3vb`) is lowered once with bash's
     `${var,,}` into a step output — the same normalisation
     `docker-compose.yml:23` already bakes in as `ghcr.io/j3vb/…`.

  3. `scripts/check-release-environment.mjs:28`: `PUBLISH_MARKERS` gains
     `/^\s*push-to-registry:\s*true\s*$/m`; the test file gains one fixture
     where a job carries only that marker and no `environment:` and must fail.
     The comment at `:26-27` already says "extend this list".
- **Why**: summary rows 4, 5, 6. A public repository's attestations are
  recorded in the public Sigstore log, which is what makes "traceable" true
  for someone who is not the owner.
- **Gotcha**: the provenance names the workflow and run, not the job — an
  attestation created in `publish` for a Windows binary built in
  `release-server` is accurate at the run level, which is what SLSA's GitHub
  build type records. That is SLSA Build L2 (hosted, signed, provenance from
  the same run), and the docs say L2, not L3. Attestation subjects are hashes,
  so the `.sig` files created after `checksums.sha256` (`:698` runs after
  `:665`) are attested even though they are not in the checksum file — unchanged
  from today, and documented in Task 5.
- **Validate**: `actionlint`; `node scripts/check-release-environment.mjs`
  green with the new marker and its test red on the fixture; after the tag,
  `gh attestation verify chatserver.exe --repo J3vb/OwnCord` from a clean
  machine prints the run's workflow ref and commit.

### Task 4: Prove the smoked image is the pushed image — or write down that it is not

- **Action**:
  1. In both `smoke-server-docker` (`:428-476`) and `release-server-docker`,
     set `SOURCE_DATE_EPOCH` on the build step's `env:` from
     `git log -1 --pretty=%ct`, so BuildKit's config `created` and history
     timestamps are the commit time in both builds.
  2. `smoke-server-docker` gets `id: build` on its build step and two
     statically declared job outputs — `outputs:` keys cannot be built from
     `matrix.*`, and matrix job outputs are last-writer-wins, so each leg
     writes only its own key:

     ```yaml
     outputs:
       imageid-amd64: ${{ steps.id-amd64.outputs.imageid }}
       imageid-arm64: ${{ steps.id-arm64.outputs.imageid }}
     steps:
       # … build step with id: build …
       - id: id-amd64
         if: matrix.arch == 'amd64'
         run: echo "imageid=${{ steps.build.outputs.imageid }}" >> "$GITHUB_OUTPUT"
       - id: id-arm64
         if: matrix.arch == 'arm64'
         run: echo "imageid=${{ steps.build.outputs.imageid }}" >> "$GITHUB_OUTPUT"
     ```

     A skipped step's output is empty, so each key is written by exactly
     one leg.

  3. In `release-server-docker`, after the push and the manifest check
     (`:570-587`): read the pushed manifest list's per-platform config
     digests (`docker buildx imagetools inspect "$tag" --format '{{json .Image}}'`
     gives each platform's config) and compare with the two smoked
     `imageid`s. Equal → log "smoked == pushed" per arch. Unequal → fail the
     job with `::error::` naming both digests.
  4. Run the tag. If the compare fails on the first rehearsal, the run is
     re-run once with the compare downgraded to `::warning::`, and the
     limitation is written into `docs/deployment.md` in the words B6-2 used
     ("rebuilt from the same commit and cache; identity is argued, not
     proven") — B6-12 does not hold the release for it.
- **Why**: B6-2 plan `:190` delegated this here; "traceable" for the image
  means the digest the owner pulls is the digest that passed the smoke on
  native hardware.
- **Gotcha**: `imageid` under the docker exporter is the image config digest;
  under the OCI exporter with `sbom`/`provenance` on, the **index** digest
  changes (attestation manifests are added) but the per-platform image config
  does not — compare configs, never index digests.
- **Validate**: locally, two `docker buildx build` runs of `Server/` with the
  same `SOURCE_DATE_EPOCH` produce the same `--output type=docker` image id;
  then the tag run's log line.

### Task 5: Tell an owner how to verify, and what is signed by what

- **Action**: `docs/deployment.md` gains "Verifying a download" after the
  Auto-Update section, in the numbered-recipe shape of the existing backup
  recipe: `## Auto-Update` is at `:825` and its last line is `:875`, so the
  next heading `## Firewall and Ports` at `:876` is the insertion point. The
  house style to copy is the `**Docker:**` block at `:509-531` (fenced
  ```bash, `# N.` comment per step with the _why_ on a three-space-indented
  continuation line, backslash continuations aligned two spaces,
  `--format '{{index .RepoDigests 0}}'` for the image reference):
  1. `sha256sum --check --ignore-missing checksums.sha256` after downloading
     the asset and the checksum file;
  2. `gh attestation verify <asset> --repo J3vb/OwnCord` — proves the file was
     built by `release.yml` at the tagged commit; the same command on
     `checksums.sha256` and `owncord-src-<tag>.tar.gz`;
  3. `gh attestation verify oci://ghcr.io/j3vb/owncord-server:<version> --repo J3vb/OwnCord`
     for the image, and `docker buildx imagetools inspect … --format '{{json .SBOM}}'`
     to read its SBOM;
  4. the Windows binaries additionally carry minisign signatures the updater
     checks against `Server/updater/server_update_public_key.txt`
     (`minisign -Vm chatserver.exe -x chatserver.exe.sig -p <pub>` after
     `base64 -d` of both, the exact sequence `release.yml:725-728` runs);
  5. a four-row table — asset class → signature → SBOM → who verifies it
     (updater / operator / both) — and one honest paragraph: attestations are
     SLSA Build L2, the Tauri client bundles carry updater signatures and a
     provenance attestation but no SBOM until B8, Authenticode is still
     separate work (`docs/security.md:317` unchanged).

  `README.md:63` — the existing sentence is list item `1.` under
  `### Option A: Prebuilt binaries`, so keep the marker; it becomes
  `1. Download assets from [Releases](…) (binaries, checksums, signatures,
SBOMs, a signed provenance attestation and a full source snapshot per
release).`
  `CHANGELOG.md`: one short block at the end of Unreleased per the style rule
  at `CHANGELOG.md:37-40` ("at most a short block at the end", and only when a
  contributor must do something differently) — releases now carry attestations
  and SBOMs; the verify command. `## Unreleased` is at `:42` and its last line
  is `:317`, with `## v1.2.0-alpha.4` at `:319`, so the block goes after
  `:317`.

- **Why**: the refuted claim — nothing tells an owner how to check a
  download today, and HP-6's "operator usability record" reads this page.
- **Validate**: `npm run check:docs` (link and count checks) and
  `npm run format`; every command in the section was run once against the
  rehearsed tag's assets and its output pasted into the PR.

### Task 6: The rehearsed tag, and the evidence it leaves

- **Action**: after this PR merges to `dev` **and B6-11, B6-13, B6-14 and
  B6-15 are on `dev`** (decision taken 2026-09-15, question 4 — the tag is
  HP-6's release candidate and HP-6 checks each of those merges is an
  ancestor of the tag SHA), and `dev` is merged to `main`
  (`docs/contributing.md:200-202`): write the `## v1.2.0-alpha.5` CHANGELOG
  section (the release fails closed without it, `release.yml:762-765`), bump
  the three client manifests (`:64-79`), update `docs/quick-start.md:13-18`
  so "Linux ARM64 — Not published yet" names the tag that publishes it (the
  row is true until this tag and false after; B6-13 does not own it), cut
  the tag from `main`. Then watch:
  - `gate-evidence` passes on the tagged SHA — record its job id; if it fails,
    the tag stays (ruleset forbids deletion, `b1-release-tag-protection.sh:53`)
    and the fix is a new patch tag, which is itself evidence the gate works;
  - the run stops at `release-server-docker` and `publish` for the owner's
    approval — record who approved and when (the environment log);
  - after publish: run every Task 5 command from a machine that is not the
    runner; paste outputs into the PR that flips the rows;
  - **carried from B6-11 (2026-09-18):** once `dev` is on `main`,
    `gh workflow run upgrade-rehearsal.yml --ref dev` resolves for the first
    time. Dispatch it once, and record the run id in B6-11's last unticked
    acceptance row and in `docs/architecture/data-lifecycle.md`'s B6-11 block
    — the same run settles phase D's container leg and the paced disk-full
    re-measurement that block lists as unmeasured. Ask the owner before
    dispatching: the drill log is public.

  Then the PRD: B6-12 row → `complete` with the run id and this plan; B6-1's
  three unchecked rows (`b6-1 plan:220,223,224`) → ticked with the same run
  id, and the B6-1 PRD row → `complete` (the 2026-09-11 decision,
  `prd.md:225-231`); the 2026-09-11 dev log's "proven only by the next tag
  run" line closes.

- **Why**: summary row 7; roadmap workstream 15 verbatim.
- **Gotcha**: a deleted-and-re-pushed tag has happened before
  (`release.yml:8-12`); the ruleset now forbids it, so a broken rehearsal
  costs one more patch version, not a rewrite. Do not "fix" that by lifting
  the ruleset.
- **Validate**: `gh run view <id>` shows every job green including the two
  verify steps; `gh attestation verify` succeeds off-runner; the PRD rows
  cite the id.

## Validation

```bash
# containers
docker build --platform linux/amd64 Server/ && docker compose -f Server/docker-compose.yml config | grep livekit-server
gh workflow run nightly-docker-smoke.yml            # after merge to dev
# workflow + guards
actionlint
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:v0.9.0 <extracted run: blocks>
node --test scripts/check-release-environment.test.mjs && node scripts/check-release-environment.mjs
npm run check:hygiene && npm run check:docs && npm run format
# SBOM tool, locally
cd Server && go run github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@v1.12.0 app -json -main . -output /tmp/chatserver.cdx.json && jq .metadata.tools /tmp/chatserver.cdx.json
# reproducible config digest, locally
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build --output type=docker Server/  # twice; compare `docker images --digests`
# the rehearsal
gh run watch <release run id>
gh attestation verify chatserver.exe --repo J3vb/OwnCord
gh attestation verify oci://ghcr.io/j3vb/owncord-server:1.2.0-alpha.5 --repo J3vb/OwnCord
# → ci-check skill
```

## Risks

| Risk                                                                                                           | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A step that exists only in `release.yml` first runs at tag time and breaks the release (`release.yml:27-31`)   | High       | Medium | Every new step is either a first-party action (schema checked by actionlint in PR CI) or a shell line run locally in Validation; the guard extension has a PR-time test; a failure costs one patch tag                                                                                                 |
| The rehearsal tag is live: a broken attestation step after `gh release create` would leave a published release | Medium     | High   | Both attest+verify steps run **before** `gh release create` and before the image `:latest` push has been announced; a failure leaves no release and no tag moved                                                                                                                                       |
| The attest action's `push-to-registry` needs `packages: write` the job lacks                                   | Low        | Low    | `release-server-docker` already has `packages: write` (`:518`); `publish` attests files only                                                                                                                                                                                                           |
| `subject-name` case: GHCR rejects `J3vb`                                                                       | Medium     | Low    | lower-cased once into a step output with `${GITHUB_REPOSITORY_OWNER,,}` (Task 3.2)                                                                                                                                                                                                                     |
| Task 4's digest compare never matches on GitHub's cache                                                        | Medium     | Low    | Measured, with the written-limitation fallback decided in advance; the release is not held for it                                                                                                                                                                                                      |
| Dependabot's `docker` block starts opening a PR per digest bump every week                                     | Medium     | Low    | Grouped (`dependabot.yml:77-80`), majors ignored; a digest bump of the same tag is a patch-class PR that CI's nightly smoke proves                                                                                                                                                                     |
| `cyclonedx-gomod app` fails on the Windows ARM64 runner                                                        | Low        | Medium | The SBOM is a **gate** (decided 2026-09-18): no `continue-on-error`, no `::warning::` fallback, so a failed row fails `release-server` and nothing is published. It is a pure-Go module run as `go run …@v1.12.0`, sumdb-checked, and it was run against this commit locally before the branch existed |
| A public Sigstore entry reveals the source tarball hash before the release page is up                          | Low        | None   | The repository is public; the hash of a public commit's archive is not sensitive                                                                                                                                                                                                                       |
| Windows Authenticode expected by readers of "signed release"                                                   | Medium     | Low    | Task 5's table says what is signed by what; `docs/security.md:317` still lists Authenticode as separate work                                                                                                                                                                                           |

## Out of scope

- **Windows Authenticode / SmartScreen signing** — `docs/security.md:317`,
  separate work, no certificate exists.
- **Client-bundle SBOMs (Rust + npm)** — roadmap workstream 6: B8 supplies the
  final signed client bundle. The bundles are attested as subjects here
  because it costs nothing.
- **Pinning the Go patch** — owner decision 2026-09-18: Go keeps floating
  (`release.yml:261` `go-version: "1.26"`, with `Server/go.mod`'s `toolchain`
  line as a floor), and the SBOM records the version that actually built each
  asset. Rust **is** pinned — that part is in scope, Task 1 item 4.
- **SLSA Build L3** (`slsa-github-generator`, builds inside the attesting
  job) — L2 satisfies "signed provenance"; L3 is a re-architecture of the
  matrix.
- **`docker-compose.otel.yml`'s `:latest` sidecars** — dev-only tracing.
- **Changing what `:latest` on GHCR tracks** — owner question below.
- **Making the updater verify attestations** — it verifies minisign and the
  manifest (`Server/updater/verify.go:119-176`); adding Sigstore verification
  to the binary is a dependency and a design, not a release-pipeline change.

## Open questions for the owner

All four decided by the owner on 2026-09-18. The answers below are binding and
override the defaults this section proposed.

1. **Should `:latest` on GHCR follow alpha tags?** Today every `v*` tag
   moves it (`release.yml:546`) and every release is "latest" to the updater
   (`updater.go:226`). This plan leaves both as they are, because all
   releases so far are alphas and changing it would freeze every `:latest`
   deployment. Revisit at the first non-alpha tag.
   **Decided 2026-09-18:** no change — `:latest` keeps following every `v*`
   tag. Revisit at the first non-alpha tag, and change the updater and the
   Docker tag together, not one of them.
2. **Pin the build toolchains — Go and Rust?** Go: `go-version-file:
Server/go.mod` in `release.yml` makes the release build's Go version
   exact, at the cost of CI testing a possibly newer patch than the release
   builds. Rust: `dtolnay/rust-toolchain` at `release.yml:97,164,355`
   resolves `stable` on the day; a `rust-toolchain.toml` in
   `Client/src-tauri/` is one file.
   **Two statements this question originally made are false and are
   corrected here:**
   - "Dependabot-reviewed (gomod block)" — **false.** Dependabot does not
     bump the `go.mod` `toolchain` line; that is dependabot-core issue
     13520, still open as of 2026-09-18. A `gomod` block would therefore
     review every Go dependency _except_ the toolchain line this question
     was about.
   - "the action honours it, so the pin is Dependabot-invisible" —
     **false.** `dtolnay/rust-toolchain` reads only its own `@rev` and its
     `toolchain` input; it never reads `rust-toolchain.toml`. The file works
     because **rustup** applies it when cargo runs under
     `Client/src-tauri` — which is the mechanism Task 1 must verify, not
     assume. And the pin is not Dependabot-invisible either: Dependabot has
     had a `rust-toolchain` ecosystem since 2025-08-19.

   **Decided 2026-09-18:** pin Rust, leave Go floating. Create
   `Client/src-tauri/rust-toolchain.toml` with `channel = "1.98.1"` (current
   stable, from `channel-rust-stable.toml`) and `components = ["clippy",
"rustfmt"]` — the union of the six `dtolnay/rust-toolchain` steps; none of
   them sets `targets`, so the file carries no `targets` key. Leave all six
   action steps unchanged: the action does not read the file, rustup does, and
   that must be verified (`rustup show active-toolchain` from
   `Client/src-tauri`). Add a Dependabot block with package-ecosystem
   `rust-toolchain` and directory `/Client/src-tauri`, same shape as the
   existing `cargo` block. Go keeps floating by the same decision, and the
   SBOM records the version that actually built each asset. Summary row 2 and
   its acceptance box are no longer **partial**.

3. **Is the SBOM a gate or evidence?** This plan proposed evidence — a
   failed SBOM step warns and the release proceeds.
   **Decided 2026-09-18:** it is a **gate**. No `continue-on-error` and no
   `::warning::` fallback on the SBOM step: a failed SBOM fails the job.
   There is no downgraded re-run for it either.
4. **Which tag is the rehearsal?** Decision taken for planning
   (2026-09-15), open to the owner's reversal: `v1.2.0-alpha.5` is cut from
   `main` only after B6-11, B6-13, B6-14 and B6-15 are on `dev` and `dev` is
   merged — because that tag is HP-6's release candidate, and HP-6 Task 0
   checks each of those merges is an ancestor of the **tag SHA**. B6-10 is
   not a precondition (HP-6 may sign around it). If the owner wants the tag
   sooner (B6-12 alone), the PRD's "same release candidate … before HP-6
   closes" (roadmap `:889-892`) needs a second tag later, which is fine — the
   gate is rehearsed on every tag from now on — but HP-6 then measures
   against the second tag, not this one.
   **Decided 2026-09-18:** unchanged — one rehearsal tag, `v1.2.0-alpha.5`,
   cut later by the owner. No tag is cut by this PR.

## Acceptance

Ticked only where the tag run happened; evidence is the run id in the PRD
rows and the pasted `gh attestation verify` output in the flipping PR.

- [ ] `Server/Dockerfile` base images pinned by digest; Dependabot's `docker`
      block has opened or would open the digest bump (first Monday after
      merge, or the PR shows the pin form Dependabot documents)
- [ ] `livekit/livekit-server` in compose pinned to `DefaultLiveKitVersion`;
      a `docker-compose` Dependabot block exists
- [ ] Build inputs pinned or auto-reviewed: actions, lockfiles and Dependabot
      roots yes; Rust pinned by `Client/src-tauri/rust-toolchain.toml` and
      auto-reviewed by a `rust-toolchain` Dependabot block; the Go patch floats
      by owner decision and is recorded in the SBOM, which names the Go version
      that built each asset
- [ ] Four `*.cdx.json` SBOMs published beside their assets, each naming the
      Go version and the module set of the shipped binary; the pushed image
      carries a BuildKit SBOM and `mode=max` provenance
- [ ] Provenance attestation covers every file in `windows/`, `linux/`,
      `checksums.sha256` and `owncord-src-<tag>.tar.gz`; SBOM attestations
      cover the four server assets; the image digest is attested and the
      attestation pushed to GHCR
- [ ] Both verify steps ran green **before** `gh release create`, and
      `gh attestation verify` succeeds off-runner for a file and for the image
- [ ] `check-release-environment.mjs` treats `push-to-registry: true` as a
      publish marker, with a failing fixture
- [ ] Smoked-vs-pushed image config digests compared in the run: equal, or
      the limitation written into `docs/deployment.md`
- [ ] `gate-evidence` passed on the tagged SHA and the owner approved at
      `environment: release` — run id and approval recorded in the PRD
- [ ] B6-1's three unchecked rows ticked from the same run: four assets
      built, smoked and uploaded; manifest and checksums cover all four;
      signed assets verified against the pinned key
- [ ] `docs/deployment.md` "Verifying a download" present; every command in
      it run once against the rehearsed tag; `docs/quick-start.md:13-18` no
      longer says "Not published yet" for Linux ARM64
- [ ] PRD rows (B6-12, B6-1), `README.md`, `CHANGELOG.md` updated;
      `ci-check` green
