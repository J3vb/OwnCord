# Plan: B7-2 — Node/npm support policy settled (Node 26)

**Source PRD**: `docs/plans/b7-shared-client-platform-desktop-parity.prd.md`
**Selected Milestone**: B7-2 — Node/npm support policy settled (roadmap B7
workstream 17, `repo-health-roadmap-2026-08-23.md:989-994`, audit carryover
B1-2).
**Satisfies**: PRD row B7-2 (`prd.md:305`): "Contributors and CI build against
one documented major Node/npm version instead of an open-ended `>=` range that
can drift silently"; PRD workstream row 17 (`prd.md:185`). Workstream 17:
"Verify both an admitted version and a refused unsupported major;
`engine-strict` alone does not turn an open-ended `>=` range into the
documented major-version pin."
**Complexity**: Small
**Drafted**: 2026-09-20 at `dev` `48681909`. In flight beside it: B7-1 (edits
`Client/package.json` `scripts` and the `client-check` job in `ci.yml`) and
B7-3. B7-2 merges first.

**Owner decision 2026-09-20 (confirmed by the owner in session)**: the supported
major becomes **Node 26**, not 24. Reasons: the open range had already drifted — the
owner's machine runs 26.4.0 while CI ran 24, and the B7-0 baseline was measured
on 26; Node is build tooling only (the shipped client is a Tauri webview, the
server is Go), so end users are unaffected; per the Node release schedule
(`https://github.com/nodejs/Release`, read 2026-09-20) v24 leaves active LTS on
2026-10-20 and ends 2028-04-30, while v26 becomes LTS on 2026-10-28 and ends
2029-04-30. Workstream 17's "rather than choosing a new runtime during this
audit" bound the auditor, not the owner.

**Executor rule**: Where this plan proposes a default, apply it. Where a step
needs something you do not have, do not guess: mark the task `BLOCKED` in your
report with the exact error and continue with the next independent task. Never
leave a `<placeholder>` in committed text. You do **not** edit `docs/plans/*`,
`CHANGELOG.md` or any status row.

## Summary

One major, stated once per place it must be stated, and a check that fails
when the places disagree: `engines` `^26` / npm `^11` in the three package
roots, `Client/.nvmrc` `26`, every `actions/setup-node` pin `26`,
`@types/node` `^26`, the five documents that name the version, a
`scripts/check-node-policy.mjs` drift check in the hygiene gate, and one small
CI job that proves a refused major really is refused.

## Verify before you implement

Facts at `48681909`, 2026-09-20.

| Claim                                                          | Status      | Evidence                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three package roots carry `engines`                            | verified    | `package.json:3-6`, `Client/package.json:6-9`, `tools/mcp-introspect/package.json:7-10` — each `"node": ">=24", "npm": ">=10"`                                             |
| `engine-strict` is set in every root                           | verified    | `.npmrc`, `Client/.npmrc`, `tools/mcp-introspect/.npmrc` — identical five lines ending `engine-strict=true`                                                                |
| The `>=` range is a pin                                        | **Refuted** | This machine runs Node `v26.4.0` / npm `11.17.0` and `npm ci` succeeds in all three roots — the range admits any future major                                              |
| `engine-strict` refuses a wrong major for the **root** package | verified    | Probe in a temp dir on Node 26.4.0: `engines.node: "^24"` + `engine-strict=true` → `npm install` exit 1, `EBADENGINE Unsupported engine`; changed to `"^26"` → exit 0      |
| npm's `--node-version` flag can fake the refusal               | **Refuted** | `npm install --dry-run --node-version=23.9.0` exits 0 against `>=24`: the flag does not feed the root-package check. Only a real other-major Node proves refusal           |
| CI pins                                                        | verified    | `node-version: 24` appears 11× in `.github/workflows/ci.yml`, 5× in `release.yml`, 2× in `nightly-test-depth.yml`; no other workflow sets up Node. `Client/.nvmrc` is `24` |
| Types                                                          | verified    | `Client/package.json:48` `"@types/node": "^24.13.3"` is the only `@types/node` in the repo; `npm view @types/node@26 version` → `26.6.2`                                   |
| Documents naming the version                                   | verified    | `README.md:133`, `docs/contributing.md:16`, `docs/contributing.md:359-362`, `docs/quick-start.md:23`, `Client/CLAUDE.md:33`, `.claude/skills/ci-check/SKILL.md:114`        |
| The client suite runs on 26                                    | verified    | `npx vitest run` on Node 26.4.0: 212 files / 5524 tests pass (2026-09-20). Not yet shown on 26: Linux CI runners, Playwright, Stryker, the Tauri builds in `release.yml`   |
| Dependabot will do the `@types/node` major                     | **Refuted** | `.github/dependabot.yml` ignores `semver-major` for all three npm roots                                                                                                    |

## Patterns to Mirror

- A static repo-consistency check with its own test, wired into a gate:
  `scripts/check-tauri-versions.mjs` + `scripts/check-tauri-versions.test.mjs`.
  `scripts/run.mjs:136-137` (inside `CHECK_CLIENT`) shows the step _shape_; the
  new pair goes in `CHECK_HYGIENE` (`:181-211`), which the required
  "Repository Hygiene" CI job runs (`ci.yml:422-459`).
- The `.npmrc` comment block explains _why_; keep it.

## Files to Change

| File                                                                                                               | Action                 | Why                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| `package.json`, `Client/package.json`, `tools/mcp-introspect/package.json`                                         | edit `engines` only    | `"node": "^26"`, `"npm": "^11"`                                            |
| `Client/package.json`                                                                                              | edit `devDependencies` | `"@types/node": "^26.6.2"`                                                 |
| `Client/package-lock.json` (and the other two lockfiles only if `npm install` rewrites their `engines` mirror)     | regenerate             | follows the two edits above                                                |
| `Client/.nvmrc`                                                                                                    | edit                   | `26`                                                                       |
| `.github/workflows/ci.yml`, `release.yml`, `nightly-test-depth.yml`                                                | edit                   | every `node-version: 24` → `26`; `ci.yml` also gains the `node-policy` job |
| `scripts/check-node-policy.mjs`, `scripts/check-node-policy.test.mjs`                                              | create                 | the drift check and its test                                               |
| `scripts/run.mjs`                                                                                                  | edit `CHECK_HYGIENE`   | run the test then the check                                                |
| `README.md`, `docs/contributing.md`, `docs/quick-start.md`, `Client/CLAUDE.md`, `.claude/skills/ci-check/SKILL.md` | edit                   | say 26; say "exactly this major", not "24+"                                |

## Tasks

### Task 1 — the pins

- **Action**: make the `engines`, `.nvmrc` and `node-version:` edits from the
  table. Use `git grep -n "node-version: 24" -- .github/workflows` to find all
  18; afterwards it must print nothing.
- **Gotcha**: in `Client/package.json` touch `engines` and the `@types/node`
  line only — B7-1 edits `scripts` in the same file. Do not change
  `actions/setup-node`'s pinned SHA. Do not add `packageManager` or `volta`
  fields.
- **Validate**: `git grep -n "node-version: 24" -- .github/workflows` prints
  nothing; `git grep -c "node-version: 26" -- .github/workflows` prints
  `ci.yml:11`, `nightly-test-depth.yml:2`, `release.yml:5`.

### Task 2 — types and lockfiles

- **Action**: `cd Client && npm install` (Node 26 is what this machine runs, so
  the new `^26` admits it). Then `npm install` in the repo root and in
  `tools/mcp-introspect` so each lockfile's mirrored `engines` block matches.
- **Gotcha**: `postinstall` runs `patch-package --error-on-fail`; if it fails,
  that is BLOCKED, not something to skip with `--ignore-scripts`. The lockfile
  diff must contain only `@types/node`, its `undici-types` dependency
  (`@types/node` 26 wants `~8.9`, the lock has `7.18.2`) and the `engines`
  mirror — if anything else moved, record BLOCKED with the extra hunks pasted
  in. Do **not** fall back to `npm install --package-lock-only`: it writes the
  lockfile without installing, so the typecheck below would run against the old
  `@types/node` and pass for the wrong reason, and it skips `patch-package`.
- **Validate**: `cd Client && npm run typecheck && npm run typecheck:build && npm run typecheck:e2e`
  all exit 0 (the new Node types can surface real errors — fix them at the call
  site, never with `any` or `@ts-expect-error`); `npm test` reports 5524 or
  more passed, 0 failed.

### Task 3 — the drift check

- **Action**: `scripts/check-node-policy.mjs` — plain Node, no dependencies.
  It reads the supported major from `Client/.nvmrc` — parsed as
  `readFileSync(path, "utf8").trim().replace(/^v/, "").split(".")[0]` (the file
  ends in a newline) — and fails (exit 1, one line per mismatch) unless: each of
  the three `package.json` has `engines.node === "^<major>"`; all three
  `engines.npm` values are byte-identical and match `/^\^\d+$/` (the check
  asserts agreement — one root drifting is the failure — not a hard-coded npm
  major); each of the three `.npmrc` contains `engine-strict=true`; every
  `node-version:` value in the workflow files equals the major, with
  surrounding quotes stripped before comparing; `Client/package.json`'s
  `@types/node` range starts with `^<major>.`. Enumerate workflows with
  `git ls-files ".github/workflows/*.yml" ".github/workflows/*.yaml"`, not a
  filesystem glob. Export the pure checking
  function and test it in `scripts/check-node-policy.test.mjs` with `node:test`
  using in-memory inputs: one passing fixture, and one failing fixture per rule
  (a `>=` range, three `engines.npm` that disagree, a missing `engine-strict`,
  a stray `node-version: 24`, a mismatched `@types/node`), plus passing
  fixtures for a quoted pin (`node-version: "26"`) and a `v26\r\n` `.nvmrc`.
  Make the script importable the way `scripts/check-tauri-versions.mjs:40,76`
  does — `export function …` plus
  `if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))`
  — **not** `import.meta.main`. In `scripts/run.mjs` add at the **end of
  `CHECK_HYGIENE`** (`:181-211`, beside `check-release-environment`; not
  `CHECK_CLIENT`, which B7-1 is editing):
  `step("node", ["--test", "scripts/check-node-policy.test.mjs"])` and
  `step("node", ["scripts/check-node-policy.mjs"])`.
- **Why**: "one documented major" stays true only if disagreement fails a gate
  that already runs on every PR.
- **Gotcha**: read `CHECK_HYGIENE` before editing it; if the hygiene task is
  assembled differently from `CHECK_CLIENT`, follow its existing shape. No YAML
  parser — a line regex for `node-version:\s*(\S+)` is enough.
- **Validate**: `node --test scripts/check-node-policy.test.mjs` passes;
  `node scripts/check-node-policy.mjs` exits 0; change `Client/.nvmrc` to `24`,
  confirm exit 1 listing every disagreeing file, restore `26`.

### Task 4 — the refused-major proof in CI

- **Action**: add to `.github/workflows/ci.yml` a job `node-policy` named
  "Node policy (refused major)", `runs-on: ubuntu-latest`, same checkout and
  `actions/setup-node` SHA as the other jobs but `node-version: 24` — write it
  as `node-version: "24"` **with quotes and a trailing comment**
  `# deliberately NOT the supported major` — and one step with `shell: bash`
  whose script starts `set -uo pipefail` (**not** `-e`: GitHub's default bash
  runs with `-e`, and the first expected failure would abort the step). For
  each `d` of `.`, `Client`, `tools/mcp-introspect` it runs
  `out=$(cd "$d" && npm ci --ignore-scripts 2>&1); rc=$?` — `rc` captured before
  any pipe — and fails the job, echoing `$out`, unless `rc` is non-zero **and**
  `$out` contains `EBADENGINE`. Never add `continue-on-error` to this job: a
  green `node-policy` must mean three refusals, not three skips.
- **Why**: workstream 17 asks for a refused major to be verified, and only a
  real other-major Node can do it (see the Verify table).
- **Gotcha**: Task 3's regex must not count this job's pin as drift — make the
  check skip a `node-version:` line that carries the
  `deliberately NOT the supported major` comment, and cover that in the test.
  `--ignore-scripts` is correct **here only**: the install is meant to fail
  before any script runs. Do not add the job to any required-checks list.
- **Validate**: run `actionlint .github/workflows/ci.yml` if `actionlint` is on
  PATH (exit 0); if it is not, say so in the report — the job is then proven
  only by the PR's own CI run, which the orchestrator checks.
  `node scripts/check-node-policy.mjs` still exits 0.

### Task 5 — documents

- **Action**: update the six places in the Verify table, plus two code
  comments outside it: `Client/vitest.config.ts:10` ("CI's Node 24" → "CI's
  Node 26") and `scripts/verify-gate-evidence.mjs:147-149` (its rationale says
  `import.meta.main` "needs Node 24.2 while package.json's engines floor is
  > =24" — the floor is now `^26`, where it is always defined; keep the
  > `argv[1]` guard, correct the stated reason). Replace "24+" wording
  > with the policy: exactly Node 26.x and npm 11.x; a different major fails
  > `npm ci` by design; `Client/.nvmrc` is the source of truth and
  > `node scripts/check-node-policy.mjs` checks the rest against it. In
  > `docs/contributing.md:359-362` name the drift check and the `node-policy` job.
- **Gotcha**: `.claude/skills/ci-check/SKILL.md` also carries stale test counts
  ("192 files / 5257 tests") — out of scope; change only its Node wording.
- **Validate**: `git grep -nE "Node(\.js)? ?24|node 24|>=24" -- README.md docs/contributing.md docs/quick-start.md Client/CLAUDE.md .claude/skills Client/vitest.config.ts scripts/verify-gate-evidence.mjs`
  prints nothing.

### Task 6 — final gate

- **Action**: from the repository root, `node scripts/run.mjs check:hygiene`,
  `node scripts/run.mjs check:client`, `npx prettier --check .`. Capture exit
  codes before any pipe.
- **Validate**: all exit 0.

## Validation

```bash
git grep -n "node-version: 24" -- .github/workflows          # nothing
node --test scripts/check-node-policy.test.mjs               # pass
node scripts/check-node-policy.mjs                           # exit 0
cd Client && npm run typecheck && npm test                   # 0, 5524 passed
node scripts/run.mjs check:hygiene && node scripts/run.mjs check:client
npx prettier --check .
```

## Risks

| Risk                                                                           | Likelihood | Impact | Mitigation                                                                                                                                       |
| ------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A CI job that was green on 24 is red on 26 (Playwright, Stryker, Linux runner) | Medium     | Medium | The PR's own CI run is the test; report any red job with its log excerpt rather than reverting the pin                                           |
| The Tauri release build has never run on 26                                    | Medium     | High   | `tauri-build` runs only on PRs to `main`; the orchestrator sequences this merge clearly before or after the B6-12 tag rehearsal, never during it |
| `@types/node` 26 surfaces type errors                                          | Low        | Low    | Fix at the call site (Task 2)                                                                                                                    |
| Merge conflict with B7-1 in `Client/package.json` / `ci.yml`                   | Medium     | Low    | This plan touches `engines`, one devDependency line, `node-version:` lines and one new job; B7-2 merges first                                    |

## Out of scope

- Adding `node-policy` to branch protection (owner settings action,
  `docs/plans/b0-dev-branch-protection.sh`). A Node version manager for the
  owner's machine. Workspaces. `packageManager`/corepack. Rust/Go toolchain pins.
- `docs/plans/*`, register rows, CHANGELOG.

## Open questions for the owner

- Should `node-policy` become a required check? Default applied: no — it is a
  hard-failing job visible on every PR; HP-7 can promote it.

## Acceptance

- [ ] `engines` is `^26` / `^11` in all three roots; `.nvmrc` is `26`; the 18 supported-major pins are `26`, plus exactly one `node-version: "24"` line carrying the `deliberately NOT the supported major` comment
- [ ] `@types/node` `^26`; lockfile diff limited to that and the `engines` mirror; typechecks and 5524 tests green
- [ ] `check-node-policy.mjs` + test exist, run in `check:hygiene`, and fail on each of the four drift kinds
- [ ] `node-policy` job asserts `EBADENGINE` in all three roots on Node 24 and is ignored by the drift check
- [ ] No document says "Node 24" or "24+"
- [ ] `check:hygiene`, `check:client`, `prettier --check` exit 0
