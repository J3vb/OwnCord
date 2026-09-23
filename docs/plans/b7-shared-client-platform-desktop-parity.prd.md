# B7 — Shared client platform and desktop parity

> **Second phase in the PRD format**, after B6's format trial
> (`docs/plans/b6-server-deployment-operations-capacity.prd.md`). Source of
> truth is still
> ["B7 — Establish the shared client platform and desktop parity"](repo-health-roadmap-2026-08-23.md#b7--establish-the-shared-client-platform-and-desktop-parity);
> [README.md](README.md) remains the status authority. Kept in `docs/plans/`
> rather than ECC's default `.claude/prds/` for the same reason B6 states:
> `.gitignore:9` (`.claude/*`) would leave it untracked.
> **Drafted:** 2026-09-19. **Base commit:** `ccd9a5d` (`dev`).
>
> The B7 entry gate is not yet met — HP-6 is unsigned (B6 close-out state,
> below). **Amended 2026-09-20 (owner decision): HP-6 is no longer B7's
> gate.** B7-4 onward may proceed without it, because HP-6 cannot be reached
> before the beta: it takes B6-12's rehearsed tag as its release candidate,
> and the owner is cutting no further release until the beta ships — which B7
> itself precedes. HP-6 still runs before the beta, against that tag.
> B7-0's plan is drafted alongside this PRD.
>
> **HP-7 signed by the owner 2026-09-23** after B7-17 merged
> ([#1737](https://github.com/J3vb/OwnCord/pull/1737)); stated limits in
> [HP-7 sign-off](#hp-7-sign-off-2026-09-23).

## Problem

The desktop client runs and is feature-rich, but nothing proves it is one
application built behind explicit platform contracts, and the workstreams B7
exists to close are unfinished or unmeasured. 21 production files import
`@tauri-apps` directly with no seam and no lint rule stopping a 22nd
(`docs/architecture/platform-contracts.md:51,57`). The gates that are
supposed to keep the client honest hide known problems instead of failing on
them: oxlint already carries 471 warnings (`docs/plans/b0-baseline-2026-08-25.md:42`),
CI's local mirror runs no knip and no coverage floor
(`scripts/run.mjs:135-141`, `CHECK_CLIENT`), and there is no
import-cycle tool and no bundle-budget tool anywhere in the repo. The three
requirements B7 exists to prove — BPR-033 (update notice / incompatible
state), BPR-034 (one connection, isolated profiles), BPR-035 (multi-device
sessions) — are each only partly built: ws 8 exists but no client code calls
`GET /api/v1/server-info`; ws 9 has no instrumented evidence that exactly one
live session exists; ws 10 is server-API-only with no client revoke-all
wrapper and no UI; ws 11's recovery-kit and support-bundle-export flows are
missing entirely from the client. None of this can be planned confidently
today because several inputs the phase needs — startup time, memory, client
coverage percentage, mutation score, knip hint count, import-cycle count — have
never been measured (no B0 baseline or HP-0..HP-5 scorecard records them). Leaving it
unsolved means B7's later milestones would be planned against invented
numbers, and desktop parity would ship un-audited behind the same 21 untyped
native call sites it has today.

## Evidence

- **Native seam.** `Client/src/platform/` does not exist; there is no project
  `isTauri()` helper (only the SDK's, used solely in
  `Client/src/lib/pendingMessages.ts:5,34,38,42`). 21 production files import
  `@tauri-apps` across 29 distinct invoke names (`docs/architecture/platform-contracts.md:51-52`).
  `docs/architecture/platform-contracts.md` has drifted from the tree
  it documents — it lists `lib/livekitSession.ts` in the native-proxy cluster
  although that file imports no `@tauri-apps` API at all, and omits the real
  second site `lib/livekitUrlResolver.ts` (the row's other entry,
  `lib/httpProxy.ts`, is correct); it also omits `lib/pendingMessages.ts` from
  its table entirely, and claims `ptt_get_key` and `store_cert_fingerprint`
  are registered Tauri commands when neither exists in `generate_handler!`
  (`Client/src-tauri/src/lib.rs:108-142`). `Client/CLAUDE.md` still says "20
  files"; the real count is 21. The guard test
  `Client/tests/unit/platform-contracts-counts.test.ts` does not catch this
  drift: it only re-derives the three numeric counts (21 importing files, 29
  invoke names, 34 `#[tauri::command]` handlers), all of which still match
  the doc's count table, so the test is green while the prose and cluster
  table are stale.
- **Dead surface named at HP-1.** `probe_credential_store`
  (`Client/src-tauri/src/credentials.rs:414`, registered `lib.rs:128`) has no
  caller in TS or tests; HP-1's scorecard names it a B7 dead-surface candidate
  alongside `ptt_get_key`, which does not exist at all.
- **Gates hide known problems.** oxlint's `Client/.oxlintrc.json` runs with
  correctness=error but suspicious/perf only warn, and B0 recorded 471
  warnings under that config (`docs/plans/b0-baseline-2026-08-25.md:42`); no
  rule enforces the `@tauri-apps` seam (`Client/eslint-rules.js` has five
  local rules in use, none about native imports). `scripts/run.mjs:135-141`'s
  CHECK_CLIENT runs the tauri-version check, typecheck, lint and test only —
  no knip, no coverage-floor gate — even though both run in full CI: knip in
  `client-check` (`.github/workflows/ci.yml:248`, step :314) and the coverage
  floor in `client-tests` (:461, step :484). There is no
  dependency-cruiser/madge/import-cycle tool anywhere in the repo, and no
  size-limit/bundlesize tool either, despite C-11 already recording four
  production import cycles and C-07/C-08 recording unbudgeted bundles.
- **Bundle facts and the B0 baseline.** LiveKit is statically imported by 12
  modules and RNNoise statically imported by
  `Client/src/lib/noise-suppression.ts:13`. **Amended 2026-09-20 (owner
  decision, factual correction):** the clause "both currently load on the
  startup path" was never true — at this PRD's own base commit `ccd9a5d`,
  `main.ts` imported `livekitSession` dynamically (`void
import("@lib/livekitSession")`), and B7-0's re-measurement confirms the
  entry's only static edge is the 1.2 kB `core` helper. The startup-path
  cost these two carry is the RNNoise barrel's dead 1.9 MB sync-WASM inside
  the _lazy_ `livekitSession` chunk (fixed by B7-7's deep import). B0's
  recorded chunk sizes — `livekitSession` 1,998.25 kB / 1,344.96 kB gz,
  `livekit` 495.41 / 127.88, `MainPage` 192.18 / 58.92 — are the only budget
  numbers that exist, and B0 itself names them "the budget baseline B7
  ratchets against" (`docs/plans/b0-baseline-2026-08-25.md:58-60`).
- **Hotspot sizes.** Non-test line counts run large and undivided:
  `lib/livekitSession.ts` 1621, `lib/livekitE2EE.ts` 1609, `lib/dispatcher.ts`
  1440, `stores/messages.store.ts` 1171, `components/MessageList.ts` 1141,
  `components/MessageInput.ts` 1096 (line counts by path, above). These are the
  modules C-11/C-12/C-16 name for decomposition and the ones a mutation
  baseline needs to exist before it decomposes them safely.
- **Lifecycle facts.** Only two lifecycle helpers exist —
  `Client/src/lib/disposable.ts` (4 consumers) and
  `Client/src/lib/sessionScope.ts` — against 45 files that construct their own
  `AbortController` and 69 that construct one or take a signal, 76 timer
  sites, and 392 `addEventListener` calls vs. 28 explicit `removeEventListener`
  calls. `Client/tests/setup.ts` has no `afterEach` and asserts no leaks or
  timers; `vitest.config.ts` sets no `clearMocks`/`restoreMocks`/`unstubGlobals`.
  Three register rows tagged B7 record listener accumulation in exactly this
  territory (OC-0335, OC-0336, OC-0365); like the other 22 B7-tagged OC rows
  they are `fixed` in `.superpowers/findings-ledger.json` while the register
  still reads as open — B7-0 reconciles the register, it does not re-plan
  the fixes.
- **Per-workstream feature state (BPR-033/034/035).** Ws 8 (update
  notice/incompatible state) exists end to end on the WS-frame path
  (`Server/ws/messages.go:392`, `Client/src/lib/dispatcher.ts:299-311`,
  `components/UpdateNotifier.ts`), but `GET /api/v1/server-info`
  (`Server/api/router.go:629`) has no client caller at all. Ws 9 (one
  connection, profiles) has the profile-switching UI
  (`Client/src/lib/profiles.ts`, `pages/connect-page/ServerPanel.ts`) but no
  BPR-034 instrumented evidence test proving exactly one live transport/media
  session exists. Ws 10 (sessions) is server-API-only: the routes, wire shape
  and live-teardown all exist (`Server/api/profile_handler.go:89-162`), but the
  client's `SessionInfo` type carries no `unseen` field
  (`Client/src/lib/api.ts:57-74`), there is no revoke-all wrapper, and no
  session-management UI component exists. Ws 11 (account lifecycle) is mostly
  missing on the client: zero recovery-code UI (only TOTP backup codes at
  enrollment, `AccountTab.ts:578,587`), no retention-disclosure copy anywhere
  in `Client/src`, and no user-initiated support-bundle export — the only
  support-bundle endpoints are admin-only (`Server/admin/api.go:237-238`),
  which does not satisfy BPR-055's user-initiated local export.
- **Updater and release gaps.** The updater's asset map
  (`Server/updater/assets.go:39-43`) has rows for
  windows-x86_64-nsis, linux-x86_64-appimage and linux-aarch64-appimage but no
  windows-aarch64 row, even though BPR-010 requires native Windows ARM64
  validation. `.github/workflows/release.yml` has no Windows ARM64 client job
  and no client-artifact smoke test (install/boot/connect/update/rollback/media/recovery)
  anywhere in the repo.
- **Fixtures are Go-only.** `protocol/fixtures/epoch-1/`'s 13 journey
  transcripts are consumed only by
  `Server/ws/protocol_epoch1_contract_test.go`; no client code reads them
  (three prose mentions only: `Client/src/lib/livekitSession.ts:230` and two
  unit tests). Entry gate item 2 (fixtures) is therefore only half met.
- **Node policy unsettled.** Root, `Client/` and `tools/mcp-introspect/` all
  pin `engines: {node: ">=24", npm: ">=10"}` with `engine-strict=true`, but an
  open `>=` range is not a major-version pin; ws 17 (an audit carryover from
  B1-2) asks to settle this with one documented pin proven by an admitted and
  a refused version.
- **Unrecorded baselines assigned to B7 entry.** Startup time, memory, client
  coverage percentage, mutation score, knip hint count and import-cycle count
  have never been recorded in any B0 baseline or HP-0..HP-5 scorecard.
  `docs/plans/b3-server-architecture-guardrails-2026-08-29.md:143-144,201,2561`
  recorded the client-baseline refresh as B7 entry work, and the roadmap's
  phase-execution Rule 1 (`repo-health-roadmap-2026-08-23.md:208-227`) requires
  each phase's execution plan to re-verify claims against HEAD before
  building on them — which is exactly B7-0's job.
- **B6 close-out state.** On `dev` `ccd9a5d`, B6-1/2/6/7/8/9/10/11/13/14/15 are
  complete; B6-3/4/5 (TLS) are deferred by owner decision (2026-09-11); B6-12
  (tag rehearsal) and B6-16 (final pass) are in progress with every acceptance
  box unticked; HP-6 is pending with all 15 acceptance boxes unticked and
  cannot start before B6-12's tag run
  (`.claude/plans/hp-6-operator-capacity-acceptance.plan.md`). `docs/plans/README.md:36`'s
  B6 row is stale and reconciling it is B6-16's job, not B7 prep's. This means
  B7 entry gate item 1 ("the complete beta server is stable through B6") is
  not formally met; item 2 (fixtures) is half met; item 3 (baselines) is not
  met — all three are B7-0's opening work.
- **B8 deferral.** The roadmap owner deferred B8 (browser/PWA/mobile parity)
  post-beta on 2026-09-18, amending several B7 workstreams and issue-register
  rows in place: ws 2 (`:941-943`), ws 3 (`:946-949`), ws 16 (`:980-982`), HP-7
  (`:1001-1003`), the exit-gate's first bullet (`:1008-1009`), and the
  browser-smoke evidence clause (`:1026-1028`). C-10 and BG-04 each carry a
  "B8 half deferred" note as a result.

### Roadmap workstream → state today

| WS  | Roadmap text (short)                                                                        | State on `ccd9a5d`                                                                                                                                                                                                                                   | Milestone   |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Platform-contract inventory / typed adapters for every native responsibility                | 21 Tauri-import files, no `platform/` dir, contracts doc stale (`docs/architecture/platform-contracts.md:51,57`)                                                                                                                                     | B7-3        |
| 2   | Migrate native-dependent services behind the adapter (connectivity, identity, media, shell) | No adapter exists yet; every native call site is direct (`docs/architecture/platform-contracts.md:95-101` capability-cluster table)                                                                                                                  | B7-4, B7-5  |
| 3   | Target-neutral build split (`build:web` / `build:desktop`)                                  | Single `Client/vite.config.ts`; no split exists                                                                                                                                                                                                      | B7-6        |
| 4   | Honest client gates locally and in CI                                                       | Local `CHECK_CLIENT` skips knip and coverage floor; no import-cycle or native-import lint rule (`scripts/run.mjs:135-141`)                                                                                                                           | B7-1        |
| 5   | Bundle and runtime budgets                                                                  | No budget tool exists; only the B0 chunk-size baseline (`docs/plans/b0-baseline-2026-08-25.md:51-60`)                                                                                                                                                | B7-7        |
| 6   | Decompose large modules by ownership (dispatcher, voice, messaging)                         | Hotspots unchanged: `livekitSession.ts` 1621, `dispatcher.ts` 1440, `messages.store.ts` 1171 lines                                                                                                                                                   | B7-9, B7-10 |
| 7   | Lifecycle ownership (timers, listeners)                                                     | 2 lifecycle helpers, 45 files constructing their own `AbortController` (69 constructing one or taking a signal), 392 vs. 28 listener add/remove, no leak assertions in test setup (`Client/src/lib/disposable.ts`, `Client/src/lib/sessionScope.ts`) | B7-11       |
| 8   | Compatible update / incompatible-epoch state                                                | WS-frame path complete; `GET /api/v1/server-info` has no client caller (`Server/api/router.go:629`)                                                                                                                                                  | B7-12       |
| 9   | One connection, isolated profiles                                                           | Profile UI exists; no BPR-034 instrumented evidence test (`Client/src/lib/profiles.ts`, `Client/src/pages/connect-page/ServerPanel.ts`)                                                                                                              | B7-13       |
| 10  | Multi-device session management                                                             | Server API and wire shape complete; no client `unseen` field, no revoke-all, no UI (`Client/src/lib/api.ts:57-74`)                                                                                                                                   | B7-14       |
| 11  | Account lifecycle desktop flows                                                             | No recovery-code UI, no retention disclosure, no user support-bundle export (`Client/src/components/settings/AccountTab.ts:578,587`, `Client/src/lib/logPersistence.ts`)                                                                             | B7-15       |
| 12  | Desktop artifact matrix and smoke                                                           | No Windows ARM64 client job, no client-artifact smoke test (`.github/workflows/release.yml`)                                                                                                                                                         | B7-17       |
| 13  | Dead-surface candidates                                                                     | `probe_credential_store` unreferenced; `ptt_get_key` does not exist (HP-1 scorecard :339)                                                                                                                                                            | B7-0        |
| 14  | Protocol negotiation re-verify                                                              | `protocol_epoch_unsupported` path implemented and tested (`Server/ws/protocol_epoch_test.go`)                                                                                                                                                        | B7-12       |
| 15  | Mutation baseline refresh                                                                   | Stryker score stale at 67.04% (C-16); no B7-era re-run recorded                                                                                                                                                                                      | B7-0, B7-8  |
| 16  | Layout-refactor Phases 4-6 (voice/dispatcher decomposition)                                 | Supplement plan exists (`docs/plans/developer-experience-layout-refactor-2026-08-29.md:351-431`); not started                                                                                                                                        | B7-9, B7-10 |
| 17  | Node/npm support policy                                                                     | `>=24`/`>=10` ranges pinned with `engine-strict`, not a single documented major-version pin (`Client/package.json`, `Client/.npmrc`)                                                                                                                 | B7-2        |

## Users

- **Primary**: a desktop user of a self-hosted server, dealing with updates,
  profiles, multiple devices, and account recovery.
- **Secondary**: the client contributor who must move existing behaviour
  behind the platform adapter without regressing it.
- **Not for**: browser/PWA/mobile users (B8, deferred post-beta), and server
  operators (B6).

## Hypothesis

We believe **explicit platform contracts, honest gates, and completed
BPR-033/034/035 flows** will **let a desktop user trust updates, profile
switching, device sessions, and account recovery, and let a contributor move
client code without regressing it** for **desktop users of a self-hosted
server and the client contributors who maintain it**.
We'll know we're right when **every native import outside
`platform/desktop` and bootstrap is gone or lint-flagged, every client gate
ratchets instead of hiding a known count, BPR-033/034/035 each have a passing
evidence row in the traceability doc, and the four-target desktop artifact
matrix installs, boots, connects, updates, rolls back, and recovers under
smoke.**

## Success Metrics

| Metric                                                | Target                                                                                                                                                                                                                    | How measured                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Native imports outside `platform/desktop` + bootstrap | 0                                                                                                                                                                                                                         | Native-import lint rule (added B7-1) plus the platform-contracts count test      |
| oxlint unapproved warnings                            | 0 (from 471 today, `docs/plans/b0-baseline-2026-08-25.md:42`)                                                                                                                                                             | `Client/.oxlintrc.json` run in `CHECK_CLIENT`, cleared or explicitly allowlisted |
| Import cycles                                         | 0, or each remaining one boundary-tested (from "four" today per C-11; no tool exists yet — added in B7-1)                                                                                                                 | Import-cycle tool added in B7-1                                                  |
| Coverage floor                                        | 90 % statements in B7-1 (from 70; B7-0 measured 93.99 %), +1 per decomposition milestone to 93; four exclusions each justified (`Client/vitest.config.ts`, `Client/coverage-floor.json`) — decision 9                     | `Client/scripts/coverage-floor.sh` in `CHECK_CLIENT`                             |
| Mutation baseline                                     | Recorded as the accepted pre-decomposition number (last recorded: 67.04%, stale per C-16)                                                                                                                                 | Stryker run against `src/lib/**`, `src/stores/**` before B7-9/B7-10 start        |
| Bundle budgets                                        | Enforced in CI against the B0 baseline (livekitSession 1,998.25 kB / 1,344.96 kB gz, livekit 495.41 / 127.88, MainPage 192.18 / 58.92 — `docs/plans/b0-baseline-2026-08-25.md:51-60`); exact targets are Open Question 10 | CI budget gate added in B7-7                                                     |
| BPR-033/034/035 evidence                              | Each has a passing row in `docs/plans/beta-requirements-traceability-2026-08-23.md`                                                                                                                                       | Traceability doc rows :82-84                                                     |
| Artifact matrix                                       | 4/4 (Windows x64/ARM64, Linux x64/ARM64) building and passing install/boot/connect/update/rollback/media/recovery smoke                                                                                                   | B7-17 CI job                                                                     |
| HP-7                                                  | Signed by the owner 2026-09-23 — recorded in the milestone table and [HP-7 sign-off](#hp-7-sign-off-2026-09-23), not a separate scorecard                                                                                 | `docs/plans/hp-7-scorecard-<date>.md`, after B7-17 and before B7-18              |

## Scope

**MVP** — the desktop client reaches beta behind typed platform contracts.
Every native-dependent responsibility moves off ad hoc `@tauri-apps` imports
scattered across 21 production files and into a single `platform/desktop`
adapter with contract tests, and the client-side lint/typecheck/knip/coverage
gates that today run only by hand are enforced honestly in CI. The three BPR
feature flows land in the client: compatible update and incompatible-epoch
handling (BPR-033), one connection with isolated, quickly switched profiles
(BPR-034), and multi-device session management with a new-login notice and
revocation (BPR-035), alongside the account-lifecycle flows (registration
mode, recovery, deletion disclosure, support-bundle export) the beta needs.
Windows x64/ARM64 and Linux x64/ARM64 desktop artifacts are built and pass an
install/boot/connect/update/rollback/media/recovery smoke matrix. HP-7 closes
the phase — this cycle it gates the beta client against one release
candidate, not browser exposure (that purpose moved to B8, owner decision
2026-09-18).

**Out of scope**

- Browser adapters, `build:web`, and PWA/mobile surfaces — deferred to B8,
  post-beta (owner decision 2026-09-18; roadmap :1040-1055).
- The CSS source split and later feature UX (Message Requests, moderation
  UX, translation-ready strings, phone/tablet layouts) — B9, per the
  layout-refactor supplement's Phase 5 item 6 (:404-407) and roadmap B9
  workstream 11 (:1211-1215).
- The render gate / consent UI for external content — B9, per HP-5's
  scorecard (:285): the desktop broker is B7's (C-09), the gate/consent UI
  is B9's.
- Server features beyond the two small server-info additions raised in Open
  Questions 2-3 (`registration_mode`, a retention summary). No other server
  work is in scope for this phase.
- Redesigning any UI during extraction — the layout-refactor supplement's
  rule that visual changes are separate changes from a source split or
  decomposition (:404-407) applies to every B7 milestone that moves code.

## Satisfied preconditions

- `GET /api/v1/server-info` already exists and answers `name`,
  `protocol_epoch`, and `browser_client_enabled` (B6-7): mount
  `Server/api/router.go:629`, response shape :651-655, handler :729-745. No
  client code calls it yet — B7-12 is the first caller.
- The `protocol_epoch_unsupported` handling already exists end to end: server
  builds `ErrCodeProtocolEpoch` on `auth_error` (`Server/ws/messages.go:392`,
  builder :397-414, emitted at `Server/ws/serve_auth.go:67-69`), and the
  client already reacts to it (`Client/src/lib/dispatcher.ts:299-311`,
  `stores/ui.store.ts:17,27,68`, `components/UpdateNotifier.ts`,
  `Client/src/lib/updater.ts`). B7-12 wires this to the new server-info
  caller; it does not build the mechanism from scratch.
- The sessions API with `unseen` already exists:
  `Server/api/profile_handler.go:160-162` (list, revoke-all, revoke-one),
  `sessionResponse` :89-103 including `unseen`, live teardown via
  `SessionDisconnector` :117-131. B7-14 adds the client `unseen` field and UI,
  it does not build the server side.
- Recovery, deletion, and TOTP endpoints already exist:
  `Server/api/auth_handler.go:79-91` (TOTP + recovery codes), :97-101
  (recovery-kit / status / recover), :74 (`DELETE /api/v1/auth/account`).
  B7-15 wires the client to these; the server contract is not new work.
- The Linux ARM64 client build is already native, not cross-compiled: release
  workflow `release-client-linux-arm64` runs on `ubuntu-22.04-arm`
  (`.github/workflows/release.yml:347-445`). B7-17's artifact matrix reuses
  this pattern; only the Windows ARM64 row is open (Open Question 4).
- `Client/src/lib/disposable.ts` (Disposable) and `Client/src/lib/sessionScope.ts`
  (SessionScope) already exist with four consumers between them. B7-11 extends
  their use, it does not design the lifecycle primitives.
- `Client/vitest.config.ts` already includes the `src/**/*.test.ts` glob for
  colocated unit tests; zero files currently match it. B7-9/B7-10's
  decomposition is what populates it — no config change is needed first.
- OC-0313, OC-0329, OC-0353, and OC-0354 are already fixed and register-closed
  (B4-12a, #1530, B4-7) — they are not part of the 25 B7-tagged rows this
  phase reconciles and are not re-planned here.

## Delivery Milestones

<!-- Business outcomes, not engineering tasks. /plan turns each into a plan. -->
<!-- Status: pending | in-progress | complete | deferred -->

| #        | Milestone                                              | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status            | Plan                                                                                                                                                                                                                                                                                        | Roadmap WS                         |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| B7-0     | Verify claims and record the entry baselines           | Every roadmap claim entering the phase is re-checked against HEAD and the missing baselines (startup, memory, client coverage %, mutation score, knip hints, import cycles, bundle sizes) are recorded once, so later milestones ratchet against real numbers instead of guesses                                                                                                                                                                                                                                                                                                                                                                                      | complete          | [b7-0-verify-and-baseline.plan.md](../../.claude/plans/b7-0-verify-and-baseline.plan.md)                                                                                                                                                                                                    | 13, 15 (baseline half), entry gate |
| B7-1     | Honest client gates locally and in CI                  | A contributor cannot merge past a lint, knip, coverage, or import-cycle regression that today only shows up if someone runs the full suite by hand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | complete          | [b7-1-honest-client-gates.plan.md](../../.claude/plans/b7-1-honest-client-gates.plan.md)                                                                                                                                                                                                    | 4                                  |
| B7-2     | Node/npm support policy settled                        | Contributors and CI build against one documented major Node/npm version instead of an open-ended `>=` range that can drift silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | complete          | [b7-2-node-npm-support-policy.plan.md](../../.claude/plans/b7-2-node-npm-support-policy.plan.md)                                                                                                                                                                                            | 17                                 |
| B7-3     | Platform contracts and the desktop adapter shell       | Every native-dependent responsibility has a typed contract and a `platform/desktop` home to move into, before any code actually moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | complete          | [b7-3-platform-contracts-desktop-shell.plan.md](../../.claude/plans/b7-3-platform-contracts-desktop-shell.plan.md)                                                                                                                                                                          | 1, entry gate item 2               |
| B7-4     | Adapter migration, connectivity and identity           | HTTP, WebSocket, credentials, identity, pending messages, profiles/settings, and logs/filesystem all reach native APIs through the desktop adapter, with app behavior unchanged from a user's perspective                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pending           | —                                                                                                                                                                                                                                                                                           | 2                                  |
| B7-5     | Adapter migration, media and shell                     | Media/devices, LiveKit's native proxy, push-to-talk, notifications, window state, deep links, updater, and app metadata all reach native APIs through the desktop adapter, closing off any remaining direct `@tauri-apps` import outside it                                                                                                                                                                                                                                                                                                                                                                                                                           | pending           | [b7-5-adapter-media-shell.plan.md](../../.claude/plans/b7-5-adapter-media-shell.plan.md)                                                                                                                                                                                                    | 2                                  |
| B7-6     | Target-neutral Vite split and the desktop compile gate | The build config stops assuming one platform: a shared config plus a desktop overlay makes `build:desktop` an explicit, checked target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pending           | —                                                                                                                                                                                                                                                                                           | 3                                  |
| B7-7     | Bundle and runtime budgets                             | Startup, route, LiveKit, RNNoise, and feature-chunk sizes are enforced in CI instead of drifting unnoticed. **Amended 2026-09-20 (owner decision, factual correction):** the outcome's second clause ("LiveKit/RNNoise no longer load on the startup path") was already satisfied before this milestone started — `main.ts` imported `@lib/livekitSession` dynamically at the PRD's own base commit `ccd9a5d`, and B7-0's record calls `livekitSession` "the largest lazy chunk". What B7-7 actually delivers is the enforcement (CI bundle budgets) and the RNNoise deep-import fix, which removes 1.9 MB of dead embedded WASM from the lazy `livekitSession` chunk | pending           | [b7-7-bundle-runtime-budgets.plan.md](../../.claude/plans/b7-7-bundle-runtime-budgets.plan.md)                                                                                                                                                                                              | 5                                  |
| B7-8     | Mutation baseline refreshed before decomposition       | The mutation score is recorded once, honestly, as the number every later decomposition milestone is measured against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pending           | [b7-8-mutation-baseline.plan.md](../../.claude/plans/b7-8-mutation-baseline.plan.md)                                                                                                                                                                                                        | 15                                 |
| B7-9     | Decompose voice                                        | The two largest voice modules split into ownership-scoped files with colocated tests, with supersession and staleness behavior proven unchanged, not just assumed unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pending           | —                                                                                                                                                                                                                                                                                           | 6, 16                              |
| B7-10    | Decompose dispatcher, messaging and stores             | Message handling and its stores split by ownership while the dispatcher stays the only door store writes come through, and production import cycles drop to zero or are explicitly boundary-tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | complete          | [b7-10-decompose-dispatcher-messaging-stores.plan.md](../../.claude/plans/b7-10-decompose-dispatcher-messaging-stores.plan.md) — [#1670](https://github.com/J3vb/OwnCord/pull/1670), [#1672](https://github.com/J3vb/OwnCord/pull/1672), [#1677](https://github.com/J3vb/OwnCord/pull/1677) | 6, 16                              |
| B7-11    | Lifecycle ownership and long-session evidence          | Timers and listeners are owned through the existing lifecycle primitives everywhere, and a client that stays connected for a long session is proven not to leak or misbehave, not just assumed to                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | complete          | [b7-11-lifecycle-ownership-long-session.plan.md](../../.claude/plans/b7-11-lifecycle-ownership-long-session.plan.md) — [#1702](https://github.com/J3vb/OwnCord/pull/1702), [#1703](https://github.com/J3vb/OwnCord/pull/1703), [#1728](https://github.com/J3vb/OwnCord/pull/1728)           | 7                                  |
| B7-12    | Compatible update and incompatible state               | A connected user gets a clear update notice when the server says a newer compatible release exists, and lands in a safe, exitable state when the server's epoch is incompatible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pending           | —                                                                                                                                                                                                                                                                                           | 8, 14                              |
| B7-13    | One connection, isolated profiles, quick switch        | A user has exactly one live connection and one live media session at a time; switching profiles tears the old one down completely and isolates the new one's credentials and cache                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pending           | —                                                                                                                                                                                                                                                                                           | 9                                  |
| B7-14    | Multi-device session management                        | A user sees every device signed into their account, is told about a new sign-in, and can revoke one device or all of them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pending           | —                                                                                                                                                                                                                                                                                           | 10                                 |
| B7-15    | Account lifecycle desktop flows                        | Sign-up honestly reflects the server's registration mode including a pending-approval state, recovery works end to end from the client, deletion discloses retention, and a user can export their own local support bundle without a server call; `server-info` gains `registration_mode` and a retention summary (decisions 2, 3)                                                                                                                                                                                                                                                                                                                                    | pending           | —                                                                                                                                                                                                                                                                                           | 11                                 |
| B7-16    | Desktop external-content broker                        | External content (link previews, embeds, media) is fetched through a bounded, budgeted, cache-partitioned broker instead of unbounded native fetches, closing the desktop half B5 deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pending           | [b7-16-external-content-broker.plan.md](../../.claude/plans/b7-16-external-content-broker.plan.md)                                                                                                                                                                                          | B5 carry-over                      |
| B7-17    | Desktop artifact matrix and smoke                      | An owner can install, boot, connect, update, roll back, use media, and recover an account on Windows x64/ARM64 and Linux x64/ARM64 builds, all exercised by CI, not just built; Windows ARM64 tries the native `windows-11-arm` runner first (decision 4)                                                                                                                                                                                                                                                                                                                                                                                                             | complete          | [b7-17-desktop-artifact-matrix-smoke.plan.md](../../.claude/plans/b7-17-desktop-artifact-matrix-smoke.plan.md) — [#1737](https://github.com/J3vb/OwnCord/pull/1737)                                                                                                                         | 12                                 |
| **HP-7** | **Desktop parity, the owner signs**                    | An owner confirms the desktop beta client is ready against one release candidate before register and roadmap reconciliation closes the phase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | signed 2026-09-23 | Signed by the owner 2026-09-23 — B7-17 [#1737](https://github.com/J3vb/OwnCord/pull/1737), B7-11 [#1728](https://github.com/J3vb/OwnCord/pull/1728), B7-10 [#1727](https://github.com/J3vb/OwnCord/pull/1727); stated limits in [HP-7 sign-off](#hp-7-sign-off-2026-09-23)                  | HP-7                               |
| B7-18    | Register, traceability and roadmap reconciliation      | The issue register and roadmap match what B7 actually shipped, with every deferral to B8 recorded against the exact artifacts left behind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pending           | —                                                                                                                                                                                                                                                                                           | exit                               |

**Ordering.** B7-0 runs strictly first — roadmap workstream 16 is explicit
that nothing creates `Client/src/platform/` before the entry gate is
verified. B7-1, B7-2, and B7-3 may proceed in parallel once B7-0 lands, and
may start before HP-6 signs (decision 15): gate cleanup, the Node policy and
contract design consume no server service. B7-4 onward no longer wait for
HP-6 (decision 18, 2026-09-20). B7-3 → B7-4
→ B7-5 are serialized by responsibility, since B7-4 and B7-5 both migrate
call sites into the same adapter B7-3 shapes. B7-6 runs beside B7-4/B7-5 —
it is a build-config change, not a call-site migration, so it does not need
to wait on them. B7-7 runs after B7-6 and B7-0, since it budgets against a
build it did not previously have and a baseline B7-0 records. B7-8 runs
before B7-9 and B7-10, so decomposition has a mutation baseline to be
measured against; B7-9 runs before B7-10, because the dispatcher
reorganization B7-10 performs touches the voice handlers B7-9 extracts.
B7-11 runs after B7-10. B7-12 through B7-16 run after B7-5, in parallel with
each other and with B7-9 through B7-11, on the rule that extraction and
feature behavior never share one PR. B7-16 needs only B7-4's HTTP contract,
not the full adapter migration, so it does not wait on B7-5. B7-17 is the
last of the build steps, since its smoke matrix exercises B7-12's update
path and B7-15's recovery path. HP-7 sits at the end of the phase, as HP-6
did for B6: its browser-gating purpose moved post-beta, so it now gates the
beta client itself against one release candidate. B7-18 runs after the
signature.

### HP-7 sign-off (2026-09-23)

**Signed by the owner on 2026-09-23.** The owner confirmed desktop parity on
the evidence of B7-17's four-target install/boot/connect/update/rollback/media
smoke ([#1737](https://github.com/J3vb/OwnCord/pull/1737)), B7-11's lifecycle
and long-session evidence ([#1728](https://github.com/J3vb/OwnCord/pull/1728))
and B7-10's close-out record ([#1727](https://github.com/J3vb/OwnCord/pull/1727)).
The sign-off carries B7-17's stated limits, verbatim:

- nightly schedule inert until main carry;
- first-release Windows ARM64 update N/A;
- owner-run real-desktop Linux device check still outstanding.

The Linux device check is owner-run and stays open after this signature. B7-18
(register and roadmap reconciliation) still follows.

### What each milestone closes in the register

| Milestone | Register rows                                        | OC rows                                                                                                                                                                      |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B7-0      | —                                                    | reconciled 2026-09-19: all 25 B7-tagged register rows carry the ledger's `fixed` prefix (PRs #1436, #1530, #1533), none re-tagged                                            |
| B7-1      | C-02, C-03, C-04, C-05                               | —                                                                                                                                                                            |
| B7-2      | —                                                    | —                                                                                                                                                                            |
| B7-3      | L-02 (contract half)                                 | —                                                                                                                                                                            |
| B7-4      | —                                                    | —                                                                                                                                                                            |
| B7-5      | L-02 (implementation half)                           | —                                                                                                                                                                            |
| B7-6      | L-03, C-10 (B7 half)                                 | —                                                                                                                                                                            |
| B7-7      | C-07, C-08                                           | —                                                                                                                                                                            |
| B7-8      | C-16 (B7 half)                                       | —                                                                                                                                                                            |
| B7-9      | C-12 (voice half)                                    | — (any row that fails B7-0's re-verification and falls under voice)                                                                                                          |
| B7-10     | C-11, C-12 (rest)                                    | — (same rule, messaging/stores); closed 2026-09-22 by #1670, #1672, #1677 — `lint:cycles` at `--max-warnings=0`, madge residue of 11 lazy/type-only cycles recorded in #1677 |
| B7-11     | C-13                                                 | — (same rule, lifecycle; OC-0335/0336/0365 are already `fixed`)                                                                                                              |
| B7-12     | BG-07 (B7 re-verify)                                 | — (BPR-033 evidence)                                                                                                                                                         |
| B7-13     | —                                                    | — (BPR-034 evidence)                                                                                                                                                         |
| B7-14     | —                                                    | — (BPR-035 evidence)                                                                                                                                                         |
| B7-15     | —                                                    | — (same rule, account flows)                                                                                                                                                 |
| B7-16     | C-09 (clauses 1, 7, 8), BG-19, SEC-03 (desktop half) | —                                                                                                                                                                            |
| B7-17     | BG-04 (B7 half)                                      | — (BPR-010 evidence)                                                                                                                                                         |
| B7-18     | —                                                    | confirms no B7-tagged OC-\* is open (rule 2), per B7-0's reconciliation                                                                                                      |

## Open Questions

- [x] **Decided 2026-09-19 (owner-delegated):** poll the sessions list on connect and on window focus and surface `unseen`; no new WebSocket frame in B7. A push frame is recorded as a B9 candidate. _Why:_ the server already computes `unseen`, and a frame is a protocol change (schema, both generators, fixtures) inside a client phase. Question as recorded: **New-login notice (B7-14): poll the sessions list on connect/focus and surface `unseen` (default), or add a WS new-login frame (protocol change, server work in a client phase)?** The server already computes `unseen` on the sessions list (`Server/api/profile_handler.go:99-102`) but there is no WebSocket frame for it (`Server/ws/message_types.go:15-87`). Proposed default: poll on connect/focus using the existing `unseen` field.
- [x] **Decided 2026-09-19 (owner-delegated):** extend `GET /api/v1/server-info` with `registration_mode`, owned by the B7-15 plan as one small server change with one test. _Why:_ it is the unauthenticated "what is this server" endpoint from B6-7; inferring the mode from error responses gives a dishonest sign-up screen. Question as recorded: **Registration mode (B7-15): no public endpoint advertises closed/invite/approval/open.** `Server/service/registration.go:12-37` sets the mode server-side but `server-info` does not carry it, so the client cannot show an honest sign-up screen. Proposed default: extend `GET /api/v1/server-info` with `registration_mode` — one small server change owned by the B7-15 plan.
- [x] **Decided 2026-09-19 (owner-delegated):** add a `retention` summary object to `server-info` (server-default message and attachment retention only; channel overrides stay admin-only), in the same server PR as `registration_mode`. _Why:_ static text would lie on servers with retention configured. Question as recorded: **Retention disclosure (B7-15): retention is admin-only today.** `Server/admin/api.go:88-96` exposes retention only to admins; there is no user-facing disclosure endpoint or client copy. Proposed default: add a retention summary to `server-info`; alternative is static client-side text.
- [x] **Decided 2026-09-19 (owner-delegated):** add the `windows-aarch64-nsis` updater row and a Windows ARM64 client build job. Try the `windows-11-arm` runner first (release.yml already uses it for the server); only if the Tauri toolchain fails there, cross-compile on `windows-latest` and mark the smoke as declared. _Why:_ BPR-010 asks for native evidence and the runner already exists in this repo. Question as recorded: **Windows ARM64 client (B7-17): add the windows-aarch64 updater row and a client build job.** The updater asset map has no windows-aarch64 row (`Server/updater/assets.go:39-43`) and release.yml has no Windows ARM64 client job. Proposed default: cross-compile if no native runner is available, mirroring the Linux ARM64 evidence rule in BPR-010.
- [x] **Decided 2026-09-19 (owner-delegated):** full-client Stryker on the nightly job (`nightly-test-depth.yml`) as the baseline; PR CI keeps the `permissions.ts` subset plus the modules B7-9/B7-10 extract. Ceiling 90 minutes nightly; if the full run exceeds it, split the nightly by directory (`lib/`, `stores/`). _Why:_ the dry run (12 822 mutants, 2 m 48 s initial run) shows the cost shape; nobody waits on a nightly. Question as recorded: **Stryker (B7-8): full-client run nightly as the baseline, CI keeps a hotspot subset (default). What time ceiling?** `Client/stryker.config.mjs` covers `src/lib/**` and `src/stores/**` at thresholds 80/60/50; `Client/stryker.ci.config.mjs` narrows to `src/lib/permissions.ts` at 100/95/90 and runs nightly (`.github/workflows/nightly-test-depth.yml:31`). Proposed default: nightly full-client run as baseline, CI keeps the narrow hotspot subset.
- [x] **Decided 2026-09-19 (owner-delegated):** confirmed — done in B7-0 (#1626): all 25 rows carry the ledger's `fixed` prefix, none re-tagged; B6-16 re-merges its own hunks. Question as recorded: **The 25 B7-tagged OC register rows are stale: the register reads them as open, `.superpowers/findings-ledger.json` records every one as `fixed` (2026-09-03 and earlier). May B7-0 mark them fixed in the register, given B6-16's final pass edits the same file?** Rule 2 (`docs/plans/repo-health-roadmap-2026-08-23.md:208-227`) blocks phase exit while any tagged OC-\* is open, so the stale rows would block B7 for bugs that no longer exist. Proposed default: B7-0 re-verifies each at HEAD and adds the ledger's `fixed` prefix, sequenced after B6-16 merges; a row that fails re-verification goes to the B7 milestone that owns its subsystem, or to B9 with a written reason.
- [x] **Decided 2026-09-19 (owner-delegated):** client-local export: a zip of the rotating log files, the connection-diagnostics text and settings with secrets redacted, saved where the user chooses via the save dialog. No server call, no upload. _Why:_ BPR-055 says diagnostics stay local and export is user-initiated; the admin bundle needs admin rights and a server round-trip. Question as recorded: **Support bundle (B7-15): client-local zip of logs + connection diagnostics + redacted settings, no server call (default), versus a client trigger of the admin bundle.** The admin bundle already exists server-side (`Server/admin/api.go:237-238`, `Server/admin/support_bundle.go`) but BPR-055 requires a user-initiated local export with no telemetry. Proposed default: client-local zip, no server call.
- [x] **Decided 2026-09-19 (owner-delegated):** the existing default Playwright config plus one scenario per B7-12/13/14/15 flow, run in the existing `client-e2e` job. No new pipeline. Question as recorded: **Browser-smoke evidence: the existing `Client/tests/e2e` suite plus one scenario per B7-12..15 flow (default).** There is no dedicated browser-smoke evidence bucket recorded for these four flows today. Proposed default: extend the existing e2e suite with one scenario per flow rather than a new evidence pipeline.
- [x] **Decided 2026-09-19 (owner-delegated):** raise `coverage-floor.json` to 90 % statements in B7-1 (measured 93.99 % in B7-0), then +1 per decomposition milestone (B7-9, B7-10, B7-11) to 93. Keep the four exclusions, each with a one-line justification in `vitest.config.ts` (`*.d.ts` has none today). _Why:_ measurement minus 2 would leave no headroom for the extractions; 90 still stops regression. Question as recorded: **Coverage ratchet (B7-1): B7-0's measured value minus 2 points, then +1 per decomposition milestone; remove or justify the four exclusions (default).** `Client/vitest.config.ts` currently excludes `src/**/*.d.ts`, `src/main.ts`, `src/pages/MainPage.ts`, and `src/lib/noise-suppression.ts` — three of the four with an individual comment (`src/**/*.d.ts` has none) and no ratchet plan. Proposed default: B7-0's measured value minus 2 points as the floor, +1 per decomposition milestone, with the four exclusions individually justified or removed.
- [x] **Decided 2026-09-19 (owner-delegated):** gzip budgets, measured with `gzip -9` as in the B7-0 baseline: startup (`index` + `style`) ≤ 90 kB; `MainPage` ≤ 60 kB; `livekit` ≤ 135 kB and lazy; `livekitSession` ≤ 1,400 kB until B7-9 lands, then ≤ 800 kB; RNNoise wasm off the startup path. CI fails above the number, not on today's value. _Why:_ startup measures 86 kB today, so 90 leaves drift room; the `livekitSession` figure is conditioned on decomposition. Question as recorded: **Bundle budgets (B7-7): startup (index + MainPage) ≤ 120 kB gzip, livekit chunk ≤ 130 kB gzip and lazy, livekitSession chunk < 800 kB gzip after decomposition, RNNoise lazy and off startup (default, confirmed against B7-0's measurement).** B0 recorded index 59.07 kB gzip, MainPage 58.92 kB gzip, livekit 127.88 kB gzip, livekitSession 1,344.96 kB gzip as "the budget baseline B7 ratchets against" (`docs/plans/b0-baseline-2026-08-25.md:51-60`). Proposed default: the figures above, confirmed against B7-0's re-measurement.
- [x] **Decided 2026-09-19 (owner-delegated):** confirmed — `get_cert_fingerprint` stays, inventoried as "consumed by tests, unconsumed in production"; revisit at B7-5 when the certificate flow moves behind the adapter. Question as recorded: **`get_cert_fingerprint` is registered with no TS caller: keep it as "registered, unconsumed" in the inventory (default) or delete it with `probe_credential_store` in B7-0.** `get_cert_fingerprint` is in `generate_handler!` with no caller in `Client/src/` (it is invoked only from the e2e helpers, `Client/tests/e2e/native/helpers.ts:75`); `probe_credential_store` (`Client/src-tauri/src/credentials.rs:414`) has no caller anywhere and is already slated for deletion by B7-0. Proposed default: keep `get_cert_fingerprint` documented as registered-but-unconsumed in production code rather than deleting it alongside `probe_credential_store`.
- [x] **Decided 2026-09-19 (owner-delegated):** run `tauri-build` on PRs to `dev` when `Client/src-tauri/**`, `Client/package*.json`, `Client/vite.config.ts` or `Client/src-tauri/tauri.conf.json` change; stay main-only for pure `Client/src/**` TypeScript changes. _Why:_ the compile risk is in the Rust crate and packaging config; a full Tauri build on every TS change costs 10+ minutes per PR. Question as recorded: **`tauri-build` on PRs to `dev` when `Client/**`or`Client/src-tauri/**` changes (default), or main-only as today.** `tauri-build` currently runs only on PRs to `main` (`.github/workflows/ci.yml:722`, `if:` :725-728), so a client PR to `dev` never proves it compiles. Proposed default: extend `tauri-build` to PRs touching `Client/**` or `Client/src-tauri/**` on the path to `dev`.
- [x] **Decided 2026-09-19 (owner-delegated):** HP-7 at the end of the phase, after B7-17, as the milestone table shows. _Why:_ mirrors HP-6; its browser purpose is post-beta, so it gates the beta client against one release candidate. Question as recorded: **HP-7 placement at the end of the phase (default) versus mid-phase after B7-5.** Placing it after B7-5 would gate decomposition and feature work on an early sign-off; placing it at the end mirrors HP-6's role for B6. Proposed default: end of phase, as in the milestone table above.
- [x] **Decided 2026-09-19 (owner-delegated):** re-tag BG-16 to B9 alone, with the reason sentence in the register (this PR). _Why:_ no B7 workstream builds translation-ready strings; roadmap B9 workstream 6 owns it. Question as recorded: **BG-16 (translation-ready strings) re-tag to B9 (default) — nothing in B7's workstreams builds it.** BG-16 is tagged B7/B9 in the register, but roadmap B9 workstream 6 (translation-ready boundaries) is where the work is actually scoped; no B7 workstream touches it. Proposed default: re-tag to B9 alone.
- [x] **Decided 2026-09-19 (owner-delegated):** confirmed — B7-0 ran before HP-6 (#1626). B7-1, B7-2 and B7-3 may also start before HP-6: they touch gates, the Node policy and contract files only, and consume no server service. B7-4 onward wait for HP-6's signature. _Why:_ the entry gate protects the client from consuming unstable server services; those three consume none. Question as recorded: **Entry gate item 1 is unmet until HP-6 signs: may B7-0 (measure and verify only, no `Client/src/platform/`) start before HP-6 (default yes) while every other milestone waits?** HP-6 is pending with all 15 acceptance boxes unticked and cannot start before B6-12's tag rehearsal. Proposed default: yes — B7-0 may start now since it creates no `platform/` code, but B7-1 through B7-18 wait for HP-6's signature.
- [x] **Decided 2026-09-19 (owner-delegated):** keep `b7-<slug>.prd.md`, matching B6. README rows are the status authority, not the file name. Question as recorded: **PRD file name: `b7-<slug>.prd.md` like B6 (default, used here) versus pattern rule 1's `bN-<slug>-<date>.md`.** The B6 PRD is named without a date suffix; other plan documents in the repo follow a dated pattern. Proposed default: match B6's convention, as used for this file.
- [x] **Decided 2026-09-19 (owner-delegated):** confirmed — every B7 change lands through a draft PR from a feature branch into `dev`. Question as recorded: **This preparation lands through a draft PR from `docs/b7-prd` into `dev` because `dev` is PR-only; confirm.** `dev` is a protected, PR-only branch (`docs/contributing.md:194-231`). Proposed default: yes, a draft PR from `docs/b7-prd`.
- [x] **Decided 2026-09-20 (owner, decision 18):** HP-6 is removed as B7's entry gate; B7-4 onward proceed without it. This supersedes the 2026-09-19 decision above, which held B7-4 through B7-18 for HP-6's signature. _Why:_ the two constraints are circular. HP-6's Task 0 takes B6-12's rehearsed tag as its release candidate and stops outright if B6-12 has not landed, because "every server artifact installs" is only provable from a tag run; B6-12's rehearsal is the next real alpha tag, a throwaway having been refuted (it would reach every auto-updating server); and the owner is cutting no further release until the beta. The beta ships after B9 (`docs/plans/README.md:45`), so waiting for HP-6 would mean B7 waits on a tag that cannot exist until after B7 is done. The risk the gate guards against is unchanged and small here: it protects the client from consuming unstable server services, and B7-4/B7-5 migrate client call sites onto the desktop adapter rather than consuming new server surface. Question as recorded: **B7-4 is blocked by HP-6, HP-6 is blocked by a release tag, and the release tag is blocked until the beta, which B7 precedes — cut the tag anyway, waive HP-6 as B7's gate, or build a non-publishing rehearsal?** Owner chose to waive. **What this does not change:** HP-6 still runs before the beta, against B6-12's tag; it is deferred, not cancelled, and B6-12 and B6-16 stay `in-progress`.

## Risks

| Risk                                                                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter migration silently changes behavior because a native call site's contract was never written down explicitly     | Medium     | High   | Contract tests written in B7-3 before any call site moves in B7-4/B7-5; app behavior compared before and after each migration step                                                                                                                                                                                                                                                                                                                                                     |
| Decomposition weakens the voice supersession or E2EE staleness guards it is meant to preserve                           | Medium     | High   | The three local ESLint rules and the supersession/staleness tests that exist today stay green through B7-9 and B7-10; any rule change is its own reviewed step                                                                                                                                                                                                                                                                                                                         |
| Extraction gets mixed with feature behavior in the same PR, making regressions hard to attribute                        | Medium     | Medium | The ordering rule above keeps B7-9/B7-10/B7-11 (extraction) and B7-12 through B7-16 (feature behavior) in separate PRs at all times                                                                                                                                                                                                                                                                                                                                                    |
| Server endpoints needed by client flows (registration mode, retention summary) quietly widen the phase into server work | Medium     | Medium | Keep the two additions to `server-info` small and owned by the client milestones that need them (B7-15); no other server work enters scope (see Out of scope)                                                                                                                                                                                                                                                                                                                          |
| Windows ARM64 has no runner, no updater asset row, and no artifact evidence today                                       | Medium     | High   | B7-0 recorded the gap; B7-17 tries the `windows-11-arm` runner release.yml already uses for the server, and falls back to declared cross-compile evidence only if the Tauri toolchain fails there (decision 4)                                                                                                                                                                                                                                                                         |
| A full-client Stryker run exceeds CI's time budget                                                                      | Medium     | Medium | Nightly full-client run as the baseline (Open Question 5), CI keeps only the narrow hotspot subset that already exists                                                                                                                                                                                                                                                                                                                                                                 |
| Gate ratchets (coverage, bundle budgets, import cycles) become a long tail that blocks unrelated PRs                    | Medium     | Medium | Ratchet thresholds move only with a decomposition milestone that earns the improvement (Open Question 9); a stalled ratchet is raised as its own issue, not silently loosened                                                                                                                                                                                                                                                                                                          |
| Bundle budgets cannot be met before B7-9 decomposes it, because LiveKit is statically imported by 12 modules            | High       | Medium | **Amended 2026-09-20 (owner decision, factual correction):** this row's premise held only for the modules already lazy-loaded — `livekitSession` is a dynamic import, and its 1.34 MB gz bulk was the RNNoise barrel's dead sync-WASM, not LiveKit's static imports. B7-7's deep-import fix lands the chunk at ~20 kB gz, so the 800 kB budget (decision 10's post-decomposition figure, adopted now) is met before B7-9; decomposition is no longer a precondition of any B7-7 budget |

---

_Status: DRAFT — requirements only. Implementation planning pending via /plan._
