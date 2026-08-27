# B1 — Isolated repository and contributor foundation

**Drafted:** 2026-08-25
**Base commit:** `6a1561fa` (`dev`, post-PR #1409)
**Status:** in progress; **entry gate met — HP-0 accepted 2026-08-25**. B1-0
(#1410), B1-1 (#1411), B1-2 (#1412) and B1-3 are complete; B1-4 is the next
step.

Primary inputs:

- [B0 measured baseline](b0-baseline-2026-08-25.md)
- [repository-layout audit](../audit-2026-08-23-repository-layout.md) (RL-01…RL-22)
- [beta roadmap](repo-health-roadmap-2026-08-23.md), B1 section and HP-1
- [issue register](repo-health-issue-register-2026-08-23.md) (L-01…L-16)

## Context

B0 replaced a contradictory status picture with one measured baseline. It also
proved the 2026-08-23 audits are **claims, not facts**: three did not survive
verification — G-01's test passed on the bug and failed on the fix, the
Playwright hang matched none of its three stated hypotheses, and G-05's tooling
failure was simply false.

B1 makes the repository discoverable, cross-platform, and shaped for one shared
desktop/browser application **without mixing layout churn into behaviour
change**. Its riskiest item is RL-01: flattening `Client/tauri-client/` into
`Client/`. That flatten is why the phase exists as an isolated migration
(BPR-103), and it is the one item where a mistake is both easy to make and hard
to see.

This plan therefore does two things the roadmap's workstream list does not: it
**re-verifies every RL claim against HEAD before implementing it**, and it
specifies a _mechanical_ proof that each of the two flatten commits changed
nothing.

## Entry gate: HP-0 — was not accepted, now is

When this plan was drafted, the roadmap's B1 entry gate (`- HP-0 is accepted.`)
was **unmet**, and nothing in the repository recorded otherwise:

| Evidence                                                                     | Finding                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md), "Not yet done in B0" | `- Step 10: HP-0 sign-off.`                                                                      |
| `git log --all --grep='HP-0' -i`                                             | Zero commits. Same for `hold point`, `scorecard`, `sign-off`.                                    |
| Whole tree                                                                   | **No scorecard file exists.** Every `scorecard` match is a _spec_ for one. `R-08` is still open. |
| That file's history                                                          | One commit (`6a1561fa` = HEAD). Nothing supersedes the line.                                     |
| `CHANGELOG.md`                                                               | B0 / PR #1409 absent entirely.                                                                   |

The material to answer HP-0's four questions mostly exists — spread across four
documents rather than the single artifact the hold point requires.

### B1-0 — what accepting HP-0 requires

1. **Write the scorecard.** New `docs/plans/hp-0-scorecard-2026-08-25.md` using
   the roadmap's `## Phase scorecard` table shape, one row per metric, each cell
   linking to its B0 evidence. Part-closes `R-08`.
2. **Pin required status checks on `dev`.** B0's own leftover. The trap is
   knowing which jobs _never report_ on a dev-targeted PR — pinning one of those
   deadlocks every PR.

   The exact reporting set was observed on a live dev-targeted PR (#1410), not
   inferred from `ci.yml` — which matters, because **three of them exist in no
   workflow file**: CodeQL runs from GitHub default setup, so reading `.github/`
   alone would have missed them.

   Pin: `Server Build & Test (windows-latest)`, `Server Build & Test
(ubuntu-latest)`, `Client Static Checks`, `Client Unit Tests`, `Rust Unit
Tests`, `Client E2E (Playwright)`, `Client E2E (parity subset, blocking)`,
   `Analyze (go)`, `Analyze (javascript-typescript)`, `Analyze (actions)`.

   Do **not** pin:
   - `Server Docker Build (verify)` — observed as **skipping** on a dev PR
     (`if: ref_name=='main' || base_ref=='main'`).
   - `Tauri Full Build (${{ matrix.os }})` — reports **skipping** on a dev PR,
     under the _unexpanded_ matrix name, because the job is skipped before matrix
     expansion. (An earlier revision of this plan said it does not appear at all;
     that was wrong — observed on PR #1410.)
   - `CodeQL` — a default-setup aggregate over the three `Analyze` jobs. Pinning
     those three is sufficient; the aggregate is redundant.
   - `Admin Panel E2E (real server, non-blocking)` — `continue-on-error: true`,
     so it reports success unconditionally. Requiring it is theatre; that is
     `R-01`, B10 work.

   Re-observe with `gh pr checks <n>` on a dev PR before writing the list: a
   name that never reports deadlocks every future PR.

   Extend [`b0-dev-branch-protection.sh`](b0-dev-branch-protection.sh) with a
   `required_status_checks` block rather than adding a second script.

3. **Resolve the two unverified baseline rows.** Rust clippy + 115 tests is
   _carried, not re-measured_; every measured row was produced on local Node 26,
   not CI's 24 (ENV-01). Once checks are pinned, one green dev PR supplies the
   CI-side numbers.
4. **Answer HP-0 question 2 honestly.** B0 verified the 38 open `OC-*` records
   resolve to a live `file:line` but deferred per-item phase adjudication. Either
   adjudicate them, or state in the scorecard that they are counted, non-stale,
   assigned to bughunt-fix, and that none blocks B1.
5. **Record the private security reconciliation.** Roadmap workstream 7.
   `docs/security-findings/` is correctly gitignored and untracked; what is
   missing is a public, content-free statement that the dedup happened.

Then add one dated acceptance line to the baseline document. **No B1 source
change starts before that line exists.**

### Status: all five closed, HP-0 accepted 2026-08-25

| #   | Item                    | Outcome                                                                                                                                                                                   |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scorecard               | [hp-0-scorecard-2026-08-25.md](hp-0-scorecard-2026-08-25.md) written; part-closes `R-08`.                                                                                                 |
| 2   | Pin required checks     | **Applied.** 10 checks pinned on `dev`. The assumption that repository-settings writes are blocked from the agent sandbox was **wrong** — the `PUT` succeeded.                            |
| 3   | Two unverified rows     | Rust **re-measured**: 115 passed, clippy `-D warnings` exit 0 — confirms the carried figure. Node 26-vs-24 accepted as a stated limitation; CI ran the full matrix on Node 24 and passed. |
| 4   | 38 open findings        | Accepted as counted, non-stale, assigned. 11 medium / 27 low, **zero high or critical**, **0 dead paths across all 348** re-verified at `6a1561fa`, and **none assigned to B1**.          |
| 5   | Security reconciliation | 7 private findings, **7 of 7 mapped** to existing public rows, 0 unmapped, 0 fixed at the reviewed revision. Content-free summary in the scorecard; detail stays private.                 |

Also corrected while closing item 2: the live check list is **not** what
`ci.yml` implies. See the amended table above.

## What B0 already closed — do not redo

| Finding                          | State at HEAD                                                                                                                                                                    | Leftover for B1                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RL-14** (dev exact-SHA CI)     | **Applied.** `dev` protection live and API-verified: PR required, 0 approvals, `enforce_admins: true`, force-push/delete off. `ci.yml` unchanged — closed by settings, not code. | `required_status_checks` is absent from the live API response. A dev PR can merge red. → B1-0.                                                                                                                                          |
| **RL-17 / C-01** (Node)          | **Only `.nvmrc` moved 20 → 24.**                                                                                                                                                 | Four places still say 20: `tools/mcp-introspect/package.json` (`">=20"`, the repo's only `engines` field), `README.md`, `docs/contributing.md`, `docs/quick-start.md`. Root and client `package.json` have no `engines` at all. → B1-2. |
| **RL-12 / R-06** (docs index)    | **Half.** `docs/plans/README.md` exists and is good.                                                                                                                             | `docs/README.md` does not exist; root `README.md` links neither it nor the plan index; no link/status drift check. → B1-2.                                                                                                              |
| **G-04** (status/count drift)    | Index written; one stale plan header fixed.                                                                                                                                      | The _automated_ check is absent. → B1-2.                                                                                                                                                                                                |
| **G-01, G-02, C-06** (red gates) | **Fixed and measured.**                                                                                                                                                          | none                                                                                                                                                                                                                                    |
| **ENV-02** (Docker)              | **Measured locally** — 50.1 MB, boots on `:8443`.                                                                                                                                | The CI Docker job is `main`-gated, so any dev-targeted PR must re-run `docker-smoke.sh` locally.                                                                                                                                        |

## Verify before you implement

Every `RL-*` was re-tested against `6a1561fa`. Several are materially wrong, and
that changes the work.

| Claim                                                         | Verdict                               | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RL-01** release names                                       | **Safe to move**                      | `productName: "OwnCord"`, `identifier: "com.owncord.client"`, crate `owncord-client`, lib `owncord_client_lib` — none derived from the directory. `updater.endpoints` is `[]` (server-mediated via `Server/api/client_update.go`). Every release staging step globs by **filename suffix**, matched server-side by `Server/updater/assets.go`. **The move cannot rename a release asset.**                                                                                                                                             |
| **RL-09** "no one command verifies both consumers"            | **Sub-claim refuted**                 | `make protocol-verify` already regenerates _and_ diffs both outputs, and it is enforced three times over: `ci.yml`, `.githooks/pre-commit`, and `Server/ws/protocol_contract_test.go`. Only the schema's _location_ is a real finding. Scope shrinks to a relocation.                                                                                                                                                                                                                                                                  |
| **RL-10** "`init()` creates a data dir during test discovery" | **Alarming half refuted**             | `Server/scripts/` contains zero `_test.go` files, so Go never builds a test binary there and `init()` never fires under `go test ./...`. `seed.go` does `os.MkdirAll("data", 0o750)`, but only when the binary is run — and `.gitignore` already ignores `Server/data/`. Residual finding is narrow: an untagged `package main` in the main module's build graph.                                                                                                                                                                      |
| **RL-06** "regeneration not demonstrated"                     | **Closed by deletion**                | Superseded before B1-6 opened: `a5f7d95` (#1413) removed the tool and all 7 tracked files — **20,408,656 bytes**, `graph.json` **19,463,420**. `git ls-files` now matches nothing. The outcome RL-06 wanted (no large tracked payload, history intact) holds; the method it prescribed (regenerate-then-untrack) was bypassed. Portability is moot — there is nothing to regenerate.                                                                                                                                                   |
| **RL-08** "committed without its source"                      | **Half refuted**                      | The source _is_ committed (`Server/plugin/examples/hello/main.go`, `//go:build tinygo`). Only the gate is missing. **New constraint:** pinned TinyGo 0.40.1 rejects Go 1.26, so a compile-and-compare CI job needs a second Go SDK. L-08 is harder than the audit implies.                                                                                                                                                                                                                                                             |
| **RL-07** FINDINGS.md duplication                             | **Confirmed, sharper**                | `render-ledger.mjs --check` validates the JSON schema and returns **before** rendering, so it cannot detect drift at all; a stale 1.09 MB `FINDINGS.md` passes cleanly. B1-2 (#1412) wired that schema-only check into the `Docs & Ledger Consistency` job, which is why the original "no workflow runs it" no longer holds — the job runs, it just cannot see drift. B1-6 adds the check that can.                                                                                                                                    |
| **RL-20** hooks                                               | **Confirmed, plus an unreported bug** | `make` is not on PATH on a normal Windows contributor box, yet the `ci-check` skill lists `make sqlc-verify protocol-verify` as required. Worse: `.githooks/pre-commit`'s protocol branch guards on `command -v go`, not `make` — so Go-without-`make` yields a false **"protocol constants are stale"** hard failure. Separately, `core.hooksPath` may be unset (so `.githooks/` never runs) while a local `post-commit` does; `npm run hooks:install` redirects `core.hooksPath` and silently disables any `.git/hooks/post-commit`. |
| **RL-05** package roots                                       | **Confirmed, wider**                  | Three JS roots, no workspaces. `dependabot.yml` covers npm for one of them — root and `tools/mcp-introspect` are uncovered — and omits the **`docker` ecosystem entirely** despite three Docker files.                                                                                                                                                                                                                                                                                                                                 |
| **RL-11** cross-stack test                                    | **Confirmed; both directions exist**  | Client→Server: `tests/unit/admin-static-channel-perms.test.ts` plus three e2e siblings (`playwright.config.admin.ts`, `tests/e2e/admin/admin-panel.spec.ts`, `tests/e2e/admin/start-server.sh`). Server→Client: `Server/updater/updater_test.go` does `os.ReadFile` on the client's `tauri.conf.json`. Also `Server/ws/protocol_contract_test.go` reads `docs/protocol-schema.json`. A sweep reporting "no server→client reads" is wrong.                                                                                              |
| **RL-04** root facade                                         | **Confirmed**                         | Root `package.json` has exactly three scripts. No root `Makefile`/`justfile`/`Taskfile`. Entry points exist only in `Server/Makefile` and the client `package.json`.                                                                                                                                                                                                                                                                                                                                                                   |
| **RL-13** module namespace                                    | **Confirmed, bounded**                | `Server/go.mod` declares `github.com/owncord/server`: **722 occurrences across 344 Go files**, plus six non-Go (go.mod, a `sed` in `Server/Makefile`, two docs, the ledger pair). **Zero** in any workflow or Dockerfile; no `.goreleaser` exists.                                                                                                                                                                                                                                                                                     |
| **RL-19** format/lint gaps                                    | **Confirmed, all sub-claims**         | No `.editorconfig` anywhere. Prettier is scoped to the client's `src/` and `tests/` TypeScript, so root Markdown, all of `docs/`, every YAML/JSON and all CSS are formatted by nothing. `.golangci.yml` enables 19 linters but no `gofmt`/`gofumpt`/`goimports`. No `cargo fmt --check`. No shellcheck/actionlint/yamllint.                                                                                                                                                                                                            |
| **RL-21** intake                                              | **Confirmed, understated**            | `feature_request.md` still exists. Both templates are **Markdown, not YAML issue forms** — no `body:`, no `validations: required`, so nothing is structured or enforced. The Environment block hardcodes one OS.                                                                                                                                                                                                                                                                                                                       |
| **RL-22** paid automation authorization                       | **Confirmed**                         | Insufficient; impact bounded today by read-only content permissions. Mechanism, guard text, and fix stay out of public commits, issues, and PR bodies per [docs/security.md](../security.md). Tracked as `L-16` only.                                                                                                                                                                                                                                                                                                                  |

Net effect: **RL-09 and RL-10 shrink to near-nothing; RL-08 grows a toolchain
constraint; RL-05, RL-07, RL-20 and RL-21 are each worse than written.**

## B1-1 — The flatten (RL-01 / L-01)

**Do this immediately after B1-0, before any other B1 work.**

This deliberately contradicts the audit's own step order, which puts docs and
the command facade first. Reason: every later B1 workstream _adds_ files that
reference the client path. Flattening now keeps the rewrite set at its minimum —
39 tracked files, about 15 of them active automation — and lets the proof be a
row-for-row comparison against the freshly measured B0 baseline with nothing
else in the diff.

### Shape of the tree

- `Client/` has **exactly one tracked child**: `tauri-client/`. 473 tracked files.
- No submodules (modes are `100644`/`100755` only). No symlinks anywhere.
- No `.gitattributes` rule mentions `Client` — no eol/binary reclassification risk.
- Longest tracked path is 74 characters; the move **shortens** every path by 13,
  so Windows MAX_PATH pressure strictly improves.

### Step 1 — freeze the environment

A detached `post-commit` graph rebuild used to dirty the tree between commits
here, which is why this step once began by exporting `GRAPHIFY_SKIP_HOOK=1`.
That tool and its hook were removed in `a5f7d95` (#1413); nothing to disable.

Close any editor, `cargo`, `vite`, or file watcher holding
`Client/tauri-client/src-tauri/target/`: a Windows directory rename fails while a
child handle is open.

### Step 2 — commit 1: the pure move

```bash
git mv Client/tauri-client ClientTmp
rmdir Client
git mv ClientTmp Client
git commit -m "refactor: move Client/tauri-client to Client (pure move, no content change)"
```

Moving the **directory** rather than its contents matters twice: a shell glob
misses the dotfiles at the client root (`.nvmrc`, `.gitignore`,
`.prettierignore`, `.oxlintrc.json`), and a directory rename is a filesystem
rename, so untracked heavyweights ride along — `node_modules/`,
`src-tauri/target/`, `dist/`, `test-results/`, `playwright-report/`,
`.stryker-tmp/`, `reports/` all exist on disk and would otherwise be stranded at
the old path.

If the rename fails on a locked handle, move tracked files with
`git ls-files -z | xargs -0 git mv` and move the untracked directories by hand.

### Step 3 — prove commit 1 changed nothing

```bash
test "$(git rev-parse HEAD~1:Client/tauri-client)" = "$(git rev-parse HEAD:Client)"
```

Both sides are Git tree object IDs. Equality is a **cryptographic proof that not
one byte of the 473 files changed** — stronger than reading a diff, and possible
only because `Client/` has no other tracked child. The value at `6a1561fa` is
`6f3db90d106ffdc64c474e92607b7d7866245a79`.

Belt and braces:

```bash
git diff --stat HEAD~1 HEAD                    # must be 0 insertions, 0 deletions
git diff -M100% --name-status HEAD~1 HEAD | grep -v '^R100' && echo "NOT A PURE MOVE"
```

**Do not run tests on commit 1.** It is knowingly broken; that is the point of
splitting it. CI on the PR sees only the tip.

### Step 4 — commit 2: mechanical path rewrites

Two rules, applied to an **explicit allow-list of files**, never repo-wide:

- **R1** — `Client/tauri-client/` becomes `Client/` (plus the bare
  `tauri-client/` form in `Server/service/sanitize_content_fuzz_test.go`).
- **R2** — relative paths that _escape the client root_ lose one `../`. Paths
  that stay inside the client are unchanged; depth within the subtree is
  unaffected.

A repo-wide `sed` is the wrong tool: it would corrupt the dated audits that are
the record authorising this move.

**Build the inventory with `git grep` or ripgrep, never `grep -r` from the repo
root.** `git worktree list` shows a locked stale worktree under
`.claude/worktrees/`, holding a full second copy of the repository — its own
`Server/go.mod`, its own `Client/tauri-client/`. It is correctly gitignored and
harmless to the move, but a raw recursive grep walks into it and roughly doubles
every count, which is exactly how a reference inventory ends up wrong in a way
nobody notices.

**R1 — active automation:** `.github/workflows/ci.yml` (24 refs — seven
`working-directory`, five `cache-dependency-path`, two `workspaces`, seven
artifact paths), `.github/workflows/release.yml` (22, including the three
version reads that gate the entire release), `.github/dependabot.yml` (2),
`.githooks/pre-commit` (5), `.githooks/pre-push` (5), `.gitignore` (4),
`Server/Makefile` (`protocol-verify` diff target),
`Server/scripts/genprotocol/main.go` (default `-ts-out`),
`Server/updater/updater_test.go`, `docs/protocol-schema.json` (`$comment`), and
the four `.claude/workflows/` harness files.

**R1 — active documentation:** `CLAUDE.md`, `README.md`, `docs/quick-start.md`,
`docs/architecture/voice-e2ee.md`, `docs/architecture/websocket.md`,
`docs/architecture/system-overview.md`, `.claude/skills/ci-check/SKILL.md`,
`.claude/skills/protocol-change/SKILL.md`, and the open plans that name live
files (`slash-commands.md`, `bug-detection-improvements.md`,
`tauri-capability-narrowing.md`, `security-hardening-remediation.md`,
`security-scan-2026-07-22-remediation.md`).

**R2 — depth-sensitive, ranked by how quietly they fail:**

| #   | Location                                                            | Change                             | Why it is dangerous                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `.github/workflows/release.yml`, "Sign server update assets"        | `../../windows/…` → `../windows/…` | Runs with `working-directory: Client/tauri-client` and signs the server update manifest with the production key. Fires only on a `v*` tag — **zero CI coverage before release**. It fails closed (the next step verifies signatures), but it fails on release day. |
| 2   | `Client/tauri-client/tests/e2e/admin/start-server.sh`               | five `../` → four                  | Drives `admin-e2e`, which is `continue-on-error: true` — a break is **silent**.                                                                                                                                                                                    |
| 3   | `.gitignore` entry for the generated client directory               | R1                                 | **Silent**: a stale ignore path means generated `tauri-typegen` output starts getting committed.                                                                                                                                                                   |
| 4   | `Client/tauri-client/tests/unit/admin-static-channel-perms.test.ts` | four `../` → three                 | Blocking `Client Unit Tests`; fails loudly. Also RL-11's file — re-point it here, reclassify it later.                                                                                                                                                             |
| 5   | `.claude/workflows/bughunt-fix.js` surface routing                  | R1                                 | Live control flow (`f.startsWith(...)`), not prose. Silent no-op if missed.                                                                                                                                                                                        |
| 6   | `.claude/workflows/bughunt.harness.mjs`                             | derived hotspot key string         | A hard string assertion in the harness self-test.                                                                                                                                                                                                                  |

Confirmed **not** depth-sensitive — all intra-client or `import.meta.dirname`
anchored: `vite.config.ts`, `vitest.config*.ts`, all four `playwright.config*.ts`,
all three `tsconfig*.json`, `eslint.config.js`, `eslint-rules.js`,
`.oxlintrc.json`, `knip.json`, `stryker.config.mjs`, `src-tauri/tauri.conf.json`
(`frontendDist: "../dist"`), `src-tauri/Cargo.toml`, `src-tauri/build.rs`, and
the client's own `.gitignore`. `Server/Makefile` and `genprotocol` use
`../Client/…` from `Server/`, so their depth is unchanged — only the path
element drops.

**Leave alone:** every dated `docs/audit-*.md`, and `CHANGELOG.md`.

### The ledger is the one real judgement call

`.superpowers/findings-ledger.json` holds 455 `tauri-client` strings and the
generated `.superpowers/FINDINGS.md` another 446. It is tempting to call this
historical evidence and skip it. **22 of the 38 open findings point into
`Client/tauri-client/`** — 58% of the live open ledger. Leaving them makes 22
active records point at nothing, immediately undoing B0's verification that all
38 resolve to a live `file:line`.

**Recommendation:** rewrite every path in the ledger under R1 — fixed records
included, since a fixed record's path is more useful pointing at where the code
lives now than at nothing — then re-render `FINDINGS.md`. `--check` validates
schema only and does _not_ test that `file:line` resolves, so add a resolution
check as the actual proof: read the ledger, assert every `file` exists on disk,
and print the count of dead paths.

Run it **before** the flatten (expect zero dead paths) and **after** commit 2
(must print the same). That before/after pair is the ledger's red-to-green proof.

### Step 5 — prove commit 2 is mechanical

The diff cannot be byte-identical, so prove the _transformation_ instead:
regenerate the after-state from the before-state with a scripted substitution
over the allow-list and confirm `git diff` is empty. Then review **the script and
the allow-list**, not a hundred diff hunks. The six R2 hunks get individual human
review — they are the only non-uniform edits.

Non-negotiable: `git diff HEAD~1 HEAD` must contain **no change that is not a
path string**. Any logic edit found here is split into its own commit and the
structural review restarts (HP-1).

### Step 6 — verify

Run the full B0 gate set and compare to the baseline row for row. Because `make`
is unavailable on a plain Windows box, use the raw equivalents:

```bash
# Server (from Server/)
go build ./... && go build -tags otel ./... && go build -tags wazero ./... && go build -tags otel,wazero ./...
go vet ./... && go test -race ./... && go test -tags deadlock -count=1 ./ws/
golangci-lint run ./...
go run ./scripts/genprotocol && git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts

# Client (from Client/)
NODE_OPTIONS=--no-experimental-webstorage npm test    # expect 5257 passed / 0 failed
npm run typecheck && npm run lint && npm run format:check
npm run test:e2e                                      # expect 293 passed, exit 0, ~37s
npm run build                                         # compare the five recorded chunk sizes

# Rust (from Client/src-tauri/)
cargo test && cargo clippy --all-targets -- -D warnings

# Docker — CI skips this job on dev PRs, so produce it locally
MSYS_NO_PATHCONV=1 bash Server/docker-smoke.sh        # expect exit 0, ~50.1 MB
```

Targeted proofs the generic suite will not give you:

- `go test ./updater/ -run TestDefaultServerSignaturePublicKey_DiffersFromTauriUpdaterKey`
  — the Go test that reads the client's `tauri.conf.json` from disk.
- `npx vitest run tests/unit/admin-static-channel-perms.test.ts` — the client
  test that reads `Server/admin/static/index.html`.
- `node .claude/workflows/bughunt.harness.mjs` and `bughunt-fix.harness.mjs` —
  the two self-tests that assert on literal client paths.
- `git status --porcelain` must be **empty** after a full build, proving the
  generated-output ignore path was re-pointed.
- `npm ci` from a **fresh clone** of the branch on Windows and Linux, then one
  full check run — the exit gate's fresh-clone setup smoke.
- A **dry run of the release signer's directory arithmetic** from `Client/`, or a
  throwaway tag on a fork. Do not discover a wrong `../../` on release day.

### Step 7 — refresh the graph, separately

**Retired.** This step ran `graphify update .` to regenerate the 13,233 stale
path strings in `graph.json` after the flatten. The tool was removed wholesale
in `a5f7d95` (#1413), so the command no longer exists and `git commit -am` here
would commit nothing while appearing to succeed.

### PR shape

One PR to `dev`, three commits: pure move, mechanical rewrite, graph refresh. The
first two are the HP-1 structural review. `dev` is PR-only with 0 required
approvals, so it is self-mergeable — but **do not merge before required checks
are pinned** (B1-0), or this PR can merge red, which is exactly the risk it
carries.

## B1-2 — Truth, entry points, and contributor path

Covers `RL-17/C-01`, `RL-12/R-06`, the `G-04` remnant, `RL-04/L-04`,
`RL-20/L-14`, and `R-02`. All against post-flatten paths.

1. **One Node source of truth.** Add an `engines` block pinning Node 24 and the
   intended npm major to the root, `Client/`, and
   `tools/mcp-introspect/package.json` (the last is the only existing `engines`
   field and still says `>=20`). Add `.npmrc` with `engine-strict=true` so a
   wrong major fails fast. Fix `README.md`, `docs/contributing.md`,
   `docs/quick-start.md`. Keep `Client/.nvmrc` as the human-facing pin.
2. **`docs/README.md`** — the landing page RL-12 asked for and B0 did not write.
   Active guidance, reference, historical audits, and plans (linking
   `docs/plans/README.md`). Link it from the root `README.md` docs index, which
   today links neither.
3. **The G-04 automated check.** Smallest thing that works: a script that counts
   ledger statuses and fails when an active document states a conflicting count.
   Wire it into `ci.yml` as a fast job. Do not build a document-status framework.
4. **Root command facade (`RL-04`).** Add `bootstrap`, `check`, `check:server`,
   `check:client`, `check:rust`, `format`, `generate`, `release:preflight`.
   Cross-platform: no `make`, no bash-only syntax. **Go-only contributors must
   never need Node** — the facade orchestrates, it does not become the only path.
5. **Hooks (`RL-20`).** Three problems, one a live bug:
   - `.githooks/pre-commit`'s protocol branch guards on `command -v go` rather
     than `make`, so Go-without-`make` reports a false "protocol constants are
     stale" hard failure. Fix first; it is a two-line guard.
   - Give `sqlc-verify` and `protocol-verify` `make`-free equivalents in the root
     facade — `go run ./scripts/genprotocol` plus `git diff --exit-code` already
     works — and update the `ci-check` skill to match.
   - `npm run hooks:install` repoints `core.hooksPath` at `.githooks/`, which has
     no `post-commit`, silently disabling any locally installed one.
     Either ship a chaining `.githooks/post-commit` or document the exclusivity.
6. **Branch policy (`R-02`).** One statement of the branch/PR model. Active
   documents currently disagree.

## B1-3 — Repository hygiene gates

`RL-19/L-13` and `S-05`. Add a root `.editorconfig`, widen Prettier beyond the
client's TypeScript, add `cargo fmt --check`, repository-wide `gofmt`,
`shellcheck`, and `actionlint`. Exclude `Server/db/dbgen/`, the
generated client directory, and the untracked `docs/security-findings/`. **Land
the gate and the reformat as two commits** so the world-reformat diff is
reviewable separately from the rule that caused it.

## B1-4 — Dependency automation

`RL-05/L-05` and `RL-18` (owned by `R-04`/`R-07`). `dependabot.yml` has four
blocks; the gaps are npm at the root and at `tools/mcp-introspect`, plus the
`docker` ecosystem entirely. The two client directory entries also need the
flatten's path rewrite. Record the workspace decision from measured install
behaviour rather than adopting workspaces on principle.

## B1-5 — Ownership moves (one commit each)

- **`RL-09/L-09`** — relocate `docs/protocol-schema.json` to
  `protocol/schema.json` and the generator entry point to the root boundary.
  **Smaller than written:** the one-command verify already exists and is enforced
  three times over. Move a file and re-point its references; do not build a
  verify.
- **`RL-10/L-10`** — **much smaller than written.** `init()` does not fire during
  test discovery. The real item is an untagged `package main` in the module's
  build graph: move it under `Server/cmd/seed/` and shift the `os.MkdirAll` out
  of `init()` into `main()` while there.
- **`RL-11/L-11`** — reclassify the cross-stack tests. **Both directions exist**,
  and the client→server one has three e2e siblings. Decide the tier for the whole
  set; do not move one file and declare the class closed.
- **`RL-13/L-12`** — align the Go module to `github.com/J3vb/OwnCord/Server`.
  Blast radius is bounded and known: 722 occurrences in 344 Go files, plus
  `go.mod`, one `sed` in `Server/Makefile`, two docs, and the ledger pair; zero
  in workflows or the Dockerfile. Own PR, verified like the flatten — scripted
  substitution, empty residual diff.

## B1-6 — Generated artifacts

- **`RL-06/L-06`** — **closed by deletion, before this phase opened.** `a5f7d95`
  (#1413) removed the tool and all 7 tracked files (20,408,656 bytes;
  `graph.json` 19,463,420). Nothing graphify-related is tracked, so the
  "prove portable regeneration, then untrack" sequence has no subject: there is
  nothing left to regenerate and no committed report to drift-check. History was
  not rewritten and is not going to be. B1-6 only retires the dead operational
  steps this plan still carried.
- **`RL-07/L-07`** — **done.** `--check` returned before `render()` and never
  opened `FINDINGS.md`, so a stale 1.09 MB rendering passed the
  `Docs & Ledger Consistency` job cleanly. B1-6 landed the drift check first,
  then untracked the rendering — which removes the drift class entirely rather
  than watching it. `findings-ledger.json` stays the only tracked copy; CI
  renders twice, compares, and uploads the result as an artifact.
- **`RL-08/L-08`** — source is committed; only the gate is missing, and it is
  **blocked by a toolchain conflict** (pinned TinyGo rejects Go 1.26, so a
  compile-and-compare job needs a second Go SDK). The cheaper honest option may
  be to untrack the prebuilt artifact and document the build, rather than run a
  two-SDK CI job for a disabled experimental subsystem.

## B1-7 — Community intake and automation authorization

- **`RL-21/L-15`** — worse than written: the templates are Markdown, not YAML
  issue forms, so nothing is structured, required, or validated, and the
  Environment block hardcodes one OS. Convert to YAML forms; add browser/PWA,
  CPU architecture, and deployment-mode fields; route ideas and feedback to
  Discussions.
- **`RL-22/L-16`** — harden authorization for externally triggered paid
  automation. Impact is bounded today by read-only content permissions. Mechanism
  and fix are coordinated privately per [docs/security.md](../security.md); they
  do not appear in public commits, issues, or PR descriptions.
- **`RL-16/R-09`** — tag publication consumes exact-SHA gate evidence.

## B1-8 — Platform contract map (documentation only)

`RL-02/L-02`. Record the browser-neutral contract folders
(`Client/src/platform/{contracts,browser,desktop}`) and their owners. **No native
behaviour moves in B1.** Adapter extraction is B7 and must not be smuggled in.

## Explicitly out of scope for B1

- Platform adapter extraction, `build:web`, or any browser/PWA work (B7/B8).
- Fixing any of the 38 open `OC-*` findings — B1 only re-points their paths.
- The 471 Oxlint warnings (`C-02`) and bundle budgets (`C-07`/`C-08`).
- The ARM64 release matrix and multi-architecture Docker (`BG-20`, B6).
- Server architecture, database seams, hub lifecycle (B3).
- Renaming `Server/`, lowercasing `Client`/`Server`, or monorepo consolidation —
  the layout audit explicitly rejects all three.
- Rewriting Git history to shrink the removed `graphify-out/` blobs. The files
  are gone from the tree (#1413), but four `graph.json` revisions remain in the
  pack — ~71 MiB logical, ~3.2 MiB packed of 13.28 MiB. They stay.
- Editing dated audit files to match new paths.

## Traps carried forward from B0

- `dev` is PR-only, 0 approvals, enforced on admins. **Required checks are not
  pinned**, so a PR can still merge red until B1-0 lands.
- The CI Docker job is `main`-gated and therefore **skipped on dev PRs**. Produce
  Docker evidence locally; on Git Bash for Windows, `MSYS_NO_PATHCONV=1` is
  required or MSYS path conversion reports a false boot failure.
- `.nvmrc` and CI say Node 24; a local runtime may be newer. Every B0 number was
  measured on Node 26.
- Verify with the `ci-check` skill — but note its `make` commands do not run on a
  plain Windows box, and its client paths change in B1-1.
