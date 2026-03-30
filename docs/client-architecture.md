# Client Architecture: Tauri v2

Comprehensive architecture reference for the OwnCord Tauri v2 desktop client. Covers project structure, data flow, component system, and subsystems.

## Why Tauri v2

Tauri v2 uses the OS webview (WebView2 on Windows) so the install is ~10-15 MB and RAM usage is ~30-50 MB. The HTML/CSS mockups become the actual UI code, with CSS handling hover effects, conditional visibility, theming, and animations.

---

## Project Layout

```text
Client/tauri-client/
├── src-tauri/                          # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json                 # Window size, title, plugins, CSP, updater
│   └── src/
│       ├── main.rs                     # Windows entry point
│       ├── lib.rs                      # Tauri Builder: plugins, commands, state
│       ├── credentials.rs              # Win Credential Manager (DPAPI)
│       ├── commands.rs                 # Settings store, cert fingerprints, DevTools
│       ├── ws_proxy.rs                 # WSS proxy with TOFU cert pinning
│       ├── livekit_proxy.rs            # TCP-to-TLS tunnel for LiveKit signaling
│       ├── ptt.rs                      # Push-to-talk via GetAsyncKeyState
│       ├── tray.rs                     # System tray icon and menu
│       ├── hotkeys.rs                  # Global shortcut registration
│       └── update_commands.rs          # Auto-update check + install
│
├── src/                                # TypeScript frontend
│   ├── index.html                      # Single HTML entry point
│   ├── main.ts                         # Bootstrap, router, service wiring
│   │
│   ├── styles/
│   │   ├── tokens.css                  # CSS custom properties
│   │   ├── base.css                    # Reset, scrollbar, typography
│   │   ├── login.css                   # ConnectPage styles
│   │   ├── app.css                     # MainPage + component styles
│   │   └── theme-neon-glow.css         # Default theme overrides
│   │
│   ├── lib/                            # Core services (no UI, no DOM)
│   │   ├── api.ts                      # REST client (Tauri plugin-http)
│   │   ├── ws.ts                       # WebSocket client (Tauri IPC proxy)
│   │   ├── types.ts                    # Protocol types (WS + REST + permissions)
│   │   ├── store.ts                    # Reactive store factory
│   │   ├── dispatcher.ts              # WS message -> store action router
│   │   ├── router.ts                   # In-memory page router
│   │   ├── livekitSession.ts           # LiveKit voice/video session
│   │   ├── connectionStats.ts          # WebRTC stats poller
│   │   ├── rate-limiter.ts             # Sliding-window rate limiter
│   │   ├── permissions.ts              # Bitfield utilities
│   │   ├── profiles.ts                # Server profile CRUD
│   │   ├── credentials.ts             # Credential storage (Tauri IPC)
│   │   ├── disposable.ts              # Component lifecycle cleanup
│   │   ├── dom.ts                     # XSS-safe DOM helpers
│   │   ├── safe-render.ts             # Error boundary
│   │   ├── logger.ts                  # Structured logger
│   │   ├── notifications.ts           # Desktop notifications
│   │   ├── tenor.ts                   # Tenor GIF API v2
│   │   ├── themes.ts                  # Theme manager
│   │   ├── updater.ts                 # Auto-update
│   │   ├── reconcile.ts               # Keyed DOM list reconciliation
│   │   ├── icons.ts                   # Lucide SVG icon factory
│   │   └── ...
│   │
│   ├── stores/                         # Reactive state stores
│   │   ├── auth.store.ts
│   │   ├── channels.store.ts
│   │   ├── dm.store.ts
│   │   ├── messages.store.ts
│   │   ├── members.store.ts
│   │   ├── voice.store.ts
│   │   └── ui.store.ts
│   │
│   ├── components/                     # UI components
│   │   ├── MessageList.ts, MessageInput.ts, ...
│   │   ├── message-list/              # MessageList sub-modules
│   │   └── settings/                  # Settings tab components
│   │
│   └── pages/
│       ├── ConnectPage.ts              # Login/register page
│       ├── MainPage.ts                # Main app layout
│       └── main-page/                 # MainPage sub-controllers
│           ├── SidebarArea.ts
│           ├── ChatArea.ts
│           ├── ChannelController.ts
│           ├── MessageController.ts
│           └── ...
│
├── tests/
│   ├── unit/                          # Vitest unit tests
│   ├── integration/                   # Vitest with mocked WS
│   └── e2e/                           # Playwright E2E tests
│
├── vite.config.ts
├── tsconfig.json
├── vitest.config.ts
└── playwright.config.ts
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
+===================================================================+
|                       Core Services                               |
|  ws.ts       api.ts       dispatcher.ts    rate-limiter.ts        |
|  livekitSession.ts   notifications.ts   ptt.ts   tenor.ts        |
+===================================================================+
          |                    |
          |  invoke()          |  listen()
          v                    v
+===================================================================+
|                     Tauri IPC Bridge                              |
+===================================================================+
          |                    ^
          v                    |
+===================================================================+
|                      Rust Backend                                 |
|  ws_proxy (WSS + TOFU)   livekit_proxy (TCP-to-TLS tunnel)       |
|  credentials (Win32 DPAPI)   ptt (GetAsyncKeyState polling)       |
|  commands (settings store)   tray   hotkeys   update_commands     |
+===================================================================+
```

Data flows DOWN through layers. Events flow UP via subscriptions. No component directly calls the WebSocket or REST API; they go through stores and controllers.

---

## Rust Backend Modules

### ws_proxy.rs -- WebSocket Proxy with TOFU

WebView2 rejects self-signed TLS certificates. All WebSocket traffic routes through Rust. The Rust proxy implements TOFU certificate pinning -- on first connect, the cert fingerprint is stored; on subsequent connects, it is verified.

### livekit_proxy.rs -- LiveKit TLS Tunnel

A local TCP listener proxies LiveKit SDK connections through TLS to the remote server, avoiding self-signed cert issues.

### credentials.rs -- Windows Credential Manager

Uses Win32 Credential Manager APIs. Credentials are stored as DPAPI-encrypted blobs tied to the Windows user account.

### ptt.rs -- Push-to-Talk

Uses `GetAsyncKeyState` for non-consuming key detection. 20ms polling loop on a background thread.

### tray.rs -- System Tray

System tray icon with Show/Hide, Status submenu, and Quit.

### update_commands.rs -- Auto-Update

Dynamic server URL updater endpoint. Update artifacts are verified via Ed25519 signature.

---

## Store System

The store factory (`createStore`) provides `getState`, `setState`, `subscribe`, `subscribeSelector`, `select`, and `flush`. State is always immutable. Notifications are batched via `queueMicrotask`.

### Store Responsibilities

| Store | Key State | WS Events Handled |
|-------|-----------|-------------------|
| **auth** | token, user, serverName, motd, isAuthenticated | `auth_ok`, `auth_error` |
| **channels** | channels (Map), activeChannelId | `ready`, `channel_create/update/delete` |
| **dm** | DM channel list | `dm_channel_open`, `dm_channel_close` |
| **messages** | per-channel messages, pending sends, hasMore | `chat_message`, `chat_edited`, `chat_deleted`, `chat_send_ok`, `reaction_update` |
| **members** | member Map, typing indicators | `ready`, `member_join/leave/update/ban`, `typing`, `presence` |
| **voice** | currentChannelId, voice users, local audio state | `voice_state`, `voice_leave`, `voice_config`, `voice_token` |
| **ui** | sidebar mode, modals, theme, connection status | `server_restart`, `error` |

Messages per channel are capped at 500. Typing indicators auto-clear after 5 seconds.

---

## Component System

Components are factory functions returning `{ mount, destroy }`. `mount()` appends elements to a container; `destroy()` removes DOM, unsubscribes listeners, and clears intervals.

### DOM List Reconciliation

For efficient list updates (member list, channel list), a keyed reconciliation algorithm reuses existing DOM elements, updates in place, and removes stale elements -- preserving hover states, focus, and scroll position.

---

## Sidebar Architecture

```text
+----------------------------------+
| SERVER HEADER                    |
+----------------------------------+
| DIRECT MESSAGES  (3)  [+]       |
|  Top 3 DMs with unread badges   |
|  View all messages link          |
+----------------------------------+
| TEXT CHANNELS                    |
|  Category-grouped, collapsible   |
+----------------------------------+
| VOICE CHANNELS                   |
|  User avatars in channel         |
+----------------------------------+
| MEMBERS (collapsible)            |
|  Role-grouped, drag-to-resize    |
+----------------------------------+
| VOICE WIDGET                     |
|  Mute/deafen/camera/screen/leave |
+----------------------------------+
| USER BAR                         |
|  Settings + quick-switch buttons |
+----------------------------------+
```

Two sidebar modes: **"channels"** (full server view) and **"dms"** (full DM conversations list).

---

## Chat Area Architecture

The chat area composes: chat header, message list, typing indicator, message input, video grid (overlays when cameras are active), pinned messages panel, and search overlay.

The `ChannelController` manages mounting/destroying per-channel components when the active channel changes.

---

## Voice and Video (Client Side)

### LiveKit Session

The `LiveKitSession` class manages the full voice/video lifecycle via LiveKit's `livekit-client` JS SDK.

**Stream Quality Presets:**

| Preset | Camera Resolution | Camera Bitrate | Screen Resolution | Screen Bitrate |
|--------|------------------|----------------|-------------------|----------------|
| low | 360p | 600 Kbps | 720p@5fps | 1.5 Mbps |
| medium | 720p | 1.7 Mbps | 1080p@15fps | 3 Mbps |
| high | 1080p | 4 Mbps | 1080p@30fps | 6 Mbps |
| source | 1080p | 8 Mbps | native | 10 Mbps |

### Connection Quality

A 2-second polling interval collects WebRTC stats from both publisher and subscriber PeerConnections. Quality is color-coded: green (<100ms), yellow (100-200ms), red (>200ms).

---

## REST API Client

Uses `@tauri-apps/plugin-http` fetch (not browser fetch) to bypass self-signed cert rejection. All requests include `danger: { acceptInvalidCerts: true }` for server URLs only. Third-party fetches use standard cert validation.

---

## Dispatcher

`wireDispatcher(ws)` attaches listeners to the WsClient, routing each server message type to the appropriate store actions. Key mappings:

- `ready` -> sets channels, members, voice states, DM channels
- `chat_message` -> adds message, increments unread, triggers notifications
- `voice_token` -> starts LiveKit session
- `presence` -> updates member status
- `server_restart` -> shows warning banner

See [protocol.md](protocol.md) for complete message type reference.
