# Rust Patterns (Tauri v2 Backend)

Canonical patterns extracted from OwnCord's Tauri v2 Rust backend
(`Client/tauri-client/src-tauri/src/`). AI agents must follow these
exactly when writing new Rust code for the client backend.

See also: [[06-Specs/CLIENT-ARCHITECTURE|CLIENT-ARCHITECTURE.md]],
[[06-Specs/SETUP|SETUP.md]]

---

## Table of Contents

1. [Module Organization](#1-module-organization)
2. [Tauri Command Pattern](#2-tauri-command-pattern)
3. [State Management](#3-state-management)
4. [Event Emission](#4-event-emission)
5. [Plugin Usage](#5-plugin-usage)
6. [Capabilities and Permissions](#6-capabilities-and-permissions)
7. [WebSocket Proxy (TOFU Cert Pinning)](#7-websocket-proxy-tofu-cert-pinning)
8. [LiveKit TLS Proxy](#8-livekit-tls-proxy)
9. [Windows Credential Manager](#9-windows-credential-manager)
10. [Push-to-Talk (GetAsyncKeyState)](#10-push-to-talk-getasynckeystate)
11. [Global Shortcuts](#11-global-shortcuts)
12. [System Tray](#12-system-tray)
13. [Auto-Update](#13-auto-update)
14. [Settings Store (Allowlist Pattern)](#14-settings-store-allowlist-pattern)
15. [Certificate Fingerprint Store](#15-certificate-fingerprint-store)
16. [Error Handling](#16-error-handling)
17. [Platform-Specific Code](#17-platform-specific-code)
18. [Thread Safety Patterns](#18-thread-safety-patterns)
19. [Build Configuration](#19-build-configuration)
20. [Checklist: Adding a New Feature](#20-checklist-adding-a-new-feature)

---

## 1. Module Organization

```
src-tauri/src/
+-- lib.rs              # Plugin registration, state, invoke_handler, setup
+-- main.rs             # Entry point (calls lib::run())
+-- commands.rs         # Settings, certs, devtools (general commands)
+-- credentials.rs      # Windows Credential Manager integration
+-- hotkeys.rs          # Global shortcut handling
+-- livekit_proxy.rs    # LiveKit TCP-to-TLS proxy for self-signed certs
+-- ptt.rs              # Push-to-talk polling loop
+-- tray.rs             # System tray setup + menu
+-- update_commands.rs  # Auto-update check and install
+-- ws_proxy.rs         # WebSocket proxy with TOFU cert pinning
```

### Module Responsibility Rules

- One module per domain/feature
- Declare modules in `lib.rs`: `mod commands; mod ptt;`
- Keep modules under 400 lines (current largest: `ws_proxy.rs` ~376 lines)
- Public functions are `pub fn` / `pub async fn`; helpers are private `fn`
- All state structs are defined in the module that manages them
- Each module's Tauri commands are registered in `lib.rs`'s `invoke_handler`

### Entry Point Flow

```
main.rs
  |
  +-- owncord_client_lib::run()
        |
        +-- tauri::Builder::default()
              |
              +-- .plugin(...)           # 9 plugins registered
              +-- .manage(WsState)       # WebSocket proxy state
              +-- .manage(LiveKitProxyState)  # LiveKit proxy state
              +-- .invoke_handler(...)   # 21 commands registered
              +-- .setup(|app| {         # System tray on startup
              |       tray::create_tray(app.handle())?;
              |       Ok(())
              |   })
              +-- .run(tauri::generate_context!())
```

### Complete Command Registry

From `lib.rs` `invoke_handler`:

| Command | Module | Async | Parameters |
|---------|--------|-------|------------|
| `get_settings` | commands | no | app |
| `save_settings` | commands | no | app, key, value |
| `store_cert_fingerprint` | commands | no | app, host, fingerprint |
| `get_cert_fingerprint` | commands | no | app, host |
| `open_devtools` | commands | no | _window |
| `ws_connect` | ws_proxy | yes | app, state, url |
| `ws_send` | ws_proxy | yes | state, message |
| `ws_disconnect` | ws_proxy | yes | state |
| `accept_cert_fingerprint` | ws_proxy | no | app, host, fingerprint |
| `save_credential` | credentials | no | host, username, token, password? |
| `load_credential` | credentials | no | host |
| `delete_credential` | credentials | no | host |
| `check_client_update` | update_commands | yes | app, server_url |
| `download_and_install_update` | update_commands | yes | app, server_url |
| `ptt_start` | ptt | no | app |
| `ptt_stop` | ptt | no | - |
| `ptt_set_key` | ptt | no | vk_code |
| `ptt_get_key` | ptt | no | - |
| `ptt_listen_for_key` | ptt | no | - |
| `start_livekit_proxy` | livekit_proxy | yes | state, remote_host |
| `stop_livekit_proxy` | livekit_proxy | yes | state |

---

## 2. Tauri Command Pattern

Every command exposed to the frontend uses `#[tauri::command]`.

### Synchronous Command

```rust
#[tauri::command]
pub fn my_command(app: tauri::AppHandle, key: String) -> Result<String, String> {
    // validate input
    if key.is_empty() {
        return Err("key must not be empty".into());
    }
    // do work
    Ok("done".to_string())
}
```

### Async Command

```rust
#[tauri::command]
pub async fn my_async_command(
    app: AppHandle,
    state: tauri::State<'_, MyState>,
    channel_id: String,
) -> Result<SomeData, String> {
    let lock = state.inner.lock().await;
    // async body
    Ok(data)
}
```

### Parameter Injection

Parameters injected by Tauri (not sent from frontend):

| Parameter | Type | When to Use |
|-----------|------|-------------|
| `app: AppHandle` | App handle | Emit events, access plugins |
| `app: AppHandle<R>` | Generic runtime | Commands that spawn threads/tasks |
| `state: tauri::State<'_, T>` | Managed state | Access `.manage(T)` state |
| `_window: tauri::WebviewWindow` | Window handle | DevTools, window manipulation |

Regular parameters come from the frontend `invoke()` call and must
match the JavaScript argument names exactly.

### Command Registration

Every command must be listed in `lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    commands::my_command,
    module::another_command,
])
```

### Return Type Convention

All commands return `Result<T, String>`:
- Errors serialize as strings for the frontend
- Convert library errors: `.map_err(|e| format!("context: {e}"))?`
- Use `.into()` for simple string errors: `Err("message".into())`

---

## 3. State Management

### Tauri Managed State with tokio::sync::Mutex

For complex state shared between async commands:

```rust
use tokio::sync::Mutex;

pub struct WsState {
    tx: Mutex<Option<mpsc::Sender<String>>>,
}

impl WsState {
    pub fn new() -> Self {
        Self { tx: Mutex::new(None) }
    }
}

// Register in lib.rs:
.manage(WsState::new())

// Access in commands:
#[tauri::command]
pub async fn ws_send(state: tauri::State<'_, WsState>) -> Result<(), String> {
    let tx_lock = state.tx.lock().await;
    // ...
}
```

### Nested Mutex State

For state with multiple fields that need independent locking:

```rust
pub struct LiveKitProxyState {
    inner: Mutex<ProxyInner>,
}

struct ProxyInner {
    port: Option<u16>,
    remote_host: String,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}
```

### Mutex Choice Matrix

| Mutex Type | When to Use | Lock Method |
|-----------|-------------|-------------|
| `tokio::sync::Mutex` | Async command handlers | `.lock().await` |
| `std::sync::Mutex` | Synchronous contexts only | `.lock().unwrap()` |
| `Arc<std::sync::Mutex<T>>` | Shared across TLS callbacks | `.lock().ok()` |

**Critical rule**: Never hold `std::sync::Mutex` across `.await` points.
OwnCord uses `tokio::sync::Mutex` for all command handler state.

### Atomics for Simple Flags (Lock-Free)

```rust
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static PTT_VKEY: AtomicI32 = AtomicI32::new(0);
static PTT_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn ptt_set_key(vk_code: i32) {
    PTT_VKEY.store(vk_code, Ordering::SeqCst);
}

#[tauri::command]
pub fn ptt_get_key() -> i32 {
    PTT_VKEY.load(Ordering::SeqCst)
}
```

- Use `Ordering::SeqCst` for all atomic operations (simplicity)
- Use `AtomicBool`/`AtomicI32` for global flags (no compound state)
- `static` atomics avoid Tauri managed state overhead for simple values

---

## 4. Event Emission

Broadcast data from Rust to the frontend via Tauri events.

### Event Types Used

| Event Name | Data Type | Emitter Module | Purpose |
|------------|-----------|----------------|---------|
| `ws-state` | `&str` | ws_proxy | `"connecting"`, `"open"`, `"closed"` |
| `ws-message` | `String` | ws_proxy | Server WS message text |
| `ws-error` | `String` | ws_proxy | WS error description |
| `cert-tofu` | `serde_json::Value` | ws_proxy | TOFU fingerprint status |
| `ptt-state` | `bool` | ptt | Key pressed/released |
| `ptt-press` | `()` | hotkeys | Shortcut pressed |
| `ptt-release` | `()` | hotkeys | Shortcut released |
| `status-change` | `&str` | tray | Status from tray menu |

### Emission Pattern

```rust
use tauri::Emitter;

// Simple string event
let _ = app.emit("ws-state", "connecting");

// Structured data event
let _ = app.emit("cert-tofu", serde_json::json!({
    "host": host,
    "fingerprint": fingerprint,
    "status": "trusted",
}));

// Boolean event
let _ = app.emit("ptt-state", pressed);
```

### Generic Runtime Bound

Commands that spawn threads and emit events need `<R: Runtime>`:

```rust
#[tauri::command]
pub fn ptt_start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let _ = app.emit("ptt-state", pressed);
    });
}
```

Without `<R: Runtime>`, the concrete `AppHandle` type cannot be
sent across thread boundaries. This applies to: `ws_connect`,
`ptt_start`, `accept_cert_fingerprint`, and any command that moves
`app` into a spawned task or thread.

### Rules

- Always `let _ = app.emit(...)` -- ignore emission errors
- Event names use kebab-case: `ws-message`, `ptt-state`
- Frontend listens via `listen("event-name", callback)`
  from `@tauri-apps/api/event`

---

## 5. Plugin Usage

Nine plugins registered in `lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
```

### Plugin Registration Patterns

| Pattern | Example | Used By |
|---------|---------|---------|
| `Builder::new().build()` | store, global-shortcut, updater | Plugins with configuration |
| `::init()` | notification, http, opener, dialog, fs, process | Simple init plugins |

### Store Plugin

```rust
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";

let store = app
    .store(SETTINGS_STORE)
    .map_err(|e| format!("failed to open settings store: {e}"))?;

store.set(&key, value);
store.save().map_err(|e| format!("failed to persist: {e}"))?;
```

Store files are persisted in the Tauri data directory
(typically `%APPDATA%/com.owncord.client/`).

### Updater Plugin

```rust
use tauri_plugin_updater::UpdaterExt;

let updater = app
    .updater_builder()
    .endpoints(vec![url])
    .map_err(|e| format!("failed to set endpoints: {e}"))?
    .configure_client(|client| client.danger_accept_invalid_certs(true))
    .build()
    .map_err(|e| format!("failed to build updater: {e}"))?;
```

The `danger_accept_invalid_certs(true)` call is needed because
OwnCord is self-hosted and commonly uses self-signed TLS certs.
The update artifact itself is verified via Ed25519 signature.

---

## 6. Capabilities and Permissions

All permissions are declared in `src-tauri/capabilities/default.json`.
The capability file scopes what the frontend JavaScript can access.

### Permission Categories

| Category | Permissions |
|----------|-------------|
| Core | `core:default`, `core:event:default`, `core:window:default`, show, hide, focus, position, size, maximize, is-visible, is-maximized, outer-position, outer-size |
| Store | `store:default` |
| Global Shortcut | `global-shortcut:default`, register, unregister, unregister-all, is-registered |
| Notification | `notification:default`, notify, request-permission, is-permission-granted |
| HTTP | `http:default`, fetch/send/read-body (scoped to `https://*:*` and `https://*`), fetch-cancel |
| Opener | `opener:default` |
| Dialog | `dialog:default` |
| Updater | `updater:default` |
| Process | `process:allow-restart` |
| FS | `fs:default`, write-file (scoped: `**`) |

### Scoped Permissions

HTTP fetch is scoped to HTTPS-only:

```json
{
  "identifier": "http:allow-fetch",
  "allow": [
    { "url": "https://*:*" },
    { "url": "https://*" }
  ]
}
```

### Adding New Permissions

1. Identify which plugin permissions are needed
2. Add them to `capabilities/default.json`
3. Use the most restrictive scope possible
4. Scoped permissions use object form with `identifier` + `allow` array

---

## 7. WebSocket Proxy (TOFU Cert Pinning)

The WS proxy (`ws_proxy.rs`) routes WebSocket traffic through Rust
to bypass WebView2's rejection of self-signed TLS certificates.

### Architecture

```
  Frontend (JS)                    ws_proxy.rs                Server
       |                                |                        |
  invoke("ws_connect",           TofuVerifier captures          |
    { url: "wss://..." })        cert SHA-256 fingerprint        |
       |                                |                        |
       |  <-- emit("ws-state",         |-- tokio_tungstenite --> |
       |         "connecting")          |   connect_async_tls    |
       |                                |                        |
       |  <-- emit("cert-tofu",        |-- TOFU check:          |
       |     {status:"trusted"})       |   first_use: store     |
       |                                |   same: OK             |
       |                                |   different: REJECT    |
       |                                |                        |
       |  <-- emit("ws-state","open")  |                        |
       |                                |                        |
  invoke("ws_send",                    |                        |
    { message: "{...}" })              |                        |
       | --> mpsc channel (256) -----> |-- sink.send() -------> |
       |                                |                        |
       |  <-- emit("ws-message",       |<-- stream.next() <--- |
       |         "{...}")               |                        |
```

### TOFU Certificate Verifier

```rust
#[derive(Debug)]
struct TofuVerifier {
    captured: CapturedFingerprint,  // Arc<std::sync::Mutex<Option<String>>>
}

impl rustls::client::danger::ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(&self, end_entity: &CertificateDer, ...) -> Result<...> {
        // Compute SHA-256 fingerprint of DER-encoded leaf cert
        let hash = digest(&SHA256, end_entity.as_ref());
        let hex = hash.as_ref().iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":");

        // Store fingerprint for post-handshake TOFU check
        if let Ok(mut guard) = self.captured.lock() {
            *guard = Some(hex);
        }

        // Accept cert (TOFU check is after handshake)
        Ok(ServerCertVerified::assertion())
    }

    // Also implements: verify_tls12_signature, verify_tls13_signature,
    // supported_verify_schemes (11 schemes supported)
}
```

### TOFU Check Flow

```rust
fn tofu_check<R: Runtime>(app: &AppHandle<R>, host: &str, fingerprint: &str)
    -> Result<String, String>
{
    // Open certs.json store
    let store = app.store(CERTS_STORE)?;
    let stored = store.get(host);

    match stored {
        None => {
            // First use: store fingerprint
            store.set(host, fingerprint);
            store.save()?;
            Ok("trusted_first_use")
        }
        Some(same) if same == fingerprint => Ok("trusted"),
        Some(old) => Err(format!(
            "Certificate fingerprint changed for {host}.\n\
             Stored:  {old}\nCurrent: {fingerprint}"
        )),
    }
}
```

### Bidirectional Message Forwarding

Two tokio tasks handle message flow:

```rust
// Task 1: Server -> JS (read from WS, emit to frontend)
let mut read_task = tokio::spawn(async move {
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let _ = app_read.emit("ws-message", text.to_string());
            }
            Ok(Message::Close(_)) => break,
            Err(e) => {
                let _ = app_read.emit("ws-error", format!("{e}"));
                break;
            }
            _ => {}  // ignore binary/ping/pong
        }
    }
});

// Task 2: JS -> Server (read from mpsc, write to WS)
let mut write_task = tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
        if sink.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
});

// Supervisor: when either ends, abort sibling
tokio::spawn(async move {
    tokio::select! {
        _ = &mut read_task => { write_task.abort(); }
        _ = &mut write_task => { read_task.abort(); }
    }
    let _ = app_state.emit("ws-state", "closed");
});
```

### Connection Lifecycle

```
ws_connect() called
  |
  +-- Drop existing connection (set tx = None)
  +-- Validate URL starts with "wss://"
  +-- Emit "ws-state" = "connecting"
  +-- Create TofuVerifier
  +-- Build rustls ClientConfig with custom verifier
  +-- connect_async_tls_with_config (10s timeout)
  +-- Extract captured fingerprint
  +-- Run tofu_check:
  |     +-- first_use: store + emit "cert-tofu" {status: "trusted_first_use"}
  |     +-- trusted: emit "cert-tofu" {status: "trusted"}
  |     +-- mismatch: emit "cert-tofu" {status: "mismatch"} + return Err
  +-- Emit "ws-state" = "open"
  +-- Split stream into sink + stream
  +-- Create mpsc channel (256 capacity)
  +-- Store tx in WsState
  +-- Spawn read_task + write_task + supervisor

ws_disconnect() called
  |
  +-- Set tx = None (dropping sender closes channel)
  +-- write_task recv() returns None -> breaks
  +-- supervisor aborts read_task
  +-- Emit "ws-state" = "closed"
```

---

## 8. LiveKit TLS Proxy

The LiveKit TLS proxy (`livekit_proxy.rs`) solves a specific problem:
the LiveKit JS SDK opens its own WebSocket from WebView2, which
rejects self-signed TLS certificates.

### Architecture

```
  LiveKit JS SDK                livekit_proxy.rs            Remote Server
       |                              |                          |
  Connect to                   TcpListener on                   |
  ws://127.0.0.1:{port}       127.0.0.1:0 (random port)        |
  /livekit/...                        |                          |
       | --> TCP (plain) -----------> |                          |
       |                              |-- Read HTTP headers      |
       |                              |-- Rewrite Host/Origin    |
       |                              |-- TLS connect ---------> |
       |                              |   (InsecureVerifier)     |
       |                              |-- Forward request -----> |
       |                              |                          |
       | <-------- io::copy_bidirectional ---------------------- |
```

### Key Implementation Details

**Header Rewriting**: The proxy reads the HTTP upgrade request
headers (up to 16KB), rewrites `Host:` and `Origin:` to match the
remote server so WebSocket origin checks pass, then forwards.

**InsecureVerifier**: Accepts all server certificates without
validation. Same trust model as `ws_proxy.rs` but without TOFU
fingerprint tracking. The risk is documented in the module header.

**Lifecycle Management**:

```rust
pub async fn start_livekit_proxy(
    state: tauri::State<'_, LiveKitProxyState>,
    remote_host: String,
) -> Result<u16, String> {
    let mut inner = state.inner.lock().await;

    // Reuse existing proxy for same host
    if let Some(port) = inner.port {
        if inner.remote_host == remote_host {
            return Ok(port);  // same host, reuse port
        }
        // Different host: tear down old proxy
        if let Some(tx) = inner.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }

    // Bind to random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    // Spawn proxy loop with shutdown channel
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(run_proxy_loop(listener, host, shutdown_rx));

    inner.port = Some(port);
    inner.remote_host = remote_host;
    inner.shutdown_tx = Some(shutdown_tx);

    Ok(port)
}
```

**Known Limitations** (documented in source):
- Only one proxy instance per remote host
- No TOFU fingerprint pinning (unlike ws_proxy)
- If the remote server adds stricter origin validation, header
  rewriting may need updating
- Stale proxy ports are not reused after server change

---

## 9. Windows Credential Manager

The `credentials.rs` module stores authentication tokens in Windows
Credential Manager via Win32 API calls.

### Target Name Convention

```
OwnCord/{host}
```

Example: `OwnCord/192.168.1.100:8443`

### Credential Blob Format

Stored as JSON in the credential blob (encrypted at rest by DPAPI):

```json
{
  "username": "alice",
  "token": "abc123...",
  "password": "optional"  // only if "Remember password" checked
}
```

### Win32 API Calls

| Function | Purpose |
|----------|---------|
| `CredWriteW` | Save/update credential |
| `CredReadW` | Load credential |
| `CredDeleteW` | Remove credential |
| `CredFree` | Free memory allocated by CredReadW |

### Security Properties

- **DPAPI encryption**: Blob is encrypted with the Windows user's
  key. Plaintext is never stored on disk.
- **CRED_PERSIST_LOCAL_MACHINE**: Credential persists across sessions
  on the local machine.
- **CRED_TYPE_GENERIC**: Standard credential type for applications.
- **Debug redaction**: `CredentialData`'s `Debug` impl redacts token
  and password fields with `[REDACTED]`.

### Error Handling for Missing Credentials

```rust
match read_result {
    Ok(()) => { /* parse blob */ }
    Err(e) => {
        if e.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);  // missing is not an error
        }
        return Err(format!("CredReadW failed: {e}"));
    }
}
```

Similarly, deleting a non-existent credential returns `Ok(())`.

### UTF-16 Encoding

Win32 APIs use UTF-16 strings. Helper functions handle conversion:

```rust
fn target_name(host: &str) -> Vec<u16> {
    let name = format!("OwnCord/{host}");
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
```

---

## 10. Push-to-Talk (GetAsyncKeyState)

The PTT module (`ptt.rs`) uses a polling loop to detect key
press/release without consuming the keystroke.

### Polling Architecture

```
ptt_start() called
  |
  +-- PTT_RUNNING.swap(true) -- returns early if already running
  +-- std::thread::spawn (not tokio! -- tight polling loop)
        |
        loop (20ms interval):
          +-- check PTT_RUNNING
          +-- load PTT_VKEY
          +-- if vk != 0:
          |     +-- is_key_down(vk) via GetAsyncKeyState
          |     +-- if state changed:
          |           +-- app.emit("ptt-state", pressed/released)
          +-- sleep(20ms)
```

### Key Detection

```rust
#[cfg(windows)]
fn is_key_down(vk: i32) -> bool {
    let state = unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk)
    };
    (state as u16 & 0x8000) != 0
}
```

- `GetAsyncKeyState` is non-consuming: other applications still
  receive the key event.
- The `0x8000` bit indicates the key is currently pressed.
- 20ms polling interval balances responsiveness vs CPU usage.

### Key Capture (Listen Mode)

```rust
pub fn ptt_listen_for_key() -> i32 {
    let deadline = Instant::now() + Duration::from_secs(10);

    while Instant::now() < deadline {
        for vk in 1..=254i32 {
            // Skip modifier keys (Shift, Ctrl, Alt, Win)
            if matches!(vk, 0x10 | 0x11 | 0x12 | 0x5B | 0x5C) {
                continue;
            }
            if is_key_down(vk) {
                // Wait for release (5s timeout)
                // ...
                return vk;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    0  // timed out
}
```

- Scans all 254 virtual key codes
- Skips modifiers (Shift=0x10, Ctrl=0x11, Alt=0x12, Win=0x5B/0x5C)
- 10-second timeout prevents indefinite blocking
- Returns 0 on timeout (no key pressed)
- Waits for key release before returning (with 5s sub-timeout)

---

## 11. Global Shortcuts

The `hotkeys.rs` module wraps the global-shortcut plugin for
push-to-talk via keyboard shortcuts (alternative to GetAsyncKeyState).

```rust
pub fn register_push_to_talk<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut_str: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut: Shortcut = shortcut_str.parse()?;

    // Remove previous binding first
    if app.global_shortcut().is_registered(shortcut) {
        app.global_shortcut().unregister(shortcut)?;
    }

    let handle = app.clone();
    app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
        let event_name = match event.state {
            ShortcutState::Pressed => "ptt-press",
            ShortcutState::Released => "ptt-release",
        };
        let _ = handle.emit(event_name, ());
    })?;

    Ok(())
}
```

Note: This module provides functions but no Tauri commands --
it is called from Rust code, not from the frontend.

---

## 12. System Tray

The `tray.rs` module creates a system tray icon with a context menu.

### Menu Structure

```
+-- Show/Hide        (toggle window visibility)
+-- Status >         (submenu)
|   +-- Online
|   +-- Idle
|   +-- Do Not Disturb
|   +-- Offline
+-- Quit             (exit application)
```

### Menu Item IDs

```rust
const SHOW_HIDE_ID: &str = "show_hide";
const STATUS_ONLINE_ID: &str = "status_online";
const STATUS_IDLE_ID: &str = "status_idle";
const STATUS_DND_ID: &str = "status_dnd";
const STATUS_OFFLINE_ID: &str = "status_offline";
const QUIT_ID: &str = "quit";
```

### Behaviors

- **Left click on tray icon**: Toggle window visibility
- **Show/Hide menu**: Toggle window visibility
- **Status items**: Emit `status-change` event with status string
- **Quit**: `app.exit(0)`

### Window Visibility Toggle

```rust
fn toggle_window_visibility<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
```

---

## 13. Auto-Update

The `update_commands.rs` module implements self-hosted auto-update.

### Update Endpoint Format

```
{server_url}/api/v1/client-update/{{target}}/{current_version}
```

The `{{target}}` placeholder is filled by the updater plugin with
the platform target (e.g., `windows-x86_64`).

### Check Flow

```rust
pub async fn check_client_update(
    app: AppHandle,
    server_url: String,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.config().version.unwrap_or("0.0.0");
    let endpoint = format!("{server_url}/api/v1/client-update/{{{{target}}}}/{current_version}");

    let updater = app.updater_builder()
        .endpoints(vec![url])
        .configure_client(|client| client.danger_accept_invalid_certs(true))
        .build()?;

    match updater.check().await? {
        Some(u) => Ok(UpdateCheckResult {
            available: true,
            version: Some(u.version),
            body: Some(u.body.unwrap_or_default()),
        }),
        None => Ok(UpdateCheckResult {
            available: false,
            version: None,
            body: None,
        }),
    }
}
```

### Security Model

- TLS certs are not validated (`danger_accept_invalid_certs(true)`)
  because OwnCord is self-hosted with self-signed certs
- **Update artifacts are verified via Ed25519 signature** using the
  public key in `tauri.conf.json` (`plugins.updater.pubkey`)
- The server cannot serve malicious updates without the private key

---

## 14. Settings Store (Allowlist Pattern)

The settings store (`commands.rs`) uses an allowlist to prevent
arbitrary key injection.

### Allowed Keys

```rust
const ALLOWED_SETTINGS_PREFIXES: &[&str] = &[
    "owncord:",      // owncord:profiles, owncord:settings:*, owncord:recent-emoji
    "userVolume_",   // per-user volume: userVolume_{userId}
];

const ALLOWED_SETTINGS_EXACT: &[&str] = &[
    "windowState",
];
```

### Validation

```rust
fn is_settings_key_allowed(key: &str) -> bool {
    if key.len() > MAX_SETTINGS_KEY_LEN || key.is_empty() {
        return false;
    }
    if ALLOWED_SETTINGS_EXACT.contains(&key) {
        return true;
    }
    ALLOWED_SETTINGS_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}
```

- Maximum key length: 128 characters (DoS prevention)
- Empty keys rejected
- Only exact matches or prefix matches allowed
- `save_settings` rejects unknown keys with an error

---

## 15. Certificate Fingerprint Store

The `store_cert_fingerprint` command validates SHA-256 fingerprint
format before storing:

```rust
// Validate SHA-256 colon-hex format: "aa:bb:cc:..." (95 chars, 32 hex pairs)
if fingerprint.len() != 95 {
    return Err("fingerprint must be a SHA-256 colon-hex string (95 chars)".into());
}
for (i, ch) in fingerprint.chars().enumerate() {
    if i % 3 == 2 {
        if ch != ':' {
            return Err("fingerprint must use colon-separated hex pairs".into());
        }
    } else if !ch.is_ascii_hexdigit() {
        return Err("fingerprint contains invalid hex character".into());
    }
}
```

Fingerprints are normalized to lowercase before storage for
consistent comparison with `ws_proxy.rs` fingerprints.

---

## 16. Error Handling

### Return Convention

All commands return `Result<T, String>`:

```rust
// Input validation -- return early
if host.is_empty() {
    return Err("host must not be empty".into());
}

// Plugin/library errors -- map with context
let store = app
    .store(CERTS_STORE)
    .map_err(|e| format!("failed to open certs store: {e}"))?;

// Chained operations
store.save()
    .map_err(|e| format!("failed to persist cert fingerprint: {e}"))?;

// Optional results (not-found is not an error)
match read_result {
    Ok(()) => {}
    Err(e) => {
        if e.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);  // missing is OK
        }
        return Err(format!("CredReadW failed: {e}"));
    }
}
```

### Rules

- NEVER `unwrap()` or `panic!()` in command handlers
- Use `.into()` for simple string errors
- Use `format!()` when including error context
- Validate all inputs before doing work
- Convert Win32 `ERROR_NOT_FOUND` to `Ok(None)` (missing is not failure)
- Log errors at the Rust level only when they represent unexpected conditions
  (not when the frontend can handle them via the Result)

---

## 17. Platform-Specific Code

### Conditional Compilation

```rust
// Windows implementation
#[cfg(windows)]
fn is_key_down(vk: i32) -> bool {
    let state = unsafe {
        windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk)
    };
    (state as u16 & 0x8000) != 0
}

// Non-Windows stub
#[cfg(not(windows))]
fn is_key_down(_vk: i32) -> bool {
    false
}
```

### Windows Crate Features

From `Cargo.toml` (Windows-only dependency):

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Security_Credentials",       # CredWriteW, CredReadW, CredDeleteW, CredFree
    "Win32_Foundation",                 # ERROR_NOT_FOUND, HRESULT
    "Win32_UI_Input_KeyboardAndMouse",  # GetAsyncKeyState
]}
```

### Rules

- Always provide a non-Windows stub (return default/false/empty)
- Use the `windows` crate (not raw FFI) for Win32 API access
- Prefix unused parameters with `_` on stub implementations
- Mark unsafe blocks with `// SAFETY:` comments when non-trivial

---

## 18. Thread Safety Patterns

### Pattern Matrix

| State Type | Sync Mechanism | Example |
|-----------|---------------|---------|
| Complex async state | `tokio::sync::Mutex` | WsState, LiveKitProxyState |
| TLS callback data | `Arc<std::sync::Mutex<T>>` | CapturedFingerprint |
| Simple global flags | `AtomicBool`/`AtomicI32` | PTT_RUNNING, PTT_VKEY |
| OS thread + events | `<R: Runtime>` + `std::thread::spawn` | ptt_start |
| Async tasks + events | `tokio::spawn` + `app.clone()` | ws_connect |
| Graceful shutdown | `tokio::sync::oneshot` | LiveKit proxy shutdown |
| Backpressure | `mpsc::channel(256)` + `try_send` | WS message queue |

### Arc Usage

`Arc` is used when state must be shared between the TLS handshake
callback (which runs in a separate context) and the post-handshake
verification:

```rust
type CapturedFingerprint = Arc<std::sync::Mutex<Option<String>>>;

fn new() -> (TofuVerifier, CapturedFingerprint) {
    let fp = Arc::new(std::sync::Mutex::new(None));
    (Self { captured: fp.clone() }, fp)
}
```

### Tokio Select for Task Supervision

```rust
tokio::select! {
    result = listener.accept() => { /* handle connection */ }
    _ = &mut shutdown_rx => break,  // graceful shutdown
}
```

---

## 19. Build Configuration

### Cargo.toml Highlights

```toml
[package]
name = "owncord-client"
version = "1.3.0"
edition = "2021"

[lib]
name = "owncord_client_lib"
crate-type = ["lib", "cdylib", "staticlib"]

[features]
default = ["devtools"]
devtools = ["tauri/devtools"]

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

- **crate-type**: Library built as `lib` (Rust), `cdylib` (dynamic),
  and `staticlib` (static) for Tauri embedding
- **devtools feature**: Enabled by default in dev, stripped in release
- **tauri-build**: Generates Rust bindings for Tauri config

### Conditional DevTools

```rust
#[tauri::command]
pub fn open_devtools(_window: tauri::WebviewWindow) {
    #[cfg(feature = "devtools")]
    {
        use tauri::Manager;
        _window.open_devtools();
    }
}
```

The `_window` parameter is prefixed with `_` because the body is
conditionally compiled and may not use it in release builds.

### Release vs Debug

```
Debug:  devtools feature ON, symbols included, no stripping
Release: devtools compiled but hidden behind feature gate,
         binary stripped (-s -w via ldflags on Go side)
```

In `main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```
This hides the console window in release builds.

---

## 20. Checklist: Adding a New Feature

1. **Module**: Create `src-tauri/src/my_feature.rs`
2. **Declare**: Add `mod my_feature;` to `lib.rs`
3. **State** (if needed): Define state struct with `Mutex`, add
   `.manage(MyState::new())` in `lib.rs`
4. **Commands**: Write `#[tauri::command]` functions
5. **Register**: Add commands to `invoke_handler` in `lib.rs`
6. **Events** (if needed): Define event names (kebab-case),
   use `app.emit("event-name", data)`
7. **Capabilities**: Add required permissions to
   `capabilities/default.json`
8. **Platform**: Add `#[cfg(windows)]` impl + `#[cfg(not(windows))]` stub
9. **Errors**: Return `Result<T, String>`, validate all inputs
10. **Tests**: Add `#[cfg(test)] mod tests` with unit tests
11. **Verify**: `cargo check` then `cargo test` then `npm run tauri dev`
