# ChatServer — Self-Hosted Windows Chat Platform

> **Note:** Most Phase 1-6 tasks are complete as of v1.2.0. See
> [[02-Tasks/Done|Done]] for the detailed completion list and
> [[00-Overview/Changelog|Changelog]] for version history.

Native Windows desktop client + self-hosted server.
Two executables: `chatserver.exe` (server) and
`OwnCord.exe` (Tauri v2 client). Server operator runs
the server, friends install the client.

## Tech Stack

### Server (`chatserver.exe`)

- **Go** — Single exe, no dependencies. Embeds admin web UI via `go embed`.
- **SQLite** — Single `.db` file. WAL mode. Zero config.
- **LiveKit** — Voice/video media server. Runs as a companion
  process alongside `chatserver.exe`. Token-based auth.
- **Admin panel** — Web-based, served at `/admin`.
  Browser access, not part of the client.

### Client (`OwnCord.exe`)

**Tauri v2** (Rust backend + TypeScript/HTML/CSS frontend).
See [[07-Archive/LANGUAGE-REVIEW|LANGUAGE-REVIEW]] for the evaluation that led to this
choice, and CLIENT-ARCHITECTURE.md for the full design.

- Tauri v2 desktop app using system WebView2 (NOT Electron)
- ~10-15 MB install size, ~30-50 MB RAM idle
- TypeScript frontend with CSS from HTML mockups
- WebSocket client for real-time chat (browser `WebSocket` API)
- LiveKit for voice/video (LiveKit JS SDK in webview)
- Global keyboard hooks via `tauri-plugin-global-shortcut`
- System tray via Tauri's built-in tray support
- Windows toast notifications via `tauri-plugin-notification`
- Windows Credential Manager via `windows-rs` Rust crate
- NSIS installer via Tauri bundler

## Architecture

```text
SERVER (chatserver.exe) — runs on the host machine
├── REST API (Go net/http)
├── WebSocket Hub (real-time messages, presence, typing)
├── LiveKit Companion Process (voice/video media)
├── SQLite Database (data/chatserver.db)
├── File Storage (data/uploads/)
├── Admin Web UI (embedded, browser-based, /admin)
└── config.yaml

CLIENT (OwnCord.exe) — installed by each friend
├── Native Windows UI
├── WebSocket Client (chat connection)
├── LiveKit Client (voice/video via livekitSession.ts)
├── Audio Engine (device management, noise suppression)
├── Local Settings (connection profiles, keybinds, audio config)
└── System Tray Integration
```

### How It Works

1. Server operator runs `chatserver.exe` on their PC/home server
2. Friends download and install `OwnCord.exe`
3. Client connects to the server via IP/domain + port
4. All chat, voice, video, and file transfers go through the server
5. Admin manages the server through a browser at `https://server-ip:port/admin`

---

## Phase 1: Protocol & Server Core (2–3 weeks)

- [x] Define client-server protocol over WebSocket
  (JSON messages with type/payload structure)
- [x] Message types: auth, chat, typing, presence,
  channel_update, voice_signal, file_transfer
- [x] Server: Go project with `go embed` for admin
  panel static files only
- [x] SQLite setup with migrations on startup (users,
  channels, messages, sessions, roles, invites)
- [x] config.yaml generation on first run (port, name,
  max upload size, voice quality, TLS mode)
- [ ] Windows Firewall handling on first launch
- [ ] Optional: register as Windows Service for headless operation

## Phase 2: Auth & Security (2–3 weeks)

- [x] Invite-only registration — server generates
  invite codes, client has "Redeem Invite" flow
- [x] bcrypt (cost 12+) passwords, server-side session tokens (256-bit random)
- [x] Client stores auth token securely via Windows Credential Manager / DPAPI
- [x] Login rate limiting: 5 attempts/min/IP, lockout after 10 failures (enhanced with brute-force lockout)
- [ ] Optional TOTP 2FA — database schema ready (`totp_secret` column) but API endpoints
  not yet exposed. Endpoint stubs planned for future release.
- [x] Roles: Owner, Admin, Moderator, Member + custom roles with bitfield permissions
- [x] Per-channel permission overrides, enforced server-side on every action (allow-wins semantics)
- [x] TLS modes: self-signed (default), Let's Encrypt,
  manual cert, off (Tailscale)
- [x] Client: certificate pinning or trust-on-first-use (TOFU) for self-signed certs

## Phase 3: Client App — Core UI (3–4 weeks)

- [x] Connection dialog: server address, port, login/register, invite code entry
- [x] Save server profiles (connect to multiple
  servers like TeamSpeak)
- [x] Main window layout: server list → channel list → message area → member list
- [x] Channel tree view with categories, text channels, voice channels
- [x] Message rendering: markdown, code blocks, timestamps, avatars, replies, reactions
- [x] Message input: multi-line, markdown preview, emoji picker, file drag-and-drop
- [x] Unread indicators, @mention badges per channel
- [x] System tray: minimize to tray, notification popups, badge count
- [x] Keyboard shortcuts: Ctrl+K quick switcher,
  Escape to close panels, customizable PTT key
- [x] Settings: account, appearance (light/dark),
  notifications, audio devices, keybinds

## Phase 4: Real-Time Chat Features (2–3 weeks)

- [x] WebSocket client with auto-reconnect, exponential
  backoff, message replay on reconnect
- [x] Send/receive messages in real-time, append to scrollback
- [x] Message history: paginated from server on channel switch, scroll-to-load-more
- [x] Threads, replies (inline preview), reactions (emoji), edit, delete
- [x] Typing indicators ("X is typing..." below input)
- [x] Online/offline/idle/DnD presence with status icons in member list
- [x] File uploads: drag-and-drop or clipboard paste,
  progress bar, inline image previews
- [x] Client-side file validation before upload (size check, warn on large files)
- [x] Search: query server FTS5 endpoint, display results with jump-to-message
- [x] Windows toast notifications with action buttons (reply, mark read)
- [x] Notification sounds (configurable, per-channel mute/override)

## Phase 5: Voice & Video (3–5 weeks)

- [x] LiveKit integration in native client for voice/video
  (client connects to LiveKit directly using token from server)
- [x] Audio device selection: input/output dropdowns in settings, live preview
- [x] Voice channels: click to join/leave, show connected users with speaking indicators
- [x] Voice controls: mute (button + keybind), deafen, per-user volume sliders
- [x] Push-to-talk: configurable global hotkey that works in fullscreen games
- [x] Voice activity detection with configurable sensitivity
- [x] Noise suppression (RNNoise or equivalent, bundled with client)
- [x] Server-side: LiveKit companion process with token-based auth
  and webhook sync for voice state updates
- [x] Voice quality: low (32kbps) / medium (64kbps) / high (128kbps Opus)
- [ ] Screen sharing via LiveKit screen share track
- [x] Video calls: camera capture, displayed in voice channel panel

## Phase 6: Admin Panel — Web-Based (1–2 weeks)

- [x] Served by server at `/admin`, browser-only access
- [x] Auth: admin credentials, session-based
- [x] Dashboard: connected users, message count, disk usage, CPU/RAM, uptime
- [x] User management: list all, edit roles, ban/unban, reset password, force disconnect
- [x] Channel management: create, rename, reorder, set permissions, archive
- [ ] Invite management: generate, view active, set expiry/use limit, revoke
- [x] Server settings: name, icon, MOTD, max upload size, voice quality, TLS config
- [x] Moderation: kick, ban, temp ban, slow mode, mute, word filter, audit log
- [x] Backup: trigger manual backup, configure
  schedule, view/restore from admin panel
- [x] Built with simple HTML/CSS/JS embedded in the server binary

## Phase 7: Distribution & Updates (1–2 weeks)

- [x] **Server:** GitHub Actions builds
  `chatserver.exe` (amd64), SHA256, GitHub Release
- [x] **Client:** Tauri bundler (NSIS) installer —
  Program Files, Start Menu, auto-start, protocol
  handler for `chatserver://` invite links
- [ ] Client auto-update: check GitHub releases on
  launch, prompt to download + install
- [x] Server update: admin panel shows available update, one-click download + restart
- [ ] Docs: Quick Start, Port Forwarding, Tailscale,
  Client install guide
- [ ] Security hardening checklist for server operators
- [ ] SECURITY.md, README.md, CONTRIBUTING.md

---

## Windows-Specific Details

### Client (Tauri v2)

- **Installer:** Tauri bundler (NSIS, ~10-15 MB).
  Registers `chatserver://` protocol handler.
- **Auto-start:** Registry key
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **Credentials:** Auth tokens stored in Windows
  Credential Manager via `windows-rs` Rust crate.
- **Push-to-talk:** Global hotkey via
  `tauri-plugin-global-shortcut`.
- **Audio:** LiveKit SDK via `livekitSession.ts`.
- **Screen capture:** LiveKit screen share track.
- **Notifications:** `tauri-plugin-notification`
  (Windows toast).
- **Tray:** Tauri built-in system tray with badge.
- See CLIENT-ARCHITECTURE.md for full design.

### Server

- **Firewall:** Prompt on first run. Installer can pre-register firewall rule.
- **SmartScreen:** Unsigned exe shows warning. Code signing cert resolves this.
- **Data path:** `data/` next to exe. Installer version uses `%APPDATA%/ChatServer/`.
- **Logs:** `data/logs/` with daily rotation, viewable from admin panel.
- **Service mode:** `chatserver.exe --service install` to register as Windows Service.

## Security Priorities

**Critical:** Invite-only registration, bcrypt auth,
TLS (self-signed minimum), file upload validation
(magic bytes, block executables), input sanitization
server-side, credential storage via DPAPI, backups.

**High:** Rate limiting, TOTP 2FA, role permissions,
WebSocket auth, LiveKit token auth, cert pinning/TOFU,
update integrity (SHA256).

## Server Libraries (Go)

| Purpose | Library |
| --- | --- |
| HTTP/routing | `net/http` + `chi` |
| WebSocket | `nhooyr.io/websocket` |
| LiveKit | `livekit/server-sdk-go` (token generation, webhook validation) |
| SQLite | `modernc.org/sqlite` (pure Go) |
| Auth | `golang.org/x/crypto/bcrypt` |
| Sanitization | `bluemonday` |
| TLS | `golang.org/x/crypto/acme/autocert` |
| Config | `koanf` |
| Logging | `log/slog` |
| Versioning | `golang.org/x/mod/semver` |
| UUID | `google/uuid` |

> **Removed references:**
> - ~~`getlantern/systray`~~ — The server has no system tray.
>   System tray is in the Tauri client (Rust-side).
> - ~~`pquerna/otp`~~ — TOTP 2FA is not yet implemented
>   (T-023 in backlog). Not in `go.mod`.
