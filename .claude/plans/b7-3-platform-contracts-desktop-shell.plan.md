# Plan: B7-3 — Platform contracts and the desktop adapter shell

**Source PRD**: `docs/plans/b7-shared-client-platform-desktop-parity.prd.md`
**Selected Milestone**: B7-3 — Platform contracts and the desktop adapter shell
(roadmap B7 workstream 1, `repo-health-roadmap-2026-08-23.md:936-938`;
workstream 16 `:977-988`; layout supplement Phase 4 steps 2 and 4,
`developer-experience-layout-refactor-2026-08-29.md:357-363`, rules `:214-216`).
**Satisfies**: PRD row B7-3 (`prd.md:306`): "Every native-dependent
responsibility has a typed contract and a `platform/desktop` home to move into,
before any code actually moves". Closes the contract half of register row L-02
(`repo-health-issue-register-2026-08-23.md:268`: "The same adapter contract
suite passes for desktop … implementations"). Starts the PRD's top risk
mitigation (`prd.md:395`): "Contract tests written in B7-3 before any call site
moves in B7-4/B7-5; app behavior compared before and after".
**Complexity**: Medium
**Drafted**: 2026-09-20 at `dev` `48681909`; revised the same day after an
adversarial review (seven blocking findings, all folded in below). In flight
beside it: B7-1 (import rule, console guard, knip in `check:client`) and B7-2.
Merge order is B7-2 → B7-1 → B7-3, so this branch is rebased onto both.

**Executor rule**: Where this plan proposes a default, apply it. Where a step
needs something you do not have, do not guess: mark the task `BLOCKED` in your
report with the exact error and continue with the next independent task. Never
leave a `<placeholder>` in committed text. You do **not** edit `docs/plans/*`,
`CHANGELOG.md` or any status row.

## Summary

B7-3 adds three things and moves nothing: (1) `Client/src/platform/contracts/`
— type-only TypeScript interfaces, one per native seam; (2)
`Client/src/platform/desktop/index.ts` — a typed, empty registry that B7-4/B7-5
fill one responsibility at a time; (3) `Client/tests/unit/platform/` —
**behaviour suites** for the contracts whose seam is already an exported
function today, written as a function of "the implementation under test" and
run now against a _legacy binding_ (today's `src/lib` exports, `@tauri-apps/*`
mocked). B7-4/B7-5 re-run the same suites against `platform/desktop`; a suite
green before and after a move is the evidence the move changed nothing.
Contracts whose native call is buried in a private function, a class or a UI
builder get their interface now and their suite in the milestone that creates
the seam.

**No file under `Client/src/lib`, `src/components`, `src/stores`, `src/pages`
or `src/main.ts` changes in this milestone.**

## Verify before you implement

Facts at `48681909`, 2026-09-20.

| Claim                                                       | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client/src/platform/` exists                               | **Refuted**   | Glob finds nothing; `Client/CLAUDE.md`: "does **not** exist yet … Building it is B7"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Platform suites go in `Client/tests/contract/`              | **Refuted**   | `docs/contributing.md:298-303`: that tier is for assertions that read an artifact owned by a _different top-level component_; it holds 7 Server-owned-artifact suites today (e.g. `ws-auth-frame.test.ts`). These suites test `Client/` code → `Client/tests/unit/platform/`. To keep the word "contract test" unambiguous, helper files here are named `*.suite.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| New tests there are picked up; helpers are not run as tests | verified      | `vitest.config.ts` `test.include` is `["tests/**/*.test.ts", "src/**/*.test.ts"]`; `tsconfig.json` `include: ["src","tests"]` typechecks both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 21 native importers, 29 invoke names, 33 handlers           | verified      | pinned by `Client/tests/unit/platform-contracts-counts.test.ts:54-56`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| That count test counts imports                              | **Refuted**   | `:23-26` counts every file under `Client/src` whose **text** contains `@tauri-apps`; `:30-34` matches `invoke("…")` anywhere in file text, comments included. One doc comment naming the package in a new `src/platform` file turns 21 into 22 and fails CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The responsibility list is 14 clusters                      | **Corrected** | `docs/architecture/platform-contracts.md:101-116` has 14 rows while its own prose at `:98` says "Thirteen capability clusters" — and neither covers `open_devtools` (`src/main.ts:86-89`, `settings/AdvancedTab.ts:70`), so the true number is 15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Every native call sits behind an exported function          | **Refuted**   | No exported seam today for: the four `listen` subscriptions in `lib/ws.ts:428-501` (module-private `setupEventListeners`, closure vars `:16-31`); `start_livekit_proxy` (private `LiveKitUrlResolver.ensureLiveKitProxy`, `lib/livekitUrlResolver.ts:26,41`); `lib/window-state.ts` (one export, `initWindowState` `:57`) and the focus check inside `lib/notifications.ts:183`; autostart inside `buildAutostartRow` (`settings/AdvancedTab.ts:235,252`); log-file clearing inside `clearLogFiles` (`AdvancedTab.ts:355-364`); `save`/`writeFile` inside `downloadFile` (`message-list/attachments.ts:647,650`); `getVersion` inside a DOM builder (`settings/LogsTab.ts:135-137`); `openUrl` inside a click listener (`main.ts:99`); `nativePersistence` in `lib/pendingMessages.ts:32-45` (module-private) |
| Two contracts already exist in production                   | verified      | `interface PersistenceBackend` with exported `createTauriBackend()` (`lib/profiles.ts:64,125`); `interface PendingMessagePersistence` (`lib/pendingMessages.ts:26-29`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Roadmap workstream 1 lists "media" and "LiveKit" contracts  | **Corrected** | No `@tauri-apps` import exists for media devices; LiveKit's native surface is the proxy pair, already the "Native proxies" row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Tauri is mocked globally in `tests/setup.ts`                | **Refuted**   | It handles only Web Storage and `scrollIntoView`; each test file mocks what it needs (`tests/integration/client-updater-lifecycle.test.ts:11-13`). `vi.mock` intercepts dynamic `import()` too (`credentials.ts:32`, `identity.ts:31`, `ptt.ts:200`, `window-state.ts:58`, `ws.ts:25`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| knip accepts files only tests import                        | **Refuted**   | `Client/knip.json` `project` is `["src/**/*.ts"]`; tests are not entries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `get_cert_fingerprint` needs a contract method              | **Refuted**   | Registered (`src-tauri/src/lib.rs:111`), no caller in `Client/src/`; decision `prd.md:383`: revisit at B7-5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `check:client` lints the new tests                          | **Refuted**   | `npm run lint` covers `src/` only; the suites are checked by `tsc`, vitest and prettier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Patterns to Mirror

- Mocking shape: `tests/unit/attachments-auth.test.ts:9,25-26`,
  `tests/integration/client-updater-lifecycle.test.ts:11-13`.
- Interface style: `readonly` fields, no classes, no enums —
  `src/lib/updater.ts:11-30`, `src/lib/window-state.ts:17`.

## Design rules (the reviewer checks these)

1. **Contracts mirror the native seam.** A contract method describes one
   native capability and the value its caller receives — parameters and result
   types as production code sees them today. Where an exported function already
   sits at that seam (the `seam` rows below), the contract method has that
   function's exact signature. Do not redesign an API in this milestone.
2. **Host-neutral, down to the text.** No `@tauri-apps` import, no Tauri type,
   no "Tauri"/"invoke" in identifiers — and the literal strings `@tauri-apps`
   and `invoke("` must not appear **anywhere** in any file under
   `src/platform/`, comments included (the count test reads file text). Write
   "the native HTTP plugin", not the package name.
3. **No production imports, no domain types.** Contracts import nothing from
   `@lib/*`, `@stores/*`, `@components/*`, `@pages/*`. Small host result types
   (`UpdateCheckResult`, `WindowRect`, `IdentityPinLookup`) are re-declared,
   structurally identical. A contract never takes a protocol or domain type
   (`ChatMessagePayload`, `ServerMessage`, `ClientMessage`): if it seems to
   need one it is at the wrong altitude — narrow it to the seam
   (`show(title, body, options)`, `send(text: string)`).
4. **Reuse before inventing.** `SettingsStore` is `PersistenceBackend`'s shape
   and `PendingMessageStore` is `PendingMessagePersistence`'s shape, member for
   member. B7-4 deletes the `@lib` copies and imports the contract.
5. **The typechecker is the oracle** (seam rows). Each suite's legacy binding is
   assigned to a variable typed as the contract —
   `const legacy: CredentialStore = { saveCredential, loadCredential, … }` —
   with no cast. If that line needs a cast, the contract is wrong.
6. **Suites assert behaviour, not wiring.** `describe<Name>Suite(makeSubject)`
   sees only `{ subject, native }`, where `native` is a small control handle
   the binding supplies (`native.succeedWith(value)`, `native.failWith(error)`,
   `native.unavailable()`). The suite asserts what the **caller** receives.
   It never mentions a command name. Command-name and argument assertions are
   desktop wiring: they already live in the modules' existing unit tests
   (`tests/unit/credentials*.test.ts`, `updater.test.ts`, `ptt*.test.ts`, …),
   which B7-4/B7-5 keep green. Do not duplicate them.

## Responsibility map

`seam` = an exported function exists at the native boundary today → contract +
suite now. `no-seam` = contract only; the suite lands with the seam.

| #   | Contract file        | Interface(s)                                                                                                    | Today                                                                                                                    | Seam                                                                       | Moves in        |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------- |
| 1   | `http.ts`            | `HttpClient`                                                                                                    | plugin `fetch` called directly in `lib/api.ts:4`, `lib/profiles.ts:10`, `message-list/{attachments,embeds,media}.ts`     | no-seam (a suite over the mocked plugin would test the mock)               | B7-4            |
| 2   | `socket.ts`          | `SocketTransport` — `connect`, `send(text)`, `disconnect`, `acceptCertificate`, four `on…(handler): () => void` | `lib/ws.ts` closure                                                                                                      | no-seam                                                                    | B7-4            |
| 3   | `credentials.ts`     | `CredentialStore`                                                                                               | `lib/credentials.ts` `saveCredential`, `loadCredential`, `loginWithSavedPassword`, `deleteCredential`                    | **seam**                                                                   | B7-4            |
| 4   | `identityStore.ts`   | `IdentityStore`                                                                                                 | `lib/identity.ts:41,69,88,116,158`                                                                                       | **seam**                                                                   | B7-4            |
| 5   | `pendingMessages.ts` | `PendingMessageStore`                                                                                           | `lib/pendingMessages.ts:26-45`                                                                                           | no-seam (`nativePersistence` is private)                                   | B7-4            |
| 6   | `settings.ts`        | `SettingsStore`                                                                                                 | `lib/profiles.ts:64,125` `createTauriBackend()`                                                                          | **seam**                                                                   | B7-4            |
| 7   | `logFiles.ts`        | `LogFiles`                                                                                                      | `lib/logPersistence.ts:22,125,182,195`; `clearLogFiles` in `AdvancedTab.ts`                                              | **seam** for the `logPersistence` exports; the AdvancedTab half is no-seam | B7-4            |
| 8   | `fileSave.ts`        | `FileSaver`                                                                                                     | `attachments.ts:647,650`                                                                                                 | no-seam                                                                    | B7-4 (proposed) |
| 9   | `nativeProxies.ts`   | `NativeProxies`                                                                                                 | `lib/httpProxy.ts` `ensureHttpProxy`; `LiveKitUrlResolver`                                                               | **seam** for `ensureHttpProxy`; LiveKit half no-seam                       | B7-5            |
| 10  | `notifications.ts`   | `Notifier` — `show(title, body, options)`, permission                                                           | `lib/notifications.ts`                                                                                                   | no-seam                                                                    | B7-5            |
| 11  | `window.ts`          | `WindowControl`                                                                                                 | `lib/window-state.ts`, focus check in `notifications.ts:183`                                                             | no-seam                                                                    | B7-5            |
| 12  | `updater.ts`         | `AppUpdater`, `Autostart`                                                                                       | `lib/updater.ts` `checkForUpdate`, install + `subscribeToUpdateInstall`, relaunch; autostart in `AdvancedTab.ts:235,252` | **seam** for `AppUpdater`; `Autostart` no-seam                             | B7-5            |
| 13  | `opener.ts`          | `UrlOpener`                                                                                                     | `lib/admin-panel.ts`, `main.ts:99`                                                                                       | no-seam                                                                    | B7-5 (proposed) |
| 14  | `pushToTalk.ts`      | `PushToTalk`                                                                                                    | `lib/ptt.ts:167,330,372,429`                                                                                             | **seam**                                                                   | B7-5            |
| 15  | `deepLinks.ts`       | `DeepLinks`                                                                                                     | `lib/deep-link.ts:121` `initDeepLinks`                                                                                   | **seam**                                                                   | B7-5            |
| 16  | `appMetadata.ts`     | `AppMetadata`                                                                                                   | `settings/LogsTab.ts:135-137`                                                                                            | no-seam                                                                    | B7-5            |
| 17  | `devTools.ts`        | `DevTools`                                                                                                      | `main.ts:86-89`, `AdvancedTab.ts:70`                                                                                     | no-seam                                                                    | B7-5            |

Eight suites: rows 3, 4, 6, 7, 9 (`ensureHttpProxy`), 12 (`AppUpdater`), 14, 15.
Line numbers are pointers — open each file and read the real call first. If a
`seam` row turns out to have no usable export, downgrade it to `no-seam`, say
so in the report, and move on.

## Files to Change

| File                                                      | Action | Why                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Client/src/platform/contracts/*.ts` (the 17 files above) | create | type-only contracts                                                                                                                                                                                                      |
| `Client/src/platform/contracts/index.ts`                  | create | `export type { … } from "./…"` re-exports and `interface Platform` with one readonly member per interface                                                                                                                |
| `Client/src/platform/desktop/index.ts`                    | create | `export const desktop: Partial<Platform> = {};` and a header comment: filled by B7-4/B7-5                                                                                                                                |
| `Client/tests/unit/platform/<name>.suite.ts` (8)          | create | `describe<Name>Suite(makeSubject)`                                                                                                                                                                                       |
| `Client/tests/unit/platform/<name>.legacy.test.ts` (8)    | create | mocks, legacy binding typed as the contract, `native` handle, the call to the suite                                                                                                                                      |
| `Client/knip.json`                                        | edit   | add `"src/platform/**"` to `ignore`                                                                                                                                                                                      |
| `docs/architecture/platform-contracts.md`                 | edit   | fix `:98` "Thirteen"; add the missing dev-tools cluster; new section "Contracts (B7-3)" — the map above, the six rules, which rows have suites, and that B7-4 removes the knip ignore with the first production consumer |
| `Client/CLAUDE.md`                                        | edit   | replace the "`src/platform/` does **not** exist yet" bullet: contracts and an empty desktop registry exist; call sites move in B7-4/B7-5; feature code must not import `platform/desktop` yet                            |

## Tasks

### Task 1 — contracts for the B7-4 group (rows 1–8)

- **Action**: for each row read every call site, write the interface, add it to
  `contracts/index.ts` and `Platform`.
- **Gotcha**: `tsconfig.json` has `isolatedModules: true` — every re-export in
  `index.ts` must be `export type { X } from "./x"`; a plain `export { X }` of a
  type is a compile error. `CredentialStore` and `IdentityStore` keep the
  "not running natively" outcome exactly as callers see it today (`false` /
  `null` / `"no-store"`), not as a thrown error.
- **Validate**: `cd Client && npm run typecheck` exits 0;
  `git grep -nE "@tauri-apps|invoke\(\"" -- Client/src/platform` prints nothing.

### Task 2 — contracts for the B7-5 group (rows 9–17)

- **Action**: as Task 1.
- **Gotcha**: `PushToTalk` mirrors the four exported functions of `lib/ptt.ts`,
  not its module state. `AppUpdater` delivers progress through a listener today
  (`subscribeToUpdateInstall`); keep that shape.
- **Validate**: as Task 1.

### Task 3 — desktop shell

- **Action**: create `src/platform/desktop/index.ts` as specified.
- **Validate**: `npm run typecheck` exits 0;
  `npx vitest run tests/unit/platform-contracts-counts.test.ts` passes
  (21 / 29 / 33 unchanged).

### Task 4 — eight behaviour suites with legacy bindings

- **Action**: per `seam` row, per method, the suite asserts what the caller
  receives when (i) the native layer succeeds, (ii) it rejects, (iii) it is
  unavailable, for modules that have a not-native guard. Assert what happens
  **today**, even where it looks wrong. One commit per row.
- **Why**: this is the before/after evidence for B7-4/B7-5.
- **Gotcha**: if today's behaviour looks like a defect, do not fix it and do not
  weaken the assertion: pin it, add `// B7-3: pinned as-is — see report`, and
  list it in the report. If B7-1 has merged into your base, its console guard
  fails tests that log a warning (`credentials.ts:52` warns on the unavailable
  path) — claim those with B7-1's `expectConsole` helper; if B7-1 has not
  merged, ignore this sentence. Reset module caches between tests where a
  module memoises its dynamic import (`vi.resetModules()`).
- **Validate**: `npx vitest run tests/unit/platform` — all pass; `npm test` —
  5524 plus the new tests, none skipped.

### Task 5 — knip, docs

- **Action**: the `knip.json`, `platform-contracts.md` and `Client/CLAUDE.md`
  edits from the file table. Leave untouched the pinned table rows that
  `platform-contracts-counts.test.ts:59-63` reads.
- **Validate**: `npx knip` prints nothing, exit 0; the counts test passes.

### Task 6 — final gate

- **Action**: `node scripts/run.mjs check:client` and `npx prettier --check .`
  from the repository root. Capture exit codes before any pipe.
- **Validate**: both exit 0.

## Validation

```bash
cd Client && npm run typecheck                                   # exit 0
cd Client && npx vitest run tests/unit/platform                  # all pass
git grep -l "@tauri-apps" -- 'Client/src/**' | wc -l             # 21 (repo root)
git grep -nE "@tauri-apps|invoke\(\"|@lib/|@stores/" -- Client/src/platform   # no output
cd Client && npx knip                                            # no output, exit 0
git diff --stat origin/dev -- Client/src/lib Client/src/components Client/src/stores Client/src/pages Client/src/main.ts   # empty
node scripts/run.mjs check:client && npx prettier --check .      # exit 0
```

## Risks

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                                |
| ------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| A contract is tidier than reality, so B7-4's move changes behaviour | Medium     | High   | Rules 1 and 5: the legacy binding must typecheck with no cast                                             |
| A suite asserts the mock rather than behaviour                      | Medium     | Medium | Rule 6: the suite sees only `subject` and `native`, never a command name                                  |
| `no-seam` contracts are wrong and nobody notices until B7-4/B7-5    | Medium     | Low    | They are type-only; the milestone that creates the seam writes the suite first and may amend the contract |
| A comment trips the text-based count test                           | Medium     | Low    | Rule 2 and the `git grep` in Task 1's Validate                                                            |
| Re-declared types drift from `src/lib` before B7-4                  | Low        | Low    | The legacy binding stops compiling the moment they drift                                                  |

## Out of scope

- Moving any call site; implementing any desktop adapter; `platform/browser/`.
- The `@tauri-apps` lint rule and its allowlist (B7-1; B7-4 adds
  `src/platform/desktop/**`). Deleting `get_cert_fingerprint` (B7-5).
- Suites for `no-seam` rows. Fixing defects a suite pins.
- `docs/plans/*`, register rows, CHANGELOG.

## Open questions for the owner

- Rows 8 and 13 (`FileSaver` → B7-4, `UrlOpener` → B7-5) are proposed
  assignments; the PRD names neither. Default applied; B7-4's plan can move them.

## Acceptance

- [ ] 17 contract files + `index.ts` with `Platform`; type-only; no `@tauri-apps`, `invoke("`, `@lib`, `@stores` text under `src/platform/`
- [ ] No contract takes a protocol or domain type; `SettingsStore` and `PendingMessageStore` match the existing interfaces member for member
- [ ] `desktop/index.ts` exports an empty `Partial<Platform>`
- [ ] 8 suites, each a function of `{ subject, native }`, none naming a command; each legacy binding typed as its contract with no cast
- [ ] Zero diff under `src/lib`, `src/components`, `src/stores`, `src/pages`, `src/main.ts`
- [ ] Importer / invoke / handler counts unchanged (21 / 29 / 33)
- [ ] `knip` clean; `platform-contracts.md` (incl. the "Thirteen" fix and the dev-tools cluster) and `Client/CLAUDE.md` updated
- [ ] `check:client` and `prettier --check` exit 0; test count is 5524 + new, none skipped
