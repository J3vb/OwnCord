# Linux desktop platform audit (2026-10)

**Date:** 2026-10-09
**Audited tree:** `dev` at `610ec96`
**Scope:** the Linux desktop client (WebKitGTK webview, Rust backend) compared
with the Windows client (WebView2), prompted by the Linux GIF report: with no
`ipc:` in the CSP, Tauri fell back to its postMessage IPC on Linux and raw-byte
command responses arrived as `number[]`, so every image loaded through the
native content broker silently broke. Three questions: (1) what else breaks the
same way; (2) where else a Linux user gets different behaviour; (3) what to fix
now. Code was read; nothing was run on a real Linux desktop, and the box this
was written on cannot build the Rust crate (no clang 21, no libwebrtc), so each
row says what still needs a desktop.
**Versions read:** `tauri` 2.12.0, `wry` 0.57.0, `webkit2gtk` 2.0.2 (feature
`v2_38`), `tauri-plugin-http` 2.7.0 (patched), `tauri-plugin-fs`,
`tauri-plugin-notification` 2.5.0 (`notify-rust` 4.18.0), `tauri-plugin-deep-link`
2.6.0, `tauri-plugin-autostart` 2.6.0, `tray-icon` 0.25.1, `livekit` 0.9.3
(all from `Client/src-tauri/Cargo.lock`); the upstream sources for Tauri's
`scripts/ipc-protocol.js`, `ipc/channel.rs`, `ipc/protocol.rs`,
`tauri-runtime-wry`, wry's `webkitgtk/mod.rs`, and the plugin guest-js.
**Method:** every area below cites the lines that decide the behaviour. Effort
is S/M/L ≈ hours/days/week+. Verdicts: **fix** (a PR from this audit), **fixed
elsewhere** (an open PR already covers it), **document** (a real difference, no
code change), **product decision** (a fix exists but changes behaviour,
packaging or cost beyond the finding), **needs desktop check** (nothing in the
repo proves it either way), **clean** (same behaviour on both). Nightly
artifact smoke run #26 on `main` (2026-10-09) was green, which proves the
AppImage boots, reports camera support and joins voice over the tunnel; it
runs under Xvfb, so it says nothing about Wayland, a real camera or a tray.

## 1. Verdict

The Linux build is one platform switch (`isLinuxDesktop()`) plus a Rust voice
engine, and the parts that differ are mostly deliberate and documented. Two
things are not:

1. **Today's class of bug has exactly one site.** `external_image` is the only
   first-party command that returns raw bytes, and
   `Client/src/platform/desktop/externalContent.ts` is the only consumer that
   assumes an `ArrayBuffer`. Every other byte path (HTTP bodies, log files,
   file saves, video frames) already tolerates both IPC transports or never
   crosses IPC. The CSP fix (#2230) restores the fast transport; this audit
   adds the missing tolerance at that one site so the next fallback is a
   warning in the log, not a broken picker (§4, #2247). No central `invoke`
   wrapper is warranted.
2. **The `.deb` leaves three everyday things to chance** that WebView2 ships
   with: colour emoji, H264/AAC video playback (mp4 attachments, YouTube
   embeds) and PipeWire cameras. Recommending the distro packages costs
   nothing and fixes it for apt users (§4, #2239). The AppImage pins
   GStreamer to its bundled plugins, so host packages cannot help it: H264/AAC
   and PipeWire cameras reach AppImage users only if the release build bundles
   them, which is a product decision (§5).

The reported camera and screen-share crashes cannot be found by reading:
`camera.rs` and `screen.rs` have no production `unwrap` and every failure path
returns a string, but Rust can still panic there (the `png_url` slicing in
`screen.rs:221-227` trusts the frame's stride and height), and a native crash
in libwebrtc, GStreamer or the X server never reaches Rust at all. The panic
hook (`diagnostics.rs`) writes a `[panic]` line with a backtrace and the
native-crash hook (`crash_log.rs`) writes a `[crash]` line, so a support bundle
can tell the two apart. §7 lists what the next report must contain. The
"voice device problems" have one code-level cause worth a decision: on Linux
the connection diagnostics still test the **webview's** microphone with the
native engine's device id (§5.4).

## 2. Today's bug and the IPC byte-path sweep

### 2.1 How the two transports differ

Tauri's injected `ipc-protocol.js` (2.12.0) tries the custom protocol first:
`ipc://localhost/<cmd>` on Linux and macOS, `http://ipc.localhost/<cmd>` on
Windows. The first fetch the CSP blocks logs `IPC custom protocol failed, Tauri
will now use the postMessage interface instead`, sets `customProtocolIpcFailed`
and never resets it: the page runs on postMessage until reload. On the custom
protocol a `tauri::ipc::Response` (raw bytes) comes back as
`application/octet-stream` and the script returns `response.arrayBuffer()`. On
postMessage the same body is serialised as JSON, so the callback receives a
`number[]`. Channel messages of 1 KiB or more are fetched through
`plugin:__TAURI_CHANNEL__|fetch`, which follows the same flag and would break
the same way. `tauri.conf.json:29` lists only `http://ipc.localhost`;
`Client/tests/unit/tauri-conf-csp.test.ts:44-55` pins that exact set, so
#2230 changes both.

### 2.2 Every byte path in the client

| Path                                                                          | Direction      | Transport tolerance                                                                                                                                                                          | Evidence                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_image` (content broker: GIF picker, linked images, embeds)          | Rust → TS raw  | **No.** `new Blob([result.value])` turns a `number[]` into the text `"71,73,70,…"`; the signature sniff happens to work on either shape, so the Blob has the right type and wrong bytes      | `Client/src-tauri/src/external_content.rs:1072-1083`, `Client/src/platform/desktop/externalContent.ts:59-67`, consumers via `components/message-list/attachments.ts:795-833` |
| `plugin:http\|fetch_read_body` (every REST call and server file download)     | Rust → TS raw  | Yes: the patched guest-js wraps with `new Uint8Array(data)`, which accepts both                                                                                                              | `Client/patches/@tauri-apps+plugin-http+2.7.0.patch`                                                                                                                         |
| `plugin:fs\|read_text_file` (log files for the support bundle)                | Rust → TS raw  | Yes: `arr instanceof ArrayBuffer ? arr : Uint8Array.from(arr)` upstream                                                                                                                      | `Client/src/platform/desktop/logFiles.ts:266,282`                                                                                                                            |
| `plugin:fs\|write_file` (save attachment, save support bundle)                | TS → Rust raw  | Yes: the Rust command accepts `InvokeBody::Raw` and `Json(Array)`                                                                                                                            | `Client/src/platform/desktop/fileSave.ts:16`                                                                                                                                 |
| Uploads                                                                       | TS → server    | Never cross IPC: the loopback HTTP proxy streams them; progress is a JSON event                                                                                                              | `platform/desktop/http.ts:28`, `src-tauri/src/http_proxy.rs:495`                                                                                                             |
| Video frames (native voice)                                                   | Rust → TS      | Never cross IPC: a token-authenticated `127.0.0.1` WebSocket                                                                                                                                 | `src-tauri/src/native_voice/video.rs:4-6`                                                                                                                                    |
| Screen thumbnails                                                             | Rust → TS      | JSON (`data:image/png` strings)                                                                                                                                                              | `native_voice/screen.rs:133,238`                                                                                                                                             |
| `Channel`                                                                     | –              | None in the client                                                                                                                                                                           | grep `new Channel` / `Channel<` finds nothing                                                                                                                                |
| `emit`/`listen` events                                                        | Rust → TS JSON | Small JSON on every path (`ws-message`, `ws-state`, `cert-tofu`, `upload-progress`, `update-progress`, `ptt-state`, `voice-shortcut`, `status-change`, `notification-click`, `native-voice`) | `ws_proxy.rs:302`, `update_commands.rs:466`, `native_voice/mod.rs:216`                                                                                                       |
| `set_unread_badge`, `notify_message`, `native_voice_*`, credentials, settings | JSON/scalars   | Same on both transports                                                                                                                                                                      | `Client/src/platform/desktop/*.ts`                                                                                                                                           |

All 67 command entries registered at `lib.rs:168-265` (66 in a normal Linux
release: `open_devtools` is feature-gated) were checked; `update_commands.rs:426` returns `Vec<u8>` from a private helper, not
a command. There is no existing normalisation helper in `Client/src`.

### 2.3 Decision: harden the one site, do not wrap `invoke`

A global shim would touch 60+ mocked call sites for one real consumer, and the
plugins already normalise their own bytes. #2247 adds a 10-line `ipcBytes()`
helper in `platform/desktop/`, uses it in the broker, logs once when the
postMessage shape arrives (so a support bundle shows the fallback), and adds a
guard test so any future `invoke<ArrayBuffer>` in `platform/desktop/` must go
through it.

### 2.4 Test blind spot

The native end-to-end specs intercept IPC by matching `ipc.localhost`
(`Client/tests/e2e/native/b9-content-consent.spec.ts:24-34`,
`http-cancellation.spec.ts:32-40`, `b9-journeys.spec.ts:7`), and `client-native`
runs on `windows-latest` only. No PR job runs WebKitGTK; the only WebKitGTK
execution is the nightly/release artifact smoke (`webkit2gtk-driver` under
Xvfb). That is why the CSP omission reached users (§5.5).

## 3. Platform comparison

| Area                                               | Linux (WebKitGTK)                                                                                                                                                                                                                                                                                                                                                                          | Windows (WebView2)                                                      | User impact                                                                                                                            | Effort | Verdict                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| CSP / IPC origin                                   | `connect-src` lacks `ipc:`, so Tauri falls back to postMessage (`tauri.conf.json:29`)                                                                                                                                                                                                                                                                                                      | `http://ipc.localhost` is listed                                        | every broker image breaks                                                                                                              | S      | **fixed elsewhere** — #2230                                      |
| Broker byte handling                               | assumes `ArrayBuffer` (`externalContent.ts:62-66`)                                                                                                                                                                                                                                                                                                                                         | same code, never on the fallback                                        | silent corruption whenever the fallback is active                                                                                      | S      | **fix** — #2247                                                  |
| Asset and remote scopes                            | no `assetProtocol`, no `dangerousRemoteDomainIpcAccess`, one capability for `main` (`capabilities/default.json`), pop-outs get none (`popout.rs:7-11`)                                                                                                                                                                                                                                     | same                                                                    | none                                                                                                                                   | –      | clean                                                            |
| getUserMedia / enumerateDevices                    | `linux_media.rs:19-58` turns on `enable-media-stream`/`enable-webrtc` and auto-allows `UserMedia` and `DeviceInfo` requests on `main`; everything else keeps WebKit's default deny                                                                                                                                                                                                         | `--auto-accept-camera-and-microphone-capture` (`tauri.conf.json:24`)    | none: voice, camera and screen run in the Rust engine on Linux                                                                         | –      | clean (document)                                                 |
| Autoplay (chime, ringtone, UI sounds)              | wry's `autoplay` attribute defaults to true → `AutoplayPolicy::Allow`; `setSinkId` does not exist, so sounds use the default output                                                                                                                                                                                                                                                        | `--autoplay-policy=no-user-gesture-required`; follows the chosen output | documented in `known-limitations.md:81-88`                                                                                             | –      | document                                                         |
| Web Notification fallback                          | `NotificationPermissionRequest` is not allowed by `linux_media.rs`, so `Notification.requestPermission()` resolves `denied`                                                                                                                                                                                                                                                                | prompts                                                                 | only reached when the plugin throws (no notification daemon); the fallback would go to the same missing daemon                         | –      | document (§5.6)                                                  |
| Native notifications                               | `notify-rust` over D-Bus with an "Open" action; the host waits for the activation and emits `notification-click` (`message_notification.rs:229-281`); the "Open" label is a literal at line 256, not in `text.rs`                                                                                                                                                                          | WinRT toast whose click comes back as an `owncord://` deep link         | needs a daemon that supports actions (GNOME, KDE, dunst do)                                                                            | S      | debt (label into `text.rs`)                                      |
| Unread badge                                       | Unity `LauncherEntry` signal for `application://OwnCord.desktop` (`unread_badge.rs:106-153`): matches the deb's desktop file, not an AppImage launcher entry; no tray tooltip on appindicator                                                                                                                                                                                              | overlay icon and tooltip                                                | AppImage users get no launcher count                                                                                                   | –      | document                                                         |
| Clipboard                                          | wry only sets `javascript-can-access-clipboard` when the `clipboard` attribute is true, and Tauri never sets it; the client uses only `navigator.clipboard.writeText` inside click handlers (`content-parser.ts:658`, `renderers.ts:528,563`, `LogsTab.ts:142,287`, `RecoverySections.ts:87`, `OverlayManagers.ts:287`) and `ClipboardEvent` for image paste (`MessageInput.ts:1101-1115`) | same code                                                               | none expected: the async API in a user gesture does not need that setting                                                              | –      | clean, needs desktop check                                       |
| File dialogs and save                              | `plugin-dialog` (rfd GTK/portal) then `plugin-fs` `writeFile`; the dialog extends the fs scope; logs under `$APPLOG/**`                                                                                                                                                                                                                                                                    | same                                                                    | none                                                                                                                                   | –      | clean                                                            |
| Deep links                                         | the bundler writes the deb's `.desktop` MimeType; `deepLinks.ts:58-62` also calls `register()` on every launch, which writes `~/.local/share/applications/<exe>-handler.desktop` with the `APPIMAGE` path and runs `xdg-mime`; single-instance forwards the URL                                                                                                                            | registry                                                                | a moved AppImage re-registers on its next launch                                                                                       | –      | clean, needs desktop check                                       |
| Tray                                               | libayatana-appindicator (deb depends on it, the AppImage bundles it); **left-click is not delivered on appindicator**, so only the menu's Show/Hide works (`tray.rs:96-105`); stock GNOME needs the AppIndicator extension (Ubuntu ships it, Fedora does not)                                                                                                                              | click toggles the window                                                | GNOME without the extension shows no tray; there is no close-to-tray on either OS                                                      | –      | document (§5.7)                                                  |
| Autostart                                          | the plugin uses `app.env().appimage` so the entry points at the AppImage, not its mount                                                                                                                                                                                                                                                                                                    | registry Run key                                                        | none                                                                                                                                   | –      | clean                                                            |
| Window, decorations, drag regions                  | native decorations (`tauri.conf.json:21`), no drag-region code; the off-screen guard (`lib/window-state.ts:56-80`) reads positions Wayland does not expose and `center()` is a no-op there; fractional scaling renders at integer scale                                                                                                                                                    | same code                                                               | slightly blurry UI on fractional-scale Wayland; the guard is harmless                                                                  | –      | document                                                         |
| Startup failure                                    | `lib.rs:330-335` shows the error dialog only off Linux; a Linux user gets stderr and `exit(1)`                                                                                                                                                                                                                                                                                             | dialog                                                                  | an app that will not start explains nothing                                                                                            | S      | **product decision** (§5.1)                                      |
| Fonts                                              | Inter Variable is bundled (`styles/base.css:6-16`); `--font-mono` falls to the generic `monospace`                                                                                                                                                                                                                                                                                         | Segoe UI Variable, Cascadia                                             | fine                                                                                                                                   | –      | clean                                                            |
| Emoji                                              | no emoji family in any stack (`styles/tokens.css:120-124`), so fontconfig decides; the deb neither depends on nor recommends `fonts-noto-color-emoji`                                                                                                                                                                                                                                      | Segoe UI Emoji                                                          | monochrome or boxed emoji on minimal installs                                                                                          | S      | **fix** — #2239                                                  |
| Media playback (video attachments, YouTube embeds) | WebKitGTK decodes through GStreamer; the deb depends only on `plugins-base` and `plugins-good` (`tauri.conf.json:39-48`), so H264/AAC (`gstreamer1.0-libav`) is absent                                                                                                                                                                                                                     | H264/AAC built in                                                       | mp4 attachments silently fail to play on a deb install; the AppImage carries only what the release runner had and ignores host plugins | S      | **fix** — #2239 (deb); AppImage is a **product decision** (§5.3) |
| Camera (native)                                    | GStreamer `v4l2src`/`pipewiresrc` (`camera.rs:121-122,398-411`); the deb lacks `gstreamer1.0-pipewire` and the release runner never installs it, so neither bundle has `pipewiresrc`                                                                                                                                                                                                       | webview `getUserMedia`                                                  | PipeWire-only cameras (libcamera, Intel IPU6 laptops) list nothing                                                                     | S      | **fix** — #2239 (deb); AppImage is a **product decision** (§5.3) |
| Camera / screen crash surface                      | no production `unwrap`/`expect` in `camera.rs` or `screen.rs`; failures become strings and `*CaptureEnded` events; `crash_log.rs` writes a last line for SIGSEGV/SIGBUS/SIGABRT/SIGTRAP and X errors; `session.rs` keeps 8 `.lock().unwrap()` (846-1112) that would turn a poisoned lock into a silent stop of room events                                                                 | n/a                                                                     | a Rust panic shows up as a `[panic]` line, a native crash as a `[crash]` line; only a support bundle shows which                       | S      | debt (poison-tolerant locks); crashes need bundles (§7)          |
| Screen share                                       | Wayland → portal, X11 → own picker; `under_wayland()` (`screen.rs:113-116`) mirrors libwebrtc and needs **both** `XDG_SESSION_TYPE=wayland` and `WAYLAND_DISPLAY`, while `shortcuts.rs:62-68` and `main.rs:30-36` treat either as Wayland; video only                                                                                                                                      | `getDisplayMedia` picker with audio                                     | a Wayland session without `XDG_SESSION_TYPE` gets the X11 picker and XWayland-only (black) captures; no screen audio (documented)      | S      | **product decision** (§5.2)                                      |
| Voice devices                                      | cpal and GStreamer ids from the engine (`features/voice/native/devices.ts:21-45`); the settings tab lists them; no mic meter on Linux (`VoiceAudioTab.ts:846`); `lib/connectionDiagnostics.ts:205-219` still opens the **webview** microphone with the engine's device id, misses, and retries `"default"`                                                                                 | webview devices throughout                                              | the diagnostics report the wrong microphone; there is no mic test on Linux                                                             | S/M    | **product decision** (§5.4)                                      |
| Push-to-talk and global shortcuts                  | X11 key polling only; `ptt_polling_supported` and `voice_shortcuts_supported` report false on Wayland                                                                                                                                                                                                                                                                                      | `GetAsyncKeyState`                                                      | no global PTT on Wayland (the UI says so)                                                                                              | –      | document                                                         |
| Idle status                                        | Mutter `IdleMonitor`, then freedesktop `ScreenSaver`; Plasma Wayland refuses the latter (`idle.rs:51-93`)                                                                                                                                                                                                                                                                                  | `GetLastInputInfo`                                                      | no automatic Idle on Plasma Wayland                                                                                                    | –      | document                                                         |
| Credentials                                        | Secret Service through `keyring`, ChaCha20 file fallback with `0600`                                                                                                                                                                                                                                                                                                                       | DPAPI                                                                   | none                                                                                                                                   | –      | clean                                                            |
| WebRTC codecs                                      | Rust SDK defaults (VP8, Opus) through libwebrtc; simulcast layers mirrored in `session.rs:427-488`; no input-volume slider (the engine's AGC)                                                                                                                                                                                                                                              | `livekit-client` defaults (VP8, Opus)                                   | parity on codecs; no screen audio and no input volume on Linux (documented)                                                            | –      | document                                                         |
| Updater                                            | the AppImage self-updates then relaunches; deb/rpm get HTTP 204 and the "This install cannot update itself" banner (`update_commands.rs:228-238`, `i18n/connect.ts:25`)                                                                                                                                                                                                                    | NSIS passive install                                                    | deb users update by hand, and are told so                                                                                              | –      | by design                                                        |
| Pop-out windows (#2203)                            | `on_new_window` reaches WebKitGTK's `create` signal, which builds a related webview; `popout.rs:72-100` closes the window when WebKitGTK destroys it                                                                                                                                                                                                                                       | WebView2 new window                                                     | untested on a real WebKitGTK                                                                                                           | –      | **needs desktop check**                                          |
| Test coverage                                      | WebKitGTK runs only in the nightly artifact smoke; the IPC spies match Windows only (§2.4)                                                                                                                                                                                                                                                                                                 | WebView2 end-to-end on every native PR                                  | Linux regressions reach users first                                                                                                    | M      | **product decision** (§5.5)                                      |

## 4. Fix PRs from this audit

| PR                                                                                                                                                                      | Finding                                | Risk                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [#2247](https://github.com/J3vb/OwnCord/pull/2247) — broker tolerates postMessage byte payloads (`ipcBytes()` + guard test)                                             | §3 "Broker byte handling"              | low                                                                                                       |
| [#2239](https://github.com/J3vb/OwnCord/pull/2239) — deb recommends `fonts-noto-color-emoji`, `gstreamer1.0-libav`, `gstreamer1.0-plugins-bad`, `gstreamer1.0-pipewire` | §3 "Emoji", "Media playback", "Camera" | low (recommends, not depends; the nightly smoke installs with `--no-install-recommends` and is unchanged) |

Both are draft PRs against `dev`; each carries a test that failed before its fix and names the manual desktop check in its body. Everything else in §3 is already in
flight (#2230 CSP, #2228 drag-and-drop), a documentation item, needs a desktop
or a support bundle to confirm, or is a product decision (§5).

## 5. Needs a product decision

1. **Startup error dialog on Linux.** `lib.rs:330` skips the rfd dialog on
   Linux. `plugin-dialog` already links rfd's GTK backend, so the only reason to
   keep skipping it is a headless run blocking on a dialog. Recommendation: show
   it when `DISPLAY` or `WAYLAND_DISPLAY` is set, otherwise keep stderr.
2. **Wayland detection.** Screen share follows libwebrtc (both variables), the
   shortcut and renderer code follows either. Recommendation: at startup, when
   `WAYLAND_DISPLAY` is set and `XDG_SESSION_TYPE` is missing, set
   `XDG_SESSION_TYPE=wayland` before libwebrtc reads it, after checking on a
   real compositor (sway, Hyprland) that the portal then opens. Until then the
   X11 picker on such sessions is a known limitation.
3. **What the AppImage bundles.** `bundleMediaFramework` copies the release
   runner's GStreamer plugins (`release.yml:226-238` installs base and good
   only). Adding `gstreamer1.0-pipewire` there is cheap and safe
   (recommended). Adding `gstreamer1.0-libav` ships an H264/AAC decoder in
   the artifact: size and patent exposure, so not recommended yet. The
   consequence must be explicit: the AppImage's AppRun hook
   (linuxdeploy-plugin-gstreamer) pins `GST_PLUGIN_SYSTEM_PATH_1_0` to the
   bundled directory, so host packages do not help, and AppImage users have no
   mp4 playback or PipeWire cameras until the build bundles those plugins
   (#2239 says so in `known-limitations.md`).
4. **Microphone diagnostics on Linux.** `connectionDiagnostics.ts` tests the
   webview microphone, which the engine never uses, and the settings tab has
   no level meter on Linux. Recommendation: a native level probe through the
   `NativeVoice` contract (M), or at least report "not checked on Linux" in
   the diagnostics (S). Both change UI text, hence a decision.
5. **A WebKitGTK check before merge.** Today the first WebKitGTK execution of a
   change is the nightly smoke. Recommendation: extend the nightly first (GIF
   picker and a broker image through `webkit2gtk-driver`), and only then
   weigh a Linux `client-native` leg on PRs that touch `Client/src-tauri/` or
   `tauri.conf.json`.
6. **The Web Notification fallback** in `lib/notifications.ts:293-309` is dead
   on Linux (permission denied) and pointless everywhere the plugin fails for
   lack of a daemon. Recommendation: remove the branch rather than grant the
   permission; it only exists for the browser build that is deferred.
7. **Tray on stock GNOME and Fedora.** Nothing to fix in code: the AppIndicator
   extension is the platform's answer. Recommendation: one line in
   `docs/quick-start.md` next to the Wayland note at line 160.

## 6. What still needs a real Linux desktop

- Pop-out windows (#2203) on WebKitGTK: open, full screen, close from both sides.
- Deep-link registration on a deb and on an AppImage that was moved.
- `navigator.clipboard.writeText` from the copy buttons on WebKitGTK ≥ 2.40
  (expected to work; nothing in the repo proves it).
- The notification "Open" action on GNOME, KDE and dunst.
- The Wayland portal picker on GNOME and KDE, and the X11 picker with a real
  window manager (the X11 capturer is only exercised under Xvfb).
- #2247 with `ipc:` removed from the CSP: the GIF picker and a linked image
  must still render, and the log must show the fallback warning.
- #2239 on the next release `.deb`: `dpkg-deb -f OwnCord_*.deb Recommends`,
  then an mp4 attachment and a colour emoji.

## 7. Crash reports: what the next bundle must contain

The camera and screen-share crashes that users report are not visible in the
Rust code paths by reading: every failure returns a string or an event, so the
process either panics on an assumption (a slice on frame-supplied dimensions,
a poisoned lock) or dies below Rust in libwebrtc, GStreamer or the X server.
The two leave different last lines, and a support bundle is only useful if it
carries:

- the last `[panic]` line from the panic hook (`diagnostics.rs:20-25`: thread,
  location and backtrace) if there is one — that is a Rust bug to fix in the
  named function;
- otherwise the `crash_log` line (`[crash] SIGSEGV …` or the Xlib error), and
  in both cases the ten log lines before it, including the last `native-voice`
  event (`session.rs:121-190`);
- the WebKitGTK version (`webkit2gtk` package), the compositor,
  `XDG_SESSION_TYPE` and whether `WAYLAND_DISPLAY` was set;
- `gst-inspect-1.0` output for each of `v4l2src`, `pipewiresrc`, `decodebin`
  and `videoscale` (one invocation per element, e.g.
  `for e in v4l2src pipewiresrc decodebin videoscale; do gst-inspect-1.0 "$e"; done`),
  and the
  camera's format list (`v4l2-ctl --list-formats-ext`);
- for a screen share: X11 or portal, the source kind (screen or window), and
  whether `WEBKIT_DISABLE_DMABUF_RENDERER` was set;
- whether the session was an AppImage or a deb, and whether the window was
  hidden at the time (camera capture keeps running while hidden by design).

With that, the first thing to check is the `png_url` row slicing in
`screen.rs:221-227`, which trusts the frame's stride and height, and the
GStreamer `videoscale` step that `support()` (`camera.rs:121-122`) does not
test for.
