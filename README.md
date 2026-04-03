![stability-experimental](https://img.shields.io/badge/stability-experimental-orange.svg?style=for-the-badge)


![Go](https://img.shields.io/badge/go-%2300ADD8.svg?style=for-the-badge&logo=go&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)
![NPM](https://img.shields.io/badge/NPM-%23CB3837.svg?style=for-the-badge&logo=npm&logoColor=white)
# OwnCord

*The gaming chat platform you actually own.*

> **Early Alpha — Building in the Open**
> OwnCord is under active development and is not production-ready. Do not use it for sensitive communications. Security hardening is in progress. Contributions and [security reports](https://github.com/J3vb/OwnCord/issues) are welcome.

A self-hosted chat platform with real-time messaging,
voice/video, file sharing, and a web admin panel. Run your own
server on Windows or Linux and keep everything under your control
— zero cloud dependencies, works fully on LAN.

<p align="center">
  <img src=".github/images/Client.png" alt="OwnCord Client" width="700">
</p>

<p align="center">
  <img src=".github/images/loginpage.png" alt="Login Page" width="340">
  <img src=".github/images/Admin_Panel.png" alt="Admin Panel" width="340">
</p>

## Quick Start

**Option A — Binary (Windows / Linux)**

1. Download from [GitHub Releases](https://github.com/J3vb/OwnCord/releases):
   - **Windows**: `chatserver.exe` + `OwnCord_x.x.x_x64-setup.exe`
   - **Linux x64**: `chatserver-linux-amd64.tar.gz` + `OwnCord_x.x.x_x86_64.AppImage` (or `_amd64.deb`)
   - **Linux ARM64**: `chatserver-linux-amd64.tar.gz` + `OwnCord_x.x.x_aarch64.AppImage` (or `_arm64.deb`)
2. Run `chatserver.exe` / `./chatserver` — generates `config.yaml` and `data/` on first run
3. Open `https://localhost:8443/admin` to create the Owner account
4. Generate invite codes and share them with friends

**Option B — Docker (Linux)**

```bash
cd Server
cp .env.example .env && cp livekit.yaml.example livekit.yaml
# Edit both files (set API keys + your public IP in livekit.yaml)
docker compose up -d
```

See [Deployment Guide](docs/deployment.md) for full Docker setup.

> **Finding your IP:** `ipconfig` (Windows) or `ip a` (Linux). The server binds to `0.0.0.0:8443` — share your LAN IP (e.g. `192.168.1.2:8443`) with friends.

The client uses TOFU (Trust On First Use) for self-signed certificates — it prompts to trust the server on first connection, then pins it for future sessions.

### Voice & Video Setup (Optional)

**Binary deployment** — set in `config.yaml` and restart:
```yaml
voice:
  livekit_api_key: "my-unique-key"
  livekit_api_secret: "my-secret-min-32-characters-long!!"
  livekit_binary: "C:/path/to/livekit-server.exe"  # Windows
  # livekit_binary: "/usr/local/bin/livekit-server"  # Linux
```
OwnCord auto-starts LiveKit as a companion process.

**Docker deployment** — LiveKit runs as a separate container, configured via `.env` and `livekit.yaml`. See [LiveKit Setup](docs/livekit-setup.md#docker).


## Features

### Chat

- Real-time text messaging over WebSocket
- Message editing, deletion, and replies
- Emoji reactions with per-message counts
- Typing indicators
- Full-text message search (SQLite FTS5)
- Pinned messages per channel
- Rich link previews with Open Graph metadata
- YouTube embed support with cached titles
- GIF picker powered by Klipy with inline rendering and Klipy watermark
- Inline image previews with lightbox viewer

### Voice & Video

- Voice channels powered by LiveKit SFU
- Webcam video chat with Discord-style grid layout (fixed 16:9 aspect ratio)
- Sidebar stream preview (hover to see live video thumbnail)
- Mute, deafen, camera, and screenshare controls
- Push-to-talk with global hotkey (non-consuming, works while unfocused)
- Per-user volume control (right-click user in voice channel)
- RNNoise ML noise suppression
- Voice activity detection with speaker indicators (pulsing green glow)
- Connection quality indicator with expandable transport stats
- Voice call duration timer (MM:SS / HH:MM:SS elapsed)
- LiveKit server runs as a companion process alongside `chatserver.exe`

### Direct Messages

- One-on-one DM conversations with any server member
- DM preview section in sidebar with unread bubble indicators
- Auto-reopen DM channels on incoming message
- DM header shows `@ username` with live online status

### Channels & Organization

- Text and voice channels organized by categories
- Create, edit, delete, and reorder channels
- Unread message indicators
- Quick channel switcher (Ctrl+K)

### File Sharing

- Drag-and-drop and clipboard paste uploads
- Inline image previews with persistent caching (IndexedDB)
- File download with native save dialog
- Configurable max upload size

### Users & Permissions

- Invite-only registration with invite codes
- Role-based permissions with custom roles
- Member list with online/offline presence
- User profiles with status (online, idle, dnd, offline)

### Administration

- Web-based admin panel at `/admin` (IP-restricted to private networks by default)
- Dashboard with server stats and recent activity
- User management (ban, kick, role assignment) with modals
- Channel management (create, edit, delete)
- Settings management (server name, MOTD, limits, security)
- Live server log streaming via SSE with level filters,
  search, auto-scroll, pause/resume, copy, and clear
- Audit log with search, action type filter, copy, and CSV export
- Database backup and restore with pre-restore safety backups
- Server update checker and one-click apply (GitHub Releases)
- Metrics endpoint with uptime, goroutines, heap, connected users
- Diagnostics endpoint for connectivity checks

### Security

- TLS encryption (self-signed, Let's Encrypt, or custom cert)
- Trust-on-first-use certificate pinning in the client
- Two-factor authentication (TOTP) with QR enrollment and backup codes
- Ed25519-signed client auto-updates
- Rate limiting on all endpoints
- CSRF protection and security headers
- Account deletion with password confirmation and data anonymization

### Desktop Client

- Native desktop app built with Tauri v2 — Windows x64, Linux x64, Linux ARM64
- System tray integration
- Desktop notifications with taskbar flash and sound
- In-app auto-update with progress notification
- Credential storage via system keychain (Windows Credential Manager / Linux Secret Service / macOS Keychain)
- Auto-login with saved credentials (one-click connect)
- Custom emoji picker
- Compact mode for information-dense layouts
- Discord-style settings panel with blurred backdrop
- OC Neon Glow theme with custom theming system (JSON import/export)
- Accent color picker
- Quick-switch server overlay for multi-server users
- Structured logging with JSONL persistence (5-day rotation)


### Networking

For friends outside your LAN, you need to forward these ports:

| Port | Protocol | Purpose |
| ---- | -------- | ------- |
| `8443` | TCP | HTTPS, WebSocket, REST API |
| `7881` | TCP | LiveKit signaling (voice/video) |
| `50000-60000` | UDP | LiveKit WebRTC media (voice/video) |

Alternatively, use Tailscale for zero-config networking
with no port forwarding.

## Architecture

Two components: a **Go server** and a **Tauri v2 client**
(Rust + TypeScript).

```text
+---------------------+         +---------------------+
|   OwnCord Client    |         |   OwnCord Server    |
|   (Tauri v2)        |         |       (Go)          |
|                     |         |                     |
|  +---------------+  |  WSS    |  +---------------+  |
|  |  Chat UI      |--+------->|  |  WebSocket Hub|  |
|  +---------------+  |         |  +---------------+  |
|  +---------------+  |  HTTPS  |  +---------------+  |
|  |  REST Client  |--+------->|  |  REST API     |  |
|  +---------------+  |         |  +---------------+  |
|  +---------------+  | LiveKit |  +---------------+  |
|  |  Voice/Video  |--+------->|  |  LiveKit SFU  |  |
|  +---------------+  |         |  +---------------+  |
+---------------------+         |  +---------------+  |
                                |  |  SQLite DB    |  |
                                |  +---------------+  |
                                +---------------------+
```

- **WebSocket** — chat messages, typing, presence, voice signaling
- **REST API** — message history, file uploads, channel management, auth
- **LiveKit** — voice and video via LiveKit SFU (companion process)

## Project Structure

```text
OwnCord/
├── Server/                  # Go server
│   ├── api/                 #   REST handlers + middleware
│   ├── ws/                  #   WebSocket hub + handlers
│   ├── db/                  #   SQLite queries + migrations
│   ├── auth/                #   Authentication + rate limiting
│   ├── config/              #   YAML config loading
│   ├── updater/             #   GitHub Releases update checker
│   ├── admin/               #   Web admin panel (static SPA)
│   ├── storage/             #   File upload storage
│   ├── permissions/         #   Role-based permission system
│   └── migrations/          #   Database migration files
├── Client/
│   └── tauri-client/        # Tauri v2 desktop client
│       ├── src-tauri/       #   Rust backend (plugins, commands)
│       ├── src/             #   TypeScript frontend
│       │   ├── lib/         #     Core services (API, WS, LiveKit, updater)
│       │   ├── stores/      #     Reactive state (auth, channels, messages, voice)
│       │   ├── components/  #     UI components (28 modules)
│       │   ├── pages/       #     Page layouts
│       │   └── styles/      #     CSS
│       └── tests/           #   Unit, integration, and E2E tests
└── docs/                    # Project documentation (Obsidian vault)
```

## Building from Source

### Prerequisites

- Go 1.25+
- Node.js 20+ and Rust (stable) — client only
- Windows x64, Linux x64, or Linux ARM64

### Server

**Windows:**
```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
```

**Linux:**
```bash
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.0.0" .
```

### Client

```bash
cd Client/tauri-client
npm install
npm run tauri build
```

Output location:
- **Windows**: `src-tauri/target/release/bundle/nsis/` (NSIS installer)
- **Linux**: `src-tauri/target/release/bundle/appimage/` and `bundle/deb/`

### Running Tests

```bash
# Server
cd Server && go test ./...
cd Server && go test ./... -cover   # with coverage

# Client
cd Client/tauri-client
npm test                    # all tests (vitest)
npm run test:unit           # unit tests only
npm run test:integration    # integration tests
npm run test:e2e            # Playwright E2E (mocked Tauri)
npm run test:e2e:native     # Playwright E2E (real Tauri exe + CDP)
npm run test:coverage       # coverage report

# Type checking & linting
npm run typecheck           # full typecheck
npm run lint                # ESLint check
npm run lint:fix            # ESLint auto-fix
```

## Configuration

The server generates a `config.yaml` on first run. All runtime data
is stored in a `data/` directory alongside the executable:

```text
data/
├── owncord.db         # SQLite database
├── certs/             # TLS certificates (auto-generated if self_signed)
├── uploads/           # User-uploaded files
└── backups/           # Database backups
```

Key settings:

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `server.port` | `8443` | HTTPS port |
| `server.name` | `OwnCord Server` | Display name |
| `tls.mode` | `self_signed` | TLS mode (self_signed, acme, manual, off) |
| `upload.max_size_mb` | `100` | Max upload size |
| `voice.livekit_url` | `ws://localhost:7880` | LiveKit server WebSocket URL |
| `voice.livekit_api_key` | — | LiveKit API key (required for voice) |
| `voice.livekit_api_secret` | — | LiveKit API secret (min 32 chars, required for voice) |
| `voice.livekit_binary` | — | Path to `livekit-server` binary (empty = don't auto-start) |
| `voice.quality` | `medium` | Voice quality (low, medium, high) |
| `server.admin_allowed_cidrs` | private nets | CIDRs allowed to access `/admin` |
| `github.token` | — | Token for update checks (optional, for higher rate limits) |

## Auto-Updates

The client checks for updates after connecting to the server.
Client updates are Ed25519-signed and verified before install.
Server auto-updates use a separate minisign/Ed25519 signing key, verify `chatserver.exe.sig`, and require a signed `server-update-manifest.json` that binds the binary hash to the release version before apply.

For maintainers publishing signed releases from GitHub Actions, configure these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — client updater private key
   (via `npx tauri signer generate`)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — client updater key password
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY` — server updater private key
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD` — server updater key password

These are secret names only. Do not commit private key material or passphrases to the repository.

When rotating the server updater key, also update [Server/updater/server_update_public_key.txt](Server/updater/server_update_public_key.txt). For live deployments that rely on server auto-update continuity, treat key rotation as a staged rollover rather than a one-step secret swap.

## Documentation

- [Quick Start Guide](docs/quick-start.md)
- [Server Configuration](docs/server-configuration.md)
- [LiveKit Setup (Voice/Video)](docs/livekit-setup.md)
- [Deployment Guide](docs/deployment.md)
- [Port Forwarding](docs/port-forwarding.md)
- [Tailscale Guide](docs/tailscale.md)
- [REST API Reference](docs/api.md)
- [WebSocket Protocol](docs/protocol.md)
- [Database Schema](docs/schema.md)
- [Client Architecture](docs/client-architecture.md)
- [Contributing](docs/contributing.md)
- [Security Policy](docs/security.md)

## Contributing

1. Fork the repo and create a feature branch from `dev`
2. Follow existing code style and conventions
3. Write tests for new functionality
4. Open a PR against `dev` with a clear description

See [Contributing Guide](docs/contributing.md) for details.

## Tech Stack

| Component | Technology |
| --------- | --------- |
| Server | Go, chi router, LiveKit server SDK |
| Database | SQLite (pure Go, embedded) |
| Client | Tauri v2 (Rust + TypeScript) |
| Voice/Video | LiveKit SFU (companion process or Docker) |
| Build | NSIS (Windows), AppImage + deb (Linux), GitHub Actions CI |

## License

AGPL-3.0

---

*Built with [Claude Code](https://claude.ai/code) and [GitHub Copilot](https://github.com/features/copilot).*
