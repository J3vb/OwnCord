# Windows client update: delayed successor after relaunch

**Date:** 2026-09-23
**Audited tree:** `dev` at `233b93f`
**Scope:** the Windows (NSIS) update and relaunch path in `Client/src-tauri`,
after one report that the app stayed on the old version for about 90 s after an
update before the new version took over. Read-only; no code changes ship with
this audit.
**Versions read:** `tauri` 2.11.5, `tauri-plugin-updater` 2.10.1,
`tauri-plugin-single-instance` 2.4.3, `tauri-plugin-process` 2.3.1 (all from
`Client/src-tauri/Cargo.lock`), and the NSIS template in `tauri-bundler` 2.9.4
(used by `@tauri-apps/cli` 2.11.4 from `Client/package-lock.json`).

## 1. Verdict

The cause is **not certain**. It happened once and there are no logs from it.
The most likely explanation is below (§3, H1). It fits the report and is built
only from code that was read, but one step depends on Windows behaviour outside
this repo, so no code was changed.

## 2. What the update path does on Windows

1. The user clicks **Update Now**. `downloadAndInstallUpdate`
   (`Client/src/platform/desktop/updater.ts:92`) invokes
   `download_and_install_update` (`Client/src-tauri/src/update_commands.rs:241`).
2. That command calls the plugin's `Update::download_and_install`
   (`update_commands.rs:257`). This runs on a Tokio worker thread, because the
   command is an `async fn`.
3. After the download, the plugin's Windows `install_inner`
   (`tauri-plugin-updater` `src/updater.rs:787-866`) does this, in order:
   - runs `on_before_exit`, which the plugin always sets to
     `AppHandle::cleanup_before_exit()` (plugin `src/lib.rs:107-110`). That
     clears the tray icon and **hides** every window (tauri `src/app.rs:1108`).
     It does not close them and does not release anything else.
   - calls `ShellExecuteW("open", <installer>, "/P /R /UPDATE /ARGS …")`. This
     call **blocks** until Windows has created the installer process. The
     return value is not checked.
   - calls `std::process::exit(0)`. That ends the process without a
     `RunEvent::Exit`, so the single-instance plugin's `destroy()` (release the
     mutex, destroy its message window) never runs. Windows frees the mutex
     only when the process is gone.
4. The NSIS installer (passive mode from `tauri.conf.json:64`) finds any
   `owncord-client.exe` owned by the current user, kills it, waits 500 ms,
   copies files, then relaunches the new exe with the old arguments
   (`installer.nsi` `Section Install` and `.onInstSuccess`, `utils.nsh`
   `CheckIfAppIsRunning`).
5. The new process starts. The single-instance plugin
   (`src/platform_impl/windows.rs`) makes a named mutex
   `com.owncord.client-sim`. The `semver` feature is off
   (`Cargo.toml`: `features = ["deep-link"]`), so **old and new versions use
   the same mutex name**. If the mutex already exists and the message window
   `com.owncord.client-siw` is found, the new process sends its arguments with
   `WM_COPYDATA` and exits at once.
6. In the running instance, the callback (`Client/src-tauri/src/lib.rs:69-75`)
   calls `unminimize()`, `show()` and `set_focus()` on the main window.

## 3. Hypotheses

### H1 (most likely): the old instance is still alive while `ShellExecuteW` waits, and a launch in that gap brings the old window back

Between step 3's `cleanup_before_exit()` and `process::exit(0)`, the old
process is alive and still owns the single-instance mutex and message window.
Its main thread is free (only the worker thread is blocked in
`ShellExecuteW`), so it still handles `WM_COPYDATA`.

From the user's side the app has just vanished: the window is hidden and the
tray icon is gone. If anything starts OwnCord in that gap (the user clicks the
Start-menu or taskbar shortcut because "nothing happened", an `owncord://`
link, autostart), the new launch is handed to the old instance, which shows its
**old, hidden window again** (step 6). The user now sees the old version, with
the banner stuck at "Downloading update… 100%".

When `ShellExecuteW` finally returns, the old process exits, the installer
runs, and the new version appears. That is the "switch".

**Why the gap can be ~90 s.** Release builds are not Authenticode-signed:
`release.yml` only sets `TAURI_SIGNING_PRIVATE_KEY` (minisign for the updater
feed); there is no `signtool` or `signCommand`. So every release's installer is
a brand-new, unsigned exe with no reputation. Microsoft Defender's
"block at first sight" holds the first run of such a file while it asks the
cloud. The default hold is 10 s, and admins or policy can extend it by up to 50 s
more. On-access scanning of the installer and then the freshly copied
`owncord-client.exe` adds to that. `ShellExecuteW` waits for all of it. The
result depends on cloud latency, which fits "it happened once".

**What is not proven:** that `ShellExecuteW` blocked that long on the
reporter's machine, and that something launched OwnCord during the gap. Both
are Windows behaviour outside this repo, and there is no log from the
incident.

### H2 (possible, adds to H1): `ShellExecuteW` on an uninitialised-COM worker thread

`ShellExecuteW` is called from a Tokio worker thread where COM was never
initialised. Microsoft's docs say to initialise COM before calling
`ShellExecute`, because it can hand off to shell extensions over COM. On most
machines this still works for a plain `.exe`, but a slow or hanging shell hook
makes the same gap as H1 longer. This is in the plugin, not in OwnCord code.

### H3 (ruled out): the server's 90 s stale-client sweep

`Server/ws/hub_sweep.go:17` has `staleClientTimeout = 90 * time.Second`, which
matches the number. But it cannot hold the new client back:
`registerNow` (`Server/ws/hub_registry.go:36`) replaces an existing
connection for the same user at once and kicks the old one. The server also
does not track the client version, so it cannot show "old version".

### H4 (ruled out, wrongly for silent installs; see §6): file locks during install

If the old exe were still locked, NSIS `File` would show an
"Error opening file for writing" dialog, not a silent delay. The installer
kills the old process by name first (same `owncord-client` name in both
versions, no `mainBinaryName` override), and the local proxies bind
`127.0.0.1:0`, so there is no port clash either.

### H5 (ruled out): the frontend relaunch

On Windows the `download_and_install_update` invoke never returns (the process
exits inside it), so `relaunch()` (`updater.ts:100`) is never reached. It only
matters on Linux.

## 4. Recommended fix

In order of value. Items 1 and 2 are small and safe. Item 3 fixes the root
of the delay.

1. **Stop the old instance from taking handoffs once the install starts.** In
   the single-instance callback (`lib.rs:69`), check `UPDATE_IN_PROGRESS`
   (`update_commands.rs:19`). While it is set, do not `show()` the old window.
   Better still, split the plugin call into `Update::download()` then
   `Update::install()`, and set a separate "installer launching" flag between
   the two. The download phase stays interactive. Only the install phase ignores
   the handoff.
2. **Add timing logs so the next report is conclusive.** Log (with
   timestamps) after the download finishes, just before `install()`, in the
   single-instance callback (with "update in progress: yes/no"), and at startup
   (version and PID). The log plugin already writes a file in the app log dir,
   so a user can send it. If `ShellExecuteW` is the gap, it shows as time
   between "calling install" and the new process's startup line.
3. **Authenticode-sign the Windows installer and exe** in `release.yml`
   (Tauri's `bundle.windows.signCommand`, for example with Azure Trusted
   Signing). A signed file with reputation skips most of Defender's
   first-sight hold and SmartScreen. This is the only item that shortens the
   gap itself.
4. **Optional, upstream:** ask `tauri-plugin-updater` to initialise COM before
   `ShellExecuteW`, check its return value, and log it (H2). This is not worth
   forking the plugin for.

Not recommended: turning on the single-instance `semver` feature so old and
new versions use different mutexes. The new process would then start next to
the still-running old one instead of handing off, which gives two windows and
two WebSocket connections for the same user until the installer kills the old
one.

## 5. How to reproduce

On Windows, with an installed older build and a newer one on the server:

1. Click **Update Now** and wait for the download to finish.
2. As soon as the window disappears, launch OwnCord from the Start menu.
3. The old window comes back. How long it stays depends on how long
   `ShellExecuteW` takes. To make the gap longer on purpose, pause the process
   in a debugger with a breakpoint on `ShellExecuteW`.

## 6. Addendum (2026-09-25): H4 was wrong for silent installs, and it is fixed

CI reproduced the update race twice on one pull request (`Client E2E (Windows
native)`, runs 36179772961 attempts 1 and 2): the app log shows the alpha.5
download finishing and the installer launching, then a live `owncord-client`
reports alpha.4 for the whole 90 s wait. §3 H4 assumed a locked exe always
produces a dialog. That holds for a passive (`/P`) installer, but the CI
packages and any `installMode: "quiet"` build run NSIS silently (`/S`), where a
file that cannot be opened for writing is skipped and `/R` relaunches whatever
is still in `$INSTDIR`: the old binary. The lock is the exiting old process
itself (`std::process::exit(0)` after `ShellExecuteW`; the image stays mapped
until Windows finishes the teardown), and the template only sleeps 500 ms
after its running-app check. Upstream replaced that check with the Restart
Manager in tauri-apps/tauri#14479 (merged 2026-09-15, not in `@tauri-apps/cli`
2.11.5). Until that ships, `Client/src-tauri/nsis/hooks.nsh` makes the
installer wait, bounded, for the old executable to unlock before overwriting
it, and `tests/e2e/native/packaged-update.spec.ts` holds the executable locked
across every update so the race is forced on every run instead of once a
fortnight.
