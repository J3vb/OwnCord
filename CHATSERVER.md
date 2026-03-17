# ChatServer — Self-Hosted Windows Chat Platform

Native Windows desktop client + self-hosted server.
Two executables: `chatserver.exe` (server) and
`OwnCord.exe` (Tauri v2 client). Server operator runs
the server, friends install the client.

## Tech Stack

### Server (`chatserver.exe`)

- **Go** — Single exe, no dependencies. Embeds admin web UI via `go embed`.
- **SQLite** — Single `.db` file. WAL mode. Zero config.
- **Pion** — Pure Go WebRTC. Voice/video/TURN built into the exe.
- **Admin panel** — Web-based, served at `/admin`.
  Browser access, not part of the client.

### Client (`OwnCord.exe`)

**Tauri v2** (Rust backend + TypeScript/HTML/CSS frontend).
See LANGUAGE-REVIEW.md for the evaluation that led to this
choice, and CLIENT-ARCHITECTURE.md for the full design.

- Tauri v2 desktop app using system WebView2 (NOT Electron)
- ~10-15 MB install size, ~30-50 MB RAM idle
- TypeScript frontend with CSS from HTML mockups
- WebSocket client for real-time chat (browser `WebSocket` API)
- WebRTC for voice/video (browser WebRTC API in webview)
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
├── WebRTC SFU + TURN Relay (Pion)
├── SQLite Database (data/chatserver.db)
├── File Storage (data/uploads/)
├── Admin Web UI (embedded, browser-based, /admin)
└── config.yaml

CLIENT (OwnCord.exe) — installed by each friend
├── Native Windows UI
├── WebSocket Client (chat connection)
├── WebRTC Client (voice/video)
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

- [ ] Define client-server protocol over WebSocket
  (JSON messages with type/payload structure)
- [ ] Message types: auth, chat, typing, presence,
  channel_update, voice_signal, file_transfer
- [ ] Server: Go project with `go embed` for admin
  panel static files only
- [ ] SQLite setup with migrations on startup (users,
  channels, messages, sessions, roles, invites)
- [ ] config.yaml generation on first run (port, name,
  max upload size, voice quality, TLS mode)
- [ ] Server systray icon (getlantern/systray) — minimize to tray, status
  indicator, open admin panel, quit
- [ ] Windows Firewall handling on first launch
- [ ] Optional: register as Windows Service for headless operation

## Phase 2: Auth & Security (2–3 weeks)

- [ ] Invite-only registration — server generates
  invite codes, client has "Redeem Invite" flow
- [ ] bcrypt (cost 12+) passwords, server-side session tokens (256-bit random)
- [ ] Client stores auth token securely via Windows Credential Manager / DPAPI
- [ ] Login rate limiting: 5 attempts/min/IP, lockout after 10 failures
- [ ] Optional TOTP 2FA (`pquerna/otp`) — QR code
  during setup, prompts on login
- [ ] Roles: Owner, Admin, Moderator, Member + custom roles with bitfield permissions
- [ ] Per-channel permission overrides, enforced server-side on every action
- [ ] TLS modes: self-signed (default), Let's Encrypt,
  manual cert, off (Tailscale)
- [ ] Client: certificate pinning or trust-on-first-use (TOFU) for self-signed certs

## Phase 3: Client App — Core UI (3–4 weeks)

- [ ] Connection dialog: server address, port, login/register, invite code entry
- [ ] Save server profiles (connect to multiple
  servers like TeamSpeak)
- [ ] Main window layout: server list → channel list → message area → member list
- [ ] Channel tree view with categories, text channels, voice channels
- [ ] Message rendering: markdown, code blocks, timestamps, avatars, replies, reactions
- [ ] Message input: multi-line, markdown preview, emoji picker, file drag-and-drop
- [ ] Unread indicators, @mention badges per channel
- [ ] System tray: minimize to tray, notification popups, badge count
- [ ] Keyboard shortcuts: Ctrl+K quick switcher,
  Escape to close panels, customizable PTT key
- [ ] Settings: account, appearance (light/dark),
  notifications, audio devices, keybinds

## Phase 4: Real-Time Chat Features (2–3 weeks)

- [ ] WebSocket client with auto-reconnect, exponential
  backoff, message replay on reconnect
- [ ] Send/receive messages in real-time, append to scrollback
- [ ] Message history: paginated from server on channel switch, scroll-to-load-more
- [ ] Threads, replies (inline preview), reactions (emoji), edit, delete
- [ ] Typing indicators ("X is typing..." below input)
- [ ] Online/offline/idle/DnD presence with status icons in member list
- [ ] File uploads: drag-and-drop or clipboard paste,
  progress bar, inline image previews
- [ ] Client-side file validation before upload (size check, warn on large files)
- [ ] Search: query server FTS5 endpoint, display results with jump-to-message
- [ ] Windows toast notifications with action buttons (reply, mark read)
- [ ] Notification sounds (configurable, per-channel mute/override)

## Phase 5: Voice & Video (3–5 weeks)

- [ ] WebRTC integration in native client for voice/video
- [ ] Audio device selection: input/output dropdowns in settings, live preview
- [ ] Voice channels: click to join/leave, show connected users with speaking indicators
- [ ] Voice controls: mute (button + keybind), deafen, per-user volume sliders
- [ ] Push-to-talk: configurable global hotkey that works in fullscreen games
- [ ] Voice activity detection with configurable sensitivity
- [ ] Noise suppression (RNNoise or equivalent, bundled with client)
- [ ] Server-side: Pion SFU with DTLS-SRTP, built-in
  TURN relay with per-session credentials
- [ ] Voice quality: low (32kbps) / medium (64kbps) / high (128kbps Opus)
- [ ] Screen sharing via DXGI Desktop Duplication, sent as video track
- [ ] Video calls: camera capture, displayed in voice channel panel
- [ ] Soundboard: short clips, hotkey triggers, role-based permissions, play cooldown

## Phase 6: Admin Panel — Web-Based (1–2 weeks)

- [ ] Served by server at `/admin`, browser-only access
- [ ] Auth: admin credentials, session-based
- [ ] Dashboard: connected users, message count, disk usage, CPU/RAM, uptime
- [ ] User management: list all, edit roles, ban/unban, reset password, force disconnect
- [ ] Channel management: create, rename, reorder, set permissions, archive
- [ ] Invite management: generate, view active, set expiry/use limit, revoke
- [ ] Server settings: name, icon, MOTD, max upload size, voice quality, TLS config
- [ ] Moderation: kick, ban, temp ban, slow mode, mute, word filter, audit log
- [ ] Backup: trigger manual backup, configure
  schedule, view/restore from admin panel
- [ ] Built with simple HTML/CSS/JS embedded in the server binary

## Phase 7: Distribution & Updates (1–2 weeks)

- [ ] **Server:** GitHub Actions builds
  `chatserver.exe` (amd64), SHA256, GitHub Release
- [ ] **Client:** Tauri bundler (NSIS) installer —
  Program Files, Start Menu, auto-start, protocol
  handler for `chatserver://` invite links
- [ ] Client auto-update: check GitHub releases on
  launch, prompt to download + install
- [ ] Server update: admin panel shows available update, one-click download + restart
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
- **Audio:** WebView2 WebRTC API (browser audio).
- **Screen capture:** WebRTC `getDisplayMedia` in
  webview.
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
WebSocket auth, TURN credentials, cert pinning/TOFU,
update integrity (SHA256).

## Server Libraries (Go)

| Purpose | Library |
| --- | --- |
| HTTP/routing | `net/http` + `chi` |
| WebSocket | `nhooyr.io/websocket` |
| WebRTC/TURN | `pion/webrtc` + `pion/turn` |
| SQLite | `modernc.org/sqlite` (pure Go) |
| Auth | `golang.org/x/crypto/bcrypt` |
| TOTP | `pquerna/otp` |
| Sanitization | `bluemonday` |
| TLS | `golang.org/x/crypto/acme/autocert` |
| Systray | `getlantern/systray` |
| Config | `koanf` |
| Logging | `log/slog` |
