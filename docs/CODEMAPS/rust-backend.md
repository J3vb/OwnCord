<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~600 -->

# Tauri Rust Backend Codemap

## Source Stats
- 10 source files, ~1,751 lines
- src-tauri/src/

## Module Map

### lib.rs (61 lines) -- App bootstrap
- Registers all Tauri plugins: store, global-shortcut, notification, http, opener, dialog, fs, updater, process
- Manages WsState and LiveKitProxyState
- Registers 19 IPC commands via generate_handler!
- Creates system tray on setup

### ws_proxy.rs (444 lines) -- WebSocket proxy
- **WsState**: Arc<Mutex<Option<WsConnection>>> singleton
- `ws_connect(url, token, fingerprint)` -- TLS with TOFU cert pinning, accept_invalid_certs for server URLs
- `ws_send(message)` -- forward text frame to server
- `ws_disconnect()` -- close connection
- `accept_cert_fingerprint()` -- mark fingerprint as trusted
- Emits `ws-message` and `ws-close` events to frontend
- SHA-256 fingerprint extraction from server cert

### livekit_proxy.rs (434 lines) -- LiveKit signaling proxy
- **LiveKitProxyState**: Arc<Mutex<Option<ProxyHandle>>>
- `start_livekit_proxy(server_url)` -- launches local TCP listener, proxies to server's /livekit/* path
- `stop_livekit_proxy()` -- shuts down proxy
- TLS passthrough with TOFU fingerprint checking
- Returns local proxy URL for LiveKit JS SDK to connect to

### credentials.rs (252 lines) -- Windows Credential Manager
- `save_credential(service, username, password)` -- writes to Windows Credential Manager
- `load_credential(service, username)` -- reads password
- `delete_credential(service, username)` -- removes entry
- Uses `windows-sys` crate for CredWriteW/CredReadW/CredDeleteW
- Non-Windows: compile-time stubs returning errors

### commands.rs (218 lines) -- Settings + certs IPC
- `get_settings()` / `save_settings(key, value)` -- tauri-plugin-store with key allowlist
- `store_cert_fingerprint(host, fp)` / `get_cert_fingerprint(host)` -- TOFU cert store
- `open_devtools()` -- conditional on "devtools" feature flag
- Key allowlist: `owncord:*`, `userVolume_*`, `windowState`

### update_commands.rs (112 lines) -- Client auto-updater
- `check_client_update(server_url)` -- polls server /api/v1/client-update
- `download_and_install_update(url)` -- downloads MSI, launches installer

### ptt.rs (97 lines) -- Push-to-talk
- `ptt_start()` / `ptt_stop()` -- start/stop key polling thread
- `ptt_set_key(vk_code)` / `ptt_get_key()` -- configure PTT key
- `ptt_listen_for_key()` -- 10s capture window, returns pressed VK code
- Uses Win32 GetAsyncKeyState (non-consuming, works globally)
- Emits `ptt-active` events to frontend

### tray.rs (92 lines) -- System tray
- `create_tray(handle)` -- icon + right-click menu (Show/Quit)

### hotkeys.rs (35 lines) -- Global shortcuts
- Hotkey registration helpers (delegates to tauri-plugin-global-shortcut)

### main.rs (6 lines) -- Entry point
- Calls lib::run()

## IPC Command Registry (19 commands)
```
commands:     get_settings, save_settings, store_cert_fingerprint, get_cert_fingerprint, open_devtools
ws_proxy:     ws_connect, ws_send, ws_disconnect, accept_cert_fingerprint
credentials:  save_credential, load_credential, delete_credential
update:       check_client_update, download_and_install_update
ptt:          ptt_start, ptt_stop, ptt_set_key, ptt_get_key, ptt_listen_for_key
livekit:      start_livekit_proxy, stop_livekit_proxy
```
