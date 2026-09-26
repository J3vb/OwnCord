# Plan: B7-10 — Decompose dispatcher, messaging and stores

> **Status:** complete 2026-09-22. 10a (Tasks 0–8) merged in
> [#1670](https://github.com/J3vb/OwnCord/pull/1670), 10b (Tasks 9–14) in
> [#1672](https://github.com/J3vb/OwnCord/pull/1672) and 10c (Tasks 15–20) in
> [#1677](https://github.com/J3vb/OwnCord/pull/1677). Every acceptance item is
> met, with three deviations documented in those PRs:
>
> - **D1 (acceptance item 6):** 10a's mutant total rose 8.7 %, outside the 3 %
>   band — new call-list and registration mutants from the composition, not
>   rewritten code; no module's score dropped
>   (`docs/plans/b7-8-mutation-baseline-2026-09-20.md`, 10a section).
> - **D2 (acceptance item 2):** 10c added `onAuthCleared(cleanupNotificationAudio)`
>   to `main.ts` instead of self-registering in `notifications.ts`, which would
>   have meant editing `session-isolation.test.ts`'s mock. 10a left `main.ts`
>   untouched as the item requires.
> - **D3 (acceptance item 9):** the startup-closure budget was raised
>   90 000 → 91 000 B in 10a by owner decision (`Client/bundle-budgets.json`
>   note); after 10c the closure measures about 86 KB.
>
> `madge` still reports 11 cycles: five close only through the lazy
> `import("@lib/livekitSession")` and six through `import type` back-edges, so
> the oxlint `lint:cycles` gate at `--max-warnings=0` is the zero (owner
> answer to open question 2).

> **Milestone:** B7-10 of
> [b7-shared-client-platform-desktop-parity.prd](../../docs/plans/b7-shared-client-platform-desktop-parity.prd.md).
> **Branches:** `feat/b7-10a-dispatcher` (Tasks 0–8),
> `feat/b7-10b-messages-store` (Tasks 9–14, based on 10a) and
> `feat/b7-10c-import-cycles` (Tasks 15–20, based on 10b).
> **Worktree:** `.claude/worktrees/b7-10a`, `.claude/worktrees/b7-10b` and
> `.claude/worktrees/b7-10c`.
> **Drafted:** 2026-09-21. **Base commit:** `92242f4a` (`dev`).
> **Starts only after B7-9b and B7-12 have landed** (`prd.md:344-347`; B7-12
> landed in #1655) **and after B7-14's dispatcher edit has landed** — see
> [Dependencies](#dependencies-and-concurrent-files). Every line number below is
> from `92242f4a`; Task 0 recounts them at the real start commit.

## Summary

The milestone outcome is one sentence: "Message handling and its stores split by
ownership while the dispatcher stays the only door store writes come through,
and production import cycles drop to zero or are explicitly boundary-tested"
(`prd.md:322`). It closes gap rows 6 and 16 (`prd.md:183,193`) and register rows
C-11 and C-12 (rest) (`prd.md:371`;
`docs/plans/repo-health-issue-register-2026-08-23.md:214-215`). Recounted at
`92242f4a`, the two modules gap row 6 names are the second and fourth largest
non-generated TypeScript files in the client:

| Module                         | Lines | Mutants (B7-8) | Score (B7-8) | Re-measured here (both files, one run) |
| ------------------------------ | ----: | -------------: | -----------: | -------------------------------------: |
| `src/lib/dispatcher.ts`        | 1 447 |            851 |      80.19 % |                                80.23 % |
| `src/stores/messages.store.ts` | 1 172 |            788 |      83.64 % |                                83.64 % |

The re-measured column is one command at the base (Verify row 5): the two files
together are **1 638 mutants / 81.82 %**, with 472 errored mutants excluded from
the score, in 37 m 46 s. The B7-8 columns are its per-module table
(`docs/plans/b7-8-mutation-baseline-2026-09-20.md:158,211`).

**The milestone is three serial PRs, because its outcome has three clauses.**

- **10a — the dispatcher.** `wireDispatcher` is one 1 200-line function
  (`dispatcher.ts:226-1447`) holding 32 `ws.on(...)` registrations plus one
  `onStateChange` and one `onSendFailure` subscription. Its handlers move into
  per-feature handler modules under `src/features/`; `dispatcher.ts` keeps
  **every** `ws.on(...)` call, the `READY` and `ERROR` ordering, and its two
  exports.
- **10b — the messages store.** Every mutator in `messages.store.ts` is a
  reducer wrapped in `messagesStore.setState((prev) => …)` (22 call sites). The
  reducers move out as pure `(prev, input) => next` functions under
  `src/features/messaging/`; the store instance, the mutator names and the
  selectors stay where they are.
- **10c — import cycles.** `lint:cycles` sits exactly at its ceiling of 21
  (`Client/package.json:39`). None of the 21 diagnostics is in `dispatcher.ts`
  or `messages.store.ts`; they are four clusters with four root back-edges.
  10c removes them, pins the ceiling at the result, and carries the ratchets.

**"The only door" is a lexical rule, and that decides the shape of 10a.**
`local/no-store-write-in-ws-on` flags an imported store mutator called from
inside a `ws.on(...)` callback, in every `src/**/*.ts` file except
`src/lib/dispatcher.ts` (`Client/eslint.config.js:108-116`;
`Client/eslint-rules.js:316-386`). There are two ways to split the dispatcher:

1. handler modules call `ws.on(...)` themselves and the rule's `ignores:` list
   grows to name them — the door becomes a set of files; or
2. handler modules export **plain functions** and `dispatcher.ts` keeps every
   `ws.on(...)` registration — the door stays one file and **the rule and its
   config do not change**.

This plan takes (2). It is what the supplement asks for ("retain one composition
entry … Preserve the rule that WebSocket-driven store writes enter through
dispatcher ownership", `developer-experience-layout-refactor-2026-08-29.md:389-392`),
it is what the PRD outcome says ("the dispatcher stays the only door"), and it
avoids a local-rule change, which the PRD makes "its own reviewed step"
(`prd.md:407`). What (2) does not give for free is a guard against some _other_
module importing a handler and calling it from its own `ws.on(...)` — the rule
is lexical and would not see it. Task 1 closes that with a colocated boundary
test (Open question 1).

**The store facade is load-bearing for the same rule.** The rule recognises a
mutator by its import source matching `stores/` (`eslint-rules.js:334-337`). If a
consumer imported a mutator from `features/messaging/…` instead, the rule would
go blind to it. So 10b keeps `@stores/messages.store` as the only import path
for the 13 static importers (Verify row 8), exactly as `livekitSession.ts` stayed
the facade in B7-9 (`b7-9-decompose-voice.plan.md:59-67`).

**The oracle already exists.** `tests/unit/dispatcher.test.ts` (5 053 lines, 188
cases) drives every handler through `wireDispatcher` with a mock socket, and
`tests/unit/messages.store.test.ts` + `messages-store-detached.test.ts` (2 072 +
396 lines, 131 + 21 cases) drive every mutator through the store's public names.
Both seams survive the split untouched, so both suites stay **unedited** — a
split that needs one changed is a split that changed behavior.

**Mutation measurement follows B7-9's settled answer.** Measure locally, record
the before/after with the exact command in the B7-8 baseline doc, apply a pass
rule, and leave `stryker.ci.config.mjs` alone
(`b7-9-decompose-voice.plan.md:461-489,594-601`). The B7-8 nightly is inert on
`dev` until carried to `main`, so the local run is the only measurement this
milestone can rely on (Tasks 8 and 14).

## Dependencies and concurrent files

- **B7-8 is the baseline and it has landed** (#1644). Its shard config and union
  check are the measurement instrument.
- **B7-9a has landed** (https://github.com/J3vb/OwnCord/pull/1657) and already
  did the gate work B7-10 would otherwise need: `stryker.config.mjs:21-28`
  mutates `src/features/**/*.ts` and excludes `src/**/*.test.ts`,
  `check-mutation-shards.mjs:17` uses `matchesGlob`, and `tsconfig.build.json`
  excludes colocated tests. B7-10 adds **no** gate plumbing.
- **B7-9b is in flight and B7-10 waits for it** (`prd.md:345-346`). It edits
  `Client/eslint.config.js` (the `e2ee-*` `files:` lists), `stryker.shard.config.mjs`
  (the `livekit` list), `check-mutation-shards.mjs`' inputs, `coverage-floor.json`
  (90 → 91), `bundle-budgets.json`, `Client/CLAUDE.md`'s layout bullet and the
  B7-8 baseline doc. B7-10 touches the same five files in different places:
  other shard lists, the next coverage step (91 → 92), the same layout bullet
  and a further evidence append. **Start from a `dev` that contains 9b; if it
  does not, stop** (Task 0). B7-9b's validation greps
  `import("@lib/livekitSession")` sites as "still 8"
  (`b7-9-decompose-voice.plan.md:533`); Task 5 moves the dispatcher's site to a
  relative path, which is why B7-10 must not overlap 9b.
- **B7-12 has landed** (https://github.com/J3vb/OwnCord/pull/1655) and owns the
  epoch block in the `AUTH_ERROR` handler (`dispatcher.ts:299-320`; its oracle is
  `dispatcher.test.ts:292-339`). Task 6 moves that block **verbatim** into the
  connection handler module; it is not reworded, reordered or merged with
  anything.
- **B7-14 is in flight** and, per this milestone's brief, adds a
  `SESSION_REPLACED` branch to the `ERROR` handler beside `BANNED`
  (`dispatcher.ts:1275-1290`), plus edits to `main.ts`, `api.ts` and `types.ts`.
  It is **not** on `dev` at `92242f4a` (`git grep -n SESSION_REPLACED -- Client/src`
  → no match). "Extraction and feature behavior never share one PR"
  (`prd.md:347-349,408`) and B7-12's review already set the ordering principle —
  "`dispatcher.ts` is decomposed only after both of its editors have landed"
  (`b7-12-compatible-update-incompatible-state.plan.md:224-228`). So **10a starts
  after B7-14's dispatcher edit is on `dev`**, and Task 6 moves the
  `SESSION_REPLACED` branch with `BANNED`, verbatim. If the owner wants 10a to
  start earlier, that is Open question 3.
- **B7-15 is in flight** (`feat/b7-15a-server-info` exists on the remote) and
  touches `main.ts`, `types.ts` and `LoginForm.ts`. B7-10 edits none of the
  three. `main.ts:15` imports `wireDispatcher`/`wireConnectionStatus`, and both
  exports keep their names and signatures, so there is no shared hunk.
- **B7-13** decided its isolation case lives in its own
  `session-isolation.test.ts`, which mocks `@lib/dispatcher`
  (`session-isolation.test.ts:186`). The facade path is unchanged, so that mock
  keeps working.
- **B7-11 runs after B7-10** (`prd.md:347`) and owns timer/listener ownership.
  `wireDispatcher`'s `unsubs` array stays as it is; B7-10 introduces no new
  lifecycle primitive.
- **Startup bundle headroom is 1 063 B** (Verify row 3) and B7-14/B7-15 both add
  to `main.ts`'s static closure. `dispatcher.ts` and `messages.store.ts` are in
  that closure. A split adds module wrappers, not code, but the margin is small
  enough that **every PR re-measures** and a breach is recorded **BLOCKED**, not
  fixed by raising the budget.

## Why plain handler functions, and where they live

Extracted modules go under `src/features/` with **relative imports and no
alias** — decided once by the B7 plans review for B7-9 and stated to carry to
B7-10 as `features/messaging/` (`b7-9-decompose-voice.plan.md:132-146`);
`Client/CLAUDE.md:9-11` now records it. The supplement's target layout names the
feature directories (`developer-experience-layout-refactor-2026-08-29.md:249-255`),
and the supplement's own handler grouping — "messaging, presence, channel, DM,
voice, and compatibility handlers" (`:389-390`) — maps onto them:

| New module                                   | Handlers it owns (from `dispatcher.ts`)                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/connection/wsHandlers.ts`      | `AUTH_OK` (`:279`), `AUTH_ERROR` incl. the B7-12 epoch block (`:300`), `SERVER_RESTART` (`:1210`), the `ERROR` handler's `BANNED` branch (`:1275-1290`) and B7-14's `SESSION_REPLACED` branch; the reconnect-clock state (`:243-266`)  |
| `src/features/direct-messages/wsHandlers.ts` | `DM_CHANNEL_OPEN` (`:622`), `DM_CHANNEL_CLOSE` (`:643`), `mapDmUser`/`mapDmPayload` (`:175-204`), the `READY` DM slice                                                                                                                 |
| `src/features/channels/wsHandlers.ts`        | `PRESENCE` (`:894`), `CHANNEL_CREATE/UPDATE/DELETE` (`:909-921`), `MEMBER_JOIN/BAN/UPDATE` (`:943-957`), `ROLES_UPDATE` (`:978`), `EMOJI_UPDATE` (`:988`), `USER_UPDATE` (`:995`)                                                      |
| `src/features/messaging/wsHandlers.ts`       | `CHAT_MESSAGE` (`:681`), `CHAT_EDITED/DELETED/BULK_DELETED` (`:805-817`), `CHAT_SEND_OK` (`:823`), `REACTION_UPDATE` (`:874`), `TYPING` (`:886`), the offline/send-failure rollbacks (`:1239-1266`), the `ERROR` pending-send branches |
| `src/features/voice/wsHandlers.ts`           | `VOICE_STATE/MOVED/DISCONNECTED/LEAVE/CONFIG/TOKEN` (`:1042-1176`), `VOICE_E2EE_ANNOUNCE/OFFER` (`:1192-1200`), `enforceModeratorAudioState` (`:150`), the lazy `livekitSession()` loader (`:114`), the `ERROR` voice/video branches   |

Each handler is exported as a plain function and receives what it needs from a
small context object built once in `wireDispatcher` (`ws`, the optional `api`
pick, and the reconnect clock). `dispatcher.ts` keeps the registrations:

```ts
const ctx: DispatchContext = { ws, api, clock: createReconnectClock() };
unsubs.push(ws.on(S.CHAT_MESSAGE, (payload) => handleChatMessage(ctx, payload)));
```

**Two handlers are cross-domain and stay composed in `dispatcher.ts`:**

- `READY` (`:325-617`, ~290 lines) writes channels, roles, members, voice, DMs,
  blocks, emoji and the message-window resync in a fixed order. Each feature
  module exports its slice (`applyReadyVoice`, `applyReadyMessagingResync`, …);
  `dispatcher.ts` calls them in today's order.
- `ERROR` (`:1269-1437`) is an ordered chain with early returns: `BANNED` →
  pending send → pending reaction → the `joining` rollback → `CHANNEL_FULL` →
  `VIDEO_LIMIT` → generic toast → video rollback. Each feature exports a
  `handle…Error(ctx, payload, id): boolean` that returns `true` when it consumed
  the frame; `dispatcher.ts` keeps the order. **The order is behavior** — the
  `joining` rollback deliberately runs before every code-specific branch
  (`:1320-1366`).

**One piece of state crosses features.** `lastReconnectHandshakeAt` is written by
`AUTH_OK` (`:280-283`) and read by `CHAT_MESSAGE`'s replay gate (`:720-722`);
`serverClockSkewMs` is written by `CHAT_MESSAGE` (`:799`). Both are closure
variables today so a fresh login starts clean (`:238-244`). They become one
`createReconnectClock()` object created **inside** `wireDispatcher` per call —
never module state, or the per-login reset is lost.

## Verify before you implement

Every row was re-derived at `92242f4a` with the command shown. If a row is false
at your HEAD, **stop that task and record it**; do not improvise around it. Rows
whose numbers B7-9b or B7-14 will legitimately move are marked **(moves)** — for
those, record the new number in Task 0 and continue.

| #   | Claim                                                                                                                                                                                                                                        | How to re-check                                                                                                                                                                                                                              | Verified |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `dispatcher.ts` is 1 447 lines and `messages.store.ts` 1 172; they are the 2nd and 4th largest non-generated `.ts` files (`livekitE2EE.ts` 1 612, `AccountTab.ts` 1 221) **(moves)**                                                         | `wc -l Client/src/lib/dispatcher.ts Client/src/stores/messages.store.ts Client/src/lib/livekitE2EE.ts Client/src/components/settings/AccountTab.ts`                                                                                          | yes      |
| 2   | `wireDispatcher` holds 32 `ws.on(` registrations plus one `onStateChange` and one `onSendFailure`; the module exports exactly `DispatcherCleanup`, `wireConnectionStatus`, `wireDispatcher` **(moves with B7-14 only if it adds a handler)** | `grep -c "ws\.on(" Client/src/lib/dispatcher.ts` → 32; `grep -n "^export" Client/src/lib/dispatcher.ts` → `:206,:214,:226`                                                                                                                   | yes      |
| 3   | The bundle gate is green and startup headroom is 1 063 B: startup closure 88 937 B / 90 000; `MainPage` 56 934 / 60 000 **(moves)**                                                                                                          | `cd Client && npm run build:budget && node scripts/bundle-budget.mjs`                                                                                                                                                                        | yes      |
| 4   | The mutation surface already includes `src/features/**/*.ts` and excludes colocated tests; the union check uses `matchesGlob`; the shard union equals the surface                                                                            | `Client/stryker.config.mjs:21-28`; `Client/scripts/check-mutation-shards.mjs:17`; `cd Client && node scripts/check-mutation-shards.mjs` → `shard union equals the configured surface: 81 files`                                              | yes      |
| 5   | The two modules are 1 638 mutants / 81.82 % together (`dispatcher.ts` 80.23, `messages.store.ts` 83.64), 472 errors excluded, 37 m 46 s                                                                                                      | `cd Client && npx stryker run --mutate "src/lib/dispatcher.ts,src/stores/messages.store.ts" --reporters clear-text` → `Instrumented 2 source file(s) with 1638 mutant(s)`                                                                    | yes      |
| 6   | `dispatcher.ts` is in the `transport-auth` shard and `messages.store.ts` in `stores`; the nightly matrix names the five shards, so a **new** shard would need a workflow edit                                                                | `Client/stryker.shard.config.mjs:37,97`; `.github/workflows/nightly-test-depth.yml:46`                                                                                                                                                       | yes      |
| 7   | `local/no-store-write-in-ws-on` is lexical (a mutator call inside a `ws.on(` callback), keyed on the import source matching `stores/`, and exempts only `src/lib/dispatcher.ts`                                                              | `Client/eslint.config.js:108-116`; `Client/eslint-rules.js:331-337,339-352,385-386`                                                                                                                                                          | yes      |
| 8   | The facade costs zero consumer churn: 13 static importers of `messages.store` in `src/`, no dynamic ones; `dispatcher.ts` has one production importer (`main.ts:15`)                                                                         | `git grep -lE 'from "(@stores\|\.\.?(/\.\.)*/stores\|\.)/messages\.store"' -- 'Client/src/**' \| wc -l` → 13; `git grep -n 'lib/dispatcher"' -- Client/src` → `main.ts:15`                                                                   | yes      |
| 9   | The oracle: `dispatcher.test.ts` 5 053 lines / 188 cases; `messages.store.test.ts` 2 072 / 131; `messages-store-detached.test.ts` 396 / 21; `tests/integration/stores.test.ts` 693 / 22 **(moves with B7-14)**                               | `wc -l` the four files; `grep -cE '\b(it\|test)(\.each\([^)]*\))?\('` on each                                                                                                                                                                | yes      |
| 10  | `dispatcher.test.ts` mocks by alias (`@lib/notifications`, `@lib/livekitSession`, `@lib/screenShare`, `@lib/toast`, `@lib/identity`); vitest resolves a mock by module, so a relative import of the same file is still mocked                | `grep -n "vi.mock(" Client/tests/unit/dispatcher.test.ts` → `:46,:50,:66,:72,:76`; B7-9a precedent: `features/voice/*.ts` import relatively while `livekit-session.test.ts` mocks by alias                                                   | yes      |
| 11  | Every `messages.store.ts` mutator is a `setState((prev) => …)` reducer (22 sites); the file's only runtime import is `createStore`                                                                                                           | `grep -c "messagesStore.setState" Client/src/stores/messages.store.ts` → 22; `grep -n "^import" Client/src/stores/messages.store.ts` → `:7` (+ one `import type` at `:8`)                                                                    | yes      |
| 12  | The import-cycle ceiling is 21 and the tree sits exactly at 21 diagnostics in 12 files; `madge` reports 20 cycles over 221 files; **none** involves `dispatcher.ts` or `messages.store.ts` **(moves with 9b)**                               | `Client/package.json:39`; `cd Client && npx oxlint -c .oxlintrc.cycles.json --tsconfig tsconfig.json src/` → 21 `no-cycle` warnings; `npx madge --circular --extensions ts --ts-config tsconfig.json src` → `Found 20 circular dependencies` | yes      |
| 13  | The 21 diagnostics are four clusters (see [the cycle table](#the-21-cycle-diagnostics-10c)); the root back-edges are `logger.ts:3`↔`preferences.ts:8`, `auth.store.ts:8`, `auth.store.ts:13`, `attachments.ts:23` and `avatar.ts:23-28`      | the oxlint command in row 12, then print each flagged import line                                                                                                                                                                            | yes      |
| 14  | `clearAuth` resets the voice store and notification audio **synchronously**, and the ordering is a documented invariant                                                                                                                      | `Client/src/stores/auth.store.ts:42-48,126-145`                                                                                                                                                                                              | yes      |
| 15  | The coverage floor is 90.0 on `dev`; decision 9 takes it to 91 in B7-9 (9b) and **92 in B7-10** **(moves with 9b)**                                                                                                                          | `Client/coverage-floor.json`; decision 9 at `prd.md:391`                                                                                                                                                                                     | yes      |
| 16  | `stryker.ci.config.mjs` still lists only `permissions.ts` at `break: 90`, and its only runner is the nightly's 25-minute job                                                                                                                 | `Client/stryker.ci.config.mjs:5-6`; `.github/workflows/nightly-test-depth.yml:76,89`                                                                                                                                                         | yes      |
| 17  | The suite is green: 249 files, 5 797 passed + 140 expected fail **(moves)**                                                                                                                                                                  | `cd Client && npx vitest run`                                                                                                                                                                                                                | yes      |
| 18  | The PRD's rules bind this milestone: the local rules stay green and any rule change is its own reviewed step; extraction and feature behavior never share one PR; ratchets move only with a decomposition milestone                          | `prd.md:407`, `prd.md:408`, `prd.md:412`                                                                                                                                                                                                     | yes      |
| 19  | `dispatcher.ts` imports upward into UI layers: `@components/message-list/reaction-tooltip` (`:78`), `@components/message-list/formatting` (`:79`), `@pages/main-page/SidebarDmHelpers` (`:92`) — a layering smell, **not** a cycle           | `grep -n '@components\|@pages' Client/src/lib/dispatcher.ts`; row 12's output has no `dispatcher.ts` line                                                                                                                                    | yes      |

### The 21 cycle diagnostics (10c)

Recorded from row 12's command at `92242f4a`. `madge` additionally lists four
voice-cluster cycles through `livekitSession.ts` ↔ `joinOrchestration.ts` ↔
`livekitE2EE.ts` and four UI parent/child cycles (`MessageList.ts` ↔
`renderers.ts`, `ChannelSidebar.ts` ↔ `drag-reorder.ts`, `SettingsOverlay.ts` ↔
two tabs) that `oxlint` does not flag. `oxlint` is the gate (`package.json:39`);
see Open question 2 for what "zero" is measured with.

| Cluster                | Diagnostics | Flagged import lines                                                                                                                                      | Root back-edge to cut                                                                                                           |
| ---------------------- | ----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| logger ↔ preferences   |           2 | `lib/logger.ts:3`, `lib/preferences.ts:8`                                                                                                                 | `preferences.ts:8` — one `log.warn` (`:43`) is the only use of the logger                                                       |
| auth ↔ voice store     |           2 | `stores/auth.store.ts:8`, `stores/voice.store.ts:15`                                                                                                      | `auth.store.ts:8` — `clearAuth` calls `resetVoiceStore()` (`:135`)                                                              |
| auth ↔ notifications   |           6 | `stores/auth.store.ts:13`, `lib/notifications.ts:9,14,17`, `lib/mentions.ts:11`, `lib/avatar.ts:28`                                                       | `auth.store.ts:13` — `clearAuth` calls `cleanupNotificationAudio()` (`:145`); and `avatar.ts:23-28` reaching into `components/` |
| message-list renderers |          11 | `attachments.ts:13,23`, `media.ts:17,26,27`, `content-parser.ts:16,23,24,25`, `custom-emoji.ts:17`, `embeds.ts:14` (all under `components/message-list/`) | `attachments.ts:23` (`openImageLightbox` from `./media`) and the URL/fetch helpers every sibling imports from `attachments`     |

## Patterns to Mirror

- **Facade over rewrite.** B7-9a moved ownership modules out from behind
  `LiveKitSession` while `livekitSession.ts` kept its import path, its exports
  and its delegate names (`Client/src/lib/livekitSession.ts:35-59`). Here the two
  facades are `dispatcher.ts` (two functions, one type) and `messages.store.ts`
  (the store instance, every mutator name, every selector).
- **Existing suites are the oracle, not the thing to edit.** A split that needs
  `dispatcher.test.ts` or `messages.store.test.ts` changed has changed behavior
  (`b7-9-decompose-voice.plan.md:189-193`).
- **Relative imports under `src/features/`, colocated `*.test.ts` beside each
  module** (`Client/src/features/voice/joinOrchestration.ts:8-16`;
  `Client/CLAUDE.md:9-11`).
- **Named invariants stay armed where the code lands.** B7-9 extended ESLint
  `files:` lists in the same commit as each move
  (`Client/eslint.config.js:77-86`). B7-10's equivalent is inverted: the rule's
  exemption must **not** grow, and Task 1's boundary test proves it has not.
- **Counts are recounted, never merged.** The shard union, the cycle ceiling and
  the coverage floor are re-derived from the tree after every rebase.
- **Prove a gate can fail.** Task 1's boundary test and Task 19's cycle ceiling
  are each observed red on a deliberate violation before being trusted.
- **Pure reducers.** `applyReactionDelta` (`messages.store.ts:1013`) is already a
  `(prev, …) => next` helper that the mutators wrap. 10b makes that the shape of
  every extracted function.

## Files to Change

Touch only these. Anything else → record **BLOCKED**.

| Path                                                                                                                                      | Change                                                                                                                                                              | PR       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `Client/src/features/{connection,direct-messages,channels,messaging,voice}/wsHandlers.ts` + `*.test.ts`                                   | new handler modules (plain functions, relative imports) and their colocated tests                                                                                   | 10a      |
| `Client/src/features/connection/dispatchContext.ts` + `.test.ts`                                                                          | `DispatchContext` type and `createReconnectClock()`                                                                                                                 | 10a      |
| `Client/src/features/dispatcherDoor.test.ts`                                                                                              | boundary test: only `lib/dispatcher.ts` imports a `wsHandlers` module; no `ws.on(` in any of them                                                                   | 10a      |
| `Client/src/lib/dispatcher.ts`                                                                                                            | shrinks to the composition: every `ws.on(` registration, `READY`/`ERROR` ordering, the two exports. Public surface frozen                                           | 10a      |
| `Client/src/features/messaging/{messageModel,echoReconcile,liveMessages,historyWindows,messageEdits,reactionState}.ts` + `*.test.ts`      | pure reducers and converters extracted from the store                                                                                                               | 10b      |
| `Client/src/stores/messages.store.ts`                                                                                                     | shrinks to the store instance, the mutator wrappers, the selectors and re-exported types. Public surface frozen                                                     | 10b      |
| `Client/stryker.shard.config.mjs`                                                                                                         | 10a's modules → the **`transport-auth`** list; 10b's modules → the **`stores`** list; any 10c leaf under `src/lib/**` → the shard of the file it was cut from       | all      |
| `Client/src/lib/preferences.ts`, `Client/src/lib/logger.ts`                                                                               | cut the logger ↔ preferences back-edge                                                                                                                              | 10c      |
| `Client/src/stores/auth.store.ts`, `Client/src/stores/voice.store.ts`, `Client/src/lib/notifications.ts`                                  | invert the two `clearAuth` back-edges (row 14's ordering preserved)                                                                                                 | 10c      |
| `Client/src/lib/avatar.ts`, `Client/src/components/message-list/{attachments,media,content-parser,custom-emoji,embeds}.ts` + one new leaf | move the shared URL/fetch helpers to a leaf module; cut `attachments.ts:23`                                                                                         | 10c      |
| `Client/package.json`                                                                                                                     | `lint:cycles` `--max-warnings` lowered to the measured count (target 0)                                                                                             | 10c      |
| `Client/coverage-floor.json`                                                                                                              | ratchet 91.0 → 92.0 (decision 9)                                                                                                                                    | 10c      |
| `Client/CLAUDE.md`                                                                                                                        | the layout bullet (new `features/` directories) and the dispatcher bullet (`:40-47`): handlers live in `features/*/wsHandlers.ts`, registrations in `dispatcher.ts` | 10a, 10b |
| `docs/architecture/client.md`, `docs/architecture/ux/README.md`, `docs/architecture/ux/messaging.md`                                      | the paths they cite for handler and reducer code (`client.md:41,132`; `ux/README.md:84,117`; `ux/messaging.md:127,157,223,230-231,384`)                             | 10a, 10b |
| `docs/plans/b7-8-mutation-baseline-2026-09-20.md`                                                                                         | append the 10a and 10b before/after measurements (an evidence append, not a status row)                                                                             | 10a, 10b |

**Not in the table, deliberately:**

- `Client/eslint.config.js` and `Client/eslint-rules.js` — design (2) needs no
  rule or config change. If a task seems to need one, that is a signal the
  handler modules started calling `ws.on(` — record **BLOCKED**.
- `Client/stryker.ci.config.mjs`, `Client/stryker.config.mjs`,
  `Client/scripts/check-mutation-shards.mjs`, `Client/tsconfig.build.json`,
  `.github/workflows/**` — B7-9a already did the plumbing; no new shard is
  created (row 6), so no workflow edit.
- `Client/tests/unit/dispatcher.test.ts`, `messages.store.test.ts`,
  `messages-store-detached.test.ts`, `tests/integration/stores.test.ts` — the
  oracle. Unedited.
- `Client/src/main.ts`, `Client/src/lib/api.ts`, `Client/src/lib/types.ts`,
  `Client/src/pages/connect-page/LoginForm.ts` — B7-14/B7-15's files.
- `Client/bundle-budgets.json` — B7-10 ratchets no bundle budget; it only has to
  stay under the existing ones.

**Never** edit `Server/db/dbgen/`, `Server/ws/message_types.go`,
`Client/src/lib/protocolTypes.ts`, `gendocs:*` blocks, the PRD, the register,
`docs/plans/README.md`, `CHANGELOG.md`, any other milestone's plan, or any status
row.

## Tasks

Commit after every task — conventional subject, scope `b7-10`, one task per
commit, no `Co-Authored-By` trailer. **Every commit must leave
`node scripts/check-mutation-shards.mjs`, `npm --prefix Client run lint` and the
two oracle suites green**; a task that would break them is split, not skipped.

**Tasks 0–8 are PR 10a** (`feat/b7-10a-dispatcher`). **Tasks 9–14 are PR 10b**
(`feat/b7-10b-messages-store`, branched from 10a). **Tasks 15–20 are PR 10c**
(`feat/b7-10c-import-cycles`, branched from 10b). 10a's PR targets `dev`; each
later PR targets its predecessor's branch until that merges, then `dev`.

### Task 0: Branch, preconditions, baseline and the oracle inventory

- **Action:** confirm the start commit contains B7-9b
  (`git grep -n "features/voice/e2ee" -- Client/stryker.shard.config.mjs` is
  non-empty and `Client/coverage-floor.json` reads 91.0) and B7-14's dispatcher
  edit (`git grep -n SESSION_REPLACED -- Client/src/lib/dispatcher.ts` is
  non-empty, unless Open question 3 was answered otherwise). **If either is
  missing, stop and report** — do not start on a moving `dispatcher.ts`. Create
  `feat/b7-10a-dispatcher`. Re-run Verify rows 1, 2, 3, 5, 9, 12 and 17 and
  record the output; every **(moves)** number is replaced by what you measure.
  Write the oracle down as an explicit list: the case counts of the four suites
  (row 9), the B7-12 epoch cases (`dispatcher.test.ts:292-339`), the `BANNED`
  cases (`:3413-3458`) and B7-14's `SESSION_REPLACED` cases.
- **Why:** the line numbers in this plan are from `92242f4a`, two merges before
  the real start. The before-number and the oracle have to be named before code
  moves.
- **Validate:** suite green; record file/case counts and statements coverage —
  neither may drop. Record the two-module mutation run as the **before-number**
  (81.82 % / 1 638 mutants at this plan's base; `dispatcher.ts` 80.23 %, `messages.store.ts` 83.64 %).

### Task 1: The door's boundary test (red first) — 10a

- **Action:** add `Client/src/features/dispatcherDoor.test.ts`. It reads the
  source tree with `node:fs` and asserts three things: (a) every file matching
  `src/features/*/wsHandlers.ts` is imported by `src/lib/dispatcher.ts` and by
  **no other** non-test file under `src/`; (b) no `wsHandlers.ts` file contains
  `ws.on(`, `.onStateChange(` or `.onSendFailure(`; (c) `dispatcher.ts` is still
  the only entry in the `ignores:` of the `local/no-store-write-in-ws-on` block
  in `eslint.config.js`. With no handler module yet, (a) and (b) pass vacuously —
  so add `src/features/connection/dispatchContext.ts` (the `DispatchContext`
  type and `createReconnectClock()`, plus its colocated test) in this commit and
  prove the test can fail: temporarily add a `wsHandlers.ts` containing `ws.on(`,
  observe red, delete it.
- **Why:** design (2) keeps the ESLint rule unchanged, but the rule is lexical
  and cannot see a handler being imported elsewhere. This is the "explicitly
  boundary-tested" half of the outcome for the dispatcher seam, and the
  precedent is `tests/unit/platform-contracts-counts.test.ts`.
- **Validate:** the new tests pass; the deliberate violation was observed red;
  add `dispatchContext.ts` to the `transport-auth` shard list;
  `check-mutation-shards.mjs`, `lint`, `typecheck`, `typecheck:build` green.
  Commit.

### Task 2: Extract the DM handlers — 10a

- **Action:** move `mapDmUser`/`mapDmPayload` (`dispatcher.ts:175-204`), the
  `DM_CHANNEL_OPEN` and `DM_CHANNEL_CLOSE` bodies (`:622-676`) and the DM slice
  of `READY` into `src/features/direct-messages/wsHandlers.ts` as
  `handleDmChannelOpen(ctx, payload)`, `handleDmChannelClose(ctx, payload)` and
  `applyReadyDms(ctx, payload)`. `dispatcher.ts` keeps the three `ws.on(` lines
  and calls them. Comments travel with the code, verbatim.
- **Gotcha:** the `@pages/main-page/SidebarDmHelpers` import (`:92`, row 19)
  moves with `DM_CHANNEL_CLOSE`. Keep it as it is — fixing that layering edge is
  not this task, and it is not a cycle.
- **Validate:** `npm --prefix Client test -- tests/unit/dispatcher.test.ts
tests/integration/stores.test.ts src/features` green with **no edit** to the
  first two; colocated tests cover `mapDmPayload`'s pre-group fallback
  (`:187-190`); `lint`, `typecheck`, `typecheck:build` clean; new file in the
  `transport-auth` shard list; union check green. Commit.

### Task 3: Extract the channel, member and presence handlers — 10a

- **Action:** move `PRESENCE`, `CHANNEL_CREATE/UPDATE/DELETE`,
  `MEMBER_JOIN/BAN/UPDATE`, `ROLES_UPDATE`, `EMOJI_UPDATE` and `USER_UPDATE`
  (`dispatcher.ts:894-1037`) into `src/features/channels/wsHandlers.ts`, one
  exported function per message type, plus `applyReadyChannels` for the
  `setChannels`/`setRoles`/`setMembers`/active-channel slice of `READY`
  (`:351-353,:434-468`).
- **Gotcha:** `CHANNEL_DELETE` (`:921-938`) and `USER_UPDATE` (`:995-1037`)
  write more than one store (channels + messages/DMs; members + auth + voice +
  DMs). They stay **whole** in this module — do not split one handler across
  features to make the imports tidier.
- **Validate:** as Task 2. Commit.

### Task 4: Extract the messaging handlers — 10a

- **Action:** move `CHAT_MESSAGE` (`dispatcher.ts:681-802`),
  `CHAT_EDITED/DELETED/BULK_DELETED` (`:805-820`), `CHAT_SEND_OK` (`:823-869`),
  `REACTION_UPDATE` (`:874-881`), `TYPING` (`:886-889`), the offline and
  send-failure rollbacks (`:1239-1266`), the `READY` message-window resync
  (`:470-520`) and the `ERROR` handler's pending-send and pending-reaction
  branches (`:1291-1319`) into `src/features/messaging/wsHandlers.ts`. The
  `ERROR` branches become `handleMessagingError(ctx, payload, id): boolean`.
  `REPLAY_GATE_WINDOW_MS` and its comment (`:96-109`) move with `CHAT_MESSAGE`.
- **Gotcha:** the replay gate reads `ctx.clock.lastReconnectHandshakeAt` and
  writes `ctx.clock.serverClockSkewMs` (`:720-722,:799`). The clock is created
  per `wireDispatcher` call (Task 1); a module-level variable here would survive
  a logout and re-login and is a behavior change.
- **Validate:** as Task 2, plus the replay/skew cases in `dispatcher.test.ts`
  (`grep -n "replay\|skew" tests/unit/dispatcher.test.ts`) pass unedited. Commit.

### Task 5: Extract the voice handlers — 10a

- **Action:** move the lazy `livekitSession()` loader (`dispatcher.ts:111-116`),
  `enforceModeratorAudioState` (`:118-173`), `VOICE_STATE`, `VOICE_MOVED`,
  `VOICE_DISCONNECTED`, `VOICE_LEAVE`, `VOICE_CONFIG`, `VOICE_TOKEN`
  (`:1042-1187`), `VOICE_E2EE_ANNOUNCE/OFFER` (`:1192-1205`), the `READY` voice
  reconciliation (`:335-349,:354-417`) and the `ERROR` handler's voice and video
  branches (`:1320-1436`) into `src/features/voice/wsHandlers.ts`. The error
  branches become `handleVoiceJoinRollback(ctx)` (runs, never consumes) and
  `handleVoiceError(ctx, payload, id): boolean`.
- **Gotcha:** the dynamic imports become relative
  (`import("../../lib/livekitSession")`, `import("../../lib/screenShare")`) and
  **must stay dynamic** — `livekit-client` is kept out of the entry chunk this
  way (`:111-113`), and `dispatcher.ts` is in the startup closure (row 3). The
  facade names it calls (`setMuted`, `setDeafened`, `handleParticipantLeft`,
  `leaveVoice`, `handleVoiceToken`, `handleE2EEAnnounce`, `handleE2EEOffer`,
  `isVoiceSessionActive`, `disableCamera`, `disableScreenshare`) are the surface
  B7-9 froze (`b7-9-decompose-voice.plan.md:110-116`); do not rename or bypass
  it by importing `features/voice/*` ownership modules directly.
- **Validate:** as Task 2, plus `cd Client && npm run build:budget && node
scripts/bundle-budget.mjs` — startup closure not above Task 0's number by more
  than 300 B and under 90 000; `livekit` and `livekitSession` still `[lazy]`.
  Commit.

### Task 6: Extract the connection handlers — 10a

- **Action:** move `AUTH_OK` (`dispatcher.ts:279-297`), `AUTH_ERROR` including
  the B7-12 epoch block (`:300-320`), `SERVER_RESTART` (`:1210-1229`) and the
  `ERROR` handler's `BANNED` branch (`:1275-1290`) **and B7-14's
  `SESSION_REPLACED` branch** into `src/features/connection/wsHandlers.ts`; the
  two error branches become `handleConnectionError(ctx, payload): boolean`.
  `setActiveChannelProvider` wiring (`:275-276`) stays in `dispatcher.ts` — it is
  transport composition, not a handler.
- **Gotcha:** this is the task that touches other milestones' code. Move both
  blocks **verbatim**, comments included. `ws.disconnect()` before `clearAuth()`
  in `BANNED` is load-bearing (OC-0107, `:1277-1289`).
- **Validate:** as Task 2, with the B7-12 cases (`dispatcher.test.ts:292-339`),
  the `BANNED` cases (`:3413-3458`) and B7-14's cases named in the commit body
  as passing unedited. Commit.

### Task 7: Reduce `dispatcher.ts` to the composition — 10a

- **Action:** with Tasks 2–6 done, `READY` and `ERROR` in `dispatcher.ts` are
  ordered call lists. Make the order explicit and commented — `READY`: pending
  messages → voice snapshot → channels → voice reconcile → identity publish →
  active channel → message resync → DMs → blocks → emoji (today's order,
  `:325-617`); `ERROR`: log → connection → messaging → voice-join rollback →
  voice (today's order, `:1269-1437`). Remove imports `dispatcher.ts` no longer
  uses.
- **Why:** this is where an accidental reorder would hide. The composition is
  the one part of the old file that cannot be tested by a colocated unit test of
  a single module, so its oracle is the unedited `dispatcher.test.ts`.
- **Validate:** `grep -c "ws\.on(" Client/src/lib/dispatcher.ts` equals Task 0's
  count; `grep -n "^export" Client/src/lib/dispatcher.ts` unchanged;
  `dispatcherDoor.test.ts` green; full `npm --prefix Client test` count not below
  Task 0's; `knip` clean. Commit.

### Task 8: Measure 10a, docs and the 10a gate

- **Action:** run the after-measurement over the same code:

  ```
  cd Client && npx stryker run --mutate "src/lib/dispatcher.ts,src/features/connection/*.ts,src/features/direct-messages/*.ts,src/features/channels/*.ts,src/features/messaging/wsHandlers.ts,src/features/voice/wsHandlers.ts,!src/**/*.test.ts" --reporters clear-text
  ```

  and compare it with Task 0's `dispatcher.ts` row. **Do not add anything to
  `stryker.ci.config.mjs`** (row 16: `break: 90`, 25 minutes). Append
  before/after, the command and the wall time to
  `docs/plans/b7-8-mutation-baseline-2026-09-20.md`. Update `Client/CLAUDE.md`
  (`:9-11`, `:40-47`) and the architecture docs in the file table.

- **The pass rule.** The after-score over the same code **must not fall more
  than 1 point below** Task 0's `dispatcher.ts` score, and the mutant total must
  be within 3 % of Task 0's (code moved, not rewritten). B7-9 measured a
  run-to-run spread of 0.16 on identical code
  (`b7-9-decompose-voice.plan.md:475-482`), so a drop beyond 1.0 is real. Every
  per-module drop is explained in the append; a drop the author cannot explain
  fails the task.
- **Validate:** the Validation block's 10a section, then the `ci-check` skill.
  Commit.

### Task 9: Extract the message model and converters — 10b

- **Action:** move `MessageStatus`, `Message`, `PendingReaction`, `MessagesState`
  (`messages.store.ts:30-118`), `chatPayloadToMessage` (`:120`),
  `messageResponseToMessage` (`:142`), `MAX_MESSAGES_PER_CHANNEL` (`:164`) and
  `INITIAL_STATE` (`:170`) into `src/features/messaging/messageModel.ts`.
  `messages.store.ts` re-exports the four types so no importer changes.
- **Validate:** `npm --prefix Client test -- tests/unit/messages.store.test.ts
tests/unit/messages-store-detached.test.ts tests/unit/dispatcher.test.ts
src/features/messaging` green, the first three unedited; row 8's importer count
  still 13; `lint`, `typecheck`, `typecheck:build`, `knip` clean; new file in the
  **`stores`** shard list; union check green. Commit.

### Task 10: Extract echo reconciliation — 10b

- **Action:** move `unescapeOnce`, `stripTags`, `sanitizePassApprox`,
  `echoNormalize` and `isUnreconciledEcho` (`messages.store.ts:191-300`) into
  `src/features/messaging/echoReconcile.ts`. They are already pure.
- **Why first among the reducers:** it is the dependency of Task 11 and the
  piece with the most mutation-relevant string logic; a colocated table test
  here is cheap and raises the score rather than merely preserving it.
- **Validate:** as Task 9. Commit.

### Task 11: Extract live-message and optimistic-send reducers — 10b

- **Action:** move the reducer bodies of `addMessage` (`:302`),
  `addOptimisticMessage` (`:387`), `markSendFailed` (`:425`), `removeOptimistic`
  (`:454`), `confirmSend` (`:893`), `channelIdForSend` (`:958`) and
  `applyServerMessage` (`:991`) into `src/features/messaging/liveMessages.ts` as
  `(prev: MessagesState, …) => MessagesState`. Each exported mutator keeps its
  name and signature and becomes
  `messagesStore.setState((prev) => reduceX(prev, …))`.
- **Gotcha:** a mutator that returns a value computed inside the updater
  (`rollbackReaction`'s `found`, `:1071-1090`; check `confirmSend` and
  `channelIdForSend` the same way) needs the reducer to return both, e.g.
  `{ next, found }`. Returning `prev` **by identity** when nothing changed is
  behavior — selector subscriptions compare with `===`
  (`Client/src/lib/store.ts:38`), so a fresh-but-equal object fires listeners
  that stay silent today. Keep every `return prev`.
- **Validate:** as Task 9. Commit.

### Task 12: Extract history-window reducers — 10b

- **Action:** move `setChannelLoading` (`:496`), `setChannelLoadError` (`:509`),
  `setMessages` (`:526`), `setAroundMessages` (`:624`),
  `invalidateLoadedMessageWindows` (`:693`), `invalidateChannelMessageWindow`
  (`:729`), `reattachToPresent` (`:750`) and `prependMessages` (`:761`) into
  `src/features/messaging/historyWindows.ts`, same reducer shape.
- **Validate:** as Task 9, with `messages-store-detached.test.ts` (21 cases)
  called out — it is the oracle for the detached-window logic. Commit.

### Task 13: Extract edit/delete/pin and reaction reducers — 10b

- **Action:** move `editMessage` (`:807`), `deleteMessage` (`:831`),
  `bulkDeleteMessages` (`:851`) and `setMessagePinned` (`:871`) into
  `src/features/messaging/messageEdits.ts`, and `applyReactionDelta` (`:1013`),
  `addOptimisticReaction` (`:1055`), `rollbackReaction` (`:1071`) and
  `updateReaction` (`:1093`) into `src/features/messaging/reactionState.ts`. The
  selectors (`:1140-1172`) and `resetMessagesStore` (`:1131`) stay in the store.
- **Validate:** as Task 9; `grep -c "messagesStore.setState"
Client/src/stores/messages.store.ts` still 22 (the wrappers remain, the bodies
  left). Commit.

### Task 14: Measure 10b, docs and the 10b gate

- **Action:** the after-measurement:

  ```
  cd Client && npx stryker run --mutate "src/stores/messages.store.ts,src/features/messaging/*.ts,!src/features/messaging/wsHandlers.ts,!src/**/*.test.ts" --reporters clear-text
  ```

  compared with Task 0's `messages.store.ts` row; same append, same pass rule as
  Task 8 (**not more than 1 point below**, mutant total within 3 %, every drop
  explained). Also run `STRYKER_SHARD=stores npx stryker run
stryker.shard.config.mjs` and record the shard's post-split score. Update the
  docs rows for `messages.store.ts` in the file table.

- **Validate:** the Validation block's 10b section, then `ci-check`. Commit.

### Task 15: Cut logger ↔ preferences — 10c

- **Action:** remove `preferences.ts:8`'s import of `./logger`. Its single use
  is the `log.warn` at `:43`; replace it with the smallest thing that keeps the
  warning observable without importing the logger (the implementer chooses;
  `console.warn` with the same message and fields is acceptable and is what a
  logger that cannot load its own level preference would fall back to).
- **Gotcha:** `tests/unit/preferences.test.ts` may assert the logger call. If it
  does, that assertion names an implementation detail of a cycle, and changing
  it is legitimate — **say so in the commit body**, do not do it silently.
- **Validate:** `tests/unit/preferences.test.ts`, `tests/unit/logger.test.ts`
  green; cycle diagnostics down by 2; lower `--max-warnings` by the delta in
  this commit. Commit.

### Task 16: Invert the two `clearAuth` back-edges — 10c

- **Action:** `auth.store.ts` stops importing `@stores/voice.store` (`:8`) and
  `@lib/notifications` (`:13`). Give `auth.store.ts` a tiny synchronous hook —
  `onClearAuth(fn): () => void` — that `clearAuth` runs at the exact points it
  calls `resetVoiceStore()` (`:135`) and `cleanupNotificationAudio()` (`:145`)
  today; `voice.store.ts` and `notifications.ts` register themselves at module
  load. The `voiceStore.getState()` snapshot (`:126`) has to be supplied by the
  same registration.
- **Gotcha (row 14):** the ordering is an invariant — subscribers reacting to
  `isAuthenticated` flipping false must see the voice store **already** reset
  (`:42-48`). The hook must be synchronous and run before `setState`. A module
  that is never imported never registers: `main.ts:23` imports
  `@stores/voice.store` statically and `dispatcher.ts:80` imports
  `./notifications`, so both load before any `clearAuth` can run — re-check that
  at your HEAD, and add a colocated test that fails if `clearAuth` runs with no
  voice registrant.
- **Validate:** `tests/unit/auth.store.test.ts`, `auth-store.test.ts`,
  `voice.store.test.ts`, `notifications.test.ts`, `main.test.ts` green and
  unedited; cycle diagnostics down by the auth ↔ voice pair and the
  `auth.store.ts:13` edge; ceiling lowered by the delta. Any new file under
  `src/stores/**` goes in the `stores` shard list, under `src/lib/**` in
  `lib-rest`. Commit.

### Task 17: Cut the message-list renderer cluster — 10c

- **Action:** move the URL and fetch helpers that every sibling imports from
  `attachments.ts` (`isSafeUrl`, `resolveServerUrl`, `fetchImageAsDataUrl`,
  `fetchExternalImage`, `externalPartition`, `recoverEvictedImage`) into one leaf
  module with no import of `media.ts`, `embeds.ts` or `content-parser.ts`, and
  re-point `media.ts:12-17`, `content-parser.ts:24`, `custom-emoji.ts:17`,
  `embeds.ts:14` and `lib/avatar.ts:23-28` at it. Cut `attachments.ts:23` by
  passing the lightbox opener in from the caller that already owns both
  (`renderers.ts`/`MessageList.ts`), or by moving `openImageLightbox` to the
  leaf's side of the graph — whichever leaves **zero** diagnostics in the
  cluster. `attachments.ts` re-exports the moved names so other importers and
  their tests are untouched.
- **Where the leaf lives** is Open question 2's second half: the recommendation
  is `src/components/message-list/` (it is DOM/render support, and
  `src/features/**` is in the mutation surface — row 4). If the owner chooses
  `src/features/messaging/`, add it to the `lib-rest` shard list.
- **Gotcha:** `attachments.ts:13` (`getToken` from `@stores/auth.store`) and
  `content-parser.ts:16`, `mentions.ts:11`, `notifications.ts:9` (`authStore`)
  are flagged only because `auth.store.ts` pointed back at them; they should
  clear with Task 16. Re-run the count before editing them.
- **Validate:** `npm --prefix Client test -- tests/unit/message-list.test.ts
tests/unit/message-list-media-release.test.ts tests/unit/avatar.test.ts` and
  every suite matching `attachments|media|embeds|content-parser|custom-emoji`
  green and unedited; `MainPage` chunk still under 60 000 B; ceiling lowered by
  the delta. Commit.

### Task 18: Whatever is left — remove or boundary-test — 10c

- **Action:** re-run row 12's two commands. For every remaining `oxlint`
  diagnostic: remove it, or — only if removal would change behavior — leave it
  and add a boundary test that names the two files and the single permitted
  edge, per C-11's acceptance ("an approved seam and boundary test documents
  each unavoidable cycle",
  `repo-health-issue-register-2026-08-23.md:214`). Record the `madge` list too
  (Open question 2): the four voice-cluster cycles are B7-9's territory and may
  already be gone after 9b; the four UI parent/child cycles are type-level.
- **Validate:** `lint:cycles` green at the new ceiling. Commit.

### Task 19: Pin the cycle ceiling and prove it can fail — 10c

- **Action:** set `--max-warnings` in `Client/package.json:39` to the measured
  count (target **0**). Prove it: add a throwaway two-file cycle under `src/`,
  observe `npm run lint:cycles` red, delete it.
- **Validate:** `npm --prefix Client run lint` green. Commit.

### Task 20: Ratchet, docs and the final gate — 10c

- **Action:** ratchet `Client/coverage-floor.json` 91.0 → 92.0 (decision 9,
  `prd.md:391`) and confirm `vitest.config.ts`'s thresholds still pass. Re-measure
  the bundle. Finish the `Client/CLAUDE.md` and architecture-doc edits.
- **Why:** the ratchet rule (`prd.md:412`) moves thresholds only with a
  decomposition milestone that earns the improvement — the colocated tests of
  10a and 10b are what earn this one. If measured statements coverage is below
  92.0 + 0.5, **do not ratchet**; record the number and raise it as its own
  issue, as `prd.md:412` prescribes.
- **Validate:** the Validation block's 10c section, then `ci-check`. Commit.

## Validation

```
# PR 10a
npm --prefix Client test                                   # file/case count not lower than Task 0
npm --prefix Client test -- tests/unit/dispatcher.test.ts tests/integration/stores.test.ts
git diff --stat origin/dev -- Client/tests/unit/dispatcher.test.ts Client/tests/integration/stores.test.ts   # empty
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build
npm --prefix Client run lint                               # 0 warnings; the store-write rule unchanged
git diff --stat origin/dev -- Client/eslint.config.js Client/eslint-rules.js   # empty
npm --prefix Client run knip
cd Client && node scripts/check-mutation-shards.mjs        # union exact, new files in transport-auth
cd Client && npm run build:budget && node scripts/bundle-budget.mjs   # startup < 90 000, livekit chunks lazy
grep -c "ws\.on(" Client/src/lib/dispatcher.ts             # equals Task 0's count
git grep -n "ws\.on(" -- 'Client/src/features/*/wsHandlers.ts'        # no match
npm run check:docs && npm run check:hygiene

# PR 10b (branched from 10a)
npm --prefix Client test
npm --prefix Client test -- tests/unit/messages.store.test.ts tests/unit/messages-store-detached.test.ts
git diff --stat origin/dev -- Client/tests/unit/messages.store.test.ts Client/tests/unit/messages-store-detached.test.ts   # empty
git grep -lE 'from "(@stores|\.\.?(/\.\.)*/stores|\.)/messages\.store"' -- 'Client/src/**' | wc -l   # still 13
npm --prefix Client run typecheck && npm --prefix Client run typecheck:build && npm --prefix Client run lint && npm --prefix Client run knip
cd Client && node scripts/check-mutation-shards.mjs        # new files in stores
cd Client && npm run build:budget && node scripts/bundle-budget.mjs
npm run check:docs && npm run check:hygiene

# PR 10c (branched from 10b)
npm --prefix Client test
npm --prefix Client run test:coverage                      # statements >= 92, floor ratcheted
npm --prefix Client run lint                               # lint:cycles at the new ceiling (target 0)
cd Client && npx madge --circular --extensions ts --ts-config tsconfig.json src   # recorded, see Open question 2
cd Client && node scripts/check-mutation-shards.mjs
cd Client && npm run build:budget && node scripts/bundle-budget.mjs
npm run check:docs && npm run check:hygiene
# → then the ci-check skill on each PR
```

## Risks

| Risk                                                                                                    | Likelihood | Impact | Mitigation                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `ERROR` or `READY` order changes during the split and a rollback runs late or not at all            | Medium     | High   | The order stays in `dispatcher.ts` as an explicit commented call list (Task 7); `dispatcher.test.ts`'s 188 cases run unedited on every commit                                              |
| The reconnect clock becomes module state and survives a logout, mis-classifying live messages as replay | Medium     | High   | `createReconnectClock()` is called inside `wireDispatcher` (Task 1) and the gotcha is restated where it bites (Task 4); a colocated test asserts two `wireDispatcher` calls get two clocks |
| A handler module is imported by a page and store writes gain a second door the lint rule cannot see     | Medium     | High   | `dispatcherDoor.test.ts` (Task 1), observed red first; the ESLint rule and its single exemption are asserted unchanged                                                                     |
| A consumer imports a mutator from `features/messaging/…` and the store-write rule goes blind to it      | Medium     | Medium | The store stays the facade; Validation greps the importer count; the reducers take `prev` and return state, so they cannot be called as a mutator by mistake                               |
| B7-14's or B7-12's branch is reworded while being moved                                                 | Medium     | High   | Task 6 moves both verbatim and names their oracle cases; 10a does not start until B7-14's dispatcher edit is on `dev` (Task 0)                                                             |
| 10a overlaps B7-9b and the two fight over the shard config, the coverage floor and the baseline doc     | Medium     | Medium | Task 0 refuses to start without 9b on `dev`; B7-10 touches different lists in the shared files                                                                                             |
| The startup closure crosses 90 000 B (headroom 1 063 B at the base, and B7-14/B7-15 add to it)          | Medium     | High   | Re-measured in Tasks 5, 8, 14, 17 and 20; voice imports stay dynamic; a breach is recorded **BLOCKED** and never fixed by raising the budget                                               |
| The mutation score drops because extracted code lost test reach                                         | Medium     | Medium | The pass rule in Tasks 8 and 14 (≤ 1 point, total within 3 %, every drop explained); colocated tests land with each module                                                                 |
| Extracted modules are added to `stryker.ci.config.mjs` and the nightly breaks when carried to `main`    | Low        | High   | The file is outside the file table; row 16 records why (`break: 90`, 25 minutes)                                                                                                           |
| `clearAuth`'s ordering invariant breaks when its two calls become registered hooks                      | Medium     | High   | The hook is synchronous and runs at the same two points (Task 16); the auth/voice/main suites run unedited; a colocated test fails when no voice registrant is present                     |
| Cycle removal in `components/message-list/` drifts into a renderer refactor                             | Medium     | Medium | Task 17 moves six named helpers and cuts one named edge; `MessageList.ts` decomposition is out of scope                                                                                    |
| The 92 % coverage floor blocks unrelated PRs                                                            | Low        | Medium | Ratchet only with 0.5 points of headroom (Task 20); otherwise record and raise separately (`prd.md:412`)                                                                                   |

## Out of scope

- **Decomposing `MessageList.ts` (1 141 lines) and `MessageInput.ts` (1 096).**
  The PRD lists them as hotspots (`prd.md:97-99`) but gap row 6 names only the
  dispatcher and the messages store (`prd.md:183`), register row C-12 is tagged
  B7/**B9** (`repo-health-issue-register-2026-08-23.md:215`), and the supplement
  puts "later feature UX" in B9 (`developer-experience-layout-refactor-2026-08-29.md:383`).
  10c touches `components/message-list/` only as far as cycle removal needs.
- **The other eight stores.** "and stores" in the milestone name is delivered by
  the messages store (the only store hotspot) and by the `auth`/`voice` store
  cycle. No other store is over 600 lines.
- **Fixing `dispatcher.ts`'s upward imports into `@components`/`@pages`** (row 19).
  They are not cycles; they move with their handlers unchanged.
- **Settings and CSS splits** (supplement Phase 5 items 5–6) — B9.
- **Timer/listener ownership** — B7-11. `unsubs` stays as it is.
- **Any ESLint local-rule change.** If one turns out to be needed it is "its own
  reviewed step" (`prd.md:407`), not a commit in these PRs.
- **Adding extracted modules to `stryker.ci.config.mjs`, a new nightly shard, or
  any workflow edit.**
- **Any feature or behavior change** — "extraction and feature behavior never
  share one PR" (`prd.md:408`).
- **The register rows, the PRD, the roadmap and other milestones' plans** — the
  orchestrator owns those.
- **Raising any budget or floor without measurement.**

## Open questions for the owner

1. **Is a boundary test the right guard for "the only door", or should the
   handler modules be allowed to register themselves?** Options: **(a)** plain
   handler functions, every `ws.on(` stays in `dispatcher.ts`, guarded by
   `dispatcherDoor.test.ts`, no ESLint change (this plan); **(b)** handler
   modules call `ws.on(` themselves and the rule's `ignores:` grows to
   `src/features/*/wsHandlers.ts` — a local-rule config change that `prd.md:407`
   makes its own reviewed step, and a door that is a glob rather than a file.
   **Recommendation: (a).** It matches the outcome's wording literally and
   changes no invariant's enforcement.
2. **What does "production import cycles drop to zero" get measured with, and
   where does the message-list leaf live?** `oxlint` is the enforced gate and
   reports 21; `madge` reports 20 with a different set (it includes four
   voice-cluster and four UI parent/child cycles `oxlint` does not flag).
   Options: **(a)** zero means `lint:cycles --max-warnings=0`; the `madge` list
   is recorded in the PR and anything left is named as type-level or as B7-9's;
   **(b)** zero means both tools, which pulls `MessageList.ts`,
   `ChannelSidebar.ts` and `SettingsOverlay.ts` into 10c. **Recommendation:
   (a)** — the gate B7-1 installed is the definition the ceiling has ratcheted
   against since, and (b) widens 10c into B9's UI work. Second half: put Task
   17's leaf in `src/components/message-list/` (**recommended** — a cycle fix, not
   an ownership extraction, and it keeps render-support code out of the mutation
   surface) or in `src/features/messaging/` (follows the supplement's letter;
   grows the `lib-rest` shard).
3. **Must 10a wait for B7-14?** Options: **(a)** wait until B7-14's dispatcher
   edit is on `dev`, then move `SESSION_REPLACED` with `BANNED` (this plan —
   the same ordering principle B7-12's review set); **(b)** start 10a once 9b
   lands, and B7-14 re-points its branch into
   `features/connection/wsHandlers.ts` when it rebases. **Recommendation: (a)**
   unless B7-14 slips by more than a few days; (b) is safe too, because the
   `ERROR` chain order stays in `dispatcher.ts`, but it makes a feature PR rebase
   across an extraction.

## Acceptance

- [ ] The milestone ships as **three serial PRs** — 10a (dispatcher, Tasks 0–8),
      10b (messages store, Tasks 9–14), 10c (import cycles and ratchets, Tasks
      15–20) — each green, none mixing extraction with feature behavior
- [ ] `dispatcher.ts` is the composition only: it still holds **every**
      `ws.on(` registration, the `READY` and `ERROR` ordering and its three
      exports; the handlers live in `src/features/{connection,direct-messages,channels,messaging,voice}/wsHandlers.ts`
      as plain functions with colocated tests; `main.ts` is untouched
- [ ] The dispatcher stays the only door: `local/no-store-write-in-ws-on` and its
      single exemption are **unchanged**, and `dispatcherDoor.test.ts` fails when
      a handler module is imported elsewhere or calls `ws.on(` (observed red)
- [ ] `messages.store.ts` is the facade only: the store instance, every mutator
      name and signature, the selectors; its reducers live under
      `src/features/messaging/` as pure functions with colocated tests; the 13
      static importers compile untouched
- [ ] Behavior is proven unchanged: `dispatcher.test.ts`,
      `messages.store.test.ts`, `messages-store-detached.test.ts` and
      `tests/integration/stores.test.ts` pass **with no diff**; the B7-12 epoch
      block and B7-14's `SESSION_REPLACED` branch moved verbatim
- [ ] A before/after mutation score is recorded for each of the two modules with
      the command that produced it; the pass rule holds (not more than 1 point
      below the before-number, mutant total within 3 %) and every drop is
      explained; `stryker.ci.config.mjs` is unchanged
- [ ] Every new file under `src/features/**`, `src/lib/**` or `src/stores/**` is
      named in a shard list (`transport-auth` for 10a, `stores` for 10b) and
      `check-mutation-shards.mjs` is green on every commit
- [ ] `lint:cycles` runs at `--max-warnings=0`, or every remaining cycle has a
      boundary test naming its one permitted edge; the ceiling was observed red
      on a deliberate cycle; C-11's acceptance text is met
- [ ] Coverage floor ratcheted 91 → 92 and green, or the shortfall is recorded
      and raised separately; the startup closure stays under 90 000 B and the
      `livekit`/`livekitSession` chunks stay lazy on all three PRs
- [ ] `npm --prefix Client test` count not lower than Task 0's; `typecheck`,
      `typecheck:build`, `knip`, `check:docs`, `check:hygiene` and the `ci-check`
      skill green on all three PRs
- [ ] No new `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `.skip` /
      `.only`; no loosened assertion; no PRD, register, roadmap or status-row edit
