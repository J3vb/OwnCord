# OwnCord Audit — Documentation Accuracy & UI/UX Test Coverage (2026-08-04)

**Audited tree:** `5630aa1` (= `dev` at audit time)
**Scope:** documentation/spec accuracy against the code, a UI/UX flow
inventory with test-coverage status, real test-suite executions, and
reconciliation of the four prior audits and eleven plan documents.
**Relation to `audit-2026-08-04.md`:** same date, disjoint scope — that
document is the whole-codebase *security* review (its three findings
A-2026-08-01/02/03 are referenced here as open, not re-litigated).
**Method:** every claim below was verified in the code at `5630aa1` and cites
`file:line` as of that commit. Every test result was produced by an actual
run in this audit session (§3); nothing is inferred from CI badges.
**Fixes:** unlike a read-only review, this audit *shipped* its documentation
fixes in the same branch — §5 lists what changed per document.

---

## 1. Executive summary

The documentation set was healthier at the reference layer than at the
architecture layer. `schema.md`, `system-overview.md`, `credential-storage.md`
and the UX messaging spec were essentially current; `api.md`/`protocol.md`/
`server-configuration.md` carried a handful of wrong numbers (one
security-relevant: the login rate limit documented as 60/min vs the enforced
5/min) and a large additive gap (the `/admin/api` surface); and the five
architecture pages were badly stale — all stamped "verified 2026-07-19" and
still asserting, among other things, that the protocol-schema codegen pipeline
did not exist and that the client HTTP path was unpinned, both the opposite of
reality. All of that is fixed in this branch.

Every runnable test suite is green at `5630aa1`: Go race + deadlock, client
unit/integration (4394 tests, 94.66% stmt coverage), Rust lib + clippy, the
full Playwright web e2e suite (**270/270**), the blocking `@parity` subset
(15/15), and the browser smoke suite. Coverage is deep for messaging,
channels, DMs, voice (mocked), and settings; the four flows with **no
end-to-end coverage at all** are the cert-TOFU trust flow, E2EE identity
verification, the admin panel, and the updater — each unit-tested but never
exercised as a user journey.

The prior audits needed three status reconciliations (all applied): the HIGH
e2e-suite breakage T-2026-07-25-21 was fixed but never closed; two 2026-07-19
rows still claimed no Playwright CI job exists; and two of the four F3
security-scan follow-ups (safety-number rendering, `rePinPeerIdentity` UI)
have shipped without their plan being updated. One 2026-04-07 finding (#8,
npm dependency pinning) was orphaned — never carried into any later audit —
and is resurfaced here as DC-11.

---

## 2. Architecture summary (as verified)

**Server** — one Go 1.26 binary (~42k LOC prod, ~71k LOC test).
`main.go` wires config (koanf: defaults → `config.yaml` → `OWNCORD_*` env),
TLS (self-signed/ACME/manual), SQLite (pure-Go, single writer), migrations
001–028, the WASM plugin registry (execution gated behind `-tags wazero`),
and hands off to `api.NewRouter` (`Server/api/router.go:35`) — the
composition root that builds the middleware chain (9 entries incl. an opt-in
Coraza WAF), mounts ~91 REST routes under `/api/v1` + `/admin/api`, and
constructs the `ws.Hub`. The ws package (~9.5k LOC, the largest) implements
typed V2-only command dispatch (V1 deleted), topic pub/sub with three-tier
priority queues, and 3-tier reconnect replay (ring buffer 1000 → events table
≤5000 → full `ready`). Voice is LiveKit (optional managed subprocess,
checksum-verified auto-download, 5-min scoped JWTs); voice E2EE is
client-side ECDH with the server acting only as an announce/offer relay and
key-holder tracker (`Server/ws/voice_e2ee.go`) plus long-term identity keys
(`users.identity_public_key`, migration 017). Wire types are **generated**:
`docs/protocol-schema.json` → `Server/scripts/genprotocol` → Go + TS
constants, CI-gated (`make protocol-verify`) — except the hand-declared
plugin command family (`chat_command`/`command_reply`/`plugin_broadcast`,
`Server/ws/handlers_command.go:22,117,135`), which bypasses the gate (DC-01).

**Client** — Tauri v2: ~42k LOC vanilla TS + ~4.7k LOC Rust in 16 modules,
29 IPC commands. All three network paths (WS, REST, LiveKit) terminate TLS in
Rust proxies sharing one TOFU core (`src-tauri/src/tofu.rs`) where *deciding
never writes a pin*: first contact is rejected until the user confirms via a
blocking modal; mismatches likewise. Credentials live in the OS keyring with
read-back verification and an encrypted-file fallback. The TS side is a
hand-rolled reactive store (9 store singletons), a 34-handler dispatcher as
the single WS fan-in, imperative-DOM component factories (~60 component
files), and a 2-page router (Connect/Main). Voice adds RNNoise noise
suppression, PTT via a native key poller, device hot-swap, screen share, and
an E2EE verification surface (roster shield badge → identity-mismatch modal →
TOCTOU-safe re-pin, `ChannelSidebar.ts:45-135`).

**Test infrastructure** — Go: 224 `_test.go` files (race + deadlock-tag runs
in CI; `-tags wazero`/`-tags otel` tests never run anywhere, T-2026-07-25-16).
Client: 167 vitest files (70% coverage gate, blocking), 37 web Playwright
specs (270 tests; full run non-blocking in CI, `@parity` subset blocking),
11 native specs (Windows-only, not in CI, 3 of them matched by no config),
1 browser-mode smoke, Stryker (manual). Rust: 83 `cargo test --lib` tests +
clippy `-D warnings`, blocking.

---

## 3. Test-run results (this session, at `5630aa1`)

Environment: Linux container, Go 1.26 (auto-fetched via `GOTOOLCHAIN=auto`;
host go 1.24.7), Node 22.22.2 (**CI pins Node 20** — one version-skew to keep
in mind), npm 10.9.7, Rust 1.94.1, Playwright chromium via a revision bridge
(preinstalled build 1194 symlinked to the expected 1234 layout; Chromium
141.0.7390.37), `xvfb` for the headed browser-mode run.

| Suite | Command | Result | Wall time |
| ----- | ------- | ------ | --------- |
| Go build (all tags implied by tests) | `go build ./...` | OK | (toolchain+module download dominated) |
| Go tests, race | `go test -race -timeout 20m ./...` | **PASS** — 14 packages ok, 0 failures | 5m35s |
| Go tests, deadlock detector | `go test -tags deadlock -count=1 ./...` | **PASS** | 2m03s |
| gofmt | `gofmt -l .` (Server/) | clean — no files | <1s |
| go vet | `go vet ./...` | **PASS** | ~30s |
| Client typecheck | `npx tsc --noEmit` | **PASS** | ~40s |
| oxlint | `npx oxlint src/` | **PASS** | <5s |
| ESLint | CI's generated-file patch, then `npx eslint src/` (patch reverted after) | **PASS** | ~50s |
| Prettier | `npx prettier --check "src/**/*.ts" "tests/**/*.ts"` | **PASS** | ~15s |
| Client unit+integration | `npx vitest run --coverage` | **PASS** — 167 files, **4394/4394**; coverage 94.66% stmts / 92.07% branch / 93.77% funcs (gate: 70%) | 3m04s |
| Client production build | `npm run build` (tsc + vite) | **PASS** | 26s |
| knip | `npx knip` | exit 1 — 1 unused export (`incrementDmMention`, `src/stores/dm.store.ts:181`) + 4 config hints; **does not flag the dead modules** (§7) | ~20s |
| npm audit (prod deps) | `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** | ~5s |
| Rust lib tests | `cargo test --lib` | **PASS** — 83/83 (Windows-only DPAPI tests excluded by cfg on Linux) | cold build ~8m, tests 0.09s |
| cargo clippy | `cargo clippy --all-targets -- -D warnings` | **PASS** | ~3m |
| Playwright web e2e (full) | `CI=1 npx playwright test --config=playwright.config.ts` | **PASS — 270/270**, no flaky retries | 8m40s |
| Playwright `@parity` | `CI=1 npx playwright test --grep "@parity"` | **PASS — 15/15** (mirrors the blocking CI job) | 35s |
| Browser-mode smoke | `xvfb-run -a npm run test:browser` | **PASS — 2/2** | 17s |

Not run, with reasons (no results are claimed for these):

| Suite | Why not | Compensating evidence |
| ----- | ------- | --------------------- |
| Native Playwright (`playwright.config.native.ts`) | Drives a built Windows Tauri exe over CDP/WebView2 — impossible on this Linux container | None in CI either — deliberately manual (see `tests/e2e/E2E-ISSUES.md`) |
| Tauri full bundle (`npm run tauri build`) | Packaging run not attempted (webkit dev libs installed, but bundle output wasn't needed for a docs audit) | CI `tauri-build` job on PRs to `main` |
| golangci-lint | Not installed locally; CI-only by design | Blocking `server-build-test` step (`ci.yml:87`) |
| `go test -tags wazero` / `-tags otel` | Same gap CI has — these tests run nowhere (T-2026-07-25-16, still open) | None — that is the finding |
| Stryker mutation | Manual-only by design, hours-long | `stryker.config.mjs` thresholds |

Flake rule used: a spec is *flaky* only if it failed then passed on retry
within a run, or failed in exactly one of two runs; a spec failing every
attempt is *failing*, named by file. No suite in this session needed the
distinction — there were zero retries and zero failures.

---

## 4. UI/UX flow coverage matrix

Status legend: **covered** = spec-conformant implementation + meaningful unit
*and* e2e coverage · **partial** = implemented + unit-tested but no (or thin)
end-to-end journey · **untested** = no automated coverage · **broken** = does
not do what the spec says (none found).

| # | Flow | UX spec | Implementation | Unit tests | Web e2e | Status |
|---|------|---------|----------------|-----------|---------|--------|
| 1 | Login (password) | connection-and-auth §2.2 | `pages/connect-page/LoginForm.ts:12` | `connect-page`, `auth.store` | `connect-page.spec.ts` (17) + native `auth-flow` | covered |
| 2 | Register by invite | connection-and-auth §3 | `LoginForm.ts` register branch | `register` paths in unit suite | `register-flow.spec.ts` (10) | covered |
| 3 | TOTP challenge | connection-and-auth §2.2 | `LoginForm.ts` `totp` state | `totp-settings` | `totp-flow.spec.ts` (5) | covered |
| 4 | Logout | connection-and-auth §7 | `lib/logout.ts`, `main.ts:592` | `logout` | `logout-flow.spec.ts` (2) | covered |
| 5 | **Cert TOFU first-use + mismatch** | connection-and-auth §5 | `main.ts:146-208`, `src-tauri/src/tofu.rs`, `CertMismatchModal.ts` | `cert-first-use-modal`, `cert-mismatch-modal`, `ws-cert`, `http-proxy`; Rust `tofu.rs` (12) | **none** | **partial — headline gap** |
| 6 | Server profiles (add/delete/auto-connect) | connection-and-auth §2.1 | `connect-page/ServerPanel.ts:53-317`, `lib/profiles.ts` | `profiles`, `server-panel` | `connect-settings.spec.ts` (3) | covered |
| 7 | Server quick-switch | connection-and-auth §6 | `QuickSwitchOverlay.ts`, `SidebarArea.ts:698` | `components/QuickSwitchOverlay` | switcher cases in `overlays.spec.ts` | covered |
| 8 | Reconnect banner + recovery | README §3 | `ServerBanner.ts`, `ws.ts` backoff | `ws-reconnect`, `ws-lifecycle`, `server-banner` | `reconnection.spec.ts` (6), `banners-toasts.spec.ts` (5) | covered |
| 9 | Channel sidebar (list/switch/categories) | channels-members-dms §1 | `ChannelSidebar.ts` | `channel-sidebar*`, `channel-controller` | `channel-sidebar.spec.ts` (10), `channel-switch-messages.spec.ts` (4) + native `channel-navigation` | covered |
| 10 | Channel create/edit/delete | settings-and-admin §3 | `Create/Edit/DeleteChannelModal.ts`, `SidebarArea.ts:16-18` | `create/edit/delete-channel-modal` | none dedicated | partial |
| 11 | Channel reorder (drag) | channels-members-dms §1.3 | `channel-sidebar/drag-reorder.ts` | `drag-reorder` (listener leak fixed 2026-08-05; the lifecycle tests now pin signal-ownership) | none | partial |
| 12 | Per-channel mutes | channels-members-dms §1.1a | `lib/channel-mutes.ts`, context menu | `channel-mutes`, `channel-mute-ui` | `gating-badges.parity.spec.ts` | covered |
| 13 | Message send (optimistic) | messaging §1-2 | `ChannelController.ts`, `messages.store.ts:225-279` | `messages.store`, `message-input`, `message-controller` | `message-send-flow` (5), `message-input` (8), `message-list` (6) + native `chat-operations` | covered |
| 14 | Edit / delete (two-click) | messaging §4-5 | `MessageInput.ts:589`, `MessageController.ts:24` | store + controller units | `message-edit-delete.spec.ts` (5) | covered |
| 15 | Reactions | messaging §6 | `message-list/reactions.ts`, `ReactionController.ts` | `reaction-controller`, `reaction-tooltip` | `message-actions.spec.ts` (12) | covered |
| 16 | Replies | messaging §7 | `MessageInput.ts:577`, `renderers.ts` | renderer units | `reply-flow.spec.ts` (5) | covered |
| 17 | Pins | messaging §9 | `PinnedMessages.ts`, `OverlayManagers.ts:202` | `pinned-messages` | pins cases only in **native** `overlays.spec.ts` | partial |
| 18 | Typing indicator | channels-members-dms §2.1 | `TypingIndicator.ts:20-25` | typing units | `typing-indicator{,-ws}.spec.ts` (7) | covered |
| 19 | Embeds / link previews | messaging §8 | `message-list/embeds.ts`, `media.ts` | `embeds`, `media*` | rich-content cases in `message-list.spec.ts` | partial |
| 20 | File upload | messaging §3 | `MessageInput.ts:372-571` (NOT the dead `FileUpload.ts`) | `attachments-*`, `file-upload` (tests the dead module) | upload-blocked cases in `message-input.spec.ts` | partial |
| 21 | GIF picker | messaging §3a | `GifPicker.ts`, `lib/gifProvider.ts` | `gif-picker`, `gif-provider` | none | partial |
| 22 | Emoji (picker/autocomplete/custom) | messaging §3b | `EmojiPicker.ts`, `EmojiAutocomplete.ts`, `custom-emoji.ts` | `emoji-*`, `custom-emoji` | `emoji-insertion.spec.ts` (3), `emoji-voicemod.parity.spec.ts` | covered |
| 23 | Mentions (+badges) | messaging §10 | `lib/mentions.ts`, `MentionAutocomplete.ts` | `mention-*` incl. property tests | `gating-badges.parity.spec.ts` | covered |
| 24 | Markdown/code rendering | messaging §8 | `message-list/markdown.ts`, `formatting.ts`, `syntax-highlight.ts` | `content-markdown`, `markdown-parser.property`, `safe-render` | rich-content cases | covered |
| 25 | Search | messaging §11 | `SearchOverlay.ts` | `search-overlay` | none | partial |
| 26 | Jump-to-message / deep links | messaging §12 | `MessageJump.ts`, `lib/deep-link.ts` | `message-jump`, `deep-link{,-init}` | none | partial |
| 27 | Read state / NEW divider / unread | messaging §13 | `lib/read-state.ts`, `MessageList.ts:91` | `read-state`, `message-list-new-divider` | unread-badge case in `channel-switch-messages.spec.ts` | covered |
| 28 | DMs (1:1) | channels-members-dms §3 | `SidebarDmSection.ts`, `dm.store.ts` | `dm-*` cluster | `dm-system.spec.ts` (9); native `dm-system` is **orphaned** (DC-03) | covered |
| 29 | Group DMs | channels-members-dms §3.1a | `MemberPickerModal.ts`, `DmSidebar.ts:240-251` | `member-picker-*`, `dm-groups` | `social.parity.spec.ts` (create/leave) | covered |
| 30 | Blocking | channels-members-dms §3.2 | `SidebarMemberSection.ts:177-186`, `blocks.store` | `blocks-store` | none | partial |
| 31 | Member list / presence / roles | channels-members-dms §2 | `MemberList.ts`, `members.store` | `members.store`, `sidebar-member-section` | `member-list.spec.ts` (6) | covered |
| 32 | Profile popup | channels-members-dms §2.2 | `UserProfilePopup.ts` (mounted from `MemberList.ts`) | `user-profile-popup` | none | partial |
| 33 | Status picker / auto-idle | README §3 | `StatusPicker.ts`, `lib/autoIdle.ts` | `status-picker-*`, `auto-idle`, `user-status` | `user-bar.spec.ts` (7) | covered |
| 34 | Voice join/leave/mute/deafen | voice-and-e2ee §1-3 | `lib/livekitSession.ts`, `VoiceCallbacks.ts`, `VoiceWidget.ts` | 24-file voice cluster | `voice-lifecycle` (24), `voice-channel` (11), `voice-widget` (5) + native `voice-controls` | covered *(mocked LiveKit — no real-media e2e anywhere)* |
| 35 | Push-to-talk | voice-and-e2ee §4 | `lib/ptt.ts` + `src-tauri/src/ptt.rs` | `ptt` + Rust `ptt.rs` (7) | none (needs native input) | partial |
| 36 | Noise suppression / audio pipeline | voice-and-e2ee §8 | `lib/noise-suppression.ts`, `lib/audioPipeline.ts` | `rnnoise-worklet`, `audio-pipeline-*` (lib itself is coverage-excluded with rationale) | none | partial |
| 37 | Video grid / screen share | voice-and-e2ee §5 | `VideoGrid.ts`, `lib/screenShare.ts` | `video-grid`, `screen-share-*`, `stream-preview` | camera/share cases in `voice-lifecycle.spec.ts` | partial |
| 38 | **E2EE securing + identity verification** | voice-and-e2ee §7 | `lib/livekitE2EE.ts`, `ChannelSidebar.ts:45-135`, `CertMismatchModal.ts:221` | `e2eeCrypto`, `livekit-e2ee`, `identity`, `identity-mismatch-modal` | `voice-e2ee-verify.spec.ts` (6, added 2026-08-05) | covered *(was a headline gap)* |
| 39 | DM calls (ring) | voice-and-e2ee §9 | `lib/call-ring.ts`, `IncomingCallBanner.ts`, `MainPage.ts:527` | `call-ring` | none | partial |
| 40 | Quick switcher (Ctrl+K) | channels-members-dms §1 | `QuickSwitcher.ts`, `GlobalKeybinds.ts` | `quick-switcher`, `global-keybinds` | `overlays.spec.ts` (26) + native `overlays` | covered |
| 41 | Context menus | README §2 | `lib/context-menu.ts:31`, `AdminActions.ts:163/412` | `context-menu`, `admin-actions` | role-change case in `social.parity.spec.ts` | covered |
| 42 | Toasts | README §2 | `Toast.ts`, `lib/toast.ts:31` | `toast`, `toast-coverage` | `toast.spec.ts` (5) | covered |
| 43 | Desktop notifications | README §2 | `lib/notifications.ts:37` | `notifications` | none (OS-level) | partial |
| 44 | NSFW gate | channels-members-dms §1.1 | `NsfwGate.ts`, `lib/nsfw-gate.ts` | `nsfw-gate` | `gating-badges.parity.spec.ts` | covered |
| 45 | Settings overlay (9 tabs incl. Accessibility) | settings-and-admin §1 | `SettingsOverlay.ts:102-110` + `components/settings/*` | per-tab tests incl. `accessibility-tab`, `os-motion` | `settings-overlay.spec.ts` (24), `theme-persistence.spec.ts` (7) + native | covered |
| 46 | Invites | settings-and-admin §3 | `InviteManager.ts` | `invite-manager` | invite cases in `overlays.spec.ts` | covered |
| 47 | Inline moderation (kick/ban+reason/role) | settings-and-admin §3 | `AdminActions.ts:99-330`, `SidebarMemberSection.ts` | `admin-actions`, `admin-panel` | `social.parity.spec.ts` | covered |
| 48 | **Admin panel (web, 14 sections)** | settings-and-admin §3.1 | `Server/admin/static/index.html` + `/admin/api` | Go: 23 `_test.go` files in `Server/admin/` | **none — no browser automation at all** | **partial — headline gap** |
| 49 | **Updater UI** | settings-and-admin §5 | `UpdateNotifier.ts`, `lib/updater.ts`, `update_commands.rs` | `updater`, `update-notifier` + Rust (2) | `updater.spec.ts` (4, added 2026-08-05) | covered *(was a headline gap)* |
| 50 | System tray | settings-and-admin §6 | `src-tauri/src/tray.rs` | none (no Rust tests; TS side untestable without native menu) | none | **untested** |
| 51 | Health status indicator | connection-and-auth §2.1 | connect-page health polling | `connect-page` units | `health-status.spec.ts` (2) | covered |
| 52 | Logs tab / log purge | settings-and-admin §1 | `settings/LogsTab.ts`, `lib/logPersistence.ts`, `purge-prompt.ts` | `logs-tab`, `log-persistence` | none | partial |

**Reading the matrix:** 30 flows fully covered, 21 partial, 1 untested,
0 broken. The four headline gaps (rows 5, 38, 48, 49) share a shape: they are
the client's *security- and lifecycle-critical* flows, exactly the ones where
a regression is least visible in day-to-day dev use.

### UX problems beyond test coverage

- **Dead-but-tested modules** mislead readers of the test suite:
  `ServerStrip.ts`, `FileUpload.ts`, `lib/reconcile.ts` and `src/generated/`
  are imported by nothing in `src/` yet keep green test files
  (`server-strip.spec.ts` even runs in every e2e pass). §7.
- ~~**No toast on active-channel deletion**~~ **CLOSED 2026-08-05 (DC-12)** —
  the `channel_delete` handler toasts "This channel was deleted" alongside
  the redirect; non-active deletions stay silent.
- ~~**No optimistic reaction toggle**~~ **CLOSED 2026-08-05 (DC-12)** — the
  pill toggles on click under the send's correlation id; the self-echo is
  consumed, an error reply or transport failure rolls back exactly that
  toggle (`addOptimisticReaction`/`rollbackReaction`).
- ~~**No slow-mode countdown in the composer**~~ **CLOSED — was already
  implemented** (verified 2026-08-05): `ChannelController.startSlowMode`
  drives a ticking composer reason from the ready payload's `slow_mode`;
  the audit's gap note reflected a stale spec callout, now flipped.
- ~~**No in-flight state on destructive admin actions**~~ **CLOSED
  2026-08-05 (DC-12)** — `withConfirmation` already carried the pending
  state; the residual double-fire (role-change submenu) is now guarded too.
- ~~**Known bug (pinned by its own test):** `drag-reorder.ts` listener
  ref-count~~ **FIXED 2026-08-05 (DC-12)** — the per-row ref-count is
  replaced with per-sidebar AbortSignal ownership (idempotent per signal,
  released on abort); the pinning test now pins the fixed contract.
- ~~**Accessibility:** … untracked debt~~ **CLOSED 2026-08-05 (DC-13)** —
  systematic pass shipped: `lib/a11y.ts` (dialog semantics, focus trap,
  focus restore, roving tabindex) applied through `modalFactory` and every
  hand-rolled modal/overlay, tablist semantics on SettingsOverlay,
  combobox wiring on QuickSwitcher and the composer autocompletes,
  listbox/option + roving tabindex on the pickers, and polite live regions
  for toasts/typing; +71 unit cases and an axe-style e2e smoke
  (`a11y-smoke.spec.ts`).

---

## 5. Documentation accuracy findings (fixed in this branch)

| Doc | Verdict before | Highest-stakes drift | Fixed in |
| --- | -------------- | -------------------- | -------- |
| `docs/api.md` | minor drift + big gap | Login rate limit said **60/min**, code enforces **5/min** (`Server/api/constants.go:19`); 24 `/admin/api` endpoints had no reference section | C1 `df12147` |
| `docs/protocol.md` | moderate drift | Type counts wrong (24→26, 33→37); voice join/leave limit said "None" (is 5/1s, `ws/voice_join.go:22`); E2EE offer said 5/1s (is 64/1s, `ws/voice_e2ee.go:23`); plugin command family undocumented | C1 `df12147` |
| `docs/server-configuration.md` | moderate drift | 3 WAF keys + `database.type` + `telemetry.otlp_insecure` + entire `logging` section missing; plugin-disabled status said 501 (is 503, `api/plugins_handler.go:51`) | C1 `df12147` |
| `docs/deployment.md` | minor drift | `/health` sample still showed the removed `version` field; stale build version | C1 `df12147` |
| `docs/schema.md` | **current** | none — verified 10/10 spot checks incl. migrations table through 028 | no change needed |
| `docs/architecture/websocket.md` | badly stale | Claimed `protocol-schema.json` **does not exist** — it is the CI-gated codegen source (`Server/scripts/genprotocol`) | C2 `28f66fb` |
| `docs/architecture/server.md` | badly stale | Wrong WS dependency (`nhooyr.io` → `github.com/coder/websocket`, `go.mod:8`); LOC 44-55% low; migrations 016→028 | C2 `28f66fb` |
| `docs/architecture/data-model.md` | badly stale | Claimed migrations 001-015 & 23 tables (actual: 028 & 26); told readers `schema.md` was 6 migrations behind when it is current | C2 `28f66fb` |
| `docs/architecture/voice-e2ee.md` | stale callout | Claimed the E2EE flow is absent from `protocol.md` (it has a full section) | C2 `28f66fb` |
| `docs/architecture/client.md` | badly stale | Described the deleted Solid beachhead; claimed the HTTP path is **unpinned** when `http_proxy.rs` pins via the shared `tofu.rs`; listed a deleted `roles` store | C2 `28f66fb` |
| `docs/architecture/system-overview.md` | current | — (re-stamped only) | C2 `28f66fb` |
| `docs/architecture/ux/*` (6 files) | minor drift | Cert first-use described as an 8s banner on `trusted_first_use`; reality is a blocking modal on `first_use` with reject-until-confirmed (`main.ts:146-176`); two "remaining gaps" (block button, ban reason) had already shipped; several whole features undocumented (group DMs, channel mutes, DM ring, E2EE verify UI, tray) | C3 `8c8a4a5` |
| `docs/security.md` | minor drift | "Hardcoded **Tenor** API key" limitation was doubly wrong (provider is Klipy, key is server-side); audit-log action list claimed `backup_restore` is logged (it is not — no `WriteAudit` on the restore path); firewall checklist omitted the LiveKit media ports | C4 `a31c555` |
| `docs/credential-storage.md` | current | one casing nit (`"keyring"` vs serialized `"Keyring"`) | C4 `a31c555` |
| `docs/quick-start.md`, `README.md` | minor drift | Stale build versions (1.0.0 / 1.1.0-alpha.3 → 1.2.0-alpha.1); README's "latest audit" pointer | C4 `a31c555` |
| `docs/contributing.md` | minor drift | sqlc rows claimed a PostgreSQL engine + `pgdbgen` (removed); protocol targets missing | C4 `a31c555` |
| `docs/plans/*` (11 files) | mixed | statuses verified & stamped; see §6 | C5 `064a8c6` |
| `Client/tauri-client/tests/e2e/E2E-ISSUES.md` | 4.5 months stale | Claimed 209/209 (suite is 270); pointed at a nonexistent `docs/brain/` plan | C8 `940377c` |
| `CHANGELOG.md` | gap | No Unreleased section; three post-release fixes unrecorded | C7 `627e658` |
| `docs/livekit-setup.md`, `tailscale.md`, `port-forwarding.md`, `mcp-introspect.md`, `client-architecture.md` (stub), `SECURITY.md` | current | cross-references verified; no drift found worth an edit | no change |

---

## 6. Prior-audit & plan reconciliation

### audit-2026-08-04.md (security review, same day)

All three findings verified **still open** at `5630aa1` — nothing in this
docs-only branch changes them:

- **A-2026-08-01 (HIGH):** `handleDeleteChannelPermission` lacks the
  hierarchy/grantability guards its PUT twin has
  (`Server/admin/handlers_channel_perms.go:180` vs `:141-150`).
- **A-2026-08-02 (HIGH):** admin channel LIST/PATCH/DELETE lack the
  `type == "dm"` guard (`Server/admin/handlers_channels.go:38/159/237`).
- **A-2026-08-03 (MEDIUM):** `DMService.RingTargets` skips the block check
  every sibling DM sink performs (`Server/service/dm.go:336`).
- Its §5 observation also verified: `handleRestoreBackup` hardcodes
  `data/chatserver.db`, ignoring `cfg.Database.Path`
  (`Server/admin/handlers_backup.go:177`).

### audit-test-coverage-2026-07-25.md

- **T-2026-07-25-21 (HIGH)** — closed this branch (C6): the e2e suite was
  repaired but the audit never updated; re-verified 270/270 locally.
- Still open, re-confirmed: **-16** (wazero/otel-tagged tests never run — the
  single highest-leverage CI change), **-17** (`main.go`/seed untested),
  **-18** (`MainPage.ts`/`main.ts` coverage-excluded), **-19** (no Go/Rust
  coverage floor, deliberate), **-20** (unreproduced `-coverpkg` flake).
- Its §4 bugs: `logctx.WithGroup` nesting — not re-tested here;
  `drag-reorder` ref-count — still present (KNOWN BUG comment).

### audit-2026-07-19.md

- Item 11 ("E2E not in CI") and backlog #10 — closed this branch (C6),
  both were stale.
- Still open, re-confirmed: **A-2026-07-10** (router god-constructor),
  **A-2026-07-11** (`ws.Hub` mega-object with `Set*` post-construction
  wiring — the temporal coupling note in `websocket.md` still applies),
  **A-2026-07-13** (dead `sounds` table), **A-2026-07-14** (scattered client
  constants).

### audit-2026-04-07.md

- **#8 (HIGH, unpinned critical npm packages)** — orphaned: marked
  "review in P2" and never carried into any later audit. Resurfaced here as
  **DC-11**. (Today's `npm audit --omit=dev`: 0 vulnerabilities, and the
  repo commits `package-lock.json`, so the practical exposure is bounded —
  but the finding was never dispositioned.)
- **#9 (auth_handler bypasses service layer)** — still open
  (`api/router.go:104` passes `database` to `MountAuthRoutes`).
- **#11** — E2E-in-CI half closed; **`.nvmrc` still absent** (CI pins
  Node 20 inline; this session ran Node 22 — the skew is real, DC-10).

### docs/plans (11 files — statuses stamped in C5)

Shipped: decisions record, channel-visibility-unification, http-tofu-proxy,
permission-middleware-consolidation (disclosed `channelCanSend` copy still
open at `serve_ready.go:119`), security-hardening-remediation, sqlc-adoption,
v2-dispatch-migration, tauri-capability-narrowing (DNS-rebinding follow-up
open), **discord-parity** (all six Phase 1 rows verified shipped — including
archived channels, which recon initially mis-reported: they are filtered by
`permissions/checker.go:116-121`), **security-scan-2026-07-22** (8/8 closed;
two of four F3 follow-ups have since shipped — safety number rendered,
`rePinPeerIdentity` wired at `ChannelSidebar.ts:125`; `getIdentityPin`
fail-open remains, DC-08). Design-only: slash-commands (staleness notes
added — migration 016 taken, `Server/store/` gone).

---

## 7. Dead code & unused dependencies

`npx knip` (real output this session): 1 unused export
(`incrementDmMention`, `src/stores/dm.store.ts:181` — zero callers anywhere,
tests included) + 4 config hints. **Knip cannot flag the dead modules below:**
its vitest/playwright plugins treat test files as entries, so a module whose
only importer is its own test is "used" by construction. That is exactly the
zombie pattern all four exhibit:

| Module | LOC | Evidence of death | Kept alive by |
| ------ | --- | ----------------- | ------------- |
| `src/components/ServerStrip.ts` | 140 | `SidebarArea.ts:4` comment: "The ServerStrip has been removed in favor of…"; zero imports in `src/` | `tests/unit/server-strip.test.ts`, `tests/e2e/server-strip.spec.ts` (runs in every e2e pass) |
| `src/components/FileUpload.ts` | 231 | zero references in `src/`; real upload lives in `MessageInput.ts` | `tests/unit/file-upload.test.ts` |
| `src/lib/reconcile.ts` | — | only `tests/unit/reconcile.test.ts` imports `reconcileList` | its test |
| `src/generated/**` | 259 | zero imports in `src/` or `tests/`; generated 2026-04-03, covers only 21 of 29 IPC commands; CI regenerates it (`ci.yml:418-439`) into a directory no bundle reads; `build.rs` never invokes typegen locally | CI regeneration ritual |

Also in this category server-side: the `sounds` table (dead schema,
documented as such), `voice_speakers` (reserved, never emitted),
`voice_config.bitrate`, and the macOS PTT stub — all already inventoried in
`docs/plans/discord-parity.md` §"still-dead code".

Deletion is deliberately **not** done in this branch (docs-only diff) —
DC-05 below is the decision request.

---

## 8. TODO/FIXME inventory

The entire codebase carries **five** TODO/FIXME markers — remarkably clean:

| # | Location | Text (condensed) | Assessment |
| - | -------- | ---------------- | ---------- |
| 1 | `Server/ws/voice_e2ee.go:167` | "consider re-checking key-holder status inside sendToUserIfInVoiceChannel" | **security-adjacent** — sits on the E2EE relay path the F3 work hardened; worth a decision |
| 2 | `Client/.../src/pages/main-page/SidebarArea.ts:600` | `TODO(H16)`: O(n) DOM thrash on rebuild | perf; the only ID-tagged TODO |
| 3 | `Server/admin/update_handlers.go:35` | "maybe disable this endpoint in future docker build type?" | ops hardening; distroless image makes self-update pointless in-container |
| 4 | `Server/ws/deps.go:270` | "consider replacing 'deps any' with generics" | type-safety debt from the V2 migration |
| 5 | docs prose | non-actionable | — |

One **stale code comment** found (not a TODO): `Server/ws/serve_ready.go:141`
claims the ready payload carries "no slow_mode, archived, voice_* extras" —
but `channelPayloadFrom` (`ws/messages.go:272-284`) ships `slow_mode`,
`nsfw`, `voice_max_users`, `voice_max_video`. The comment predates
discord-parity Phase 5. Code comment → not fixable in a docs-only diff
(DC-09).

---

## 9. Prioritized gap list

**P0 — broken:** none found. Every spec'd flow that exists works as
specified, and every suite is green.

**P1 — significant risk or misleading state**

- **DC-01** ~~Extend `docs/protocol-schema.json` with `chat_command`,
  `command_reply`, `plugin_broadcast` so the codegen gate covers them~~
  **RESOLVED 2026-08-04 (remediation pass, this branch)** — schema at 27/39,
  constants regenerated both sides, hand-rolled declarations replaced, and
  the contract test's exception list is empty now.
- **DC-02** ~~The three open security findings A-2026-08-01/02/03~~
  **RESOLVED 2026-08-04 (remediation pass)** — all three fixed with pinning
  tests; statuses closed in [audit-2026-08-04.md](audit-2026-08-04.md).
- **DC-03** ~~Three native e2e specs matched by **no** Playwright project~~
  **RESOLVED 2026-08-04 (remediation pass)** — all three joined
  `native-authenticated` (they use the persistent fixture + `ensureLoggedIn`).
- **DC-04** E2E-coverage headline gaps: cert-TOFU flow, E2EE verification,
  admin panel, updater (matrix rows 5/38/48/49). **PARTIALLY RESOLVED
  2026-08-04 (remediation pass)** — the cert-TOFU ceremony now has six e2e
  tests (`cert-tofu.spec.ts`: first-use content/trust/cancel/non-stacking,
  mismatch rows/disconnect). **FURTHER RESOLVED 2026-08-05 (closure pass)** —
  the E2EE-verification journey (`voice-e2ee-verify.spec.ts`, 6 tests:
  verified badge with safety number + first-sight pin, legacy unverified,
  mismatch block, modal reject/trust, DC-08 fail-closed) and the updater
  journey (`updater.spec.ts`, 4 tests: silence, banner/Later, progress →
  auto-relaunch, failure/Dismiss) shipped. **Remaining: the admin panel
  journey (row 48)** — the only flow still without browser automation.

**P2 — hygiene with real cost**

- **DC-05** ~~Dead-module deletion decision~~ **RESOLVED 2026-08-04
  (remediation pass, decision: delete)** — `ServerStrip.ts`, `FileUpload.ts`,
  `lib/reconcile.ts`, `public/rnnoise-worklet.ts`, `src/generated/**`, the
  orphan `getSounds`/`deleteSound` API methods, `incrementDmMention`, their
  test files, and the entire typegen pipeline (CI steps, tauri.conf.json
  plugin block, Cargo build-dep) are gone; knip is blocking in CI. The dead
  `sounds` table fell in the same pass (migration 029, A-2026-07-13).
- **DC-06** ~~`go test -tags wazero` / `-tags otel` run nowhere
  (T-2026-07-25-16) — ~598 lines of tests permanently dark.~~
  **RESOLVED 2026-08-05 (closure pass)** — CI's `server-build-test` (ubuntu
  leg) now runs `go test -tags wazero ./plugin/...` and
  `-tags otel ./telemetry/...`; both passed locally on their first-ever run
  (no latent failures were hiding behind the tags).
- **DC-07** ~~Flip `client-e2e` to blocking after a soak~~ **RESOLVED
  2026-08-05 (§13)** — blocking, on the owner's direction, with the soak
  evidence recorded in the job comment.
- **DC-08** ~~`getIdentityPin` fail-open on transient keyring errors
  (`identity.ts:106-118`, F3 follow-up 3).~~ **RESOLVED 2026-08-05 (closure
  pass)** — `getIdentityPin` returns a three-state lookup
  (pinned/unpinned/unavailable, mirroring tofu.rs's Err-vs-Ok(None) split);
  `verifyPeerAnnounce` rejects the announce on "unavailable" without any pin
  write and surfaces the distinct "unknown" badge state. Pinned by unit
  tests (pin present / no pin / store error, the rejection path, the badge)
  and an e2e case in `voice-e2ee-verify.spec.ts`.
- **DC-09** ~~stale comments; backup-restore audit row; `handleApplyUpdate`
  container TODO~~ **RESOLVED 2026-08-05 — in three passes:** comments
  (§11), restore audit row (§12), container-aware update refusal (§13).
- **DC-10** Node version skew: CI pins 20, no `.nvmrc`, this session ran 22.
  **RESOLVED 2026-08-05 (remediation follow-up)** — `Client/tauri-client/.nvmrc`
  pins 20 to match CI, closing 2026-04-07 #11's remainder.
- **DC-11** ~~Resurfaced 2026-04-07 #8: adopt an explicit npm dependency
  pinning/review policy~~ **RESOLVED 2026-08-05 (§13)** — policy written in
  `docs/contributing.md`.

**P3 — polish**

- **DC-12** ~~UX open gaps already carried in the specs: channel-delete toast,
  optimistic reactions, slow-mode countdown, admin action in-flight state,
  drag-reorder listener leak.~~ **RESOLVED 2026-08-05 (closure pass)** — see
  the closed bullets in §4: toast + optimistic reactions shipped with tests;
  slow-mode countdown and the in-flight states were verified already
  implemented (stale spec notes flipped; the residual role-change
  double-fire fixed); the drag-reorder leak replaced with signal ownership.
- **DC-13** ~~Systematic a11y pass over the modal stack (focus traps,
  `aria-modal`, screen-reader labels) — nothing tracks this today.~~
  **RESOLVED 2026-08-05 (closure pass)** — see the closed a11y bullet in §4
  (`lib/a11y.ts`, modalFactory + every hand-rolled modal, tablist, combobox
  wiring, roving-tabindex pickers, live regions; +71 unit cases + e2e
  smoke).
- **DC-14** `voice_speakers` is documented "Reserved — not currently
  emitted"; either emit or drop from the schema at the next protocol rev.
  (Remediation-pass decision: kept reserved — same treatment as
  `member_leave`; dropping either is a protocol rev, not dead-code cleanup.)
- **DC-15** ~~Anchor-drift hygiene: several UX-spec `file:line` anchors were
  200-700 lines stale within 3 weeks; consider symbol-based references.~~
  **RESOLVED 2026-08-05 (closure pass)** — all 55 remaining anchors across
  the six UX specs rewritten as symbol references, each verified against the
  code (15 were already pointing at entirely wrong lines and were re-aimed);
  zero `file:line` references remain under `docs/architecture/ux/`.

### Recommended next steps (ordered)

*(Original list, kept for the record — items 2-6 landed in the same-branch
remediation pass below, except the DC-07 soak decision and the E2EE-journey
half of item 4.)*

1. Land this branch (docs are the record everything else keys off).
2. DC-03 + DC-07 (two-line CI/config changes, immediate coverage payback).
3. DC-01 schema extension as its own reviewed PR (generated Go+TS churn).
4. DC-04: one Playwright spec each for the TOFU trust journey and the E2EE
   badge/mismatch journey (both fully mockable in the web harness — the unit
   mocks for `cert-tofu` events and peer verification already exist).
5. DC-05 dead-code deletion PR.
6. The security review's A-2026-08-01/02/03 remediation (separate track,
   already specified there).

---

## 11. Remediation addendum (2026-08-04, same branch)

**Method:** the pass above was read-only about code; this addendum records the
remediation commits that followed on the same branch, executing the gap list.
Every closure is stamped in place in the sections above and in the sibling
audits' closure tables; this section is the narrative summary.

### What shipped

| Area | Change | Closes |
|------|--------|--------|
| Security | Hierarchy guard on channel-override DELETE; DM exclusion across the admin channel surface; block check on DM rings — each with pinning tests | A-2026-08-01/02/03 (DC-02) |
| Dead code (client) | `ServerStrip.ts`, `FileUpload.ts`, `lib/reconcile.ts`, `public/rnnoise-worklet.ts`, orphan `getSounds`/`deleteSound` + `SoundResponse`, `incrementDmMention`, their test files; `server-strip.spec.ts` renamed `sidebar-header.spec.ts` to say what it tests | DC-05 |
| Dead code (typegen) | `src/generated/**` and its entire feeding pipeline: CI patch/generate steps, `tauri.conf.json` plugin block, inert `Cargo.toml` build-dep (lockfile shrinks by exactly the typegen subtree) | DC-05 |
| Dead schema | Migration `029_drop_sounds_table.sql`; sqlc model regenerated; schema.md / data-model.md / 07-19 closure table updated in the same commit | A-2026-07-13 |
| Server hygiene | `NewWAFMiddleware` wrapper deleted; `MsgTypeAuth` / `MsgTypeDMChannelClose` constants now used at their call sites; stale comments fixed (`config.go` Postgres claim, `host_ui.go` phantom route, `serve_ready.go` PROTOCOL.md) | DC-09 (partial) |
| Protocol | Plugin command family added to `protocol-schema.json` (27 c2s / 39 s2c), constants regenerated Go+TS, hand-rolled declarations replaced, contract-test exception list emptied, protocol.md tables updated | DC-01 |
| Tests | 3 orphaned native specs wired into `native-authenticated` (+14 tests); `tsconfig.e2e.json` + `typecheck:e2e` + CI step (47 spec files were typechecked nowhere; 1 real error found and fixed); `modalFactory.ts` 57.6% → 100%; cert-TOFU ceremony e2e (6 tests, race-free via exposed listener registry) | DC-03, DC-04 (TOFU half) |
| CI/process | knip blocking (its `\|\| true` was masking a real unused-export finding); `claude.yml` actions SHA-pinned like every other workflow; PR template gains the docs-maintenance checkbox A-2026-07-03 recommended | DC-06's sibling gap, A-2026-07-03 |
| Docs | contributing.md (dead postgres row, missing Make targets, tombstone link, coverage claim, branch flow), docs/security.md (broken link, 48h-vs-7d contradiction → SECURITY.md canonical), audit-2026-04-07 closure table (#6/#7/#10/#11), README (branch flow, Docs Index +6, plugin feature row, de-anchored security row), server-configuration env-var subset note, mcp-introspect line count, types.ts header | §5's misses |

### Decisions taken (and why)

- **Plugin host-capability API kept.** `HTTPDo`/`RegisterUI`/`Storage*`/`Emit`/
  `UITabBindings` are unwired but tested scaffolding for the announced
  host-function work (`sandbox_wazero.go` gate comment); deleting them would
  be de-scoping a roadmap feature, not cleaning dead code. The false comments
  around them were fixed instead.
- **`voice_speakers` and `member_leave` kept as reserved protocol entries.**
  Both are documented "Reserved — not currently emitted" in protocol.md;
  removing them is a protocol rev for the owner to schedule (DC-14).
- **`client-e2e` stays non-blocking (DC-07).** Flipping it is explicitly a
  soak-length call for the owner; this pass adds green evidence (full suite
  including the new TOFU spec) but does not shortcut the soak.
- **DELETE `.../permissions/{roleId}` on a nonexistent role now answers 404**
  (was 204) — the cost of resolving the role for the hierarchy guard, and it
  matches the PUT twin. The delete-again idempotency contract on an *existing*
  role is unchanged.

### Verification (this session, remediation HEAD)

| Suite | Result |
|-------|--------|
| Go `go test -race ./...` | all 14 test packages ok (admin 32.5s, api 126.6s, db 262.3s, service 163.3s, ws 166.2s, …) |
| Go `-tags deadlock` pass | all packages ok (ws 54.1s) |
| Go tag-variant builds (`otel`, `wazero`, `otel,wazero`) | all build clean (plus the default build) |
| `make sqlc-verify` + `make protocol-verify` | both pass |
| Client typecheck + typecheck:e2e + oxlint/eslint + prettier | all pass (two pre-existing oxlint style warnings, non-blocking) |
| knip | exits 0 (blocking in CI now) |
| Client unit/integration (vitest) | 164 files, **4360/4360 passed**; coverage 95.35% stmts / 92.04% branches / 93.89% funcs |
| Playwright web suite | **276/276 passed**, 8.9 min (270 baseline + 6 new TOFU tests) |
| Playwright `@parity` subset | 15/15 passed, 33.4s |

Environment notes: Linux container, Node 22 (CI pins 20 — DC-10 remains),
Go via `GOTOOLCHAIN=auto`; Rust/Tauri compile not attempted here (webkit2gtk
system deps absent) — `rust-tests`' clippy pass and the `tauri-build` job
cover the (inert) `Cargo.toml` change in CI. golangci-lint and the
windows-latest legs are likewise CI-only.

### Still open after this pass

*(Historical — superseded by §12's closure pass, which resolved most of
these; §12's own "still open" list is current.)*

DC-04 (E2EE-verification, admin-panel and updater journeys), DC-06
(tag-gated Go tests dark in CI), DC-07 (soak decision), DC-08
(`getIdentityPin` fail-open), DC-09's backup-restore audit row and
`handleApplyUpdate` TODO, DC-10 (`.nvmrc`), DC-11 (npm pinning policy),
DC-12/13/15 (UX gaps, a11y pass, anchor hygiene), and the 2026-04-07
carryovers #5 (accepted), #8, #9.

---

## 12. Closure addendum (2026-08-05, follow-up branch)

**Method:** a second remediation pass off `dev` at `7b6d2b0`, executing the
gap list's remaining P2/P3 items. Every closure is stamped in place in §4
and §9 above; this section is the narrative summary. As before, every claim
was verified against the code and every suite result below comes from an
actual local run.

### What shipped

| Area | Change | Closes |
|------|--------|--------|
| CI | `server-build-test` (ubuntu) now RUNS the tag-gated tests it previously only compiled: `-tags wazero ./plugin/...`, `-tags otel ./telemetry/...` — verified green locally on their first-ever run before wiring | DC-06 / T-2026-07-25-16 |
| Security (client) | `getIdentityPin` fail-open fixed: three-state lookup (pinned/unpinned/**unavailable**) mirroring tofu.rs's Err-vs-first-use split; `verifyPeerAnnounce` fails closed on "unavailable" (no verify, no re-pin) and surfaces a distinct amber "could not check" badge (new `unknown` PeerVerification state) | DC-08 (F3 follow-up 3) |
| Server | `backup_restore` audit row, written synchronously *before* the pre-restore safety copy so it survives inside `pre_restore_*.db`; test opens the safety copy and asserts the row; docs/security.md documents where the row lives instead of the gap | DC-09 (restore half) |
| UX polish | Active-channel-delete toast; optimistic reaction toggle with echo-consumption + correlated rollback; role-change submenu double-fire guard; drag-reorder document-listener leak fixed via per-sidebar AbortSignal ownership; slow-mode countdown and admin in-flight states verified already-shipped (stale spec notes flipped) | DC-12 |
| Accessibility | `lib/a11y.ts` (dialog semantics, focus trap, focus restore, roving tabindex) applied through `modalFactory` and every hand-rolled modal/overlay; SettingsOverlay tablist + tabpanel + roving tabs; QuickSwitcher and composer autocompletes wired as combobox/listbox with `aria-activedescendant`; EmojiPicker/GifPicker as keyboard-operable listboxes; Toast/TypingIndicator polite live regions; Escape mapped to each modal's safe action | DC-13 |
| E2E journeys | `voice-e2ee-verify.spec.ts` (6 tests, real ECDSA/ECDH crypto through the production verification path: verified/unverified/mismatch badges, modal reject/trust, DC-08 fail-closed) and `updater.spec.ts` (4 tests: banner → progress → auto-relaunch, failure, dismissals); harness gained per-test identity-pin config, an IPC invoke log, and a LiveKit WebSocket parking shim | DC-04 (rows 38 + 49) |
| Docs | All 55 `file:line` anchors in the six UX specs rewritten as verified symbol references (15 had already rotted onto wrong code); spec gap callouts flipped for everything above | DC-15, spec hygiene |

### Verification (this session, closure HEAD)

| Suite | Result |
|-------|--------|
| Go `go test -race -timeout 20m ./...` | all packages ok (ws 125s) |
| Go tag-gated tests (`-tags wazero ./plugin/...`, `-tags otel ./telemetry/...`) | **PASS** — first-ever runs, no latent failures |
| `make sqlc-verify` + `make protocol-verify` | both pass, no generated drift |
| gofmt + go vet | clean |
| Client typecheck + typecheck:e2e | both pass |
| oxlint + ESLint + Prettier | pass (same two pre-existing oxlint style warnings) |
| knip | exits 0 |
| Client unit/integration (vitest) | 165 files, **4474/4474** (+114 over the remediation HEAD) |
| Playwright web suite | see `tests/e2e/E2E-ISSUES.md` for the recorded full-suite run at this HEAD (291 tests: 276 baseline + 6 E2EE + 4 updater + 5 a11y smoke) |

### Still open after this pass

*(Historical — superseded by §13's final closure below.)*

DC-04's admin-panel journey (row 48 — the last flow with no browser
automation), DC-07 (soak decision, owner's call), DC-09's
`handleApplyUpdate` container TODO, DC-11 (npm pinning policy), DC-14
(reserved protocol entries, owner's call), and the 2026-04-07 carryovers
#5 (accepted), #8, #9.

---

## 13. Final closure (2026-08-05, owner-directed)

The owner directed the remaining deferrals be executed ("do the remaining
now"), converting the two owner's-call items into decisions:

- **DC-07 RESOLVED** — `client-e2e` is **blocking**. Soak evidence: green
  full-suite runs at 270/276/291 tests across the audit branches; the one
  hard CI failure in the window was a real spec bug a non-blocking job
  would have hidden.
- **DC-09 RESOLVED (fully)** — the `handleApplyUpdate` container TODO is
  code now: `updater.RunningInContainer` (env-authoritative, marker-file
  fallback) refuses `POST /admin/api/updates/apply` with 503
  `CONTAINER_DEPLOYMENT`, `GET /updates` gains `can_apply`, the SPA shows
  an image-upgrade note instead of the button, and the shipped Dockerfile
  sets `OWNCORD_CONTAINER=1`. The backup-restore audit row landed in §12.
- **DC-11 RESOLVED** — the dependency pinning/review policy is written
  down in `docs/contributing.md` (lockfiles authoritative, `npm ci`-only
  installs, weekly Dependabot with deliberate majors, per-PR security
  gates). Also closes 2026-04-07 #8.
- **DC-04 RESOLVED (fully)** — the admin panel has a real-server e2e
  journey: `tests/e2e/admin/` boots the Go server fresh and drives the
  embedded SPA through the first-run wizard, dashboard stats, channel
  create/rename, audit-log verification and sign-out/sign-in, with a
  non-blocking `admin-e2e` CI job on the same graduation convention
  `client-e2e` followed. Every matrix row now has automation.

Still open, all deliberate: DC-14 (reserved protocol entries — a protocol
rev, not cleanup), the `admin-e2e` soak graduation, and the 2026-04-07
carryovers #5 (accepted residual risk) and #9 (service-layer
consolidation, tracked by A-2026-07-10/11's backlog).

---

## 10. Appendix — session command log index

All suite output was tee'd to the session scratchpad
(`go-test-race.log`, `go-test-deadlock.log`, `go-static.log`,
`client-fast-checks.log`, `eslint.log`, `knip-audit.log`, `vitest-unit.log`,
`client-build.log`, `cargo-test.log`, `cargo-clippy.log`, `e2e-full.log`,
`e2e-parity.log`, `vitest-browser.log`, `npm-ci.log`). The numbers in §3 are
transcribed from those logs; the logs are ephemeral to the audit container
and not committed.

**Environment accommodations disclosed:** Playwright browsers were served by
symlinking the preinstalled Chromium build 1194 into the directory layout the
repo's Playwright 1.62.1 expects (revision 1234, both `chrome-linux64` and
`chrome-headless-shell-linux64` layouts); the browser-mode vitest run used
`xvfb-run` (headed browser, no X server in the container); ESLint required
CI's own generated-file patch (`ci.yml:110-127`), applied and fully reverted
(`git status` clean afterwards). None of these touch the repository.
