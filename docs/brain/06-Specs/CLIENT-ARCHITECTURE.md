# Client Architecture: Tauri v2

This document is the comprehensive architecture reference for the
OwnCord Tauri v2 desktop client. It covers every module, data flow,
lifecycle, and subsystem in deep detail.

## Why Tauri v2

See LANGUAGE-REVIEW.md for the full assessment. Summary:
the HTML mockups we already have become the actual UI code.
CSS handles hover effects, conditional visibility, theming,
and animations that required 5-10x more XAML boilerplate.
Tauri v2 uses the OS webview (WebView2 on Windows) so the
install is ~10-15 MB and RAM usage is ~30-50 MB.

---

## Complete Project Layout

```text
Client/tauri-client/
├── src-tauri/                          # Rust backend
│   ├── Cargo.toml                      # Dependencies: tauri, tokio, rustls, ring, etc.
│   ├── Cargo.lock                      # Locked dependency versions
│   ├── tauri.conf.json                 # Window size, title, plugins, CSP, updater config
│   ├── icons/                          # App icons (32x32 through 512x512 + .ico)
│   └── src/
│       ├── main.rs                     # Windows entry point (hides console in release)
│       ├── lib.rs                      # Tauri Builder: plugin registration, command
│       │                               #   handler, managed state, tray setup
│       ├── credentials.rs              # Win Credential Manager (CredWriteW/ReadW/DeleteW)
│       ├── commands.rs                 # Settings store, cert fingerprints, DevTools
│       ├── ws_proxy.rs                 # WSS proxy with TOFU cert pinning
│       ├── livekit_proxy.rs            # TCP-to-TLS tunnel for LiveKit signaling
│       ├── ptt.rs                      # Push-to-talk via GetAsyncKeyState polling
│       ├── tray.rs                     # System tray icon, menu, status submenu
│       ├── hotkeys.rs                  # Global shortcut registration (PTT key)
│       └── update_commands.rs          # Auto-update check + download/install
│
├── src/                                # TypeScript frontend
│   ├── index.html                      # Single HTML entry point (<div id="app">)
│   ├── main.ts                         # Bootstrap, router, service wiring, page lifecycle
│   │
│   ├── styles/
│   │   ├── tokens.css                  # CSS custom properties (colors, spacing, radii)
│   │   ├── base.css                    # Reset, scrollbar, typography, animations
│   │   ├── login.css                   # ConnectPage-specific styles
│   │   ├── app.css                     # MainPage layout + all component styles
│   │   └── theme-neon-glow.css         # Default theme CSS overrides
│   │
│   ├── lib/                            # Core services (no UI, no DOM)
│   │   ├── api.ts                      # REST client (Tauri plugin-http fetch)
│   │   ├── ws.ts                       # WebSocket client (Tauri IPC proxy)
│   │   ├── types.ts                    # Protocol types (WS + REST + permissions)
│   │   ├── store.ts                    # Reactive store factory (immutable, batched)
│   │   ├── dispatcher.ts              # WS message -> store action router
│   │   ├── router.ts                   # In-memory page router (connect | main)
│   │   ├── livekitSession.ts           # LiveKit voice/video session lifecycle
│   │   ├── connectionStats.ts          # WebRTC stats poller (RTT, bitrate, quality)
│   │   ├── rate-limiter.ts             # Sliding-window per-key rate limiter
│   │   ├── permissions.ts              # Bitfield utilities (has/hasAny/hasAll/compute)
│   │   ├── profiles.ts                # Server profile CRUD + persistence
│   │   ├── credentials.ts             # Credential storage wrapper (Tauri IPC)
│   │   ├── disposable.ts              # Component lifecycle cleanup manager
│   │   ├── dom.ts                     # XSS-safe DOM helpers (createElement, setText)
│   │   ├── safe-render.ts             # Error boundary + MountableComponent interface
│   │   ├── logger.ts                  # Structured logger (circular buffer, listeners)
│   │   ├── notifications.ts           # Desktop notifications + taskbar flash + sound
│   │   ├── noise-suppression.ts       # RNNoise WASM TrackProcessor for LiveKit
│   │   ├── ptt.ts                     # Push-to-talk client wiring (Tauri events)
│   │   ├── tenor.ts                   # Tenor GIF API v2 (search + trending)
│   │   ├── themes.ts                  # Theme manager (built-in + custom JSON)
│   │   ├── updater.ts                 # Auto-update check + download/install
│   │   ├── window-state.ts            # Window position/size persistence
│   │   ├── context-menu.ts            # Shared right-click context menu builder
│   │   ├── reconcile.ts               # Keyed DOM list reconciliation (no rebuild)
│   │   ├── icons.ts                   # Lucide SVG icon factory (inline SVG)
│   │   ├── os-motion.ts              # OS reduced-motion preference sync
│   │   └── media-visibility.ts        # GIF auto-pause on viewport exit/blur
│   │
│   ├── stores/                         # Reactive state stores (one per domain)
│   │   ├── auth.store.ts               # Token, user, serverName, motd, isAuthenticated
│   │   ├── channels.store.ts           # Channel Map, activeChannelId, unread counts
│   │   ├── dm.store.ts                 # DM channel list, unread counts, last message
│   │   ├── messages.store.ts           # Per-channel messages, pending sends, hasMore
│   │   ├── members.store.ts            # Member Map, presence, typing indicators
│   │   ├── voice.store.ts              # Voice users, configs, local audio state, joinedAt
│   │   └── ui.store.ts                 # Sidebar mode, modals, theme, collapsed categories
│   │
│   ├── components/                     # UI components (flat directory)
│   │   ├── AdminActions.ts             # Admin moderation controls (kick/ban/role)
│   │   ├── CertMismatchModal.ts        # TLS certificate warning dialog
│   │   ├── ChannelSidebar.ts           # Channel list with categories + voice channels
│   │   ├── ConnectedOverlay.ts         # Post-login connecting/connected splash
│   │   ├── CreateChannelModal.ts       # New channel dialog (name, type, category)
│   │   ├── DeleteChannelModal.ts       # Delete channel confirmation dialog
│   │   ├── DmSidebar.ts               # DM conversation list in sidebar DM mode
│   │   ├── EditChannelModal.ts         # Edit channel dialog (name, topic, slow mode)
│   │   ├── EmojiPicker.ts             # Unicode emoji selection grid
│   │   ├── FileUpload.ts              # File attachment upload (drag + button)
│   │   ├── GifPicker.ts              # Tenor GIF search/trending picker
│   │   ├── InviteManager.ts           # Invite code management (create/list/revoke)
│   │   ├── MemberList.ts             # Right-panel member list (grouped by role/status)
│   │   ├── MessageInput.ts           # Chat input + toolbar (emoji, GIF, file, reply)
│   │   ├── MessageList.ts            # Scrollable message feed (infinite scroll)
│   │   ├── PinnedMessages.ts         # Pinned messages slide-out panel
│   │   ├── QuickSwitcher.ts          # Ctrl+K channel/user search overlay
│   │   ├── QuickSwitchOverlay.ts     # Server quick-switch overlay (door button)
│   │   ├── SearchOverlay.ts          # FTS5 full-text search UI
│   │   ├── ServerBanner.ts           # Reconnecting/server-restart banner
│   │   ├── ServerStrip.ts            # (Legacy) left server icon strip
│   │   ├── SettingsOverlay.ts        # Full settings panel (tabs, close, logout)
│   │   ├── Toast.ts                  # Toast notification system (success/error/info)
│   │   ├── TypingIndicator.ts        # "[user] is typing..." display
│   │   ├── UpdateNotifier.ts         # App update available banner
│   │   ├── UserBar.ts               # Bottom user info bar (avatar, status, settings)
│   │   ├── VideoGrid.ts             # WebRTC video tile grid (camera + screenshare)
│   │   ├── VoiceChannel.ts          # Voice channel user list in sidebar
│   │   ├── VoiceWidget.ts           # Active voice controls widget (mute, deafen, etc.)
│   │   │
│   │   ├── message-list/             # MessageList sub-modules
│   │   │   ├── renderers.ts          # Message content renderers (text, image, link)
│   │   │   ├── content-parser.ts     # @mention, `code`, URL, markdown parsing
│   │   │   ├── formatting.ts         # Timestamp, date header, message grouping
│   │   │   ├── media.ts             # YouTube embed, image lightbox
│   │   │   ├── embeds.ts            # OpenGraph metadata link previews
│   │   │   ├── attachments.ts       # File attachment rendering (image/video/audio)
│   │   │   ├── reactions.ts         # Reaction badge rendering and interaction
│   │   │   └── fenwick.ts           # Fenwick tree for efficient scroll position math
│   │   │
│   │   └── settings/                 # Settings tab components
│   │       ├── AccountTab.ts         # Username, avatar, password, 2FA, sessions
│   │       ├── AppearanceTab.ts      # Theme picker, accent color, font size, compact
│   │       ├── AccessibilityTab.ts   # Reduced motion, OS sync
│   │       ├── AdvancedTab.ts        # Developer/debug options
│   │       ├── KeybindsTab.ts        # PTT key capture, keybind configuration
│   │       ├── LogsTab.ts           # In-memory log viewer (from logger.ts buffer)
│   │       ├── NotificationsTab.ts  # Desktop/sound/flash/suppress toggles
│   │       ├── TextImagesTab.ts     # Text rendering and image display preferences
│   │       ├── VoiceAudioTab.ts     # Input/output device, volume, noise suppression
│   │       └── helpers.ts           # loadPref/savePref, createToggle, theme constants
│   │
│   ├── pages/
│   │   ├── ConnectPage.ts            # Login/register page (server panel + form)
│   │   ├── MainPage.ts              # Main app layout orchestrator
│   │   ├── connect-page/
│   │   │   ├── ServerPanel.ts        # Server profile list with health indicators
│   │   │   └── LoginForm.ts          # Login/register/TOTP form
│   │   └── main-page/                # MainPage sub-controllers
│   │       ├── SidebarArea.ts        # Sidebar DOM + component composition
│   │       ├── ChatArea.ts           # Chat column DOM + overlay wiring
│   │       ├── ChatHeader.ts         # Channel name, hash icon, topic, pin/search
│   │       ├── ChannelController.ts  # Mount/destroy per-channel components
│   │       ├── MessageController.ts  # Message loading, scrollback, optimistic send
│   │       ├── ReactionController.ts # Reaction add/remove with rate limiting
│   │       ├── VideoModeController.ts # Chat/video toggle, tile focus management
│   │       ├── OverlayManagers.ts    # Quick switcher, pinned panel, search, invite
│   │       └── VoiceCallbacks.ts     # Voice join/leave/mute/deafen/camera/screen wiring
│   │
│   └── types/
│       └── jitsi-rnnoise.d.ts        # Type declarations for @jitsi/rnnoise-wasm
│
├── tests/
│   ├── unit/                          # Vitest unit tests (~100+ files)
│   ├── integration/                   # Vitest with mocked WS
│   │   └── stores.test.ts            # Store integration tests
│   ├── e2e/                           # Playwright E2E tests (~35 specs)
│   │   ├── native-fixture.ts          # CDP fixture for native Tauri tests
│   │   └── native/                    # Native E2E (real Tauri exe + WebView2 CDP)
│   │       └── *.spec.ts              # 8 native test specifications
│   └── helpers/
│       ├── fixtures.ts               # Sample protocol payloads
│       ├── mock-ws.ts                # Mock WebSocket class for testing
│       └── test-utils.ts            # DOM helpers, store reset utilities
│
├── vite.config.ts                     # Vite build config (path aliases, source maps)
├── tsconfig.json                      # TypeScript config (strict, path aliases)
├── vitest.config.ts                   # Vitest config (JSDOM env, coverage)
├── playwright.config.ts              # Playwright E2E config (mocked Tauri)
├── playwright.config.native.ts       # Playwright native E2E config (real Tauri + CDP)
└── package.json                       # Dependencies, scripts, metadata
```

---

## Architecture Layers

```text
+===================================================================+
|                         UI Components                             |
|  (HTML + CSS, vanilla TypeScript DOM manipulation)                |
|  Components are factory functions returning { mount, destroy }    |
+===================================================================+
          |                    |                    |
          |  subscribe()      |  actions           |  events
          v                    v                    v
+===================================================================+
|                      Reactive Stores                              |
|  auth | channels | dm | messages | members | voice | ui           |
|  Immutable state. Batched notifications via queueMicrotask.       |
+===================================================================+
          ^                    |
          |  WS events         |  send()
          |  (dispatcher)      |
+===================================================================+
|                       Core Services                               |
|  ws.ts       api.ts       dispatcher.ts    rate-limiter.ts        |
|  livekitSession.ts   notifications.ts   ptt.ts   tenor.ts        |
|  themes.ts   profiles.ts   credentials.ts   connectionStats.ts   |
+===================================================================+
          |                    |
          |  invoke()          |  listen()
          v                    v
+===================================================================+
|                     Tauri IPC Bridge                              |
|  @tauri-apps/api/core (invoke)                                    |
|  @tauri-apps/api/event (listen/emit)                              |
|  @tauri-apps/plugin-http (fetch with danger.acceptInvalidCerts)   |
|  @tauri-apps/plugin-notification, plugin-store, plugin-updater    |
+===================================================================+
          |                    ^
          |  commands           |  events
          v                    |
+===================================================================+
|                      Rust Backend                                 |
|  ws_proxy (WSS + TOFU)   livekit_proxy (TCP-to-TLS tunnel)       |
|  credentials (Win32 DPAPI)   ptt (GetAsyncKeyState polling)       |
|  commands (settings store, cert store, devtools)                  |
|  tray (system tray + status)   hotkeys (global shortcuts)         |
|  update_commands (dynamic server URL updater)                     |
+===================================================================+
```

Data flows DOWN through layers. Events flow UP via subscriptions.
No component directly calls the WebSocket or REST API; they go
through stores and controllers.

---

## Rust Backend: Module-by-Module

### lib.rs -- Application Bootstrap

The Tauri Builder in `lib.rs` is the single wiring point for all
Rust-side functionality:

```text
tauri::Builder::default()
    .plugin(tauri_plugin_store)         // Key-value persistence (settings, certs)
    .plugin(tauri_plugin_global_shortcut) // Global hotkeys (PTT)
    .plugin(tauri_plugin_notification)  // Desktop notifications
    .plugin(tauri_plugin_http)          // HTTP fetch (bypass self-signed cert)
    .plugin(tauri_plugin_opener)        // Open URLs in default browser
    .plugin(tauri_plugin_dialog)        // Native file/folder dialogs
    .plugin(tauri_plugin_fs)            // File system access
    .plugin(tauri_plugin_updater)       // Auto-update framework
    .plugin(tauri_plugin_process)       // App relaunch after update
    .manage(WsState)                    // WebSocket proxy managed state
    .manage(LiveKitProxyState)          // LiveKit proxy managed state
    .invoke_handler([...commands])      // 21 IPC commands registered
    .setup(|app| tray::create_tray())   // System tray initialization
```

**Managed State:**
- `WsState` -- holds `Mutex<Option<mpsc::Sender<String>>>` for the
  active WebSocket sender. JS sends messages via IPC to the sender;
  dropping it disconnects the WebSocket.
- `LiveKitProxyState` -- holds `Mutex<ProxyInner>` with the current
  proxy port, remote host, and shutdown signal.

### ws_proxy.rs -- WebSocket Proxy with TOFU

**Problem:** WebView2 rejects self-signed TLS certificates on WSS
connections. OwnCord is self-hosted and uses self-signed certs.

**Solution:** Route all WebSocket traffic through Rust. JS sends
and receives messages via Tauri IPC events instead of native WebSocket.

**TOFU (Trust On First Use) Certificate Pinning:**
1. First connect to a host: cert SHA-256 fingerprint is computed
   via `ring::digest` and stored in `certs.json` (tauri-plugin-store).
2. Subsequent connects: fingerprint is compared. Match = trusted.
   Mismatch = connection rejected, `cert-tofu` event emitted with
   status `"mismatch"`. Frontend shows CertMismatchModal.
3. User can accept new fingerprint via `accept_cert_fingerprint`
   command, which updates the stored fingerprint.

**IPC Commands:**

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `ws_connect` | `url: String` | `Result<(), String>` | Connect to WSS URL via Rust TLS. Only `wss://` allowed. |
| `ws_send` | `message: String` | `Result<(), String>` | Send text frame through proxy. Bounded channel (256). |
| `ws_disconnect` | -- | `Result<(), String>` | Drop sender, closing the WebSocket. |
| `accept_cert_fingerprint` | `host: String, fingerprint: String` | `Result<(), String>` | Trust a new cert fingerprint (SHA-256 colon-hex). |

**Events Emitted:**

| Event | Payload | When |
|-------|---------|------|
| `ws-message` | `String` (JSON) | Server sends a text frame |
| `ws-state` | `"connecting"` / `"open"` / `"closed"` | Connection state changes |
| `ws-error` | `String` | WebSocket error occurs |
| `cert-tofu` | `{ host, fingerprint, status, message? }` | TOFU fingerprint check result |

**Architecture:**
```text
JS ws.ts ──invoke("ws_connect")──► Rust ws_proxy
                                       │
                           ┌───────────┤
                           │           │
                     TLS handshake  TOFU check
                     (TofuVerifier)  (certs.json)
                           │           │
                           └─────┬─────┘
                                 │
                         tokio::spawn(2 tasks)
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              read_task                 write_task
              server→JS                 JS→server
              (emit "ws-message")       (mpsc::Receiver)
                    │                         │
                    └────────┬────────────────┘
                             │
                        tokio::select!
                     (abort sibling on end)
```

### livekit_proxy.rs -- LiveKit TLS Tunnel

**Problem:** LiveKit JS SDK opens its own WebSocket from WebView2.
WebView2 rejects self-signed certs, so LiveKit signaling fails.

**Solution:** A local TCP listener on `127.0.0.1:0` (OS-assigned port).
LiveKit SDK connects to `ws://127.0.0.1:{port}/livekit/...` (plain,
no TLS issues). The proxy opens a TLS connection to the remote server
(accepting self-signed certs via `InsecureVerifier`) and shovels
bytes bidirectionally.

**Header Rewriting:** The proxy rewrites `Host` and `Origin` headers
so the remote server accepts the connection as if it came directly.

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `start_livekit_proxy` | `remote_host: String` | `Result<u16, String>` | Start proxy, return port. Reuses port for same host. |
| `stop_livekit_proxy` | -- | `Result<(), String>` | Stop the proxy and clear state. |

### credentials.rs -- Windows Credential Manager

Uses `windows-rs` to call Win32 Credential Manager APIs directly.
Credentials are stored as DPAPI-encrypted blobs tied to the Windows
user account -- plaintext never touches disk.

**Blob Format:** JSON `{"username":"...","token":"...","password":"..."}`
The `password` field is only present when the user checks "Remember password".

**Target Name:** `OwnCord/{host}` (e.g., `OwnCord/myserver.com:8443`)

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `save_credential` | `host, username, token, password?` | `Result<(), String>` | Write to Credential Manager |
| `load_credential` | `host` | `Result<Option<CredentialData>, String>` | Read from Credential Manager |
| `delete_credential` | `host` | `Result<(), String>` | Delete (no-op if not found) |

**Security:** The `CredentialData` struct implements custom `Debug`
that redacts `token` and `password` fields to prevent accidental
logging of secrets.

### commands.rs -- Settings & Certificates

**Settings Store** (`settings.json` via tauri-plugin-store):
- Key validation: only allowed prefixes (`owncord:`, `userVolume_`)
  and exact keys (`windowState`) are accepted. Max key length: 128.
- Prevents arbitrary key injection from the frontend.

**Certificate Store** (`certs.json` via tauri-plugin-store):
- Stores SHA-256 fingerprints per host for TOFU validation.
- Fingerprint format validated: 95 chars, colon-separated hex pairs.

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `get_settings` | -- | `Value (JSON object)` | Read all settings as key-value map |
| `save_settings` | `key: String, value: Value` | `Result<(), String>` | Write single setting (validated key) |
| `store_cert_fingerprint` | `host, fingerprint` | `Result<(), String>` | Store cert fingerprint |
| `get_cert_fingerprint` | `host` | `Result<Option<String>, String>` | Read cert fingerprint |
| `open_devtools` | -- | `()` | Open WebView2 DevTools (feature-gated: `devtools` feature, enabled by default) |

### ptt.rs -- Push-to-Talk

Uses `GetAsyncKeyState` from `windows-rs` for non-consuming key
detection. A 20ms polling loop on a background thread checks the
configured virtual key code. The key is NOT consumed -- other
applications and the chat input continue to receive it normally.

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `ptt_start` | -- | `()` | Start polling loop (emits `ptt-state` events) |
| `ptt_stop` | -- | `()` | Stop polling loop |
| `ptt_set_key` | `vk_code: i32` | `()` | Set PTT virtual key code (0 = disabled) |
| `ptt_get_key` | -- | `i32` | Get current PTT key code |
| `ptt_listen_for_key` | -- | `i32` | Wait for any key press (10s timeout), return VK code |

**Key Detection:** Uses atomic `PTT_VKEY` and `PTT_RUNNING` statics.
The polling thread compares `is_key_down()` state on each tick and
emits `ptt-state` (boolean) only on transitions.

**Key Capture:** `ptt_listen_for_key` scans VK codes 1-254
(skipping modifiers 0x10/0x11/0x12/0x5B/0x5C) and waits for a
non-modifier key press. Returns 0 on timeout.

### tray.rs -- System Tray

Creates a system tray icon with a context menu:
- **Show/Hide** -- toggles main window visibility
- **Status** submenu -- Online, Idle, Do Not Disturb, Offline
  (emits `status-change` event to frontend)
- **Quit** -- exits the application

Left-click on the tray icon toggles window visibility.

### hotkeys.rs -- Global Shortcuts

Wraps `tauri-plugin-global-shortcut` for PTT key registration.
Emits `ptt-press` and `ptt-release` events. Currently used as
an alternative PTT mechanism alongside `ptt.rs` polling.

### update_commands.rs -- Auto-Update

**Dynamic Server URL:** Because OwnCord is self-hosted, the update
endpoint varies per user. The updater is built at runtime with the
connected server's URL as the endpoint base.

**Endpoint Pattern:** `{serverUrl}/api/v1/client-update/{target}/{currentVersion}`

**Self-Signed Cert Support:** `danger_accept_invalid_certs(true)` on
the HTTP client. The update artifact itself is verified via Ed25519
signature, so TLS cert validation is not security-critical here.

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `check_client_update` | `server_url: String` | `UpdateCheckResult` | Check for newer version |
| `download_and_install_update` | `server_url: String` | `Result<(), String>` | Download, install, signal frontend to relaunch |

---

## TypeScript Frontend: Bootstrap Flow

The application bootstrap sequence in `main.ts`:

```text
1. Import CSS (tokens → base → login → app → theme-neon-glow)
2. Disable browser context menu      — contextmenu event preventDefault (module-level)
3. Wire F12/Ctrl+Shift+I             — open DevTools via IPC (module-level)
4. Wire external link handler        — open target="_blank" links in default browser (module-level)
5. installGlobalErrorHandlers()      — window error + unhandledrejection
6. applyStoredAppearance()           — font size, compact mode from localStorage
7. restoreTheme()                    — apply saved theme class + accent color
8. initPtt()                         — start Rust-side PTT polling if key configured
9. Create core services:
   - router = createRouter("connect")
   - api = createApiClient()         — with 401 callback → clearAuth()
   - ws = createWsClient()
   - profileManager = createProfileManager()
10. Wire cert mismatch handler       — show CertMismatchModal on TOFU mismatch
11. Subscribe authStore.isAuthenticated:
    - false + on main page → leave voice, disconnect WS, delete cred, navigate("connect")
12. Wire beforeunload                — send voice_leave on window close
13. renderPage("connect")            — initial page render
14. initWindowState()                — restore saved window position/size
```

### Page Lifecycle

The router tracks two pages: `"connect"` and `"main"`. Navigation
triggers `renderPage()`:

```text
renderPage(pageId)
    │
    ├── currentPage?.destroy()       // cleanup previous page
    ├── appEl.textContent = ""       // clear DOM
    │
    ├── if "connect":
    │   ├── createConnectPage(callbacks)
    │   │   ├── createServerPanel()  // server list with health checks
    │   │   └── createLoginForm()    // login/register/TOTP form
    │   ├── safeMount(connectPage, appEl)
    │   ├── profileManager.loadProfiles()
    │   ├── runHealthChecks()        // parallel health pings
    │   └── quick-switch target check (sessionStorage)
    │
    └── if "main":
        ├── createMainPage({ ws, api })
        │   ├── setWsClient(ws)      // voice session gets WS ref
        │   ├── setServerHost()      // for attachment URLs + LiveKit proxy
        │   ├── createServerBanner() // reconnect/restart banner
        │   ├── createSidebarArea()  // sidebar composition
        │   ├── createChatArea()     // chat column composition
        │   ├── createVideoModeController()
        │   ├── createSettingsOverlay()
        │   ├── createQuickSwitcherManager()
        │   ├── createToastContainer()
        │   ├── createMessageController()
        │   ├── createReactionController()
        │   ├── createChannelController()
        │   ├── createUpdateNotifier()
        │   └── subscribe channelsStore.activeChannelId
        └── safeMount(mainPage, appEl)
```

### Post-Authentication Flow

After successful login/register, `wirePostAuth()` orchestrates:

```text
wirePostAuth(host, token, username, password?)
    │
    ├── api.setConfig({ token })
    ├── authStore.setState(token)
    ├── ws.connect({ host, token })
    ├── wireDispatcher(ws)           // attach WS → store listeners
    ├── saveCredential(host, ...)    // persist to Win Credential Manager
    │
    ├── ws.onStateChange → "connected":
    │   ├── createConnectedOverlay(serverName, username, motd)
    │   └── ws.on("ready") → connectedOverlay.markReady()
    │                          → router.navigate("main")
    │
    └── ConnectedOverlay:
        ├── Shows server name + username
        ├── Animated connecting → connected transition
        └── "Enter Server" button or auto-enter after ready
```

---

## Store System

> For the full store API, immutable update patterns, subscription
> patterns, and code examples, see
> [TS-PATTERNS.md -- Section 4: Reactive Store Pattern](TS-PATTERNS.md#4-reactive-store-pattern).

The store factory (`createStore` in `lib/store.ts`) provides
`getState`, `setState`, `subscribe`, `subscribeSelector`, `select`,
and `flush`. State is always immutable. Notifications are batched
via `queueMicrotask`.

### Store Responsibilities

| Store | State Fields | WS Events Handled | Key Actions |
|-------|-------------|-------------------|-------------|
| **auth** | token, user (UserWithRole; includes totp_enabled), serverName, motd, isAuthenticated | `auth_ok`, `auth_error` | setAuth, clearAuth, updateUser |
| **channels** | channels (Map<id, Channel>), activeChannelId | `ready`, `channel_create/update/delete` | setChannels, addChannel, updateChannel, removeChannel, setActiveChannel, incrementUnread, clearUnread |
| **dm** | channels (DmChannel[]) | `dm_channel_open`, `dm_channel_close`, `dm_channels` in ready | setDmChannels, addDmChannel, removeDmChannel, updateDmLastMessage, clearDmUnread |
| **messages** | messagesByChannel (Map<id, Message[]>), pendingSends (Map<corrId, channelId>), loadedChannels (Set), hasMore (Map) | `chat_message`, `chat_edited`, `chat_deleted`, `chat_send_ok`, `reaction_update` | addMessage, setMessages, prependMessages, editMessage, deleteMessage, updateReaction, addPendingSend, confirmSend |
| **members** | members (Map<id, Member>), typingUsers (Map<channelId, Set<userId>>) | `ready`, `member_join/leave/update/ban`, `typing`, `presence` | setMembers, addMember, removeMember, updateMemberRole, updatePresence, setTyping, clearTyping |
| **voice** | currentChannelId, voiceUsers (Map<chId, Map<userId, VoiceUser>>), voiceConfigs (Map), localMuted, localDeafened, localCamera, localScreenshare, joinedAt | `voice_state`, `voice_leave`, `voice_config`, `voice_speakers`, `voice_token` | setVoiceStates, updateVoiceState, removeVoiceUser, joinVoiceChannel, leaveVoiceChannel, setLocalMuted/Deafened/Camera/Screenshare, setSpeakers |
| **ui** | sidebarCollapsed, memberListVisible, settingsOpen, activeModal, theme, connectionStatus, transientError, persistentError, collapsedCategories (Set), sidebarMode, activeDmUserId | `server_restart`, `error` | toggleSidebar, toggleMemberList, openSettings, closeSettings, openModal, closeModal, setTheme, setConnectionStatus, setTransientError, setSidebarMode, loadCollapsedCategories, toggleCategory |

**Message Eviction:** Messages per channel are capped at 500
(`MAX_MESSAGES_PER_CHANNEL`). Oldest messages are evicted on
append; `hasMore` is set to true so infinite scroll can fetch them.

**Typing Auto-Clear:** Typing indicators auto-clear after 5 seconds
via `setTimeout`. All timers are tracked in a `Map<key, timer>` and
cleared on ready (fresh session = stale typing state).

---

## WebSocket Lifecycle

### Connection States

```text
                   ┌──────────────┐
                   │ disconnected │◄──────────────────────────┐
                   └──────┬───────┘                           │
                          │ ws.connect()                      │
                          ▼                                   │
                   ┌──────────────┐                           │
                   │  connecting  │                           │
                   └──────┬───────┘                           │
                          │ Rust "ws-state" = "open"          │
                          ▼                                   │
                ┌──────────────────┐                          │
                │ authenticating   │  sends auth { token,     │
                └──────┬───────────┘    last_seq }            │
                       │                                      │
              ┌────────┤                                      │
              │        │ auth_ok                              │
              │        ▼                                      │
              │  ┌───────────┐                                │
              │  │ connected │◄─── reconnect success          │
              │  └─────┬─────┘                                │
              │        │                                      │
              │        │ "ws-state" = "closed" (unexpected)   │
              │        ▼                                      │
              │  ┌──────────────┐                             │
              │  │ reconnecting │──► exponential backoff      │
              │  └──────┬───────┘    (1s, 2s, 4s, ..., 30s)  │
              │         │                                     │
              │         └── reconnect attempt ──► connecting  │
              │                                               │
              │ auth_error                                    │
              └───────────────────────────────────────────────┘
                  (intentionalClose = true, no reconnect)
```

### Sequence Number Tracking

The client tracks `lastSeq` from every server broadcast. On
reconnect, it sends `last_seq` in the auth payload. The server
replays missed events from a 1000-event ring buffer, or falls
back to a full `ready` dump if too far behind.

`lastSeq` is preserved across automatic reconnects but reset to
0 on intentional disconnect (logout).

### Heartbeat

A 30-second interval sends `{ type: "ping", payload: {} }` to
keep the connection alive. The server sweeps for stale connections
every 30s, kicking clients with no activity for 90s.

### Dispatcher (dispatcher.ts)

`wireDispatcher(ws)` attaches 20+ listeners to the WsClient, routing
each server message type to the appropriate store action(s):

```text
Server Message          Store Actions
────────────────        ─────────────────────────────────────
auth_ok              → setAuth (authStore)
auth_error           → clearAuth, setTransientError
ready                → setChannels, setMembers, setVoiceStates,
                        setActiveChannel (first text), setDmChannels
chat_message         → addMessage, incrementUnread, updateDmLastMessage,
                        notifyIncomingMessage
chat_edited          → editMessage
chat_deleted         → deleteMessage
chat_send_ok         → confirmSend (remove from pending)
reaction_update      → updateReaction
typing               → setTyping (5s auto-clear)
presence             → updatePresence
channel_create       → addChannel
channel_update       → updateChannel
channel_delete       → removeChannel, redirect active channel
member_join          → addMember
member_leave         → removeMember
member_ban           → removeMember
member_update        → updateMemberRole
voice_state          → updateVoiceState, auto-join if current user
voice_leave          → removeVoiceUser, auto-leave if current user
voice_config         → setVoiceConfig
voice_speakers       → setSpeakers
voice_token          → handleVoiceToken (LiveKit session)
dm_channel_open      → addDmChannel
dm_channel_close     → removeDmChannel
server_restart       → setTransientError (warning banner)
error                → setTransientError (RATE_LIMITED/FORBIDDEN)
```

---

## REST API Client (api.ts)

Factory function `createApiClient(config, onUnauthorized)` returns
an object with typed methods for every endpoint.

**Key Design Decisions:**
- Uses `@tauri-apps/plugin-http` fetch (not browser fetch) to
  bypass self-signed cert rejection in WebView2.
- All requests include `danger: { acceptInvalidCerts: true }`.
- 401 responses trigger the `onUnauthorized` callback (auto-logout).
- Shared `doFetch<T>()` internal handles JSON parsing, error extraction,
  and structured logging.

**Endpoint Groups:**

| Group | Methods | Base URL |
|-------|---------|----------|
| Auth | `login`, `register`, `logout`, `verifyTotp` | `/api/v1/auth/*` |
| Users | `getMe`, `updateProfile`, `changePassword`, `enableTotp`, `confirmTotp`, `disableTotp`, `getSessions`, `revokeSession` | `/api/v1/users/me/*` |
| Channels | `getMessages`, `getPins`, `pinMessage`, `unpinMessage` | `/api/v1/channels/*` |
| Search | `search` | `/api/v1/search` |
| Uploads | `uploadFile` (multipart FormData) | `/api/v1/uploads` |
| Invites | `getInvites`, `createInvite`, `revokeInvite` | `/api/v1/invites/*` |
| Emoji | `getEmoji`, `deleteEmoji` | `/api/v1/emoji/*` |
| Sounds | `getSounds`, `deleteSound` | `/api/v1/sounds/*` |
| DMs | `getDmChannels`, `createDm`, `closeDm` | `/api/v1/dms/*` |
| Voice | `getVoiceCredentials` | `/api/v1/voice/credentials` |
| Health | `getHealth` (with custom host + timeout) | `/api/v1/health` |
| Admin: Channels | `adminCreateChannel`, `adminUpdateChannel`, `adminDeleteChannel` | `/admin/api/channels/*` |
| Admin: Members | `adminKickMember`, `adminBanMember`, `adminChangeRole` | `/admin/api/users/*` |

---

## Component System

> For complete component templates, cleanup styles, and code
> examples, see
> [TS-PATTERNS.md -- Section 2: Component Pattern](TS-PATTERNS.md#2-component-pattern)
> and [Section 5: Disposable Pattern](TS-PATTERNS.md#5-disposable-pattern).

Components are factory functions returning `{ mount, destroy }`.
`mount()` appends elements to a container; `destroy()` removes DOM,
unsubscribes listeners, and clears intervals. Two cleanup styles are
used: `AbortController` + manual `unsubs[]` (for complex components)
and `Disposable` (for simpler components with store subscriptions).

**Exceptions to factory pattern:** `LiveKitSession` (class due to
complex async lifecycle), `RateLimiter` and `Disposable` (utility
classes).

### DOM List Reconciliation (reconcile.ts)

For efficient list updates (member list, channel list, etc.):
1. Build map of existing elements by key
2. Walk new items: reuse existing DOM elements, update in place
3. Insert new elements at correct positions
4. Remove stale elements

This preserves hover states, focus, CSS transitions, and scroll
position without a nuke-and-rebuild approach.

---

## Sidebar Architecture

### Unified Sidebar Layout

```text
+----------------------------------+
| SERVER HEADER                    |  Server name, online count, invite
|  [OC] ServerName  [Invite]      |
+----------------------------------+
| DIRECT MESSAGES  (3)  [+]       |  Unread total badge, new DM button
|  ● user1  (2)                   |  Max 3 visible, bubbles to top
|  ● user2                        |  on new message
|  ● user3                        |
|  View all messages (7)          |  Shown when >3 DMs exist
+----------------------------------+
| TEXT CHANNELS                    |
|  ▼ General                      |  Category-grouped, collapsible
|    # general                    |  Unread badge, active highlight
|    # announcements              |
|  ▼ Dev                          |
|    # code-review                |
+----------------------------------+
| VOICE CHANNELS                   |
|    🔊 Voice Chat                |  User avatars in channel
|       🎤 User1  🔇 User2       |
+----------------------------------+
| ▼ MEMBERS (collapsible)         |  Collapses to header-only bar
|  OWNER ── 1                     |  Role-grouped, status dots
|    🟢 AdminUser                 |  Drag-to-resize handle
|  MEMBER ── 3                    |  Scrollable list
|    🟢 User1  🌙 User2          |  Collapsed state persisted
+----------------------------------+
| VOICE WIDGET                     |  Only visible when in voice
|  🔊 Voice Chat  [📡 12ms]      |  Connection quality indicator
|  00:42                          |  Elapsed timer (MM:SS)
|  [🎤] [🎧] [📹] [🖥️] [📞]    |  Mute/deafen/camera/screen/leave
+----------------------------------+
| USER BAR                         |
|  [Avatar] Username              |  Status indicator dot
|  [⚙️ Settings] [🚪 Switch]     |  Settings + quick-switch buttons
+----------------------------------+
```

### Mode Switching

The sidebar has two modes tracked by `uiStore.sidebarMode`:

- **"channels"** -- Full server view (header, DMs preview, channels, voice, members)
- **"dms"** -- Replaces server header with "Back to Server" header,
  hides channel list, shows full DM conversations list

Clicking a DM switches to DM mode. "Back to Server" returns to channel
mode and restores the previously active channel. The "View all messages"
button in the DM preview section also switches to DM mode.

### DM Preview Section

In channel mode, the DM section appears **above** text channels:
- Shows the 3 most recent DM conversations
- DMs with new messages automatically bubble to the top
- Red unread badge on the "DIRECT MESSAGES" header shows total unread count
- "View all messages (N)" link appears when more than 3 DMs exist
- Collapsible via the category header arrow

### Member List

The member list section is collapsible:
- Clicking the MEMBERS header toggles between expanded and collapsed
- Collapsed state shows only the header bar (no wasted space)
- Expanded state is scrollable with a drag-to-resize handle
- Collapsed/expanded state is persisted in `localStorage` (`owncord:member-list-collapsed`)
- Saved height is restored on expand (`owncord:member-list-height`)

### SidebarArea.ts

The `createSidebarArea()` factory composes:
- DM preview section (top 3 DMs with unread badges)
- Channel sidebar or DM sidebar (reactive, based on `sidebarMode`)
- Member list (collapsible, drag-to-resize handle)
- Voice widget (conditional, based on `voiceStore.currentChannelId`)
- User bar (avatar, username, settings, quick-switch)
- Channel modals (create, edit, delete -- mounted on demand)
- Invite manager (slide-out panel)

---

## Chat Area Architecture

### ChatArea.ts

The `createChatArea()` factory composes:
- Chat header (channel name, hash icon, topic, pin/search buttons)
- Message slot (where MessageList is mounted per-channel)
- Typing indicator slot
- Message input slot
- Video grid slot (overlays chat area when cameras are active)
- Pinned messages panel (slide-out)
- Search overlay (FTS5 search UI)

### ChannelController.ts

Manages mounting/destroying per-channel components when the active
channel changes:

```text
mountChannel(channelId, name, type)
    │
    ├── destroyChannel()          // cleanup previous channel's components
    ├── ws.send(channel_focus)    // tell server which channel is focused
    ├── clearUnread(channelId)    // reset unread badge
    │
    ├── Load messages (if not cached):
    │   ├── api.getMessages(channelId)
    │   └── setMessages(channelId, messages, hasMore)
    │
    ├── createMessageList({
    │     messages, userId, onReply, onEdit, onDelete,
    │     onPin, onReaction, onContextMenu, onScrollTop
    │   })
    │   └── mount into messagesSlot
    │
    ├── createTypingIndicator(channelId)
    │   └── mount into typingSlot
    │
    └── createMessageInput({
          channelId, ws, api, limiters, onSend, onUpload,
          onGifSend, onEmojiPick
        })
        └── mount into inputSlot
```

### MessageController.ts

Handles message loading and optimistic send:
- `loadInitialMessages(channelId)` -- fetches from REST, stores in messages store
- `loadOlderMessages(channelId)` -- prepends for infinite scroll
- `sendMessage(channelId, content, replyTo, attachments)` -- via WS with correlation ID

### VideoModeController.ts

Toggles the chat area between text mode and video mode:
- `showChat()` -- shows message list, hides video grid
- `showVideoGrid()` -- shows video grid, hides message list
- `checkVideoMode()` -- checks if any user has camera/screenshare active
- `setFocus(userId)` -- focuses a specific video tile

---

## Voice & Video (Client Side)

### LiveKit Session (livekitSession.ts)

The `LiveKitSession` class is the single stateful class in the
codebase. It manages the full voice/video lifecycle via LiveKit's
`livekit-client` JS SDK.

**Architecture:**
```text
WS "voice_token" event
    │
    ▼
handleVoiceToken(token, url, channelId, directUrl?)
    │
    ├── Start LiveKit TLS proxy (Rust-side, for self-signed certs)
    │   invoke("start_livekit_proxy", { remoteHost })
    │   Returns local port → ws://127.0.0.1:{port}/...
    │
    ├── Create Room with quality presets:
    │   - adaptiveStream, dynacast (disabled for "source" quality)
    │   - audioCaptureDefaults (echo cancel, noise suppress, AGC)
    │   - videoCaptureDefaults (resolution per quality preset)
    │   - publishDefaults (max bitrate per quality preset)
    │
    ├── room.connect(proxyUrl, token)
    │
    ├── Wire Room events:
    │   - TrackSubscribed → attach audio/video, apply per-user volume
    │   - TrackUnsubscribed → detach, cleanup
    │   - Disconnected → auto-reconnect (MAX_RECONNECT_ATTEMPTS = 2)
    │   - ActiveSpeakersChanged → setSpeakers in voice store
    │   - AudioPlaybackStatusChanged → resume audio context
    │   - LocalTrackPublished → re-enforce mute state
    │
    ├── Apply noise suppression (RNNoise WASM) if enabled
    │
    └── Start token refresh timer (4 min, server sends new token)
```

**Stream Quality Presets:**

| Preset | Camera Resolution | Camera Bitrate | Screen Resolution | Screen Bitrate |
|--------|------------------|----------------|-------------------|----------------|
| low | 360p | 600 Kbps | 720p@5fps | 1.5 Mbps |
| medium | 720p | 1.7 Mbps | 1080p@15fps | 3 Mbps |
| high | 1080p | 4 Mbps | 1080p@30fps | 6 Mbps |
| source | 1080p | 8 Mbps | native | 10 Mbps |

**Audio Pipeline:**
```text
rawMicTrack → AudioContext source → AnalyserNode (VAD reads)
                                   → GainNode (volume x vadGate) → Destination → WebRTC
```

When noise suppression is enabled, RNNoise processes the mic track
via LiveKit's `TrackProcessor` API before the audio pipeline.

**Per-User Volume:** Each remote participant's volume is set via
LiveKit's GainNode-backed `participant.setVolume()` (0-2.0 range).
Saved per-user volumes are stored as `userVolume_{userId}` in
the settings store.

**Screenshare Audio:** Managed separately from mic audio via
`HTMLAudioElement` elements (not participant.setVolume). Allows
independent volume control of screenshare audio streams.

### Connection Quality (connectionStats.ts)

A 2-second polling interval collects WebRTC stats from both
publisher and subscriber PeerConnections:

| Metric | Source | Display |
|--------|--------|---------|
| RTT | Subscriber PC candidate-pair stats | Ping text in VoiceWidget |
| Quality | RTT thresholds | Signal bars icon, color-coded |
| outRate/inRate | Bytes delta / time delta | Transport stats pane |
| outPackets/inPackets | Transport stats | Transport stats pane |
| totalUp/totalDown | Cumulative bytes | Session totals |

**Color Coding:** green (<100ms), yellow (100-200ms), red (>200ms)

### Voice Widget (VoiceWidget.ts)

Visible when `voiceStore.currentChannelId !== null`. Shows:
- Channel name + connection quality indicator (clickable for stats pane)
- Elapsed timer (from `voiceStore.joinedAt`, formatted MM:SS / HH:MM:SS)
- Control buttons: mute, deafen, camera, screenshare, leave

Each button sends a WS message (voice_mute, voice_deafen, voice_camera,
voice_screenshare, voice_leave) and updates the local voice store.

### Video Grid (VideoGrid.ts)

Replaces the chat area when cameras/screenshares are active.
- Dynamic tile layout (1x1, 2x1, 2x2, 3x2, etc.)
- Local camera tile with mirror + "You" label
- Remote camera/screenshare tiles with username
- Click-to-focus: enlarges a specific tile
- Screenshare tiles labeled as "Username (Screen)"

---

## DM System (Client Side)

### Data Model

```typescript
interface DmChannel {
  channelId: number;          // Server channel ID (type = "dm")
  recipient: DmUser;          // Other user in the conversation
  lastMessageId: number | null;
  lastMessage: string;        // Preview text
  lastMessageAt: string;      // ISO timestamp
  unreadCount: number;
}
```

### DM Lifecycle

```text
User clicks [+] in DM section
    │
    ├── MemberPicker opens (from MemberList)
    ├── User selects a recipient
    │
    ├── api.createDm(recipientId)
    │   └── Returns { channel_id, recipient, created }
    │
    ├── Server broadcasts dm_channel_open to both users
    │   └── Dispatcher: addDmChannel(channel)
    │
    ├── setActiveChannel(channel_id)
    │   └── ChannelController mounts MessageList for the DM channel
    │
    ├── ChatHeader shows "@ recipientUsername" with live status dot
    │
    └── Messages flow through standard chat_message / chat_send pipeline
        (dispatcher checks isDm flag for unread counting logic)
```

### DM Authorization

DM channels use `IsDMParticipant` checks on the server instead of
role-based permissions. The dispatcher's `chat_message` handler
branches on `isDm` to skip `incrementUnread` on channelsStore (DMs
use dmStore's own unread tracking) and to update the DM last message
preview.

### DM Sidebar (DmSidebar.ts)

Shows when `uiStore.sidebarMode === "dms"`:
- "Back to Server" header
- List of open DM conversations (sorted by last message time)
- Each entry shows avatar, username, last message preview, unread badge
- Close button removes DM from list (api.closeDm)

Auto-reopen: When a message arrives for a closed DM channel, the
server sends `dm_channel_open` which re-adds it to the list.

---

## Theme System

### Built-in Themes

| Theme | Body Class | Description |
|-------|-----------|-------------|
| dark | `theme-dark` | Classic dark mode (Discord-like) |
| neon-glow | `theme-neon-glow` | Cyan-to-purple gradient (default) |
| midnight | `theme-midnight` | Deep blue dark theme |
| light | `theme-light` | Light mode |

### Custom Themes

Custom themes are JSON objects with CSS variable overrides:

```typescript
interface OwnCordTheme {
  name: string;
  author: string;
  version: string;
  colors: Record<string, string>;  // CSS custom property → value
}
```

Custom themes are applied by:
1. Adding `theme-custom` class to `document.body`
2. Setting each CSS variable as inline style on body
3. Validating: properties must be `--` prefixed, values allowlisted
   against `[\w\s#().,%+\-/]+` to prevent CSS injection

### Theme Lifecycle

```text
App startup → restoreTheme()
    ├── applyThemeByName(localStorage["owncord:theme:active"] ?? "neon-glow")
    │   ├── Remove all theme-* classes
    │   ├── Remove all inline -- CSS vars
    │   ├── Add theme-{name} class (built-in) or theme-custom + inline vars
    │   └── Persist to localStorage
    └── Restore accent color from localStorage["owncord:pref:accentColor"]
        └── Set --accent on both documentElement and body
```

### Accent Color Override

Users can override the theme's accent color via the AppearanceTab
color picker. The accent is stored separately and applied after the
theme via inline style specificity, so it wins over the theme's
`--accent` value.

---

## GIF Picker (tenor.ts + GifPicker.ts)

### Tenor API v2 Client

```typescript
searchGifs(query: string, limit = 20): Promise<TenorGif[]>
getTrendingGifs(limit = 20): Promise<TenorGif[]>
```

Uses Google's public anonymous API key (not a secret -- documented
by Google for development use). The key is intentionally committed
to source code.

### GIF Picker Component

- Opened from MessageInput toolbar
- Search input with debounced API calls
- Grid of tinygif thumbnails (lazy-loaded)
- Click sends the full-size GIF URL as message content
- Inline image rendering in `renderers.ts` detects GIF URLs

### Media Visibility (media-visibility.ts)

GIFs have an auto-pause system:
1. GIF plays for 10 seconds after entering viewport
2. Freezes after timeout (shows play button overlay)
3. Freezes immediately on viewport exit or window blur
4. User can click play/pause overlay to control

Freezing works by replacing `src` with a captured still frame
(canvas snapshot), restoring the original `src` on play.

---

## Notifications (notifications.ts)

Triggered by the dispatcher when `chat_message` arrives:

**Skip conditions:**
- Message from current user (own messages)
- Window focused AND message is in active channel
- `@everyone/@here` suppression enabled and message contains them

**Actions (all preference-gated):**

| Action | Preference Key | Default | Implementation |
|--------|---------------|---------|----------------|
| Desktop notification | `desktopNotifications` | true | Tauri plugin-notification, Web API fallback |
| Taskbar flash | `flashTaskbar` | true | `win.requestUserAttention(2)` |
| Notification sound | `notificationSounds` | true | Web Audio API oscillator (800Hz → 600Hz, 200ms) |

---

## Push-to-Talk (ptt.ts)

### Client-Side Wiring

```text
App startup → initPtt()
    ├── Load saved VK code from localStorage
    ├── invoke("ptt_set_key", { vkCode })
    ├── invoke("ptt_start")
    └── listen("ptt-state", (pressed) => {
          if (in voice channel) setMuted(!pressed)
        })
```

When PTT key is pressed: unmute. When released: mute.

### Key Capture UI (KeybindsTab.ts)

1. User clicks "Capture Key" button
2. UI shows "Press any key..." prompt with 10s timeout countdown
3. `captureKeyPress()` calls `invoke("ptt_listen_for_key")` (blocking Rust call)
4. Rust scans all VK codes 1-254 at 20ms intervals
5. Returns the VK code when a non-modifier key is pressed
6. UI displays human-readable name via `vkName(vk)` lookup table

---

## Settings System

### SettingsOverlay.ts

Discord-style centered floating panel with blurred backdrop (8px blur),
rounded corners (12px), and scale animation on open. DOM structure:
- `.settings-overlay` — full-screen fixed background (rgba(0, 0, 0, 0.7))
  with backdrop-filter blur; click outside panel to close
- `.settings-panel` — 900px wide card (max 100vw - 80px), 80vh tall
  (max 720px), containing sidebar + content area + close button
- Sidebar navigation with user profile, tab buttons grouped by category
  (User Settings, App Settings), logout button at bottom
- Content area renders active tab with page title (h1)
- Close button with ESC label and escape key listener

Tab navigation:

| Tab | File | Purpose |
|-----|------|---------|
| Account | `AccountTab.ts` | Username, avatar, password change, TOTP 2FA enrollment/disable, active sessions |
| Appearance | `AppearanceTab.ts` | Theme picker, accent color, font size, compact mode |
| Voice & Audio | `VoiceAudioTab.ts` | Input/output device, volume, echo cancel, noise suppress, AGC, stream quality |
| Keybinds | `KeybindsTab.ts` | Push-to-talk key capture and configuration |
| Notifications | `NotificationsTab.ts` | Desktop/sound/flash toggles, @everyone suppress |
| Text & Images | `TextImagesTab.ts` | Text rendering and image display preferences |
| Accessibility | `AccessibilityTab.ts` | Reduced motion, OS motion preference sync |
| Advanced | `AdvancedTab.ts` | Developer/debug options |
| Logs | `LogsTab.ts` | In-memory log viewer (from logger.ts circular buffer) |

### SettingsOverlayOptions Interface

Callbacks passed to all tab builders from MainPage:

```typescript
interface SettingsOverlayOptions {
  onClose(): void;
  onChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  onUpdateProfile(username: string): Promise<void>;
  onLogout(): void;
  onDeleteAccount(password: string): Promise<void>;
  onStatusChange(status: UserStatus): void;
  onEnableTotp(password: string): Promise<{ qr_uri: string; backup_codes: string[] }>;
  onConfirmTotp(password: string, code: string): Promise<void>;
  onDisableTotp(password: string): Promise<void>;
}
```

### AccountTab TOTP Components

`AccountTab.ts` includes the following TOTP helper functions:

- `buildTotpSection()` — Main 2FA control panel (enabled/disabled view switcher)
- `buildTotpEnrollForm()` — Password + submit form to initiate enrollment
- `buildTotpConfirmArea()` — QR code display, backup code backup, verification code input
- `buildTotpDisableView()` — Password confirmation + disable button for existing 2FA

State updates via `updateUser({ totp_enabled: true/false })` after successful
enrollment or disable operations.

### Preference Persistence

Preferences use `localStorage` with the `owncord:settings:` prefix.
The `loadPref<T>(key, fallback)` and `savePref(key, value)` helpers
provide type-safe access with JSON serialization. Changes dispatch
a `owncord:pref-change` custom event for same-window invalidation.

### Appearance Restore on Startup

`applyStoredAppearance()` runs before first render to apply:
- Font size (CSS `--font-size` variable)
- Compact mode (`.compact-mode` body class)

---

## Noise Suppression (noise-suppression.ts)

### RNNoise WASM Integration

Uses `@jitsi/rnnoise-wasm` compiled to WebAssembly. Implements
LiveKit's `TrackProcessor<Track.Kind.Audio>` interface:

```text
Mic Track → TrackProcessor.init(opts) → processedTrack → WebRTC
```

**Two Processing Strategies:**

1. **AudioWorklet** (preferred, audio thread):
   - Loads `rnnoise-worklet.js` processor module
   - Sends WASM bytes to worklet via postMessage
   - Processes 480-sample frames (10ms at 48kHz) on audio thread

2. **ScriptProcessorNode** (fallback, main thread):
   - Uses deprecated but widely supported API
   - Ring buffer pattern for 480-sample frame alignment
   - Processes in `onaudioprocess` callback

Both strategies: source → processing node → destination → processedTrack

---

## Auto-Update System

### Flow

```text
MainPage mount
    │
    └── createUpdateNotifier({ serverUrl })
        │
        ├── checkForUpdate(serverUrl)
        │   └── invoke("check_client_update", { serverUrl })
        │       └── Rust: build updater with dynamic endpoint
        │           GET {serverUrl}/api/v1/client-update/{target}/{version}
        │
        ├── If available: show banner with version + release notes
        │
        └── User clicks "Update":
            ├── downloadAndInstallUpdate(serverUrl)
            │   └── invoke("download_and_install_update", { serverUrl })
            │       └── Rust: download, verify Ed25519 signature, install
            └── relaunch() via @tauri-apps/plugin-process
```

---

## Server Profile Management (profiles.ts)

### Profile Data Model

```typescript
interface ServerProfile {
  id: string;              // UUID
  name: string;            // Display name
  host: string;            // host:port
  username: string;        // Last used username
  autoConnect: boolean;    // Auto-connect on launch
  rememberPassword: boolean;
  color: string;           // Accent color for profile card
  lastConnected: string | null;  // ISO timestamp
}
```

### Persistence

Profiles are stored in the Tauri settings store under
`owncord:profiles` with schema versioning (envelope pattern):

```json
{
  "schemaVersion": 1,
  "profiles": [...]
}
```

### Health Checks

When the ConnectPage loads, parallel health checks are fired for
each saved server profile. Results show status indicators:
- green: online (<1500ms latency)
- yellow: slow (>1500ms latency)
- red: offline (unreachable / timeout)

Health checks also display the **online user count** from the
`online_users` field in the `/api/v1/health` response.

Health checks **repeat every 15 seconds** while on the ConnectPage
so servers that come back online are detected automatically. The
interval is cleared when navigating away from the ConnectPage.

### Auto-Login

One server profile can be marked as the auto-login target via
`setAutoLogin(id)`. Only one profile can have `autoConnect: true`
at a time — enabling it on one clears all others. Setting auto-login
also forces `rememberPassword: true` so credentials are saved.

On startup, if an auto-login profile exists with saved credentials:
1. Show "Auto-connecting..." overlay with server name and cancel button
2. Load credentials from Windows Credential Manager
3. Call `api.login()` automatically
4. If 2FA required → fall back to TOTP overlay
5. If login fails → show error, revert to normal login form
6. If cancelled → revert to normal login form

Auto-login is skipped when arriving via quick-switch (sessionStorage
flag). The toggle is a lightning bolt icon on each server card in
the ServerPanel.

---

## Quick Server Switch

### Flow

```text
User clicks 🚪 in UserBar
    │
    ├── QuickSwitchOverlay opens
    │   └── Shows favorited server profiles with health indicators
    │
    ├── User clicks a server
    │   ├── sessionStorage.setItem("owncord:quick-switch-target", host)
    │   ├── Leave voice channel (if active)
    │   ├── Disconnect WS
    │   ├── clearAuth()
    │   └── router.navigate("connect")
    │
    └── ConnectPage reads sessionStorage
        ├── Finds matching profile
        ├── Auto-selects server in ServerPanel
        └── Pre-fills login form with saved credentials
```

---

## Logging System (logger.ts)

### Structured Logger

```typescript
const log = createLogger("component-name");
log.debug("message", { key: "value" });
log.info("message", data);
log.warn("message", error);
log.error("message", error);
```

**Features:**
- Component-scoped prefixes: `[2024-01-15T10:30:00.000Z] [INFO] [ws] message`
- Circular buffer: last 500 entries in memory
- Log level filtering: debug < info < warn < error
- Listener API: `addLogListener(fn)` for log forwarding
- Error serialization: `Error.message` and `.stack` are extracted
  since they don't serialize with `JSON.stringify`
- LogsTab in settings reads from `getLogBuffer()` for in-app viewing

---

## Rate Limiting (rate-limiter.ts)

> For implementation details, immutable internal state, and usage
> patterns, see
> [TS-PATTERNS.md -- Section 9: Rate Limiting](TS-PATTERNS.md#9-rate-limiting).

Sliding-window algorithm with per-key tracking. All seven limiters
(chat, typing, presence, reactions, voice, voiceVideo, soundboard)
are bundled as `RateLimiterSet` and shared across the MainPage.
Limits match PROTOCOL.md.

---

## Permission System (permissions.ts)

Bitfield utilities wrapping the `Permission` enum from `types.ts`:

```typescript
hasPermission(userPerms, Permission.SEND_MESSAGES)     // single check
hasAnyPermission(userPerms, Permission.KICK, Permission.BAN)  // OR
hasAllPermissions(userPerms, Permission.KICK, Permission.BAN) // AND
computeEffective(basePerms, allow, deny)  // channel overrides
isAdministrator(userPerms)                // shorthand
```

ADMINISTRATOR bit (`0x40000000`) bypasses all checks. Channel
overrides: deny bits removed first, then allow bits added (allow
takes precedence -- matches server semantics).

---

## Window State Persistence (window-state.ts)

Saves window position, size, and maximized state to the Tauri
settings store (`windowState` key). Restores on startup.

Debounced save (500ms) on window move/resize events to avoid
excessive writes during drag operations.

---

## Security Considerations

### XSS Prevention

- `dom.ts` helpers enforce `textContent` (never `innerHTML`) for
  user content
- `escapeHtml()` available for building safe HTML strings
- `content-parser.ts` sanitizes mentions, code blocks, and URLs
- Custom theme CSS variables are validated against an allowlist
  regex to prevent CSS injection

### Certificate Security

- TOFU pinning on all WebSocket connections (ws_proxy.rs)
- CertMismatchModal warns users on fingerprint changes
- LiveKit proxy uses InsecureVerifier (documented limitation --
  no TOFU for LiveKit signaling)

### Credential Security

- Windows Credential Manager stores credentials with DPAPI
  (encrypted at rest, tied to Windows user account)
- `CredentialData.Debug` redacts token and password in logs
- Token is never included in API client's `getConfig()` return

### Input Validation

- Settings store validates key prefixes and exact keys
- Certificate fingerprints validated as SHA-256 colon-hex format
- Rate limiters enforce protocol-mandated limits client-side

---

## Data Flow Diagrams

### Message Send Flow

```text
User types in MessageInput → presses Enter
    │
    ├── RateLimiter.tryConsume("chat")
    │   └── false → show "slow down" toast, abort
    │
    ├── ws.send({
    │     type: "chat_send",
    │     payload: { channel_id, content, reply_to, attachments }
    │   })
    │   └── Returns correlationId (UUID)
    │
    ├── addPendingSend(correlationId, channelId)
    │
    ├── Server broadcasts chat_message to all clients
    │   └── Dispatcher: addMessage → messagesStore
    │       └── MessageList re-renders (subscribed)
    │
    └── Server sends chat_send_ok to sender
        └── Dispatcher: confirmSend(correlationId)
            └── Remove from pendingSends map
```

### Voice Join Flow

```text
User clicks voice channel in sidebar
    │
    ├── ws.send({ type: "voice_join", payload: { channel_id } })
    │
    ├── Server validates permissions, adds user to voice state
    │
    ├── Server broadcasts voice_state to all clients
    │   └── Dispatcher: updateVoiceState, joinVoiceChannel
    │       └── VoiceWidget appears in sidebar
    │
    ├── Server sends voice_token to joining user
    │   └── Dispatcher: handleVoiceToken(token, url, channelId)
    │       │
    │       ├── Start LiveKit TLS proxy (Rust-side)
    │       │   invoke("start_livekit_proxy", { remoteHost })
    │       │
    │       ├── Create LiveKit Room with quality presets
    │       ├── room.connect(ws://127.0.0.1:{port}/..., token)
    │       ├── Publish local microphone track
    │       ├── Apply noise suppression (if enabled)
    │       └── Start token refresh timer (4 min)
    │
    └── Room events:
        ├── TrackSubscribed → remote audio attached, volume applied
        ├── ActiveSpeakersChanged → setSpeakers in voice store
        └── Disconnected → auto-reconnect (max 2 attempts)
```

### Channel Switch Flow

```text
User clicks channel in sidebar
    │
    ├── setActiveChannel(channelId)
    │   └── channelsStore: update activeChannelId, clear unread
    │
    ├── channelsStore.subscribeSelector fires
    │   └── ChannelController.mountChannel(id, name, type)
    │       │
    │       ├── destroyChannel()  // cleanup previous
    │       ├── ws.send({ type: "channel_focus", payload: { channel_id } })
    │       │
    │       ├── if (!isChannelLoaded(id)):
    │       │   ├── api.getMessages(id, { limit: 50 })
    │       │   └── setMessages(id, messages, hasMore)
    │       │
    │       ├── createMessageList(...)  → mount into messagesSlot
    │       ├── createTypingIndicator(id) → mount into typingSlot
    │       └── createMessageInput(...)   → mount into inputSlot
    │
    └── ChatHeader updates: channel name, hash icon, topic
```

---

## CSS Strategy

All CSS originates from the HTML mockups
(`ui-mockup.html`, `login-mockup.html`):

1. **tokens.css** -- `:root` CSS custom properties (colors, spacing, radii)
2. **base.css** -- Reset, scrollbar, typography, keyframe animations
3. **login.css** -- ConnectPage-specific layout and styles
4. **app.css** -- MainPage layout and ALL component styles
5. **theme-neon-glow.css** -- Default theme CSS variable overrides

**No CSS-in-JS.** Plain CSS files imported in `main.ts`. Components
reference class names from `app.css` -- the mockup CSS IS the
production CSS. Theme-specific overrides use body class selectors
(`.theme-neon-glow { --accent: #00c8ff; }`).

**Compact Mode:** `.compact-mode` on body reduces avatar sizes,
spacing, and font sizes via CSS overrides.

---

## Testing Infrastructure

### Unit Tests (Vitest)

~100+ test files in `tests/unit/`. JSDOM environment.
Mock patterns:
- `mock-ws.ts` -- Mock WebSocket class
- `test-utils.ts` -- DOM helpers, store reset utilities
- `fixtures.ts` -- Sample protocol payloads

### Integration Tests (Vitest)

`tests/integration/stores.test.ts` -- Tests store interactions
with mocked WebSocket messages flowing through the dispatcher.

### E2E Tests (Playwright)

~35 specs in `tests/e2e/`. Two configurations:

1. **Mocked Tauri** (`playwright.config.ts`) -- Tests run in browser
   with mocked Tauri APIs. Fast, no real server needed.

2. **Native** (`playwright.config.native.ts`) -- Tests run against
   a real Tauri executable via WebView2 CDP (Chrome DevTools Protocol).
   Fixture: `native-fixture.ts`. 8 native specs in `tests/e2e/native/`.
   60s login timeout due to server rate limiting.

### Coverage Target

80%+ line coverage (TDD: RED -> GREEN -> IMPROVE).

---

## Key Design Decisions

1. **No framework**: Vanilla TS + DOM. The mockup HTML/CSS
   is the UI. Adding React/Vue/Svelte would require
   rewriting the mockup into components with framework
   syntax. Vanilla TS lets us copy CSS directly.

2. **Stores over ViewModel**: Seven focused stores replace
   the monolithic ViewModel pattern. Each store handles one
   domain. No cross-store dependencies in store files
   (the dispatcher is the only cross-store coordinator).

3. **CSS from mockups**: The mockup CSS IS the production
   CSS. No design system rebuild. Just extract and organize.

4. **Tauri plugins over custom Rust**: Use official plugins
   (notification, global-shortcut, store, dialog, fs,
   updater, http, opener, process) before writing custom
   Rust code. Custom Rust only where plugins can't help:
   credentials (Win32 DPAPI), WS proxy (TOFU), PTT
   (GetAsyncKeyState), LiveKit proxy (TLS tunnel).

5. **LiveKit for voice/video**: Voice and video use
   LiveKit (SFU) via `livekit-client` JS SDK. The server
   runs LiveKit as a companion process alongside
   `chatserver.exe`. Client connects via `livekitSession.ts`
   using a JWT token from `voice_token` WS message.

6. **Factory functions over classes**: All components and
   services are factory functions returning plain objects.
   Exception: `LiveKitSession` (class due to complex async
   lifecycle), `RateLimiter` (class for encapsulation),
   `Disposable` (class for lifecycle management).

7. **Immutable state everywhere**: All store state updates
   return new objects. Maps and Sets are replaced on every
   update, never mutated in place. This matches the
   subscription system's shallow equality comparison.
