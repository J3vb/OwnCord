# HP-1 — Structural diff review and B1 exit scorecard

**Hold point:** HP-1, defined in
[repo-health-roadmap-2026-08-23.md](repo-health-roadmap-2026-08-23.md)
**Commits reviewed:** the pre-squash commits of #1411 and #1417 (table below)
**Measured at:** `db3f28b7`, the B1-8 branch off `dev` `eb873fe7`
**Measured:** 2026-08-27
**Evidence base:** [b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md),
[b1-repository-foundation-2026-08-25.md](b1-repository-foundation-2026-08-25.md)

**Decision: ACCEPTED — 2026-08-27 by J3vb (repository owner).**

All eight exit conditions are evidenced below. Condition 6 is accepted **as a
stated limitation, not as met**: `dev` carries `strict: false`, so a PR can
still merge without re-testing against a moved base. Nothing found in the
structural review blocks acceptance. **B1 is complete and B2 may begin.**

HP-1 asks one question: were B1's structural changes **mechanical**? This
scorecard answers it with reproducible commands rather than assertion, then
walks the B1 exit gate's eight conditions. It follows the shape of
[hp-0-scorecard-2026-08-25.md](hp-0-scorecard-2026-08-25.md).

Acceptance is not a claim that OwnCord is beta-ready. It is a claim that B1's
migrations changed structure without changing behaviour, and that B2 may begin.

## The commits under review are not on `dev`

`dev` is squash-merge only, so each B1 PR landed as **one** commit. The
separation HP-1 exists to review — pure move, then adjacent mechanical
rewrite — survives only on the pull-request refs:

```bash
git fetch origin 'refs/pull/1411/head:pr-1411' 'refs/pull/1417/head:pr-1417'
```

| PR                                    | On `dev`   | Pre-squash commits                                                                      |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| #1411 — flatten `Client/tauri-client` | `7365a31b` | `4befe699` pure move, `38ddca73` path rewrite                                           |
| #1417 — ownership moves               | `9eba6969` | `63b52249` protocol, `93ee14d5` seed, `474bb217` test tier, `7a4e5dc3` Go module rename |

**Reading `dev` history alone cannot satisfy HP-1.** Anyone re-running this
review must fetch the PR refs first. This is a process finding, not a defect:
squash merge is the repository's chosen model, so future phases that require a
structural review should record the pre-squash SHAs at merge time, as this
table now does.

## Question 1 — was the pure move pure?

`7c286abe..4befe699`, the first half of the flatten.

| Measure                                | Required | Actual  |
| -------------------------------------- | -------- | ------- |
| Rename entries                         | —        | **473** |
| Non-rename summary entries             | 0        | **0**   |
| Renames at similarity R100             | all      | **473** |
| Text files with any line added/removed | 0        | **0**   |
| Renamed blobs whose object ID changed  | 0        | **0**   |

```bash
git diff -M --summary 7c286abe 4befe699 | grep -vc '^ rename '     # 0
git diff -M --raw     7c286abe 4befe699 | grep -oE 'R100' | wc -l  # 473
git diff -M --numstat 7c286abe 4befe699 | awk '$1!="-" && ($1!="0"||$2!="0")'   # empty
git diff -M --raw     7c286abe 4befe699 | awk '$5 ~ /^R/ {print $3, $4}' | awk '$1!=$2'  # empty
```

**Verdict: PASS.** Every one of 473 files moved with a byte-identical blob,
binaries included. Nothing was edited under cover of the move.

A note on method: `--numstat` prints `-` for binary files, so a naive
`$1!="0"||$2!="0"` filter flags the six binaries (icons, `rnnoise.wasm`) as
changes. The blob-OID comparison is the check that actually covers them, and it
is the one to keep.

## Question 2 — was the path rewrite mechanical?

`4befe699..38ddca73`. 33 files, **983 lines added and 983 removed** — equal
counts, which is necessary but nowhere near sufficient.

The real proof normalises the substitution the commit claims to make and looks
for any line left unpaired:

```bash
git diff 4befe699 38ddca73 | grep -E '^[+-]' | grep -v '^[+-][+-]' \
  | sed 's#Client/tauri-client#Client#g; s#tauri-client/##g; s#^[+-]##' \
  | sort | uniq -u
```

**Result: six unpaired pairs**, every one a relative-path depth change that a
plain string substitution cannot express — the flatten removed one directory
level, so `../../` became `../`. Each was resolved against `HEAD`:

| File                                           | Change                                | Verified                                                              |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `.github/workflows/release.yml` ×2             | `../../windows/` → `../windows/`      | step has `working-directory: Client`; `../windows` is the repo root ✓ |
| `Server/updater/updater_test.go`               | dropped `"tauri-client"` path segment | resolves to `Client/src-tauri/tauri.conf.json`, which exists ✓        |
| `Client/tests/unit/admin-static-…test.ts`      | `../../../../` → `../../../`          | resolves to `Server/admin/static/index.html`, which exists ✓          |
| `Client/tests/e2e/admin/start-server.sh`       | `../../../../../` → `../../../../`    | resolves to `Server/` ✓                                               |
| `Server/service/sanitize_content_fuzz_test.go` | comment path                          | comment only, no code ✓                                               |
| `.claude/workflows/bughunt.harness.mjs`        | hotspot lens label                    | self-test assertion string, no code ✓                                 |

**Verdict: PASS with six documented exceptions**, all mechanical, none a
behaviour change.

The release-signer line deserves its own note. `.github/workflows/release.yml`
runs only on a tag, so **no CI run on any branch ever executes it** — a wrong
`../` there would have surfaced on release day. It is correct: the step declares
`working-directory: Client`, the artifacts sit at the repository root, so
`../windows/chatserver.exe` resolves. A downstream step
(`Verify signed assets against pinned server update key`) runs from the root and
fails closed if the signer wrote to the wrong place, so the path is guarded as
well as correct.

## Question 3 — was the Go module rename mechanical?

`474bb217..7a4e5dc3`. `github.com/owncord/server` → `github.com/J3vb/OwnCord/Server`.
350 files, 728 added and 728 removed.

```bash
git diff 474bb217 7a4e5dc3 | grep -E '^[+-]' | grep -v '^[+-][+-]' \
  | sed 's#github.com/owncord/server#github.com/J3vb/OwnCord/Server#g; s#^[+-]##' \
  | sort | uniq -u
```

**Result: empty. Zero unpaired lines.**

**Verdict: PASS, unconditionally.** The largest single change in B1 is provably
a pure string substitution.

## Question 4 — the other three ownership moves

`63b52249` (protocol), `93ee14d5` (seed), `474bb217` (test tier) are **not**
pure renames, and were never claimed to be — the plan specifies content changes
for each. Reviewed individually:

| Commit     | Change                                               | Assessment                                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `63b52249` | `docs/protocol-schema.json` → `protocol/schema.json` | The schema's only content change is its `$comment` string (it now names `npm run generate`). **The protocol constants are byte-identical** — no wire-format drift. The +115/−76 is dominated by a new 36-line `protocol/README.md`. **Mechanical.**                                                              |
| `93ee14d5` | seed tool → `Server/cmd/seed/`                       | `func init()` deleted and its `os.MkdirAll("data", 0o750)` moved into `main()`. **This is a deliberate behaviour change**, specified by the plan (`RL-10`), in its own commit, and it is the intended one: the directory is created when the tool runs, not when its package is linked. **Correctly split out.** |
| `474bb217` | cross-stack tests → `tests/contract`                 | Both directions retiered: `Server/updater/updater_test.go` → `tauri_key_contract_test.go`, and `Client/tests/unit/admin-static-channel-perms.test.ts` → `Client/tests/contract/server-admin-static-channel-perms.test.ts`. Renames plus assertion-preserving edits. **Mechanical.**                              |

**Verdict: PASS.** One behaviour change exists, it was authorised in advance,
and it is isolated in its own commit — which is exactly what HP-1 asks for.

## Question 5 — is the active path inventory complete?

```bash
git grep -Il "tauri-client"    # 11 files
```

All eleven are historical records, and **zero** are active code, workflows,
scripts, hooks, or the Dockerfile:

- `.superpowers/findings-ledger.json` — hunt _lens labels_ such as
  `hotspot-client-tauri-client-src`, not filesystem paths. Records of what was
  hunted, and rewriting them would falsify the record.
- Six dated `docs/audit-*.md` — deliberately left alone so links from old commit
  messages keep resolving. B1 lists editing them as out of scope.
- Four `docs/plans/*.md` — documents that describe the move and must name the
  old path to do so.

**Verdict: PASS.** The rewrite is complete.

## B1 exit gate

| #   | Condition                                                            | Status            | Evidence                                                                                                                                                                           |
| --- | -------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One setup path; Windows and Linux; no directory guessing             | **met**           | Fresh-clone smoke, both platforms — below                                                                                                                                          |
| 2   | Desktop behaviour, release asset names, update contracts unchanged   | **met**           | See below                                                                                                                                                                          |
| 3   | Move and rewrite independently reviewable; active path refs complete | **met**           | Questions 1–5                                                                                                                                                                      |
| 4   | Generated sources have explicit reproducible owners                  | **met**           | `check:server` regenerates and diffs both generators — below                                                                                                                       |
| 5   | Protocol schema generates and verifies both consumers from the root  | **met**           | `protocol/schema.json` → `Server/ws/message_types.go` + `Client/src/lib/protocolTypes.ts`; enforced in `ci.yml`, `.githooks/pre-commit`, and `Server/ws/protocol_contract_test.go` |
| 6   | Every `dev` integration commit has exact-SHA CI                      | **partially met** | See below — 12 checks pinned, but `strict: false`                                                                                                                                  |
| 7   | Issues, Discussions, PRs, private security reporting match the model | **met**           | B1-7 (#1419), merged 2026-08-27 — see below                                                                                                                                        |
| 8   | Full B0 evidence remains green after the migration                   | **met**           | Gate run below; every B0 number reproduced                                                                                                                                         |

### Condition 2 — nothing that names a release asset derives from a directory

| Field               | Value                  | Derived from directory? |
| ------------------- | ---------------------- | ----------------------- |
| `productName`       | `OwnCord`              | no                      |
| `identifier`        | `com.owncord.client`   | no                      |
| Cargo crate         | `owncord-client`       | no                      |
| Cargo lib           | `owncord_client_lib`   | no                      |
| `updater.endpoints` | `[]` (server-mediated) | n/a                     |

`Server/updater/assets.go` selects update assets with
`strings.HasSuffix(a.Name, suffix)` against suffixes like `_amd64.AppImage.tar.gz`
— **filename only, never a path**. The flatten therefore cannot rename a release
asset. The cross-component test
`Server/updater/tauri_key_contract_test.go` reads the client's
`tauri.conf.json` from disk and still resolves after the move.

### Conditions 1, 4 and 8 — the gate run

Measured 2026-08-27 on the B1-8 branch. Every step below exited 0.

**Windows** — `npm run check` and `npm run check:server`:

| Step                                                                | Result                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `go build ./...` ×4 tag variants (`—`, `otel`, `wazero`, both)      | pass ×4                                                           |
| `go vet ./...`                                                      | pass                                                              |
| `go test -race ./...`                                               | pass (`ws` 116.2s)                                                |
| `go test -tags deadlock -count=1 ./ws/`                             | pass (54.3s)                                                      |
| `golangci-lint run ./...`                                           | pass                                                              |
| `cargo fmt --check`, `cargo test --lib`, `cargo clippy -D warnings` | pass — **115 Rust tests**, clippy clean                           |
| `npx prettier --check .`                                            | pass                                                              |
| `check:docs`                                                        | pass — 21 claims across 8 watched documents agree with the ledger |
| `shellcheck`, `actionlint`                                          | **skipped** — no clean Windows install; CI runs both              |

**Linux, Node 24** — a genuinely fresh `git clone` into a `node:24` container,
then `npm run bootstrap` and the scoped checks:

| Step                                  | Result                                  |
| ------------------------------------- | --------------------------------------- |
| `npm run bootstrap` (3 × `npm ci`)    | pass — `engine-strict` accepted Node 24 |
| `npm run check:docs`, `check:hygiene` | pass                                    |
| `npm run check:client`                | pass — **192 files, 5257 tests**        |

**This closes `ENV-01`.** B0 measured 5257 client tests on Node 26 and recorded
the Node 24 figure as unverified. The containerised run reproduces **5257 exactly
on Node 24**, from a clone with no untracked files — which also proves the setup
path does not depend on anything a contributor would not receive.

**Condition 4 — generated sources.** `check:server` regenerates each generated
tree and diffs it, so reproducibility is proven rather than asserted:

| Generator                  | Verification                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `go run ./cmd/genprotocol` | `git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts` — empty |
| `sqlc generate`            | `git diff --exit-code db/dbgen` — empty                                               |

**Docker** (`ENV-02`) — the CI job is `main`-gated and skips on dev PRs, so this
was produced locally:

```bash
MSYS_NO_PATHCONV=1 docker build --build-arg VERSION=ci -t owncord-smoke:candidate Server/
MSYS_NO_PATHCONV=1 bash Server/scripts/docker-smoke.sh owncord-smoke:candidate   # exit 0
```

Image **50.1 MB**, boots as uid 65532 on `:8443` with TLS. Matches B0 exactly.

Three traps this run hit, recorded so the next person does not:

- **The build context is `Server/`, not the repository root.** `ci.yml` sets
  `context: Server/`; only `Server/.dockerignore` exists. Building from the root
  streams the whole working tree (400 MB+) and then fails on the missing
  `go.mod`.
- **`docker image inspect --format '{{.Size}}'` reports 12.5 MB for this image.**
  It is not the figure B0 recorded. `docker images … --format '{{.Size}}'` gives
  50.1 MB and is the one to compare against.
- **`ENV-03` is still open.** `docker-smoke.sh` moved to `Server/scripts/` and now
  takes the image as an argument, but still does not set `MSYS_NO_PATHCONV`
  itself, so Git Bash on Windows still reports a boot failure that did not
  happen. The B1 plan's copy of the command was stale and is corrected in this
  change.

### Condition 6 — pinned, but not strict

Live protection on `dev`, read from the API rather than inferred:

| Setting                  | Value                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Pull request required    | yes, **0** approvals                                                                        |
| `enforce_admins`         | **true**                                                                                    |
| Force pushes / deletions | disabled                                                                                    |
| Required checks          | **12** — B1-0's 10, plus `Repository Hygiene` (B1-3) and `Docs & Ledger Consistency` (B1-6) |
| `strict`                 | **false**                                                                                   |

The twelfth was pinned on 2026-08-27 by running
[`b0-dev-branch-protection.sh`](b0-dev-branch-protection.sh), which B1-6 landed
but deliberately did not run — repository-settings writes need a person. Until
that run, the FINDINGS.md drift gate reported but could not block a merge.

`strict: false` means "require branches to be up to date before merging" is
**off**. When `dev` advances after a PR's checks go green, that PR can still
merge without re-running them — so the squash commit that lands on `dev` was
never itself tested; what was tested is the PR's changes against an _older_
base. B1 merged seven PRs across two days, so this is a live condition, not a
theoretical one.

The exit gate's wording is "every `dev` integration commit has exact-SHA CI".
Under `strict: false` that is **not satisfied**, and the scorecard records it as
such rather than reading the pinned-checks list as sufficient.

**Deliberately not changed here.** Flipping `strict` to `true` closes the gap
but forces a rebase on every open PR each time another lands, and
`enforce_admins: true` means the repository owner is not exempt. That trade is
the owner's to make, and it is a repository-settings change rather than a code
one. Carried as an open item.

### Condition 7 — closed by B1-7, plus the settings it could not apply

B1-7 (#1419) landed the community model on 2026-08-27, and its two
repository-settings scripts were applied the same day:

| Control                | State                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `Release tags` ruleset | **active**, target `tag`, `refs/tags/v*`, blocks update + deletion, **0 bypass actors**       |
| `release` environment  | created, **1 required reviewer** (`J3vb`), no wait timer                                      |
| Discussions slugs      | `q-a` and `ideas` both exist and match `.github/ISSUE_TEMPLATE/config.yml` — routing resolves |

Two things that read-back surfaced, neither blocking:

- **The `release` environment has `can_admins_bypass: true`** (GitHub's
  default). The ruleset was created with `bypass_actors: []` so nobody can
  bypass _it_, but the reviewer gate on the environment is admin-bypassable.
  On a repository where the sole admin is also the sole reviewer this changes
  little, and it is the setting to revisit if that ever stops being true.
- **`.github/workflows/claude.yml` cannot authenticate.** It passes
  `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`, and that
  secret does not exist on the repository — `gh secret list` shows six secrets,
  none of them it. Five `issue_comment` runs exist and every one is `skipped`,
  so the B1-7 guard is stopping them before the missing secret would matter.
  The paid-automation surface `RL-22` hardens is therefore inert today.

`RL-22` is coordinated privately per [security.md](../security.md) and does not
appear in public commits, issues, or PR descriptions — so that part of this row
is closed by B1-7's merge plus the private record, not by anything visible here.

The structural proofs in Questions 1–5 were measured before B1-7 merged, which
does not matter: they compare fixed historical SHAs. The **gate run** did
matter, so it was re-run after this branch was rebased onto `c0c87366` (B1-7),
over the final tree — including B1-7's `check-workflow-guards.mjs`, which
`check:hygiene` now runs twice (`--selftest`, then live). Its sibling
`verify-gate-evidence.mjs` is **not** in the local facade: `ci.yml` runs its
`--selftest` and the assert form needs a `$GITHUB_TOKEN` and a real SHA, so CI
is the only place it is exercised.

## Open items carried past B1

Recorded, not fixed. Nothing here blocks B2's entry gate.

| Item                                   | State                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RL-08` — WASM artifact gate           | **blocked.** The pinned TinyGo rejects Go 1.26, so a compile-and-compare job needs a second Go SDK. B1-6 judged the cheaper honest option to be untracking the prebuilt artifact and documenting the build. Unresolved.                    |
| `dev` `strict: false`                  | **open.** Condition 6 above.                                                                                                                                                                                                               |
| 38 open `OC-*` findings                | **counted, non-stale, assigned.** 11 medium / 27 low, zero high or critical, none assigned to B1. Accepted at HP-0; re-stated here, not re-adjudicated.                                                                                    |
| Two unreferenced Rust commands         | `probe_credential_store` and `ptt_get_key` are registered in `lib.rs` and invoked from nowhere. Dead-surface candidates for B7, recorded in [platform-contracts.md](../architecture/platform-contracts.md).                                |
| Human owners for `platform/`           | **none exist.** Ownership is recorded by phase (B7/B8/B2) because there is nothing else to record.                                                                                                                                         |
| `environment: release` in the workflow | **open, deliberately.** `.github/workflows/release.yml` does not name the environment. The key stalls a release if the environment does not exist, so B1-7 left it out; the environment now exists, so this is a separate two-line change. |
| `release` env admin bypass             | **open.** `can_admins_bypass: true` (GitHub default). The ruleset has zero bypass actors, but the reviewer gate does not. Matters only once the sole admin stops being the sole reviewer.                                                  |
| `CLAUDE_CODE_OAUTH_TOKEN`              | **absent.** `claude.yml` passes it and the repository has no such secret, so the workflow cannot authenticate. Every run to date is `skipped` at the B1-7 guard, so nothing is failing — but the automation is inert.                      |
| `ENV-03` — `MSYS_NO_PATHCONV`          | **open, P2.** `Server/scripts/docker-smoke.sh` still does not set it, so Git Bash on Windows reports a boot failure that did not happen.                                                                                                   |

## Hand-off to B2

B2's entry gate has three conditions. B1 closes the first; the other two are
**B2 entry work, not B1 debt**:

| B2 entry condition                                                   | State after B1                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| B1 is complete and protocol source has one owner                     | **met** — `protocol/schema.json`, relocated in B1-5, verified from one root command    |
| Confirmed security findings have private owners and acceptance tests | **B2 work.** HP-0 mapped 7 private findings to public rows; acceptance tests are B2's. |
| Alpha protocol fixtures and updater contracts are captured           | **B2 work.** Not started.                                                              |

## What acceptance does and does not authorise

Accepting HP-1 authorises B2 to begin. It does **not** claim:

- that the client can run in a browser — the seam is documented, not built (B7);
- that every `dev` commit has been CI-tested as it landed — see condition 6;
- that the 38 open findings are resolved — they are assigned, not fixed;
- that B1's numbers were all re-measured on CI's exact toolchain — see the
  limitations recorded against condition 8.
