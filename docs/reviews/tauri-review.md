# Tauri reliability review

Reviewed 2026-11-07 against `dev` commit
`6bb5a49ba564723cd49178a43a7857009a41ae1d`.

## Scope and method

Static review of `Client/src-tauri/` for panics, unchecked untrusted input,
blocking work on async threads, and resource ownership. Searched the first-party
Rust modules and portable parser crate, then traced relevant command, socket,
capture, storage, and teardown paths. Also inspected the reachable vendored
LiveKit signalling code and the custom Android Kotlin bridges. Vendored code is
identified explicitly below. Unmerged work is outside this baseline.

Source files used for the review were checked against their Git blob hashes at
the recorded commit. These are source-confirmed findings, not measured latency
or leak rates. No desktop build, fault injection, device test, or Android
lifecycle test was performed. Suggested verification below is future work.

Severity: **high** means a core voice path can fail instead of returning a
recoverable error; **medium** means async progress or resource release depends
on blocking work or an unrelated peer; **low** means a narrower lifecycle leak.
No critical finding was established. The document changes no product code.

## Findings

### 1. High: vendored LiveKit unwraps network-derived signalling values

**Locations:** `Client/src-tauri/vendor/livekit/src/rtc_engine/rtc_session.rs:1455`,
`:1481`, `:1503`, `:1505`, `:1566`, `:1571`;
`Client/src-tauri/vendor/livekit/src/room/mod.rs:723`, `:1271`, `:1440`, `:1459`.

The Linux native voice backend calls this vendored SDK through
`Client/src-tauri/src/native_voice/session.rs:485`; `Cargo.toml:355` selects it.
SDP type/description parsing and ICE JSON/candidate parsing unwrap their results.
Track/room signal envelopes unwrap optional fields. Participant and speaker
updates unwrap fallible SID conversions, and speaker sorting unwraps a float
comparison without rejecting non-finite levels. None of these local paths
turns invalid contents into an ordinary error. A handler panic can terminate
signalling/event processing; `rtc_session.rs:1213` propagates a signal handler's
panic into its supervisor. This is a voice availability finding, not evidence
that every such panic terminates the whole application.

**Suggested fix:** validate at the SDK's signal-to-domain boundary. Return a
typed error for invalid SDP/ICE or missing required fields; reject invalid SIDs
and non-finite audio levels before updating room state. Close/recover the affected
session deliberately and surface a terminal event rather than leaving a dead
handler. Keep this as a documented vendor patch or take a verified upstream fix.

**Verify:** malformed signal fixtures return errors without unwinding; the
caller receives failure and can close and reconnect with all session resources
released. The join's participant is already checked earlier in
`rtc_session.rs:592`; its later redundant unwrap is not a separate finding.

### 2. Medium: stopping a proxy leaves accepted connections running

**Locations:** `Client/src-tauri/src/proxy_common.rs:356`, `:377`;
`Client/src-tauri/src/livekit_proxy.rs:229`, `:299`;
`Client/src-tauri/src/http_proxy.rs:210`.

The shared accept loop detaches each connection with `tokio::spawn` and retains
neither a task handle nor a cancellation signal for it. Shutdown ends the accept
loop only. In particular, an accepted LiveKit connection remains in
`copy_bidirectional` until an endpoint closes; it has no owner-driven stop.
Replacing or stopping its tunnel therefore does not guarantee that its tasks,
TCP sockets, or TLS state are released. HTTP workers have data-phase deadlines,
but those do not bind them to tunnel shutdown either. Normal peer closure masks
the ownership gap; it is not a guaranteed leak on every leave.

**Suggested fix:** own connection tasks in a `JoinSet` scoped to the tunnel,
abort/drain them on shutdown or listener failure, and retain a completion handle
so stop can await release. Ensure a retired tunnel cannot cancel a replacement.

**Verify:** keep both endpoints of an accepted connection open, stop its tunnel,
and assert the connection closes and its worker exits; repeat across replacement.

### 3. Medium: credential commands block the async executor

**Locations:** `Client/src-tauri/src/credentials.rs:101`, `:151`, `:208`, `:503`;
`Client/src-tauri/src/secret_store.rs:312`.

Credential, identity-key, and pending-message commands use
`#[tauri::command(async)]` but execute synchronous keyring/DPAPI/fallback-file
operations directly. Saved-password login does the same before its network
await. `with_credential_lock` also waits on a standard mutex inside that work.
A slow or interactive credential backend occupies an async worker, and concurrent
credential calls can occupy other workers waiting for the same mutex.
`SAVED_LOGIN_TIMEOUT` wraps the later HTTP request, not the credential lookup.

**Suggested fix:** move the complete serialized store operation, including
acquiring its existing mutex, into a bounded blocking worker or dedicated store
worker. Return owned results to the async command and preserve current atomicity
and secret-handling rules. Merely adding `async` does not offload blocking work.

**Verify:** stall a store operation and issue concurrent reads/deletes while an
async timer and proxy request keep progressing; confirm serialization survives.

### 4. Medium: native audio device work runs inline in async commands

**Locations:** `Client/src-tauri/src/native_voice/mod.rs:392`, `:575`, `:614`;
`Client/src-tauri/src/native_voice/session.rs:606`, `:689`, `:1382`;
`Client/src-tauri/src/native_voice/capture.rs:798`, `:825`;
`Client/src-tauri/src/native_voice/playout.rs:584`.

Connect calls `enable_audio` directly after awaiting the network. Device switches
and microphone enable also enumerate/open/close CPAL devices synchronously on
the command's async thread. The latter paths hold `NativeVoiceState.inner`
through the operation. A slow or restarting audio service therefore occupies an
executor worker and delays other commands waiting for the session lock. Device
listing already uses `spawn_blocking` in `mod.rs:517`, but these paths do not.

**Suggested fix:** give device operations a blocking owner, pass it owned
requests, and commit results only if the session/generation is still current.
Keep the async state lock out of driver calls and preserve the existing device
fallback and supersession behavior.

**Verify:** stall device open/switch while leave and an unrelated async timer
run; neither should wait on the driver, and a late result must release itself.

### 5. Medium: capture destruction joins OS threads on async workers

**Locations:** `Client/src-tauri/src/native_voice/camera.rs:364`;
`Client/src-tauri/src/native_voice/screen.rs:772`;
`Client/src-tauri/src/native_voice/share_audio.rs:928`;
`Client/src-tauri/src/native_voice/session.rs:948`, `:1119`, `:1292`;
`Client/src-tauri/src/native_voice/mod.rs:1036`.

Capture destructors signal stop and synchronously join their worker. Async
camera/screen stop, replacement, preview stop, and session close drop these
objects directly. Several also hold the shared session lock. Camera teardown
waits for GStreamer's pipeline transition (`camera.rs:514`), so join duration
depends on native work completing, not merely on sending the stop signal.
The code releases resources eventually when the worker exits, but blocks the
async executor while waiting. Mic-test release and Windows app-audio stop already
offload destruction (`mic_test.rs:125`, `windows_app_audio.rs:527`).

**Suggested fix:** detach the retired capture from state under a short lock,
then await its destruction on a blocking worker. Apply this to pending captures,
standalone previews, and stale/error returns as well as normal stop. Preserve
the guarantee that an acknowledged stop has released the device/portal.

**Verify:** delay a capture worker's exit during stop/replacement; async timers
and other state commands progress while stop awaits cleanup, then counts reach zero.

### 6. Medium: activity polling and notifications also block async workers

**Locations:** `Client/src-tauri/src/media_activity.rs:112`;
`Client/src-tauri/src/media_activity/win.rs:56`, `:98`;
`Client/src-tauri/src/media_activity/mpris_linux.rs:15`;
`Client/src-tauri/src/game_activity.rs:145`, `:175`;
`Client/src-tauri/src/message_notification.rs:100`;
`Client/src-tauri/src/notification_bus.rs:75`.

These synchronous command bodies are dispatched with `#[tauri::command(async)]`.
Media polling waits synchronously for WinRT results or blocking D-Bus calls;
game detection scans processes and installed-game files. Linux notification
delivery waits on `recv_timeout` even though the notification bus has its own
thread. The media busy flag bounds overlap and Linux poll deadlines bound time,
but neither moves those waits off the async executor. Together with credential
work, they can delay network tasks sharing that runtime.

**Suggested fix:** use bounded `spawn_blocking` work for activity scans, retain
the existing overlap guard, and use an async reply channel for notification
delivery (or offload its synchronous wait). Keep OS thread-affinity requirements.

**Verify:** hold an OS reply pending and deliver several notifications while
proxy requests and timers continue without waiting for those operations.

### 7. Medium: Android async commands stage large files synchronously

**Locations:** `Client/src-tauri/src/files.rs:297`, `:327`, `:262`, `:272`;
`Client/src-tauri/src/update_commands/android.rs:104`, `:112`, `:149`;
`Client/src-tauri/src/json_store.rs:169`, `:170`.

Save/share calls invoke `stage` before the mobile-plugin await: pruning old
directories, writing the attachment, and fsync all run on an async worker.
Android update similarly verifies the complete downloaded artifact and removes/
writes/fsyncs the APK inline. Kotlin offloads the later MediaStore copy, but not
the Rust staging work. Large attachments/installers or slow storage can therefore
stall async progress during an otherwise asynchronous command.

**Suggested fix:** extract owned request bytes/name before awaiting, then move
pruning, staging, hashing/signature verification, and APK replacement into bounded
blocking work. Preserve atomic writes and verification before installer launch;
keep shared files available until their existing retention policy permits removal.

**Verify:** delay storage sync while an unrelated async operation progresses;
exercise both staging failure and successful handoff without orphaned partial files.

### 8. Low: Android plugin executors have no lifecycle shutdown

**Locations:**
`Client/src-tauri/gen/android/app/src/main/java/com/owncord/client/FilesPlugin.kt:56`;
`Client/src-tauri/gen/android/app/src/main/java/com/owncord/client/ShareInPlugin.kt:71`.

Each plugin instance allocates a single-thread executor without a destruction
hook or shutdown call. The share-in plugin starts its worker on ordinary load
as well (`ShareInPlugin.kt:89`). Recreating an activity/plugin has no deterministic
worker-release path; queued operations can also retain the retired activity.
Garbage collection/finalization may eventually shut down an unreachable executor,
but is not lifecycle ownership or cancellation of pending work. This is an
ownership finding, not a measured permanent thread or Android heap leak.

**Suggested fix:** bind executors and queued work to plugin/activity destruction,
stop admitting work, invalidate pending share generations, and shut down the
workers. Use application context for storage work where possible. Arrange a
clear completion/cancellation result for outstanding invokes.

**Verify:** repeatedly recreate the activity after load/save/share, then check
worker counts return to baseline and no retired activity receives a completion.

## Existing safeguards and limits

- No confirmed untrusted-input `unwrap()` was found in the first-party parser
  paths examined. The portable parser crate returns `Result`/`Option`; test-only
  unwraps, deliberate crash fixtures, and guarded constant/internal invariants
  were not reported as defects.
- Frame-server connections are owned by a `JoinSet` and aborted with the server
  (`native_voice/video.rs:106`, `:190`); the proxy finding concerns a different
  accept loop. HTTP pool sockets have per-host caps and scheduled expiry
  (`http_pool.rs:60`, `:161`).
- Existing worker threads, desktop consent waits, cached app-lifetime services,
  and correctly offloaded operations are not leaks merely because they persist.
  Native-library internals, every upstream SDK path, and OS-specific runtime
  behavior require additional targeted testing.
- Tauri's [async command documentation](https://v2.tauri.app/develop/calling-rust/#async-commands)
  specifies async-task dispatch. The locally available Tauri macro implementation
  also invokes synchronous `command(async)` bodies inside an async block; it
  does not automatically wrap them in `spawn_blocking`.
