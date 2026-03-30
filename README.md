# OwnCord

*The gaming chat platform you actually own.*

A self-hosted Windows chat platform with real-time messaging,
voice/video, file sharing, and a web admin panel. Run your own
server and keep everything under your control — zero cloud
dependencies, works fully on LAN.

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
- GIF picker powered by Tenor with inline rendering
- Inline image previews with lightbox viewer

### Voice & Video

- Voice channels powered by LiveKit SFU
- Webcam video chat with responsive grid layout
- Mute, deafen, camera, and screenshare controls
- Push-to-talk with global hotkey (non-consuming, works while unfocused)
- Per-user volume control (right-click user in voice channel)
- RNNoise ML noise suppression
- Voice activity detection with speaker indicators
- LiveKit server runs as a companion process alongside `chatserver.exe`

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

### Security

- TLS encryption (self-signed, Let's Encrypt, or custom cert)
- Trust-on-first-use certificate pinning in the client
- Ed25519-signed client auto-updates
- Rate limiting on all endpoints
- CSRF protection and security headers

### Desktop Client

- Native Windows app built with Tauri v2
- System tray integration
- Desktop notifications with taskbar flash and sound
- In-app auto-update with progress notification
- Credential storage via Windows Credential Manager
- Custom emoji picker and soundboard
- Compact mode for information-dense layouts

## Quick Start

1. Download the latest release from
   [GitHub Releases](https://github.com/J3vb/OwnCord/releases)
2. Run `chatserver.exe` — generates `config.yaml` on first run
3. Open `https://localhost:8443/admin` to access the admin panel
4. Generate an invite code and share it with friends
5. Friends download the client installer and connect
   using your server address

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
│   ├── ws/                  #   WebSocket hub + SFU
│   ├── db/                  #   SQLite queries + migrations
│   ├── auth/                #   Authentication + rate limiting
│   ├── config/              #   YAML config loading
│   ├── updater/             #   GitHub Releases update checker
│   ├── admin/               #   Web admin panel (static SPA)
│   └── storage/             #   File upload storage
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
- Node.js 20+
- Rust (stable)
- Windows 10/11

### Server

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.2.0" .
```

### Client

```bash
cd Client/tauri-client
npm install
npm run tauri build
```

The installer is output to
`Client/tauri-client/src-tauri/target/release/bundle/nsis/`.

### Running Tests

```bash
# Server
cd Server && go test ./...

# Client
cd Client/tauri-client
npm test                    # unit tests (vitest)
npm run test:e2e            # Playwright E2E tests
npm run test:coverage       # coverage report
```

## Configuration

The server generates a `config.yaml` on first run. Key settings:

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
Updates are Ed25519-signed and verified before install.

To enable signed releases in CI, add these GitHub repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — Ed25519 private key
  (via `npx tauri signer generate`)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — key password

## Documentation

Detailed docs live in the `docs/brain/` Obsidian vault:

- [Quick Start Guide](docs/brain/08-Guides/quick-start.md)
- [Port Forwarding Guide](docs/brain/08-Guides/port-forwarding.md)
- [Tailscale Guide](docs/brain/08-Guides/tailscale.md)
- [Client Architecture](docs/brain/06-Specs/CLIENT-ARCHITECTURE.md)
- [Server Spec](docs/brain/06-Specs/CHATSERVER.md)
- [WebSocket Protocol](docs/brain/06-Specs/PROTOCOL.md)
- [REST API](docs/brain/06-Specs/API.md)
- [Database Schema](docs/brain/06-Specs/SCHEMA.md)
- [Testing Strategy](docs/brain/06-Specs/TESTING-STRATEGY.md)
- [Contributing](docs/brain/08-Guides/CONTRIBUTING.md)
- [Security](docs/brain/08-Guides/SECURITY.md)

## Repo Copilot Assets

This repo includes project-shared Copilot instructions and skills under
`.github/instructions/` and `.claude/skills/`.

Auto-applied instructions cover:

- admin panel workflows
- database and migration rules
- DM authorization rules
- Go server conventions
- protocol and API synchronization
- Tauri frontend and Rust backend conventions
- testing expectations
- vault workflow and project-brain updates

On-demand repo skills cover:

- reconnection and replay bugs
- LiveKit voice and video integration
- E2E tier selection
- config and secret-safe setup changes
- observability and debugging workflows
- Windows-specific desktop integration paths

For the full list and one-line descriptions, see [CLAUDE.md](CLAUDE.md).

## Tech Stack

| Component | Technology |
| --------- | --------- |
| Server | Go, chi router, LiveKit server SDK |
| Database | SQLite (pure Go, embedded) |
| Client | Tauri v2 (Rust + TypeScript) |
| Voice/Video | LiveKit SFU (companion process) |
| Build | NSIS installer, GitHub Actions CI |

## License

MIT
