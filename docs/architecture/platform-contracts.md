# Platform contract map — desktop and browser

**Kind:** target-state map. **Status:** the desktop half is implemented — B7-3
wrote the contracts and B7-4/B7-5 moved every native call behind
`Client/src/platform/desktop/`; the `browser/` half is B8, deferred.
**Measured against:** B7-5 (branch `fm/b7-5-impl`, 2026-09-21), which moved
the last native importers behind the seam, and B7-16 (branch `fm/b7-16-impl`,
2026-09-21), which added the external-content broker contract, its two native
commands and a twenty-first importer, so all twenty-one live under
`platform/desktop/`, and the Linux native-voice phase 0 (branch
`fm/linux-voice-p0`, 2026-09-22), which added the Linux-only
`native_voice_build_info` command, and phase 1 (branch `fm/linux-voice-p1`,
2026-09-22), which added the `NativeVoice` contract, its desktop facade and
service (the twenty-second importer) and seven Linux-only `native_voice_*`
commands; the
three counts below are re-derived from the tree by
`Client/tests/unit/platform-contracts-counts.test.ts`, and eslint rejects a
static or dynamic native import anywhere else.
**Closes:** `RL-02` / `L-02` (B1-8). **Executed by:** B7.

OwnCord is a Tauri desktop app whose frontend talks to native APIs directly.
The plan is for the same frontend to also run in a browser _(amended
2026-09-18, owner decision: B8, the browser client, is deferred to
post-beta — the beta ships desktop-only; B7's contracts below still land in
the beta so the browser target stays possible without rework)_. This document
records **where the seam between "shared app" and "native host" will go**, and
what has to move across it — so that B7 executes a decided plan instead of
rediscovering the surface.

> **Nothing here is implemented.** B1 was an explicitly non-functional phase:
> _"No native behaviour moves in B1. Adapter extraction is B7 and must not be
> smuggled in."_ This file adds no directory, no interface, and no code.

## Target layout

```
Client/src/platform/
├── contracts/   # TypeScript interfaces only. No imports from @tauri-apps.
├── desktop/     # Tauri implementations. The ONLY place @tauri-apps may appear.
└── browser/     # Web-standard implementations, or an explicit refusal.
```

The rule this eventually enforces is `BPR-025`
([traceability](../plans/beta-requirements-traceability-2026-08-23.md)):

> Static checks keep native imports inside desktop ownership; the same
> domain/store/protocol suites run against desktop and browser adapters.

Two consequences worth stating now, because they shape the interface design:

- **Contracts must be async everywhere.** Some operations are synchronous in a
  browser and IPC round-trips on desktop. A contract that exposes a sync method
  cannot be implemented by the desktop side.
- **A browser adapter is allowed to refuse.** Three capabilities below have no
  web equivalent. The contract must let an adapter say "unsupported" and let the
  app degrade, rather than force a fake implementation that fails at runtime.

## What exists today

Measured with `git grep`, not estimated:

| Measure                                                    | Value |
| ---------------------------------------------------------- | ----- |
| Files under `Client/src/` importing `@tauri-apps/*`        | 22    |
| Distinct `invoke` command names called from `Client/src/`  | 37    |
| `#[tauri::command]` handlers in `Client/src-tauri/`        | 43    |
| TS calls with no matching Rust handler                     | 0     |
| Uses of the `window.__TAURI__` global                      | 0     |
| Environment-detection helper (`isDesktop()` or equivalent) | 1     |
| Files under `Client/src/platform/`                         | 47    |

The handler count covers both attribute spellings — 31 `#[tauri::command]` plus
12 `#[tauri::command(async)]` — so a `git grep '#\[tauri::command\]'` with exact
brackets undercounts to 31. Attributes and registrations are two different
counts: of the 43 attributed functions, 41 appear in `generate_handler!`
(`Client/src-tauri/src/lib.rs`); `open_devtools` sits behind
`#[cfg(feature = "devtools")]` and the eight `native_voice_*` commands behind
`#[cfg(target_os = "linux")]`, so a default build registers 40 on Linux and 32
elsewhere. The one environment-detection helper is
`features/voice/native/platform.ts`'s `isLinuxDesktop()`, a user-agent check
that selects the native voice backend; it is not a desktop/browser seam.

Reproduce:

```bash
git grep -l "@tauri-apps" -- 'Client/src/**' | wc -l
git grep -hoE '(tauriInvoke|invoke)(<[^>]*>)?\(\s*"[a-z_]+"' -- 'Client/src/**' \
  | grep -oE '[a-z_]+"$' | tr -d '"' | sort -u | wc -l
```

Note the alias: `Client/src/lib/ws.ts` binds `core.invoke` to a local
`tauriInvoke` before calling it, so a regex that only matches `invoke("…")`
undercounts by four (`ws_connect`, `ws_send`, `ws_disconnect`,
`accept_cert_fingerprint`). Any future lint rule enforcing the seam must match
the binding, not the call site.

A second blind spot, found while B7-4 moved these call sites: the recipe cannot
see a **nested** generic. `invoke<Record<string, unknown>>("get_settings")` in
`platform/desktop/settings.ts` does not match, so the table's 30 counts
distinct names _the recipe finds_; the tree calls 31.

One registered Rust handler is never invoked from `Client/src/`:
`get_cert_fingerprint`, which the native E2E harness calls directly
(`Client/tests/e2e/native/helpers.ts`) and `Client/tests/e2e/helpers.ts` stubs.
It stays registered as "consumed by tests, unconsumed in production" (B7 PRD
open question 11). `probe_credential_store`, the one handler with no caller
anywhere, was deleted in B7-0. An earlier revision of this paragraph also named
`store_cert_fingerprint` and `ptt_get_key`; neither command has ever existed in
`generate_handler!`, so nothing further is owed there.

There is no `window.__TAURI__` access, and the only environment branching is
the SDK `isTauri` guard in `lib/pendingMessages.ts` (imported, not global), which is
good news: every native dependency is a static or dynamic **import**, so a
static check can find all of them. The only `typeof window` guards in
`Client/src/lib/` are in `channel-mutes.ts` and `logger.ts`, and are unrelated
to desktop/browser branching.

## Proposed contracts

Seventeen capability clusters (the seventeenth, external content, added by
B7-16). Each becomes one file under `contracts/` (a few
split across two or three), with matching implementations under `desktop/` and
`browser/`. Since B7-5 the "Files today" column names the app-side callers; the
native surface itself lives only in `platform/desktop/`.

| Contract          | Files today                                                                   | Native surface                                       | Browser outlook                                             |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| HTTP fetch        | `lib/api.ts`, `lib/profiles.ts`, `message-list/attachments.ts` (server files) | `plugin-http`                                        | native `fetch` — but CORS becomes a server concern          |
| External content  | `message-list/{embeds,media,attachments}.ts`, `GifPicker.ts`                  | `api/core`; 2 invokes (`external_*`)                 | ⚠ no equivalent — a page cannot classify resolved addresses |
| WebSocket         | `lib/ws.ts`                                                                   | `api/core`, `api/event`; 4 invokes, 4 event listens  | ⚠ see hard cases                                            |
| Secret storage    | `lib/credentials.ts`, `lib/identity.ts`, `lib/pendingMessages.ts`             | `api/core`; 11 invokes, plus the SDK `isTauri` guard | ⚠ see hard cases                                            |
| Settings          | `lib/profiles.ts`                                                             | `api/core` (`save_settings`, `get_settings`)         | `localStorage` / IndexedDB                                  |
| Native proxies    | `lib/httpProxy.ts`, `lib/livekitUrlResolver.ts`                               | `api/core`; 3 invokes                                | not needed — the proxies exist to work around desktop TLS   |
| Notifications     | `lib/notifications.ts`                                                        | `plugin-notification`, `api/window`                  | Notification API + Page Visibility                          |
| Filesystem / logs | `lib/logPersistence.ts`, `settings/AdvancedTab.ts`, `settings/LogsTab.ts`     | `api/path`, `plugin-fs`                              | in-memory ring buffer + download                            |
| Window            | `lib/window-state.ts`, `lib/notifications.ts`                                 | `api/window`                                         | mostly unsupported; degrade                                 |
| Updater / process | `lib/updater.ts`, `settings/AdvancedTab.ts`                                   | `api/core`, `plugin-process`, `plugin-autostart`     | unsupported — the page reloads instead                      |
| Tray status       | `main.ts`                                                                     | `api/event` (`status-change`)                        | unsupported — there is no tray                              |
| Shell / opener    | `lib/admin-panel.ts`, `main.ts`                                               | `plugin-opener`                                      | `window.open`                                               |
| File save / pick  | `message-list/attachments.ts`                                                 | `plugin-dialog`, `plugin-fs`                         | `<a download>` / File System Access API                     |
| Input / PTT       | `lib/ptt.ts`                                                                  | `api/core`, `api/event`; 5 invokes                   | ⚠ see hard cases                                            |
| Deep links        | `lib/deep-link.ts`                                                            | `plugin-deep-link`                                   | URL routing                                                 |
| App metadata      | `settings/LogsTab.ts`                                                         | `api/app`                                            | build-time constant                                         |
| Dev tools         | `main.ts`, `settings/AdvancedTab.ts`                                          | `api/core` (`open_devtools`)                         | unsupported — the browser has its own devtools already      |

**Media devices are not on this map, deliberately.** No `@tauri-apps` surface
exists for them: every media-device call site (`lib/deviceManager.ts`,
`lib/connectionDiagnostics.ts`, `components/settings/VoiceAudioTab.ts`) is the
Web API `navigator.mediaDevices`, and no Rust command touches devices. A
contract would wrap a web API that already works unchanged in a browser, so
B7-5 closed the PRD's "media and devices" clause with this finding instead.

Two files appear under more than one contract (`lib/profiles.ts` does HTTP and
settings; `settings/AdvancedTab.ts` spans four). That is expected — the clusters
are capabilities, not a file partition, and those files split during extraction.

## Hard cases — where a browser adapter cannot be a shim

These three are not implementation details. Each is a product decision that B7
must take deliberately, and each changes what the browser build **is**.

**`lib/ws.ts` — certificate TOFU.** The desktop client tunnels its WebSocket
through Rust specifically so it can pin a self-signed certificate on first use
(`accept_cert_fingerprint`, the `cert-tofu` event). A browser cannot inspect or
pin a certificate; the user agent decides, and a self-signed server is simply
refused. The browser adapter must **degrade honestly** — require a
publicly-trusted certificate and say so — not emulate the flow. This trust path
has been hardened twice already (identity TOFU, then a re-pin TOCTOU); do not
let a browser adapter quietly reopen it.

**`lib/credentials.ts` / `lib/identity.ts` — OS keychain.** Secrets live in
Windows Credential Manager / GNOME Keyring / macOS Keychain, and
`Client/src-tauri/src/secret_store.rs` reads each write back before returning.
The browser has no peer for this. Whatever the browser adapter stores, it is
strictly weaker, and the E2EE identity key is among the secrets involved. This
is a security-posture decision, not a storage swap.

**`lib/ptt.ts` — push-to-talk.** PTT is deliberately hand-rolled rather than
using `plugin-global-shortcut`, because it must observe a key held down while
OwnCord is unfocused. A browser cannot see keys outside its tab. The browser
adapter can offer in-tab PTT or voice-activity detection, but not the desktop
behaviour.

## Contracts (B7-3)

B7-3 implemented this design. `Client/src/platform/contracts/` holds one
type-only file per row of the map above (17 files at B7-3, 19 since B7-5
added two; `index.ts` re-exporting each and a `Platform` interface with one
readonly member per interface), and `Client/src/platform/desktop/index.ts` was
a typed `Partial<Platform>` that B7-4/B7-5 filled in one capability at a time —
a full `Platform` since B7-5.

**B7-4 moved eight of them** (`Client/src/lib/`, `Client/src/components/`):
HTTP, WebSocket, credentials, identity, pending messages, settings,
logs/files, and file save/pick. Each has an implementation file under
`platform/desktop/`, is registered on `desktop`, and every call site that used
to reach a native package directly now reaches it through that implementation —
the four in this list that had a behaviour suite ran it against the in-place
seam first, then again against the desktop binding, and the four that had none
got one written the same way. The rows still on `lib/` are the ones B7-5 owns
(media, LiveKit's proxies, push-to-talk, notifications, window state, deep
links, updater, app metadata, dev tools, the shell opener), plus the LiveKit
half of `NativeProxies`.

**B7-5 moved the rest**, and added two contracts the map lacked:
`contracts/appProcess.ts` (`AppProcess.relaunch()`, for the Advanced tab's
"Clear & Restart" — the updater's own relaunch is internal to
`downloadAndInstallUpdate`) and `contracts/trayStatus.ts` (one named
subscription to the tray's `status-change`, not a by-name event bus).
`desktop/index.ts` is now a full `Platform`, and no file outside
`platform/desktop/` imports `@tauri-apps` — `main.ts` included; it is a
consumer of the registry, not an exception. `Client/eslint.config.js` carries
the seam as a rule: `src/platform/desktop/**` is the only path under `src/`
allowed a static `@tauri-apps` import.

Three shapes recur in B7-5's moves, worth knowing before adding a member:

- **The registry is in the startup chunk.** `desktop` is statically reachable
  from the entry, so a native module that was a lazy `import()` before its
  move (deep link, notification, window, process, autostart, app) stays one
  inside the desktop method.
- **An adapter that needs app state loads lazily.** Push-to-talk gates the mic
  through the voice store, whose import graph reaches back into the registry.
  `desktop/pushToTalk.ts` is a facade over `desktop/pushToTalkService.ts`,
  loaded on first use, so the static graph gains no import cycle.
- **Where a `lib/` export keeps callers, it stays as a thin delegate**
  (`lib/updater.ts`, `lib/httpProxy.ts`, `LiveKitUrlResolver`), and its legacy
  suite binding stays with it. Where the export went internal (deep links,
  push-to-talk, and every capability whose seam was lifted in place), the
  legacy binding was deleted in the same commit.

Six rules the reviewer checked, kept here because they hold for every future
addition to `contracts/`, not just B7-3's:

1. **Contracts mirror the native seam.** A contract method describes one
   native capability and the value its caller receives, with today's exact
   parameters and result types where an exported function already sits at
   that seam. No API redesign.
2. **Host-neutral, down to the text.** No `@tauri-apps` import, no Tauri
   type, no "Tauri"/"invoke" in an identifier — and the literal strings
   `@tauri-apps` and `invoke("` must not appear anywhere under
   `src/platform/`, comments included.
3. **No production imports, no domain types.** Contracts import nothing from
   `@lib/*`/`@stores/*`/`@components/*`/`@pages/*`. Small host result types
   are re-declared, structurally identical, rather than imported.
4. **Reuse before inventing.** Where an existing interface already has the
   right shape (`PersistenceBackend`, `PendingMessagePersistence`), the
   contract matches it member for member so the call-site move stays a pure
   rename.
5. **The typechecker is the oracle.** Each seam row's suite assigns today's
   legacy binding to a variable typed as the contract with no cast — a cast
   there would mean the contract is wrong.
6. **Suites assert behaviour, not wiring.** A suite sees only
   `{ subject, native }` and never a command name; command/argument
   assertions stay in the modules' existing unit tests.

**One contract was amended in B7-4:** `contracts/socket.ts`. B7-3 declared
`SocketTransport` as the transport object itself, which the app cannot use — it
needs one transport _per client_ (a fresh login, and every test, must not
inherit the previous connection's listeners or its certificate registration),
and it needs the dial and the send to settle as promises so a failure can be
classified. `SocketTransport` is now the capability (`create(): SocketConnection`)
and `SocketConnection` is the transport it hands back. `Platform.socket`'s
declared type did not change; its meaning did. The registry member is the
factory `lib/ws.ts` calls, so nothing is registered that no one uses.

Eight of the 17 rows already sat behind an exported function when B7-3 wrote
their behaviour suites (`seam` in the responsibility map that milestone worked
from): `CredentialStore`, `IdentityStore`, `SettingsStore`, `LogFiles` (the
`logPersistence` half only), `NativeProxies` (`ensureHttpProxy` only),
`AppUpdater`, `PushToTalk`, `DeepLinks`. Those suites live in
`Client/tests/unit/platform/*.suite.ts`, run against a binding — today's
`src/lib` exports, or `platform/desktop` once the capability moves.

Four rows had no seam at all when B7-4 started (`HTTP`, `WebSocket`,
`PendingMessageStore`, `FileSaver`): nothing exported to bind a legacy suite
against, so each seam was lifted in place first, verbatim, and the suite was
written against that — the code the app actually ran — before the move. Where
the move then made the `lib/` export internal, the legacy binding was deleted
in the same commit rather than left asserting what the desktop binding already
covers. `LogFiles.clearAll` is the same story inside a row that already had a
suite: no exported seam until B7-4, so its coverage lands with the move.

`Client/tests/unit/platform/suites-are-falsifiable.test.ts` runs all
twenty-two suites against a null subject: the eight rows above, the four B7-4
created, nine from B7-5, and B7-16's `ExternalContentBroker`. Seven of those nine were written against a seam
lifted in place first (notifications, window, opener, app metadata, dev tools,
autostart, the LiveKit half of the proxies), exactly as B7-4 did; `AppProcess`
was lifted the same way. `TrayStatus` has no legacy binding — the subscription
was inline in `main.ts`, which cannot be imported on its own — so its oracle
for the move is `tests/unit/main.test.ts`'s tray tests (OC-0037, OC-0176),
green before and after.

**One contract was added in B7-16:** `contracts/externalContent.ts`
(`ExternalContentBroker`, registered as `desktop.externalContent`). It is
deliberately not an extension of `HttpClient`: the C-09 contract in
[trust-model.md](../trust-model.md) says renderer code gets no general-purpose
client for content other users named, so the shape makes a raw URL result
unrepresentable. `preview(partition, url)` returns the typed minimum (title,
description, site name, dimensions, and an opaque image handle) and
`image(partition, source)` returns the bytes of a handle or of a URL the caller
already holds, both as a result union whose failure is one of six refusal
classes rather than a thrown error. Two methods, two native commands
(`external_preview` returns JSON, `external_image` returns raw IPC bytes over
`tauri::ipc::Response`), because a raw-bytes response cannot also carry the
JSON. The suite is `externalContent.suite.ts`, run against the desktop binding.

**Suite coverage gaps.** A round-3 adversarial review found suite tests whose
only assertion a completely inert, do-nothing subject also satisfies —
`Client/tests/unit/platform/suites-are-falsifiable.test.ts` now runs every
suite against exactly such a subject to catch this mechanically. Two methods
have no caller-visible effect at their seam beyond "did not reject", which an
inert subject also never does, and are left untested rather than pinned to a
green that means nothing:

- `SettingsStore.save()`'s success path — `save(): Promise<void>` gives the
  caller nothing to observe beyond not rejecting; the rejection paths (native
  error, native host unavailable) are still covered.
- `DeepLinks.init()`'s native-host-unavailable path — resolving without
  calling either callback is exactly what a subject that does nothing at all
  also does; the cold-start paths (invite, message permalink) are still
  covered.
- `NativeProxies.stopLiveKitProxy()` — fire-and-forget, it hands the caller
  nothing back; the resolve paths are covered.

`Client/knip.json` no longer ignores `src/platform/**` (B7-5). Removing it
surfaced one class of dead export: `contracts/index.ts` re-exported every
contract's auxiliary types (options, results, events) that no caller imports
through it, so it now re-exports only the capability interfaces, and
`contracts/window.ts`'s unused `WindowRect` is gone.

## Ownership

**No human owners are recorded for these folders, here or anywhere in the
repository.** That is a real gap, not an omission in this document — assigning
them is unstarted work. Until then, ownership is by phase, matching the
convention already used in the
[issue register](../plans/repo-health-issue-register-2026-08-23.md):

| Area                                          | Phase  |
| --------------------------------------------- | ------ |
| `contracts/`, `desktop/`, `browser/`          | **B7** |
| The static check enforcing the seam (BPR-025) | **B7** |
| Browser build target and PWA packaging        | **B8** |
| Protocol contract both adapters speak         | **B2** |

## Source of truth

- `Client/src/lib/`, `Client/src/components/` — the 21 files listed above
- `Client/src-tauri/src/lib.rs` — the `generate_handler!` registration list
- [`docs/audit-2026-08-23-repository-layout.md`](../audit-2026-08-23-repository-layout.md) — `RL-02`, and the target tree
- [`docs/plans/beta-requirements-traceability-2026-08-23.md`](../plans/beta-requirements-traceability-2026-08-23.md) — `BPR-025`
- [`docs/architecture/client.md`](client.md) — the client as-built

Per this directory's maintenance rule: a PR that adds a new `@tauri-apps` import
to `Client/src/`, or a new `#[tauri::command]`, updates the counts and the
cluster table here in the same change. That rule is now enforced rather than
promised — `Client/tests/unit/platform-contracts-counts.test.ts` re-derives all
three counts from the tree and fails when the table above disagrees, so a
forgotten update is red in CI instead of drifting.
