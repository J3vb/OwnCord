# B7-0 client baseline

**Measured:** 2026-09-19
**Base commit:** `058fbabb` (`dev`, after PR #1625)
**Branch:** `feat/b7-0-verify-and-baseline`
**Plan:** `.claude/plans/b7-0-verify-and-baseline.plan.md`, Task 1
**Supersedes, for the client only:** the client rows and the bundle table in
[b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md)

Every number below was produced in this session by the command printed next to
it, on the tree at the base commit plus this branch's own changes (the
`probe_credential_store` deletion is the only change that moves a number, and
it is called out where it does). Nothing is copied from B0; B0's figure is
shown beside each row only for comparison. This is the baseline B7-1 (gates),
B7-7 (budgets) and B7-8 (mutation) ratchet against.

## Environment

| Tool                       | Version                 | Note                                                                                          |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| Node / npm                 | 24.21.0 / 11.19.0       | Installed with nvm for this session; matches the CI pin (24). The container default is 22.    |
| Vitest / Vite / TypeScript | 4.1.11 / 8.2.2 / 6.0.3  | Unchanged from B0.                                                                            |
| oxlint / eslint / prettier | 1.80.0 / 10.9.1 / 3.9.6 | oxlint and eslint moved one patch since B0 (1.79.0 / 10.9.0).                                 |
| Playwright                 | 1.62.1                  | Browsers from `/opt/pw-browsers`; nothing downloaded.                                         |
| cargo / rustc              | 1.94.1                  | Tauri system libraries installed with the same `apt-get` line as CI's `rust-tests` job.       |
| Client version             | 1.2.0-alpha.4           | `Client/package.json`.                                                                        |
| Machine                    | 4 vCPU, 15 GB, x86_64   | A cloud container; timings below are not comparable to a developer machine and are not gated. |

## Measured results

| Measure                                                 | Value                                                         | B0 (2026-08-25)                   | Provenance |
| ------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------- | ---------- |
| Unit + integration tests                                | **5501 passed / 205 files, 0 failed**                         | 5257 / 192                        | measured   |
| All vitest suites (unit+int+contract)                   | **5524 passed / 212 files, 0 failed**                         | —                                 | measured   |
| Coverage — statements                                   | **93.99 %** (15843/16855)                                     | never recorded                    | measured   |
| Coverage — lines                                        | **95.55 %** (14891/15583)                                     | never recorded                    | measured   |
| Coverage — functions                                    | **91.97 %** (2669/2902)                                       | never recorded                    | measured   |
| Coverage — branches                                     | **86.49 %** (7003/8096)                                       | never recorded                    | measured   |
| Coverage floor gate                                     | ok — statements 93.99 % against floor 70 %                    | —                                 | measured   |
| oxlint warnings (`oxlint src/`)                         | **547**, exit 0                                               | 471                               | measured   |
| knip hints                                              | **0** (empty output, exit 0)                                  | "four configuration hints" (C-05) | measured   |
| Production import cycles (madge)                        | **22**                                                        | "four" (C-11, no tool)            | measured   |
| Playwright — default config                             | 292 tests in 41 files                                         | 293 passed (full suite)           | measured   |
| Playwright — `prod` config                              | 292 tests in 41 files                                         | —                                 | measured   |
| Playwright — `native` config                            | 82 tests in 14 files                                          | —                                 | measured   |
| Playwright — `fullstack` config                         | 16 tests in 5 files                                           | —                                 | measured   |
| Playwright — `admin` config                             | 1 test in 1 file                                              | —                                 | measured   |
| Stryker dry run                                         | 76 files, 12 822 mutants, initial run 5412 tests in 2 m 48 s  | 67.04 % score, stale (C-16)       | measured   |
| Mutation score                                          | **not measured** — B7-8's milestone (PRD open question 5)     | 67.04 % (stale)                   | deferred   |
| Files importing `@tauri-apps`                           | **21**                                                        | 20 claimed in `Client/CLAUDE.md`  | measured   |
| Distinct `invoke` names                                 | **29**                                                        | 29                                | measured   |
| `#[tauri::command]` attributes                          | **33** (34 before the `probe_credential_store` deletion)      | 34                                | measured   |
| `generate_handler!` entries                             | **31** (30 unconditional + `open_devtools` behind `devtools`) | 32 before the deletion            | measured   |
| Rust tests                                              | 152 passed, 0 failed; `cargo clippy --all-targets` clean      | 115, carried                      | measured   |
| Colocated `src/**/*.test.ts`                            | 0 (glob already in `vitest.config.ts`)                        | —                                 | measured   |
| Test files: unit / contract / int / browser / e2e specs | 203 / 7 / 2 / 1 / 61                                          | —                                 | measured   |
| Startup time                                            | **not measurable here** — see "Startup and memory"            | never recorded                    | unverified |
| Memory                                                  | **not measurable here** — see "Startup and memory"            | never recorded                    | unverified |

### Bundle sizes (measured)

`cd Client && npm run build`, then for each `dist/assets/*` file:
`wc -c < FILE` (minified) and `gzip -9 -c FILE | wc -c` (gzip). Vite's own
report uses a lower gzip level, so its numbers differ by a few percent; the
`wc`/`gzip -9` figures are the ones this file records, and the B0 column is
Vite's report at B0.

| Chunk                        |    Minified |        Gzip | B0 gzip (Vite report) |
| ---------------------------- | ----------: | ----------: | --------------------: |
| `livekitSession`             | 2,003,590 B | 1,358,532 B |           1,344.96 kB |
| `livekit`                    |   516,588 B |   131,982 B |             127.88 kB |
| `index`                      |   213,502 B |    67,575 B |              59.07 kB |
| `MainPage`                   |   185,879 B |    56,644 B |              58.92 kB |
| `style` (css)                |   103,751 B |    18,349 B |                     — |
| `livekit-client.e2ee.worker` |    94,339 B |    28,759 B |                     — |
| `SettingsOverlay`            |    49,561 B |    14,854 B |              13.98 kB |
| `window`                     |    13,339 B |     3,222 B |                     — |
| `screenShare`                |     6,895 B |     2,388 B |                     — |

Startup path (everything loaded before the connect page renders) is `index`
plus `style`: about 86 kB gzip. `MainPage` and `SettingsOverlay` are
route-level lazy chunks; `livekitSession` (which statically pulls in RNNoise,
`Client/src/lib/noise-suppression.ts:13`) and `livekit` are loaded on the
first voice action. The `index` chunk grew from 59 kB to 68 kB gzip since B0.

## Commands and notes per measure

### Tests and coverage

```bash
cd Client && npx vitest run tests/unit tests/integration    # 5501 / 205 files
cd Client && npm run test:coverage                          # 5524 / 212 files, writes coverage/coverage-summary.json
node -e "const s=require('./Client/coverage/coverage-summary.json').total; console.log(s.statements.pct, s.lines.pct, s.functions.pct, s.branches.pct)"
cd Client && bash scripts/coverage-floor.sh                 # coverage-floor: ok statements 93.99% (floor 70%)
```

The B0 figure (5257 / 192) was unit + integration, so the first command is the
comparable one. The coverage percentages are the first ever recorded for the
client; the floor (`Client/coverage-floor.json`, 70.0) sits 24 points below the
measured value, which is what B7-1's ratchet (PRD open question 9) starts from.
`vitest.config.ts` excludes `src/**/*.d.ts`, `src/main.ts`,
`src/pages/MainPage.ts` and `src/lib/noise-suppression.ts` from the
denominator; the numbers above are with those exclusions in place.

### Lint and static gates

```bash
cd Client && npx oxlint src/     # "Found 547 warnings and 0 errors", exit 0
cd Client && npx knip            # no output, exit 0
```

oxlint rose from 471 to 547 warnings since B0 with the same
`Client/.oxlintrc.json` (suspicious and perf categories at `warn`). Nothing
gates the count. The knip row in the register (C-05, "four configuration
hints") is stale: `knip.json` produces no hints today.

### Import cycles

```bash
cd Client && npx --yes madge --circular --extensions ts --ts-config tsconfig.json src
```

22 circular dependencies across 166 files. `--ts-config` is required: without
it madge drops every `@lib/*`, `@stores/*`, `@components/*`, `@pages/*` edge
and undercounts. The register's C-11 row says "four production import cycles";
that figure had no tool behind it and is superseded by this measurement. The
cycles fall into four families: `stores/auth.store.ts` → `lib/livekitSession.ts`
→ (`audioElements`, `livekitE2EE`, `livekitDiagnostics`, `roomEventHandlers`)
→ back into the stores; `message-list/attachments.ts` → `media.ts` →
`content-parser.ts` → (`custom-emoji`, `embeds`, `mentions`,
`channel-navigation` → `SidebarDmHelpers` → `DmSidebar`); `auth.store.ts` →
`notifications.ts` → `avatar.ts` → `attachments.ts`; and four
component-to-subcomponent back-edges (`ChannelSidebar`/`drag-reorder`,
`MessageList`/`renderers`/`reactions`, `SettingsOverlay`/`AccountTab`,
`SettingsOverlay`/`LogsTab`) plus `logger.ts` ↔ `preferences.ts`. No tool in
this repo gates import cycles; madge was run as a one-off measurement and is
not added to `package.json` or CI here (B7-1 decides the gate).

### Playwright

```bash
cd Client && npx playwright test --list | tail -1
cd Client && npx playwright test --list --config playwright.config.prod.ts | tail -1
cd Client && npx playwright test --list --config playwright.config.native.ts | tail -1
cd Client && npx playwright test --list --config playwright.config.fullstack.ts | tail -1
cd Client && npx playwright test --list --config playwright.config.admin.ts | tail -1
```

Counts are listed, not run: the E2E suites need a server and, for `native`, a
desktop build, neither of which this container has. CI runs them on every PR.
B0's "293 passed" was one run of the default config at that time.

### Mutation

```bash
cd Client && npm run test:mutate:dry
```

The dry run instruments 76 of 734 files (`src/lib/**`, `src/stores/**`) into
12 822 mutants and completes its initial test run (5412 tests, 2 m 48 s, two
runner processes). The mutation score itself is not measured here: the full run
is B7-8's deliverable and its CI placement is PRD open question 5. C-16's
67.04 % remains the last recorded score and remains stale.

### Lifecycle sites

```bash
cd Client && grep -rl 'new AbortController' src --include=*.ts | grep -v '\.test\.ts' | wc -l            # 45
cd Client && grep -rlE 'new AbortController|AbortSignal' src --include=*.ts | grep -v '\.test\.ts' | wc -l  # 68
cd Client && for p in 'setTimeout(' 'setInterval(' 'clearTimeout(' 'clearInterval(' 'addEventListener(' 'removeEventListener('; do printf '%s %s\n' "$p" "$(grep -rF "$p" src --include=*.ts | grep -v '\.test\.ts' | wc -l)"; done
# setTimeout( 69, setInterval( 7, clearTimeout( 67, clearInterval( 7, addEventListener( 392, removeEventListener( 28
cd Client && grep -rl 'lib/disposable\|/disposable"' src --include=*.ts | grep -v '\.test\.ts' | grep -v 'lib/disposable.ts' | wc -l   # 4
```

76 timer-creation sites, 74 explicit clears; 392 listener registrations against
28 explicit removals (the rest rely on `AbortSignal`); `lib/disposable.ts` has
four consumers. `Client/tests/setup.ts` still has no `afterEach` and asserts no
leaks. These are B7-11's starting numbers.

### Native seam

```bash
git grep -l "@tauri-apps" -- 'Client/src/**' | wc -l                                   # 21
grep -rc '#\[tauri::command' Client/src-tauri/src | awk -F: '{s+=$2} END {print s}'   # 33 (34 before Task 3)
sed -n '/generate_handler!\[/,/\]/p' Client/src-tauri/src/lib.rs | grep -c '::'       # 31 (32 before Task 3)
cd Client && npx vitest run tests/unit/platform-contracts-counts.test.ts               # 3 passed
```

`docs/architecture/platform-contracts.md` now carries the corrected inventory
(Task 2): the native-proxy sites are `lib/httpProxy.ts` and
`lib/livekitUrlResolver.ts`, `lib/pendingMessages.ts` joins the secret-storage
cluster, `store_cert_fingerprint` and `ptt_get_key` never existed, and
`get_cert_fingerprint` is the one registered handler without a production
caller (kept, PRD open question 11).

### Rust

```bash
cd Client/src-tauri && cargo fmt --check && cargo clippy --all-targets && cargo test   # 152 passed
```

Run after deleting `probe_credential_store` (Task 3); the deletion also removed
the now-unused `Backend` import from `credentials.rs`.

### Startup and memory

**Amended 2026-09-20 (owner decision): startup and memory measured on a real desktop.**

Measured on a Windows 11 developer desktop with `cd Client && npm run tauri dev`
(Vite dev server, not a production build): time-to-connect-page was **598 ms**,
navigation start to the connect form's first paint, read from the WebView2
devtools Performance timeline. Largest contentful paint landed in the same frame
(0.60 s), so the connect form is what paints first and no splash precedes it.
The WebView held **380 MB** RSS across its six processes after 60 s idle on the
connect page; `owncord-client.exe` itself, a seventh process, held 42 MB. One
correction to the method above: `tauri dev` runs `cargo run
--no-default-features`, and the devtools entry point is the `open_devtools`
command behind the `devtools` cargo feature, so `npm run tauri dev -- --features
devtools` is required — without it F12, Ctrl+Shift+I and the in-app DevTools
button all fail silently. Roadmap entry gate item 3 ("desktop behavior, bundle,
startup, memory, and test baselines are recorded") is therefore satisfied; every
half is recorded above.

## What this changes for later milestones

- **B7-1** ratchets from 547 oxlint warnings (not 471), 0 knip hints, 22 import
  cycles (not four) and a 93.99 % statement coverage against a 70 % floor.
- **B7-7** budgets against the gzip column above; the `index` chunk already grew
  9 kB gzip since B0, which is the kind of drift a budget exists to catch.
- **B7-8** owns the mutation score; the dry run proves the harness runs.
- **B7-11** starts from 45 ad-hoc `AbortController` owners and 392/28
  listener add/remove sites.
- **HP-7** cannot cite a startup or memory baseline until someone runs the
  method above on a real desktop and appends the numbers to this file.

## B7-7 bundle-budget baseline (2026-09-20)

**Amended 2026-09-20 (owner decision): the gzip tool is Node
`zlib.gzipSync` at level 9, not the `gzip -9` CLI.** Decision 10 named
`gzip -9`; this keeps the level and format but pins the implementation —
the CLI differs between GNU, macOS and busybox, and a gate people first
meet in CI is a bad gate for a Windows-first desktop app. Node's zlib is
pinned by the repo's own Node ^26 policy and runs identically everywhere,
so `bundle-budget.mjs` needs no `optional()` probe. Both figures for the
same pre-fix `livekitSession` chunk, recorded once as a bridge to the
gzip-CLI column above: CLI `gzip -9 -c` 1,358,542 B, Node zlib-9
1,344,534 B — the spread is well inside the budget headroom.

Measured at `dev` `4c45d26a` (B7-7 base) with
`cd Client && npm run build:budget` — the scratch `--manifest` build whose
`dist-budget/.vite/manifest.json` names every chunk, so the startup payload
is the entry's **static closure** (entry file + static imports + linked
CSS), not a fixed file list:

| Measure                       | Before (barrel import)              | After (deep import, B7-7) | Budget          |
| ----------------------------- | ----------------------------------- | ------------------------- | --------------- |
| Startup closure (zlib-9)      | 87,982 B                            | 87,974 B                  | 90,000 B        |
| `livekitSession` (zlib-9)     | 1,344,534 B (CLI gzip-9: 1,358,542) | 20,192 B                  | 800,000 B       |
| `livekitSession` minified     | 2,003,591 B                         | 78,194 B                  | —               |
| `livekit` (zlib-9)            | 132,225 B                           | 132,225 B                 | 135,000 B, lazy |
| `MainPage` (zlib-9)           | 56,853 B                            | 56,855 B                  | 60,000 B        |
| `AGFzbQ` embedded-Wasm marker | present in `livekitSession`         | absent everywhere         | forbidden       |

The before/after gap is the RNNoise barrel fix (C-07): the barrel re-exported
`createRNNWasmModuleSync`, whose module embeds ~1.9 MB of WASM as base64, and
the package has no `sideEffects` field so it shipped in `livekitSession`
though nothing called it. The deep import keeps the same async factory and the
same runtime `locateFile`/fetch paths — only the import specifier changed.

The startup closure's ~2 kB headroom under the 90 kB ceiling is deliberate
per the ratchet rule (decision 9): thresholds move only with a decomposition
milestone, and B7-9 sets the real ceiling from measurement. The
`livekitSession` budget is the owner's own decision-10 post-decomposition
figure (800 kB) adopted now — 1,400 kB would pass the very barrel regression
this milestone fixes (1,358,542 B CLI gzip-9), and the no-embedded-WASM
marker assertion catches that regression exactly rather than by size.

"Runtime" in the milestone name is bundle-size-only: startup time and memory
have a defined method above and are measured on a real desktop; no
runtime-timing gate is added in CI.

## B7-11 long-session baseline (Task 0 and Task 3, 2026-09-22)

This section is B7-11's PR 11a (instruments, no production file changed) evidence
append: the recount at the 11a base, the ownership classification, the guard
baseline, and the soak calibration. It is an evidence append, not a status row.

### Task 0 recount at the 11a base (`27d3d47d`, from `dev` `e5eb4b19`)

The plan's Verify rows re-derive unchanged at the 11a base:

- `addEventListener(` 409 calls: 288 with `signal`, 28 `once: true`, 93 with
  neither, in 31 files. `removeEventListener(` 29.
- Timers: `setTimeout(` 69 (17 discarded handles), `setInterval(` 7 (all cleared
  in their own file), `clearTimeout(` 68, `clearInterval(` 7.
- `new AbortController` 55 constructions in 45 files. `AbortController` or
  `AbortSignal` named in 71 files.
- Lifecycle primitives: 2 (`lib/disposable.ts`, `lib/sessionScope.ts`).
  `Disposable` is imported by 3 files, `SessionScope` by 2.
- Suite: 274 files, 6 124 passed + 140 expected fail; statements coverage
  94.33 % (16 937 / 17 955). Startup closure 85 678 / 91 000 B, `MainPage`
  57 263 / 60 000 B. (Verify row 11's statement count is unchanged; the row's
  row 6/7/8 numbers are the ones above.)

### Ownership classification (the R1/R3/R4 allowlists)

`tests/unit/lifecycle-ownership.test.ts` pins exact, shrink-only allowlists at
the base:

- **R1** (long-lived-target listeners without `signal`/`once`): 22 sites — 16
  app-lifetime singletons (module-load preference/storage/visibility listeners,
  the `main.ts` bootstrap singletons, `safe-render`'s global handlers) and 6
  per-mount sites paired with a hand-written `removeEventListener`
  (`MemberList`/`MessageInput` outside-click, `deviceManager` devicechange,
  `GlobalKeybinds`, `OverlayManagers`).
- **R3** (discarded `setTimeout` handles): 17 sites, all self-bounded (a
  button-label or error-class reset on a node the caller owns: `AdvancedTab`
  ×5, `LogsTab` ×4, `content-parser` ×2, and one each in `MemberList`, `Toast`,
  `channel-sidebar/context-menu`, `volume-menu`, `lib/context-menu`,
  `LoginForm`).
- **R4** (`new AbortController` outside the two primitives): 53 sites — 8
  cancellation tokens with a named owner (`api.ts` ×3, `profiles.ts`,
  `roomEventHandlers.ts`, `SearchOverlay.ts`, `ConnectionDiagnosticsPanel.ts`,
  `ChannelController.ts`), 5 per-render children, and 40 component/overlay
  lifetimes. 11b moves the lifetimes and children onto `Disposable`, leaving
  the 8 tokens.
- **R2** (intervals): 0 sites fail — every `setInterval` keeps its handle and
  clears it in its own file.

Informational counts printed by the test: 93 bare listeners in 31 files,
`requestAnimationFrame` 16 / `cancelAnimationFrame` 6, 3 observer files
(`MessageList`, `VideoGrid`, `media-visibility`), and 3 native `listen(` sites
under `src/platform/desktop/`.

### Unit lifecycle guard baseline

`tests/helpers/lifecycle.ts` records every non-`once` `window`/`document`
registration and releases each when its signal aborts, so a component that was
never destroyed stays red even though every listener it carries has a signal
(the OC-0335 class). At the base, **14 files** leak and are listed in
`tests/lifecycle-guard-baseline.json`; 11b adds each file's missing teardown and
empties the list. The plan's row 10 counted 20 files with a throwaway probe that
did not release signal-owned listeners, and it also counted jsdom's own
`requestAnimationFrame` timer (jsdom implements rAF on an internal
`setInterval`); the real guard excludes both. Full suite with the guard on: 276
files, 6 139 passed + 140 expected fail.

### Soak calibration

Command: `cd Client && OWNCORD_SOAK_CYCLES=20 OWNCORD_E2E_LIVEKIT_BINARY=tests/e2e/.bin/livekit-server npm run test:e2e:fullstack -- long-session`,
Linux x86_64 Chromium, ~2.3 minutes for the 20-cycle test (the whole
`client-fullstack` suite is 6.0 minutes, inside the config's 20-minute
`globalTimeout`, so no `playwright.config.fullstack.ts` change was needed).

**Bars and why they are phase-grouped.** The plan's cycle logs out and back in
every 10 cycles and samples every 5, so the raw sample series alternates between
the settled mid-session state and the torn-down post-logout state. A single
least-squares slope over that would read the reset, not the app, and give the
mid-session sample no weight (review finding `soak-mid-session-blind`). The bars
therefore group samples like-for-like by their phase in the 10-cycle login
generation (`cycle % 10`): the 5/15/25 series is one mid-session line, the
10/20 series the post-logout line. A metric passes only when every series' slope
is within its ceiling; `documents` and `intervals` must be exactly flat in every
series; heap uses the same per-series last ≤ first × 1.10 with a 25 KB/cycle
slope. Slopes are regressed on the cycle number, so the "per cycle" label is
literal (review finding `slope-units`).

**Ceilings.** `nodes` and `listeners` carry the known logout-path leak (below),
so rather than leaving them at the plan's 0.05 they are ratcheted a small margin
above their measured per-cycle slopes: listeners 0.15/cycle and nodes 2/cycle
(measured 0.1 and 1.6, run-to-run spread 0). Any growth past that fails the PR
soak; 11c's Task 12 fixes the leak and removes the ceilings, returning both to
0.05.

**Five 20-cycle calibration runs** on the uncommitted working tree that became
`7eaa1570` (on top of `03570460`), under the earlier 0.5/8 ceilings. Their
numbers are the committed phase-grouped evaluation's output (the ceilings do not
change what is measured). All five passed; every count metric was identical
across them (run-to-run spread 0 on all counts):

| Run | nodes warm → final (slope) | listeners warm → final (slope) | AbortControllers | heap slope |
| --- | -------------------------- | ------------------------------ | ---------------- | ---------- |
| 1   | 3489 → 3453 (−3.6)         | 192 → 193 (0.1)                | 20               | 9 464      |
| 2   | 3489 → 3453 (−3.6)         | 192 → 193 (0.1)                | 20               | 9 788      |
| 3   | 3489 → 3453 (−3.6)         | 192 → 193 (0.1)                | 20               | 9 391      |
| 4   | 3489 → 3453 (−3.6)         | 192 → 193 (0.1)                | 20               | 9 560      |
| 5   | 3489 → 3453 (−3.6)         | 192 → 193 (0.1)                | 20               | 12 431     |

`documents` 1, `intervals` 1, `timeouts` 1, and sockets/peerConnections/tracks/
audioContexts 0 in every run, all flat. The **LiveKit `error reading from signal
stream … WS closed unexpectedly with code 1006`** console line did **not** appear
in any of the five runs: it is intermittent, emitted when the every-5th-cycle
application reconnect drops the socket LiveKit's signaling connection rides on,
and it is expected because that step deliberately severs the transport. It is on
the named expected-line list (with `[ws] ws_send failed {error: WS is not open}`)
so a run that does see it still passes, while any other `console.error` fails.

**The known leak.** Over 40 cycles with post-reset sampling, the post-logout
series grows monotonically while the mid-session series is flat:

| Cycle (phase)     | nodes                     | listeners             |
| ----------------- | ------------------------- | --------------------- |
| 5 / 15 / 25 / 35  | 3453                      | 211                   |
| 10 / 20 / 30 / 40 | 2102 → 2118 → 2134 → 2150 | 192 → 193 → 194 → 195 |

That is about one listener and 1.6 nodes per logout/login. The soak (and the
ratchet ceilings) are the finding's evidence; 11c writes the regression test and
fixes it.

Two measurement fixes the calibration needed, both in the probe: quiesce drains
one second before sampling (leaving a voice room and closing a socket finish on
microtasks/timers after their synchronous call returns), and `AbortController`s
are counted by `!signal.aborted` rather than reachability (the media probe keeps
every peer, track and socket it sees, so "reachable" never falls — the plan's
own trap).

**Runs at the 0.15/2 ceilings** (`7eaa1570` plus the working-tree change that
sets these ceilings; nothing else differs):

- **Planted control, failed as intended, but on nodes only.** A throwaway
  `window.addEventListener("resize", () => void section)` in the Account tab's
  mount (added on every settings visit, so every cycle) failed the soak on the
  nodes bar (`phase 5: 6087→6207`, 12/cycle against the 2/cycle ceiling). The
  **listeners bar stayed green** (phase 5 `217→217`, worst slope 0.1): the samples
  were c0 191, c5 217, c10 193, c15 217, c20 194. The plant grows listeners
  within a login generation (c5 is +6 over the clean 211), but the soak's
  re-login goes through `login()` in `tests/e2e/fullstack/fixtures.ts`, which
  calls `page.goto("/")`. That is a full navigation, so every 10-cycle generation
  starts on a fresh page and the plant's listeners are dropped. The phase-grouped
  bars compare c5 against c15, both 5 cycles into a fresh page, so a leak that
  only lives within one page cannot move them. Only growth that outlives the
  navigation is visible. This is unresolved in 11a and left to the owner. The
  likely fix is an in-app re-login with no navigation, which needs a fresh
  calibration. The plant was then removed; no production file is changed in 11a.
- **Clean 20-cycle soak, passed.** nodes 3489 → 3453 (−3.6), listeners 192 → 193
  (0.1), AbortControllers 20, heap slope 11 762; documents, intervals and timeouts
  1, and sockets/peerConnections/tracks/audioContexts 0, all flat. These match
  the five calibration runs.
