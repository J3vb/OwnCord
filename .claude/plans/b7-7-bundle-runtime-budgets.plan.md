# Plan: B7-7 — Bundle and runtime budgets

> **Milestone:** B7-7 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branch:** `feat/b7-7-bundle-runtime-budgets`.
> **Worktree:** `.claude/worktrees/b7-7`.
> **Drafted:** 2026-09-20. **Base commit:** `3634cb0d` (`dev`).

## Summary

The PRD row promises two things: "Startup, route, LiveKit, RNNoise, and
feature-chunk sizes are enforced in CI instead of drifting unnoticed, and
LiveKit/RNNoise no longer load on the startup path"
(`b7-shared-client-platform-desktop-parity.prd.md:313`). Recounted at
`3634cb0d`, the **second half is already true** — the entry chunk's only static
edge is a 1.2 kB `core` helper, and `livekit`, `livekitSession`, `MainPage`,
`SettingsOverlay` and `screenShare` are all `dynamicImports` of `index.html`.
What B7-7 actually owes is the first half: an **enforcement gate** where today
there is none (`repo-health-issue-register-2026-08-23.md:211`, C-08), and the
closure of C-07 (`:210`) whose stated cause is now wrong.

**The cause of C-07 is not "static RNNoise inclusion".** It is a
tree-shaking failure in the `livekitSession` chunk: `noise-suppression.ts:13`
imports the `@jitsi/rnnoise-wasm` **barrel**, whose `index.js:1-7` re-exports
`createRNNWasmModule` and the _unused_ `createRNNWasmModuleSync`. The package
carries no `sideEffects` field, so the sync variant — `rnnoise-sync.js`, a
1,933,102 B file with the WASM embedded as base64 (`AGFzbQ` at offset 6166) —
is pulled into the shipped chunk even though nothing calls it
(`grep -rn createRNNWasmModuleSync src public tests` → only the ambient
declaration). Measured with a one-line deep import, the same chunk falls from
**2,003,591 B min / 1,358,542 B gzip to 78,194 B / 20,142 B gzip** and the WASM
marker disappears from it. The runtime module is unchanged: the async factory
is still imported and its WASM is still fetched from `public/rnnoise.wasm`
(`noise-suppression.ts:81`).

That fix changes the milestone's risk shape. The PRD's "`livekitSession` ≤
1,400 kB until B7-9 lands, then ≤ 800 kB" (decision 10,
`b7-shared-client-platform-desktop-parity.prd.md:386`) was conditioned on B7-9's
decomposition because the chunk could not be met otherwise
(`:407`). With the tree-shake, the chunk is ~20 kB and the 800 kB figure is met
**before** B7-9 — so B7-7 does not block on B7-9, exactly as the risk row
requires.

This is a build-and-gate change. No application behavior changes, only one
import specifier and one ambient declaration, and the budget gate is a new Node
script in the shape of `coverage-floor.sh`.

## Verify before you implement

Every row was re-derived at `3634cb0d` by the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it.

| #   | Claim                                                                                                                                                                                            | How to re-check                                                                                                                                                                                                                                                           | Verified  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | The entry has exactly one static edge, `core` (1.2 kB gzip); `livekit`, `livekitSession`, `MainPage`, `SettingsOverlay`, `screenShare`, `window` are `dynamicImports`                            | `cd Client && npx vite build --config vite.config.desktop.ts --manifest --outDir /tmp/p && node -e 'const m=require("/tmp/p/.vite/manifest.json");console.log(m["index.html"].imports,m["index.html"].dynamicImports)'` (plain `build:desktop` emits no manifest — row 5) | corrected |
| 2   | LiveKit/RNNoise do **not** load on the startup path, contradicting the PRD's bundle-facts paragraph and the milestone row's second clause                                                        | built `Client/index.html` has one `<script type=module>` + one `modulepreload` (`core`) + one CSS link; `main.ts:62-66,943` and `auth.store.ts:129` import `livekitSession`/`MainPage` dynamically                                                                        | refuted   |
| 3   | gzip -9 baselines (`gzip -9 -c FILE \| wc -c`): `livekitSession` 1,358,542; `livekit` 131,982; `index` 68,259; `MainPage` 56,672; `style` 18,349; `core` 1,193; `SettingsOverlay` 14,762         | `cd Client && npm run build:desktop && for f in dist/assets/*.{js,css}; do printf '%s %s\n' "$f" "$(gzip -9 -c "$f" \| wc -c)"; done`                                                                                                                                     | measured  |
| 4   | `@jitsi/rnnoise-wasm` is a barrel that re-exports an unused sync module carrying 1.9 MB of embedded WASM into `livekitSession`                                                                   | `cat Client/node_modules/@jitsi/rnnoise-wasm/index.js`; `grep -rl AGFzbQ Client/dist/assets` → only the `livekitSession` chunk                                                                                                                                            | measured  |
| 5   | Vite emits no manifest by default (`dist/.vite/` absent) and `--manifest` writes `dist/.vite/manifest.json` with `imports`/`dynamicImports`/`isEntry`/`css`                                      | `ls Client/dist/.vite` → absent; `cd Client && npx vite build --config vite.config.desktop.ts --manifest --outDir /tmp/probe && ls /tmp/probe/.vite`                                                                                                                      | measured  |
| 6   | No bundle-budget tool exists anywhere (no `size-limit`, `bundlesize`, `rollup-plugin-visualizer`, `chunkSizeWarningLimit`)                                                                       | `grep -rln "size-limit\|bundlesize\|bundle-budget\|chunkSizeWarningLimit" Client scripts .github` → empty                                                                                                                                                                 | measured  |
| 7   | 12 files statically import `livekit-client`; 3 of those are `import type` only (`connectionDiagnostics`, `connectionStats`, `livekitDiagnostics`)                                                | `grep -rl 'from "livekit-client"' Client/src --include=*.ts \| wc -l` → 12; `grep -rl 'import type.*livekit-client' Client/src --include=*.ts \| wc -l` → 3                                                                                                               | verified  |
| 8   | The `MainPage` _route_ statically pulls `livekitSession` + `livekit` + `screenShare` — a >1.6 MB gzip closure behind a 56 kB chunk name                                                          | `MainPage.ts:39` imports `@lib/livekitSession`; closure sum over the manifest for `src/pages/MainPage.ts` → 1,633,817 B gzip                                                                                                                                              | measured  |
| 9   | `Client Static Checks` is the required check (context `:64`) and is gated on the `client` capability (`ci.yml:412`), which any `Client/` path selects (`ci-select.mjs:204-210`)                  | `docs/plans/b0-dev-branch-protection.sh:61-65`; `.github/workflows/ci.yml:409-412`; `scripts/ci-select.test.mjs` `a modified client file runs the client, browser and native jobs`                                                                                        | verified  |
| 10  | The gzip method is not neutral: `gzip -9 -c FILE` 1,358,542 vs `gzip -9 -n -c` 1,358,515 vs Node `zlib.gzipSync(b,{level:9})` 1,344,534 — a 1 % spread wider than the drift these budgets police | the three commands against the same `livekitSession` file                                                                                                                                                                                                                 | measured  |
| 11  | Startup time and memory are not measurable in this environment; B7-0 recorded that and left the entry gate open for them                                                                         | `docs/plans/b7-0-client-baseline-2026-09-19.md:205-216`                                                                                                                                                                                                                   | verified  |

**Row 2 is the one that changes the milestone.** The PRD's "both currently load
on the startup path" (`:82-85`) and the outcome clause are stale at the base
commit; the enforcement work is real, the relocation work is done. Record it, do
not rebuild it.

## Patterns to Mirror

- **Floor-file + script:** `Client/coverage-floor.json` (the number) plus
  `Client/scripts/coverage-floor.sh:1-62` (the gate). The script fails closed
  (`exit 2`) when its inputs are missing or unparseable, and its header explains
  why the parsing has to understand the format. The budget gate copies this
  shape exactly: `Client/bundle-budgets.json` + `Client/scripts/bundle-budget.mjs`.
- **Node checking Node, in `check:hygiene` or `client-check`:** `ci-select.mjs`,
  `check-node-policy.mjs`, `check-workflow-guards.mjs`. A gate is self-tested and
  lives where an existing required check already runs, so it needs no new
  required context.
- **A gate that cannot fail is not a gate:** B7-3's null-subject probe and B7-6's
  Task 4 both insist on observing red before trusting green. The budget gate is
  proven red by lowering a budget and reverting.
- **`optional()` for tools a contributor may lack:** `scripts/run.mjs:46-52`;
  used for `shellcheck` and `actionlint`. `gzip` may need the same treatment
  locally (row 10).

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                            | Change                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Client/bundle-budgets.json`                    | new: the gzip budgets, one number per named chunk + the startup closure ceiling    |
| `Client/scripts/bundle-budget.mjs`              | new: reads the Vite manifest + emitted files, fails closed over budget             |
| `Client/package.json`                           | add `build:budget` and `check:budgets`; keep `build:desktop` untouched             |
| `Client/src/lib/noise-suppression.ts`           | barrel import → deep import (one line)                                             |
| `Client/src/types/jitsi-rnnoise.d.ts`           | declare the deep module (the barrel declaration does not cover it)                 |
| `Client/.gitignore`                             | add the scratch build directory (`dist-budget/`)                                   |
| `scripts/run.mjs`                               | `CHECK_CLIENT` gains the budget build + check, after coverage                      |
| `.github/workflows/ci.yml`                      | one step inside the existing `client-check` job                                    |
| `docs/contributing.md`                          | the Build & dev and check tables gain the two scripts                              |
| `docs/plans/b7-0-client-baseline-2026-09-19.md` | append the B7-7 re-measured budget baseline (measurement record, not a status row) |

**Never** edit generated files, `Server/**`, `Client/vite.config*.ts` build
semantics, `docs/plans/b7-shared-client-platform-desktop-parity.prd.md` beyond
the one B7-7 plan-link cell (the orchestrator owns the outcome wording),
`CHANGELOG.md`, or any status row.

## Tasks

Commit after every task — conventional subject, scope `b7-7`, one task per
commit, no `Co-Authored-By` trailer.

### Task 0: Baseline and recount

- **Action:** build with the manifest and record every number row 3 asserts,
  using the documented `gzip -9 -c FILE | wc -c` method. Record the startup
  closure (entry + static imports + linked CSS), each named chunk, and the
  `MainPage` static closure. Confirm rows 1, 2 and 4 with the commands in the
  table.
- **Why:** the budgets this milestone writes are derived from these numbers, and
  the milestone's second clause is only knowable from them.
- **Validate:** the recorded `livekitSession` is ~1,358 kB, not ~1,345 kB — the
  1 % spread of row 10 proves which tool produced it. Keep the listing; Task 4
  diffs against it.

### Task 1: The budget gate

- **Action:** write `Client/bundle-budgets.json` with the decision-10 figures —
  startup closure ≤ 90 kB, `MainPage` ≤ 60 kB, `livekit` ≤ 135 kB **and lazy**,
  `livekitSession` ≤ 1,400 kB (Task 4 re-tightens it), plus a `lazy` list for
  `livekit`/`livekitSession` and a `forbidWasmInStartup` assertion. Write
  `Client/scripts/bundle-budget.mjs` to read the built manifest, compute the
  entry's **static closure** (not just `index`+`style`, see the open question),
  gzip each file, compare against the JSON, and exit 2 when the manifest or a
  named chunk is missing. It must print one line per budget with
  actual/budget/verdict.
- **Why:** C-08's closure line is "Recorded gzip budgets fail CI on regression
  and distinguish startup from lazy feature cost"
  (`repo-health-issue-register-2026-08-23.md:211`).
- **Gotcha:** key the budget file on the manifest `name` field, never the hashed
  filename — the hash changes every build. `livekitSession` is
  `name: "livekitSession"`, `MainPage` is `name: "MainPage"`, `livekit` is
  `name: "livekit"`; `index`/`style` are the manifest `index.html` entry file and
  the `.css`-valued entry.
- **Gotcha:** do not add `--manifest` to `build:desktop`. That script is what
  `tauri.conf.json`'s `beforeBuildCommand` runs; adding an emitted
  `.vite/manifest.json` changes the shipped `dist/` that B7-6 Task 3 proved
  unchanged. Add a separate `build:budget` that writes to a scratch dir.
- **Validate:** `cd Client && npm run build:budget && node scripts/bundle-budget.mjs`
  exits 0 and prints every budget. **Prove it can fail:** drop one budget to
  `1` in the JSON, confirm exit 1, restore. Commit.

### Task 2: Wire it into the required check and the local mirror

- **Action:** in `.github/workflows/ci.yml`, inside the existing `client-check`
  job (`:409`), add one step after "Desktop build (Tauri target)" (`:488-489`)
  that runs `npm run build:budget` then `npm run check:budgets`. In
  `scripts/run.mjs`, add the same two steps to `CHECK_CLIENT` (`:135-142`), after
  the coverage step.
- **Why:** no new required check and no selector edit are needed. `client-check`
  is the `Client Static Checks` required context
  (`docs/plans/b0-dev-branch-protection.sh:64`) and it is gated on the `client`
  capability (`ci.yml:412`), which every `Client/**` change selects
  (`ci-select.mjs:204-210`). Riding the existing job keeps the required list
  coherent.
- **Gotcha:** the gate script lives under `Client/scripts/`, **not** root
  `scripts/`. Any path under root `scripts/` selects every capability
  (`ci-select.mjs:161-169`); `Client/scripts/` selects only `client`. Do not
  move it.
- **Gotcha:** `gzip` is on `ubuntu-latest` but not guaranteed on a Windows dev
  box. If the script shells to `gzip`, mirror `run.mjs`'s `optional()` probe so
  the local task prints a SKIP rather than a false failure; in CI it always
  runs. (If the owner picks the Node-zlib method in the open question, this
  disappears.)
- **Validate:** `node scripts/run.mjs check:client` exits 0 and its output shows
  the budget build and the budget lines. `npx actionlint` is skipped locally on
  Windows only; CI runs it. Commit.

### Task 3: The RNNoise dead-sync-WASM fix (C-07)

- **Action:** change `Client/src/lib/noise-suppression.ts:13` from the barrel
  `import { createRNNWasmModule } from "@jitsi/rnnoise-wasm"` to the deep
  `import createRNNWasmModule from "@jitsi/rnnoise-wasm/dist/rnnoise"`, and add
  to `Client/src/types/jitsi-rnnoise.d.ts` a declaration for the deep module
  (the existing block declares the barrel only, and the deep import raises
  `TS7016`). Keep `createRNNWasmModuleSync` declared if the barrel declaration is
  kept; it stays unused.
- **Why:** C-07's closure line is "Load on demand, cache after first use, and
  prove voice/noise restart/fallback behavior"
  (`repo-health-issue-register-2026-08-23.md:210`). The module is already loaded
  on demand and cached (`noise-suppression.ts:41-45` `cachedModule`); this task
  removes the 1.9 MB of dead sync WASM the barrel drags in.
- **Gotcha:** this is the security-relevant file. Lift nothing else — the async
  factory, the `locateFile` mapping to `/rnnoise.wasm` (`:43`) and the
  `/rnnoise-worklet.js` path (`:80`) are unchanged. Verify with the existing
  `noise-suppression-restart.test.ts` and `rnnoise-worklet.test.ts`.
- **Validate:** `npm run build:budget` then `node scripts/bundle-budget.mjs`
  exits 0; the `livekitSession` chunk is ~20 kB gzip and `grep -c AGFzbQ` on it
  is 0; `npm --prefix Client test` count does not drop; `typecheck` and
  `typecheck:build` clean. Commit.

### Task 4: Re-baseline and tighten the ratchet

- **Action:** with the fix landed, re-measure every chunk and rewrite
  `Client/bundle-budgets.json` against the fixed bundle. Replace the
  `livekitSession` 1,400 kB placeholder with the owner's chosen figure (open
  question 2 — the recommended default is decision 10's post-decomposition ≤
  800 kB, now met pre-decomposition). Append the before/after table to
  `docs/plans/b7-0-client-baseline-2026-09-19.md`.
- **Why:** a gate set 70× above the measured value cannot catch a regression —
  the "gate that cannot fail" anti-pattern B7-3 and B7-6 both name. The
  `livekitSession` budget is the one the milestone exists to make honest.
- **Gotcha:** the ratchet rule (decision 9,
  `b7-shared-client-platform-desktop-parity.prd.md:385`) moves thresholds only
  with a decomposition milestone. This is **not** a decomposition; it is a
  tree-shake fix, so the tightened number must be the one the owner already
  chose (≤ 800 kB), not an improvised tighter value. Record the measured value
  beside the budget so B7-9 can ratchet further.
- **Validate:** `node scripts/bundle-budget.mjs` exits 0 at the new numbers;
  prove red by lowering one by 1, restore. `npm --prefix Client run build:desktop`
  still exits 0. Commit.

### Task 5: Documentation and the baseline record

- **Action:** add `build:budget` and `check:budgets` to the Build & dev table
  (`docs/contributing.md:87-88`) and the budget gate to the `check:client` row
  (`:36`). Ensure the appended `docs/plans/b7-0-client-baseline-2026-09-19.md`
  section states the method (`gzip -9 -c`, decision 10) and the before/after.
- **Why:** B7-1 set the precedent that a new gate is documented where the
  commands live; B7-0 set the precedent that budget numbers are recorded once.
- **Validate:** `npx prettier --check --ignore-unknown` on the changed files
  exits 0. Commit.

### Task 6: Final gate

- **Validate:**

  ```
  cd Client && npm run build:budget && node scripts/bundle-budget.mjs
  npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
  npm --prefix Client test
  npm run check:docs
  npm run check:hygiene
  ```

  Then the `ci-check` skill. Commit.

## Validation

```
cd Client && npm run build:budget && node scripts/bundle-budget.mjs   # green, proven red in Task 1/4
npm --prefix Client run build:desktop                                 # bundle unchanged except the RNNoise drop
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
npm --prefix Client test                                              # count not lower
npm run check:docs
npm run check:hygiene
# → then the ci-check skill
```

## Risks

| Risk                                                                                                   | Likelihood | Impact | Mitigation                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| The gate is green only because the budgets sit just above today's value, and cannot catch a regression | High       | Medium | Task 1 proves red by lowering a budget; Task 4 tightens `livekitSession` to the owner's figure and records headroom         |
| The gzip tool drifts between the number recorded and the number checked (1 % spread, row 10)           | Medium     | Medium | Pin one tool in the script and in `bundle-budgets.json`'s method note; the open question settles which                      |
| The deep RNNoise import changes runtime behavior instead of only the bundle                            | Low        | High   | Lift only the specifier; `noise-suppression-restart` and `rnnoise-worklet` suites stay green; WASM still fetched at runtime |
| `--manifest` leaks into the shipped desktop build and moves `dist/`                                    | Medium     | Medium | `build:budget` is a separate script writing to `dist-budget/`; `build:desktop` is untouched                                 |
| The budget step silently never runs because it lands in a skipped job                                  | Low        | High   | It rides `client-check`, the required `Client Static Checks` context, selected by every `Client/**` change (row 9)          |
| A chunk is renamed and the budget file stops matching it                                               | Medium     | Low    | The script exits 2 on a missing named chunk rather than passing over an empty set                                           |

## Out of scope

- **Moving LiveKit/RNNoise off the startup path.** Already done at the base
  commit (row 2); B7-7 verifies and enforces it, it does not redo it.
- **Decomposing `livekitSession.ts`.** B7-9. This milestone only stops the
  barrel from shipping dead WASM.
- **A real "runtime" budget** (startup time, memory, main-thread work). B7-0
  proved neither is measurable in this environment (`:205-216`); long-session
  runtime evidence is B7-11's. See open question 5.
- **Raising the `index`/`livekit` budgets.** Ratchet-only per decision 9/10.
- **`build:web` or any browser target.** B8, deferred post-beta.
- **The PRD outcome wording and the register rows.** The orchestrator owns
  `prd.md` and the register; this plan only links itself into the B7-7 cell.

## Open questions for the owner

- [ ] **The milestone outcome's second clause is already true.** At `3634cb0d`,
      `livekit`/`livekitSession` are `dynamicImports`, not startup imports (row 2),
      and the PRD's bundle-facts paragraph (`:82-85`) says they "currently load on
      the startup path". Amend the B7-7 outcome at PR time to name only enforcement
      (and C-07's closure), or leave the wording and record the refutation in the
      PR description? **Proposed default:** record the refutation in the PR
      description and have the orchestrator amend the row when it links this plan —
      do not rebuild a relocation that already happened.
- [ ] **`livekitSession` budget after the tree-shake.** Decision 10 sets 1,400 kB
      until B7-9, then 800 kB. The fix lands the chunk at ~20 kB, so 1,400 kB is
      ~70× headroom and barely a gate. Keep 1,400 kB as literally decided, or adopt
      the already-decided 800 kB now since it is met pre-decomposition?
      **Proposed default:** adopt ≤ 800 kB (the owner's own post-decomposition
      figure), record the measured ~20 kB beside it, and let B7-9 ratchet further.
      That honours the decision rather than inventing a new number.
- [ ] **Startup budget definition.** Decision 10 defines startup as "`index` +
      `style`" (`:386`). Recounted, the entry's static closure also contains a
      1,193 B `core` chunk (`index.html` preloads it), so the true startup payload is
      87,801 B, not 86,608 B. Gate on `index` + `style` literally, or on the entry's
      full static closure? **Proposed default:** the closure — otherwise a future
      eagerly-imported chunk escapes the budget, which is the exact drift a startup
      budget exists to catch.
- [ ] **Which gzip is authoritative.** Decision 10 says `gzip -9` "as in the
      B7-0 baseline"; the B7-0 numbers used `gzip -9 -c FILE`. Node's `zlib` is
      cross-platform and gives ~1 % lower numbers (row 10), and `run.mjs`'s first
      rule is cross-platform steps. Match the baseline with the `gzip` CLI (ubuntu
      in CI, probed locally), or switch to Node `zlib` and re-baseline?
      **Proposed default:** match the baseline with the `gzip` CLI so the recorded
      numbers stay comparable to B7-0 and decision 10, and probe it locally.
- [ ] **"Runtime" in the milestone name.** No runtime metric is enforceable in
      CI (B7-0 could not measure startup or memory). Confirm B7-7 is bundle-only,
      with runtime evidence deferred to B7-11's long-session work?
      **Proposed default:** yes — bundle-only enforcement, and say so in the plan's
      Out of scope and the PR description, so the milestone name is not a promise a
      later reader assumes was kept.

## Acceptance

- [ ] `Client/bundle-budgets.json` records the startup closure, `MainPage`,
      `livekit` (+ lazy), `livekitSession`, and the no-WASM-on-startup assertion,
      each with the method stated
- [ ] `Client/scripts/bundle-budget.mjs` reads the built Vite manifest, fails
      closed (exit 2) on a missing input, and exits 1 above a budget
- [ ] The gate was **observed failing** on a lowered budget before being trusted
      green
- [ ] The gate runs inside the required `Client Static Checks` job and in
      `npm run check:client`, with no new required context
- [ ] `livekitSession` no longer embeds the unused sync WASM; `AGFzbQ` is absent
      from it and the chunk is ~20 kB gzip
- [ ] `npm --prefix Client test` count is not lower; `typecheck`,
      `typecheck:build`, `check:docs`, `check:hygiene` and the `ci-check` skill are
      green
- [ ] `docs/plans/b7-0-client-baseline-2026-09-19.md` carries the re-measured
      before/after budget baseline, `docs/contributing.md` names the new scripts
- [ ] No application behavior changed beyond the one import specifier; no
      loosened assertion; no new required check
