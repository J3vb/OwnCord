# Platform contract map — desktop and browser

**Kind:** target-state map. **Status:** the desktop half is implemented — B7-3
wrote the contracts and B7-4/B7-5 moved every native call behind
`Client/src/platform/desktop/`; the `browser/` half is implemented too (WP
6.13b-e: credentials, socket, the portal sign-in and its in-app branches).
**Measured against:** B7-5 (branch `fm/b7-5-impl`, 2026-09-21), which moved
the last native importers behind the seam, and B7-16 (branch `fm/b7-16-impl`,
2026-09-21), which added the external-content broker contract, its two native
commands and a twenty-first importer, so all twenty-one live under
`platform/desktop/`, and the Linux native-voice phase 0 (branch
`fm/linux-voice-p0`, 2026-09-22), which added the Linux-only
`native_voice_build_info` command, and phase 1 (branch `fm/linux-voice-p1`,
2026-09-22), which added the `NativeVoice` contract, its desktop facade and
service (the twenty-second importer) and seven Linux-only `native_voice_*`
commands, then phase 1b (same branch family, 2026-09-22), which added the two
device commands, and phase 2 (branch `fm/linux-video-p2`, 2026-09-22), which
added the two camera commands, and audio parity (branch
`fm/linux-audio-parity`, 2026-09-23), which added the per-user and
screen-share audio volume commands, and phase 3 (branch
`fm/linux-screenshare-p3`, 2026-09-23), which added the four screen-share
commands, and the Linux native camera (branch `fm/camera-share-black`,
2026-10-03), which added the five camera commands
(`native_voice_list_cameras`, `native_voice_start_camera`,
`native_voice_stop_camera` and the two out-of-call preview commands) and moved
the camera path off the webview pump. The registration-based correction was
measured at `0beee8e` (`dev`,
2026-09-23) and re-measured after the audio-parity and screen-share merges at
`2ced3de` (`dev`, 2026-09-23). P3-09 (branch `fm/dp-p309`, 2026-09-30) added
the `SystemIdle` contract and its `system_idle_ms` command, P3-04 (branch
`fm/dp-p304`, 2026-10-01) added the `set_unread_badge` command, and the
GStreamer support notice (branch `fm/linux-gstreamer-missing-msg`, 2026-10-03)
added `native_voice_camera_support`, and WP LP-3 (2026-10-16) added the
three Linux-only mic-test commands (`native_voice_start_mic_test`,
`native_voice_update_mic_test` and `native_voice_stop_mic_test`), and WP LP-5
(2026-10-16) added `native_voice_get_stats`, and WP LP-6a (2026-10-16) added
`native_voice_watch_devices`, and WP LP-6b (2026-10-16) added
`native_voice_play_sound` and `native_voice_stop_sound`, and WP LP-7b
(2026-10-16) added `native_voice_change_camera`, and WP LP-7c (2026-10-16)
added `native_voice_video_codecs` and `native_voice_unpublish_screen`, and WP
LP-8b (2026-10-16) added `native_voice_publish_screen_audio` and
`native_voice_unpublish_screen_audio`, which the webview calls from WP LP-8c on,
and WP M-12a (2026-10-16) added `native_voice_set_screen_quality`, which the
webview calls from WP M-12b on, and WP M-11a (2026-10-16) widened the
`native_voice_video_codecs` result to `{ h264, vp9, decode }` (no new
command). The
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
  The four contracts a Settings control sits on (`AppUpdater`, `Autostart`,
  `WindowControl`, `DevTools`) carry a readonly `available` flag: desktop sets
  it `true`, the browser `false`, and the control is not drawn rather than drawn
  to fail (WP 6.13d). Elsewhere a browser adapter is a real Web-API adapter
  (`notifications.ts`, `fileSave.ts`, `deepLinks.ts`, `logFiles.ts`), or refuses
  in the contract's own terms (`externalContent.ts` answers every request
  `unavailable` and fetches nothing).

## What exists today

Measured from Tauri `generate_handler![...]` registrations and the TypeScript
platform invoke bindings, including all conditional platform/feature handlers:

| Measure                                                    | Value |
| ---------------------------------------------------------- | ----- |
| Files under `Client/src/` importing `@tauri-apps/*`        | 25    |
| Distinct `invoke` command names called from `Client/src/`  | 95    |
| `#[tauri::command]` handlers in `Client/src-tauri/`        | 98    |
| TS calls with no matching Rust handler                     | 0     |
| Uses of the `window.__TAURI__` global                      | 0     |
| Environment-detection helper (`isDesktop()` or equivalent) | 1     |
| Files under `Client/src/platform/`                         | 56    |

The handler count covers the 98 distinct registrations
(`Client/src-tauri/src/lib.rs`); `open_devtools` sits behind
`#[cfg(feature = "devtools")]` and the forty-three `native_voice_*` commands
behind `#[cfg(target_os = "linux")]`, so a default build (no `devtools`) registers 97 on Linux
and 54 elsewhere. The one environment-detection helper is
`features/voice/native/platform.ts`'s `isLinuxDesktop()`, a Tauri-host plus
Linux user-agent check that selects the native voice backend; it is not a
desktop/browser seam.

Reproduce with `cd Client && npm test -- tests/unit/platform-contracts-counts.test.ts`.
The test reads real static/dynamic imports, follows the platform service's invoke
bindings (including aliases, lazy helpers, nested generic calls and the
`tryInvoke`/`invokeOrThrow` helpers in `platform/desktop/nativeInvoke.ts`), and parses
all Rust registration lists. Comments, string examples and unregistered
`#[tauri::command]` functions do not count. The handler row is the union across
platforms and features, including Linux native voice and optional devtools.

The name inventory below also detects equal-count substitutions: a command
registered but absent here, or listed here but no longer registered, fails the
guard. Keep it and the table in sync when changing registrations.

<!-- registered-commands -->

```text
accept_cert_fingerprint
app_audio_available
check_client_update
clear_call_notification
delete_credential
delete_identity_key
delete_pending_messages
detect_game
detect_media
download_and_install_update
external_image
external_preview
frontend_ready
get_cert_fingerprint
get_identity_pin
get_settings
get_window_prefs
global_keys_portal_bind
global_keys_portal_configure
global_keys_status
list_running_programs
load_credential
load_identity_key
load_pending_messages
login_with_saved_password
native_voice_build_info
native_voice_camera_support
native_voice_change_camera
native_voice_change_screen
native_voice_clear_key
native_voice_connect
native_voice_debug_info
native_voice_disconnect
native_voice_get_stats
native_voice_list_cameras
native_voice_list_devices
native_voice_play_sound
native_voice_publish_camera
native_voice_publish_screen
native_voice_publish_screen_audio
native_voice_screen_sources
native_voice_set_audio_processing
native_voice_set_device
native_voice_set_input_gain
native_voice_set_key
native_voice_set_microphone
native_voice_set_ptt_gated
native_voice_set_screen_quality
native_voice_set_screenshare_volume
native_voice_set_subscribed
native_voice_set_video_view
native_voice_set_voice_gate
native_voice_set_volume
native_voice_start_camera
native_voice_start_camera_preview
native_voice_start_mic_test
native_voice_start_screen
native_voice_stop_camera
native_voice_stop_camera_preview
native_voice_stop_mic_test
native_voice_stop_screen
native_voice_stop_sound
native_voice_unpublish_camera
native_voice_unpublish_screen
native_voice_unpublish_screen_audio
native_voice_update_mic_test
native_voice_video_codecs
native_voice_watch_devices
notify_message
open_devtools
open_external_url
open_log_folder
ptt_listen_for_key
ptt_polling_supported
ptt_set_key
ptt_start
ptt_stop
save_credential
save_identity_key
save_pending_messages
save_settings
set_unread_badge
set_window_pref
show_next_launch
start_app_audio
start_http_proxy
start_livekit_proxy
stop_app_audio
stop_http_proxy
stop_livekit_proxy
store_identity_pin
system_idle_ms
voice_shortcuts_set_keys
voice_shortcuts_start
voice_shortcuts_supported
ws_connect
ws_disconnect
ws_send
```

Three registered handlers have no production platform caller:
`get_cert_fingerprint` (native E2E), `native_voice_build_info` (native diagnostics)
and `stop_http_proxy`. `detect_game` (WP 8.3b, the Rust game scanner) has its
caller since WP 8.3c: `src/platform/desktop/gameDetector.ts`, behind the
`GameDetector` contract, a twenty-eighth importer; the web build answers "no
game" and hides the setting. WP 8.3d gives it a second command,
`list_running_programs` (the user's own running programs for the "Add a game"
picker; the list is shown only in that local picker and never stored or sent),
and an optional `{ manual, hidden }` argument to `detect_game`. `detect_media`
(WP 8.10b, the Rust reader of the song playing in the OS media session: GSMTC
on Windows, MPRIS on Linux, nothing playing elsewhere; it takes `{ hidden }`
and answers a tagged `{ state: "playing", title, artist, player, playerId,
positionMs, durationMs }`, `{ state: "none" }` or `{ state: "unknown" }`, where
unknown is a failed, timed-out or still-running read that the caller must not
treat as a stop; the player shown last stays while it still plays, else the OS's
current session goes first) has its caller since WP 8.10c:
`src/platform/desktop/mediaDetector.ts`, behind the `MediaDetector` contract, a
twenty-ninth importer; a failed call or an odd answer reads as unknown, and the
web build reads nothing and hides the setting. The three Windows per-app share audio commands
`app_audio_available`, `start_app_audio` and `stop_app_audio` (WP 6.7a, the host
half: they exist on every target and answer "unavailable" off Windows) have their
caller since WP 6.7b: `src/platform/desktop/appAudio.ts`, behind the `AppAudio`
contract, a twenty-seventh importer. They still belong in the registration
inventory.

There is no `window.__TAURI__` access, and the only environment branching is
the SDK `isTauri` guard in `lib/pendingMessages.ts` (imported, not global), which is
good news: every native dependency is a static or dynamic **import**, so a
static check can find all of them. The only `typeof window` guards in
`Client/src/lib/` are in `channel-mutes.ts` and `logger.ts`, and are unrelated
to desktop/browser branching.

## Proposed contracts

Nineteen capability clusters (the seventeenth, external content, added by
B7-16; the eighteenth, global shortcuts, added with U6; the nineteenth,
system idle, added with P3-09). Each becomes one file
under `contracts/` (a few split across two or three), with matching implementations under `desktop/` and
`browser/`. Since B7-5 the "Files today" column names the app-side callers; the
native surface itself lives only in `platform/desktop/`.

| Contract          | Files today                                                                                           | Native surface                                                                                                                                        | Browser outlook                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| HTTP fetch        | `lib/api.ts`, `lib/profiles.ts`, `message-list/attachments.ts` (server files)                         | `plugin-http`                                                                                                                                         | native `fetch` — but CORS becomes a server concern          |
| External content  | `message-list/{embeds,media,attachments}.ts`, `GifPicker.ts`                                          | `api/core`; 2 invokes (`external_*`)                                                                                                                  | ⚠ no equivalent — a page cannot classify resolved addresses |
| WebSocket         | `lib/ws.ts`                                                                                           | `api/core`, `api/event`; 4 invokes, 4 event listens                                                                                                   | ⚠ see hard cases                                            |
| Secret storage    | `lib/net/credentials.ts`, `lib/net/identity.ts`, `lib/pendingMessages.ts`                             | `api/core`; 11 invokes, plus the SDK `isTauri` guard                                                                                                  | ⚠ see hard cases                                            |
| Settings          | `lib/profiles.ts`                                                                                     | `api/core` (`save_settings`, `get_settings`)                                                                                                          | `localStorage` / IndexedDB                                  |
| Native proxies    | `lib/net/httpProxy.ts`, `lib/voice/livekitUrlResolver.ts`                                             | `api/core`; 3 invokes                                                                                                                                 | not needed — the proxies exist to work around desktop TLS   |
| Notifications     | `lib/notifications.ts`, `main.ts`, `pages/MainPage.ts` (for the unread badge)                         | `plugin-notification`, `api/window`, `api/core` (`notify_message`, `clear_call_notification`, `set_unread_badge`), `api/event` (`notification-click`) | Notification API + Page Visibility                          |
| Filesystem / logs | `lib/logPersistence.ts`, `settings/AdvancedTab.ts`, `settings/LogsTab.ts`                             | `api/path`, `plugin-fs`                                                                                                                               | in-memory ring buffer + download                            |
| Window            | `lib/prefs/windowState.ts`, `lib/notifications.ts`, `features/zoom/`                                  | `api/window`, `api/webview` (`setZoom`)                                                                                                               | mostly unsupported; degrade                                 |
| Updater / process | `lib/net/updater.ts`, `settings/AdvancedTab.ts`                                                       | `api/core`, `api/event` (`update-progress`, `update-installing`), `plugin-process`, `plugin-autostart`                                                | unsupported — the page reloads instead                      |
| Tray status       | `main.ts`                                                                                             | `api/event` (`status-change`)                                                                                                                         | unsupported — there is no tray                              |
| Shell / opener    | `lib/admin-panel.ts`, `main.ts`                                                                       | `api/core` (`open_external_url`)                                                                                                                      | `window.open`                                               |
| File save / pick  | `message-list/attachments.ts`                                                                         | `plugin-dialog`, `plugin-fs`                                                                                                                          | `<a download>` / File System Access API                     |
| Input / PTT       | `lib/voice/ptt.ts`                                                                                    | `api/core`, `api/event`; 5 invokes                                                                                                                    | ⚠ see hard cases                                            |
| Global shortcuts  | `pages/MainPage.ts`, `settings/{KeybindsTab,pttControls}.ts`, `platform/desktop/pushToTalkService.ts` | `api/core`, `api/event`; 6 invokes, 2 event listens                                                                                                   | unsupported — a page cannot observe keys outside itself     |
| Deep links        | `lib/deep-link.ts`                                                                                    | `plugin-deep-link`                                                                                                                                    | URL routing                                                 |
| App metadata      | `settings/AboutTab.ts`                                                                                | `api/app`                                                                                                                                             | build-time constant                                         |
| Dev tools         | `main.ts`, `settings/AdvancedTab.ts`                                                                  | `api/core` (`open_devtools`)                                                                                                                          | unsupported — the browser has its own devtools already      |
| System idle       | `pages/MainPage.ts` (for `lib/autoIdle.ts`)                                                           | `api/core` (`system_idle_ms`)                                                                                                                         | unsupported — answers `null`; in-page activity decides      |
| Game activity     | `pages/MainPage.ts` (for `lib/gameActivity.ts`), `settings/GameActivityRows.ts`                       | `api/core` (`detect_game`, `list_running_programs`)                                                                                                   | unsupported — answers `null`; the setting is hidden         |

**Media devices are not on this map, deliberately.** No generic `@tauri-apps`
surface exists for them: the cross-platform media-device call sites
(`lib/voice/deviceManager.ts`, `lib/net/connectionDiagnostics.ts`,
`components/settings/VoiceAudioTab.ts`) use the Web API
`navigator.mediaDevices`, while the Linux-native voice session lists its audio
and camera devices through its own `native_voice_*` commands (the audio
parity and Linux native camera work, above). A contract would wrap a web API
that already works unchanged in a browser, so B7-5 closed the PRD's "media and
devices" clause with this finding instead.

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

**`lib/net/credentials.ts` / `lib/net/identity.ts` — OS keychain.** Secrets live in
Windows Credential Manager / GNOME Keyring / macOS Keychain, and
`Client/src-tauri/src/secret_store.rs` reads each write back before returning.
The browser has no peer for this. Whatever the browser adapter stores, it is
strictly weaker, and the E2EE identity key is among the secrets involved. This
is a security-posture decision, not a storage swap.

**`lib/voice/ptt.ts` — push-to-talk.** PTT is deliberately hand-rolled rather than
using `plugin-global-shortcut`, because it must observe a key held down while
OwnCord is unfocused. A browser cannot see keys outside its tab. The browser
adapter can offer in-tab PTT or voice-activity detection, but not the desktop
behaviour. On Wayland the key is not polled at all: the desktop's
GlobalShortcuts portal grabs it (GNOME 48+, KDE Plasma), so
`GlobalShortcuts.status().backend` is `portal`, the Keybinds UI binds through
the desktop's own dialog (push to talk limited to function keys), and the
focused app no longer receives that key. The UI branches on that capability,
never on a platform check.

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
  (`lib/net/updater.ts`, `lib/net/httpProxy.ts`, `LiveKitUrlResolver`), and its legacy
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

**`HttpClient` gained one member (B11b):** `onUploadProgress(handler)` — a
subscription to the `upload-progress` event the Rust HTTP proxy emits while an
upload body crosses the loopback tunnel. It is an addition to the existing
contract, not a new one, because it is the same capability: the webview never
sees the upload bytes (the HTTP plugin buffers the whole body before the native
client sends it), so the transport reports them out of band. The API client
tags each upload with an `X-Upload-Id` header and matches ticks back by that id;
the composer's chip renders them as a determinate `<progress>`. The browser
adapter B8 will add returns an inert unsubscribe.

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
- [`docs/audits/2026-08-23-repository-layout.md`](../audits/2026-08-23-repository-layout.md) — `RL-02`, and the target tree
- [`docs/plans/beta-requirements-traceability-2026-08-23.md`](../plans/beta-requirements-traceability-2026-08-23.md) — `BPR-025`
- [`docs/architecture/client.md`](client.md) — the client as-built

Per this directory's maintenance rule: a PR that adds a new `@tauri-apps` import
to `Client/src/`, or a new `generate_handler!` registration, updates the inventory, counts and the
cluster table here in the same change. That rule is now enforced rather than
promised — `Client/tests/unit/platform-contracts-counts.test.ts` re-derives all
three counts from the tree and fails when the table above disagrees, so a
forgotten update is red in CI instead of drifting.
