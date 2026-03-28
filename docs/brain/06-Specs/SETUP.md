# Developer Setup Guide

Complete environment setup for OwnCord's Go server and Tauri v2
desktop client on Windows. Covers every prerequisite, dependency,
configuration option, and troubleshooting scenario.

See also: [[06-Specs/CHATSERVER|CHATSERVER.md]],
[[06-Specs/CLIENT-ARCHITECTURE|CLIENT-ARCHITECTURE.md]]

---

## Table of Contents

1. [Prerequisites (Manual Install)](#1-prerequisites-manual-install)
2. [Automated Dependencies](#2-automated-dependencies)
3. [Project Structure Overview](#3-project-structure-overview)
4. [Server Setup](#4-server-setup)
5. [Client Setup](#5-client-setup)
6. [Configuration Reference](#6-configuration-reference)
7. [TLS / Certificate Setup](#7-tls--certificate-setup)
8. [LiveKit Voice Server Setup](#8-livekit-voice-server-setup)
9. [Database Setup](#9-database-setup)
10. [Build Commands](#10-build-commands)
11. [IDE Setup](#11-ide-setup)
12. [Environment Variables](#12-environment-variables)
13. [Port Requirements](#13-port-requirements)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites (Manual Install)

These require GUI installers, admin privileges, or system-level changes.
Claude Code cannot install these for you.

### Required

| Tool | Version | Download | Verify |
|------|---------|----------|--------|
| Git | any | <https://git-scm.com/download/win> | `git --version` |
| Go | 1.25+ | <https://go.dev/dl/> (amd64 .msi) | `go version` |
| Node.js | 20 LTS+ | <https://nodejs.org> | `node --version` |
| Rust | stable | <https://rustup.rs> (`rustup-init.exe`) | `rustc --version` |
| VS Build Tools 2022 | latest | [Download](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) | N/A |

#### Git

Default install options are fine. Ensure Git Bash is available
(used by Claude Code and npm scripts).

#### Go 1.25+

Download the Windows amd64 `.msi` installer from <https://go.dev/dl/>.
The `go.mod` specifies `go 1.25.0` as the minimum version. After install,
the `GOPATH` defaults to `%USERPROFILE%\go` and `%GOPATH%\bin` should be
on your PATH for tool binaries (`air`, `golangci-lint`).

#### Node.js 20 LTS

Required for the Tauri frontend build toolchain (Vite, TypeScript,
Vitest, Playwright). The `package.json` uses `"type": "module"` (ESM).
npm ships with Node.

#### Rust (stable toolchain)

Install via `rustup-init.exe` from <https://rustup.rs>. The stable
toolchain is sufficient. Cargo (Rust's package manager) is included.
Verify with `rustc --version` and `cargo --version`.

#### Visual Studio Build Tools 2022

Required for Rust compilation on Windows. During install, select:
- "Desktop development with C++"
- Requires approximately 3-5 GB of disk space.

This provides `cl.exe`, `link.exe`, and the Windows SDK needed by the
`windows` crate and Tauri's native compilation.

### Optional but Recommended

| Tool | Purpose | Install |
|------|---------|---------|
| Windows Terminal | Better shell experience | <https://aka.ms/terminal> |
| VS Code | IDE with extension ecosystem | <https://code.visualstudio.com> |
| NSIS | Installer builder for Tauri | `winget install NSIS.NSIS` |

---

## 2. Automated Dependencies

These are installed by package managers and can be handled by
Claude Code or automated scripts.

### Go Dependencies (Server)

All Go dependencies are declared in `Server/go.mod` and installed
automatically by `go build` or `go mod download`.

**Direct dependencies** (from `go.mod`):

| Module | Version | Purpose |
|--------|---------|---------|
| `go-chi/chi/v5` | 5.2.5 | HTTP router with middleware |
| `google/uuid` | 1.6.0 | UUID generation for attachments |
| `knadh/koanf/v2` | 2.3.3 | Configuration loading (YAML, env, struct defaults) |
| `koanf/parsers/yaml` | 1.1.0 | YAML config file parsing |
| `koanf/providers/env` | 1.1.0 | Environment variable overrides |
| `koanf/providers/file` | 1.2.1 | Config file provider |
| `koanf/providers/structs` | 1.0.0 | Struct-based default values |
| `livekit/protocol` | 1.45.1 | LiveKit protocol types and auth |
| `livekit/server-sdk-go/v2` | 2.16.0 | LiveKit server SDK (room service, token generation) |
| `microcosm-cc/bluemonday` | 1.0.27 | HTML sanitization (XSS prevention) |
| `go.yaml.in/yaml/v3` | 3.0.4 | YAML validation on config load |
| `golang.org/x/crypto` | 0.49.0 | bcrypt password hashing, ACME autocert |
| `golang.org/x/mod` | 0.34.0 | Semantic version comparison for updater |
| `modernc.org/sqlite` | 1.46.1 | Pure-Go SQLite driver (no CGO required) |
| `nhooyr.io/websocket` | 1.8.17 | WebSocket server (RFC 6455 compliant) |

**Notable indirect dependencies**: pion/webrtc (WebRTC for LiveKit),
prometheus client (metrics), gRPC and protobuf (LiveKit protocol).

```bash
cd Server
go mod download      # download all dependencies
go mod tidy          # clean up unused dependencies
```

### NPM Packages (Client)

All client dependencies are in `Client/tauri-client/package.json`:

**Runtime dependencies** (`dependencies`):

| Package | Version | Purpose |
|---------|---------|---------|
| `@jitsi/rnnoise-wasm` | 0.2.1 | AI noise suppression (WASM) |
| `@tauri-apps/api` | 2.10.1 | Tauri IPC bridge (invoke, listen, emit) |
| `@tauri-apps/plugin-dialog` | 2.6.0 | Native file/folder dialogs |
| `@tauri-apps/plugin-fs` | 2.4.5 | Filesystem access |
| `@tauri-apps/plugin-global-shortcut` | 2.x | Global hotkey registration |
| `@tauri-apps/plugin-http` | 2.5.7 | HTTP fetch with custom TLS |
| `@tauri-apps/plugin-notification` | 2.x | Desktop notifications |
| `@tauri-apps/plugin-opener` | 2.5.3 | Open URLs / files in default app |
| `@tauri-apps/plugin-process` | 2.3.1 | App restart (for updates) |
| `@tauri-apps/plugin-store` | 2.x | Persistent key-value store |
| `@tauri-apps/plugin-updater` | 2.10.0 | Auto-update (Ed25519-signed) |
| `livekit-client` | 2.17.3 | LiveKit JS SDK for voice/video |

**Dev dependencies** (`devDependencies`):

| Package | Version | Purpose |
|---------|---------|---------|
| `@playwright/test` | 1.x | E2E testing framework |
| `@tauri-apps/cli` | 2.x | Tauri build and dev CLI |
| `@vitest/coverage-v8` | 3.x | V8-based code coverage |
| `jsdom` | 29.x | DOM environment for unit tests |
| `typescript` | 5.7+ | TypeScript compiler |
| `vite` | 6.x | Frontend build tool (dev + prod) |
| `vitest` | 3.x | Unit/integration test runner |

```bash
cd Client/tauri-client
npm install                    # install all dependencies
npx playwright install --with-deps  # install browser binaries for E2E
```

### Rust Crate Dependencies (Tauri Backend)

All Rust dependencies are in `Client/tauri-client/src-tauri/Cargo.toml`:

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri` | 2.x | Tauri framework (with `tray-icon` feature) |
| `tauri-plugin-store` | 2.x | Persistent settings store |
| `tauri-plugin-global-shortcut` | 2.x | Global shortcut registration |
| `tauri-plugin-notification` | 2.x | Desktop notifications |
| `tauri-plugin-http` | 2.5.7 | HTTP client (`rustls-tls`, `dangerous-settings`) |
| `tauri-plugin-opener` | 2.x | Open URLs/files |
| `tauri-plugin-dialog` | 2.x | Native dialogs |
| `tauri-plugin-fs` | 2.x | Filesystem access |
| `tauri-plugin-updater` | 2.x | Auto-update |
| `tauri-plugin-process` | 2.x | Process restart |
| `serde` + `serde_json` | 1.x | JSON serialization |
| `tokio-tungstenite` | 0.28 | WebSocket client (`rustls-tls-webpki-roots`) |
| `tokio` | 1.x | Async runtime (`sync`, `net`, `io-util`, `rt`, `macros`) |
| `tokio-rustls` | 0.26 | TLS connector for LiveKit proxy |
| `futures-util` | 0.3.32 | Stream utilities (`SinkExt`, `StreamExt`) |
| `rustls` | 0.23 | TLS library (with `ring`, `std` features) |
| `ring` | 0.17 | SHA-256 fingerprint hashing |
| `url` | 2.x | URL parsing |
| `windows` (Windows-only) | 0.58 | Win32 API: Credentials, Keyboard, Foundation |

**Cargo features**:
- `default = ["devtools"]` -- enables DevTools toggle in dev builds
- `devtools = ["tauri/devtools"]` -- WebView2 DevTools

**Crate type**: `["lib", "cdylib", "staticlib"]` -- the library is
built as both a dynamic and static library for Tauri's embedding.

---

## 3. Project Structure Overview

```
OwnCord/
+-- Server/                     # Go server
|   +-- main.go                 # Entry point, startup sequence
|   +-- config/config.go        # YAML + env config loading
|   +-- db/                     # SQLite database layer
|   +-- auth/                   # Auth, TLS, sessions, bcrypt, rate limiting
|   +-- api/                    # HTTP router, middleware, REST handlers
|   +-- ws/                     # WebSocket hub, handlers, LiveKit integration
|   +-- admin/                  # Admin panel (HTML + REST API)
|   +-- storage/                # File upload storage
|   +-- permissions/            # Permission bitfield constants
|   +-- migrations/             # Embedded SQL migration files
|   +-- updater/                # Server binary auto-updater
|   +-- scripts/                # Dev/test scripts
|   +-- config.yaml             # Server configuration (auto-created)
|   +-- data/                   # Runtime data dir (DB, certs, uploads)
|       +-- chatserver.db       # SQLite database
|       +-- cert.pem            # TLS certificate
|       +-- key.pem             # TLS private key
|       +-- uploads/            # User-uploaded files
+-- Client/
|   +-- tauri-client/           # Tauri v2 client
|       +-- src-tauri/          #   Rust backend
|       |   +-- src/            #     Rust source files
|       |   +-- Cargo.toml      #     Rust dependencies
|       |   +-- capabilities/   #     Tauri permission declarations
|       |   +-- tauri.conf.json #     Tauri configuration
|       +-- src/                #   TypeScript frontend
|       |   +-- lib/            #     Core services
|       |   +-- stores/         #     Reactive state
|       |   +-- components/     #     UI components
|       |   +-- pages/          #     Page layouts
|       |   +-- styles/         #     CSS
|       +-- tests/              #   Test suites
|       +-- package.json        #   NPM dependencies + scripts
|       +-- vitest.config.ts    #   Vitest configuration
|       +-- playwright.config.ts #  Playwright E2E config
+-- docs/
    +-- brain/                  # Obsidian vault (project state)
    +-- protocol-schema.json    # WebSocket protocol schema
```

---

## 4. Server Setup

### First-Time Setup

```bash
cd Server

# 1. Download Go dependencies
go mod download

# 2. Build the server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.3.0" .

# 3. Run the server (creates config.yaml and data/ on first run)
./chatserver.exe
```

On first run, the server:
1. Creates `config.yaml` with default settings
2. Creates `data/` directory
3. Generates a self-signed TLS certificate (`data/cert.pem`, `data/key.pem`)
4. Creates and migrates the SQLite database (`data/chatserver.db`)
5. Inserts default roles (Owner, Admin, Moderator, Member)
6. Starts listening on `https://0.0.0.0:8443`

### Startup Sequence (from `main.go`)

```
1. Initialize logging (ring buffer for admin log viewer)
2. Load config (defaults -> config.yaml -> env vars)
3. Ensure data directory exists
4. Load or generate TLS certificates
5. Print startup banner
6. Open SQLite database + run migrations
7. Reset stale user statuses and voice states
8. Build HTTP router + WebSocket hub
9. Create LiveKit client (if configured)
10. Start HTTP(S) server
11. Start ACME HTTP-01 server on :80 (if acme mode)
12. Start background maintenance (session cleanup, orphan files)
13. Wait for SIGINT/SIGTERM
14. Graceful shutdown (broadcast restart, stop LiveKit, drain connections)
```

### Development with Hot Reload

Install `air` for automatic rebuilds:

```bash
go install github.com/air-verse/air@latest
cd Server
air   # watches .go files, rebuilds and restarts on change
```

### Go Linting

```bash
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
cd Server
golangci-lint run ./...
```

---

## 5. Client Setup

### First-Time Setup

```bash
cd Client/tauri-client

# 1. Install NPM dependencies
npm install

# 2. Install Playwright browsers (for E2E tests)
npx playwright install --with-deps

# 3. Start development mode (hot reload)
npm run tauri dev
```

The `tauri dev` command:
1. Starts Vite dev server on `http://localhost:1420`
2. Compiles the Rust backend
3. Opens the Tauri window pointing at Vite's dev URL
4. Watches for changes in both TypeScript and Rust code

### Tauri Configuration (`tauri.conf.json`)

```
productName: "OwnCord"
version: "1.3.0"
identifier: "com.owncord.client"

Window defaults:
  - Size: 1280x720 (min: 940x500)
  - Decorations: enabled (native title bar)
  - Resizable, centered on launch

Build:
  - frontendDist: "../dist" (Vite output)
  - devUrl: "http://localhost:1420"
  - beforeDevCommand: "npm run dev"
  - beforeBuildCommand: "npm run build"

Security CSP:
  default-src 'self'
  script-src 'self' 'wasm-unsafe-eval'     (for RNNoise WASM)
  style-src 'self' 'unsafe-inline'
  connect-src 'self' http://ipc.localhost https: wss:
              http://localhost:* ws://localhost:*
              http://127.0.0.1:* ws://127.0.0.1:*
  img-src 'self' https: data:
  media-src 'self' blob:
  frame-src https://youtube.com https://www.youtube.com
  object-src 'none'

Bundle:
  - Targets: NSIS installer
  - createUpdaterArtifacts: v1Compatible
  - Ed25519 public key for update signature verification

Browser args:
  --autoplay-policy=no-user-gesture-required  (for voice audio)
```

### Capabilities (`src-tauri/capabilities/default.json`)

The capability file declares what the frontend is allowed to access:

| Category | Permissions |
|----------|-------------|
| Core | default, event, window show/hide/focus/position/size/maximize |
| Store | default (read/write persistent JSON) |
| Global Shortcut | default, register, unregister, unregister-all, is-registered |
| Notification | default, notify, request-permission, is-permission-granted |
| HTTP | default, fetch/send/read-body (scoped: `https://*:*`, `https://*`) |
| Opener | default (open URLs in browser) |
| Dialog | default (file picker dialogs) |
| Updater | default (check + install updates) |
| Process | allow-restart (for post-update relaunch) |
| FS | default, write-file (scoped: `**`) |

---

## 6. Configuration Reference

The server uses a three-layer configuration system:

```
Layer 1: Built-in struct defaults (code)
Layer 2: config.yaml file (YAML)
Layer 3: Environment variables (OWNCORD_* prefix, highest priority)
```

### Complete `config.yaml` Reference

```yaml
# ─── Server ──────────────────────────────────────────
server:
  port: 8443                    # HTTPS port to listen on
  name: "OwnCord Server"       # Server display name (shown in client)
  data_dir: "data"              # Directory for DB, certs, uploads
  allowed_origins: ["*"]        # WebSocket/CORS origin whitelist
                                # Use ["https://example.com"] in production
  trusted_proxies: []           # CIDRs of reverse proxies trusted for
                                # X-Real-IP / X-Forwarded-For headers.
                                # Empty = always use RemoteAddr (safest).
  admin_allowed_cidrs:          # IPs allowed to access /admin panel
    - "127.0.0.0/8"            #   localhost IPv4
    - "::1/128"                #   localhost IPv6
    - "10.0.0.0/8"             #   private class A
    - "172.16.0.0/12"          #   private class B
    - "192.168.0.0/16"         #   private class C
    - "fc00::/7"               #   IPv6 unique local

# ─── Database ────────────────────────────────────────
database:
  path: "data/chatserver.db"    # SQLite file path. ":memory:" for tests.

# ─── TLS ─────────────────────────────────────────────
tls:
  mode: "self_signed"           # Options: self_signed, acme, manual, off
  cert_file: "data/cert.pem"    # Path to TLS certificate (PEM)
  key_file: "data/key.pem"      # Path to TLS private key (PEM)
  domain: ""                    # Required for acme mode ("chat.example.com")
  acme_cache_dir: "data/acme_certs"  # Let's Encrypt cert cache

# ─── File Uploads ────────────────────────────────────
upload:
  max_size_mb: 100              # Maximum file size per upload
  storage_dir: "data/uploads"   # Directory for uploaded files

# ─── Voice (LiveKit) ────────────────────────────────
voice:
  livekit_api_key: ""           # LiveKit API key (REQUIRED for voice)
  livekit_api_secret: ""        # LiveKit API secret (min 32 chars)
  livekit_url: "ws://localhost:7880"  # LiveKit server WebSocket URL
  livekit_binary: ""            # Path to livekit-server binary
                                # Empty = don't auto-start
  quality: "medium"             # Audio quality: low | medium | high

# ─── GitHub ──────────────────────────────────────────
github:
  token: ""                     # Optional: GitHub token for update checks
                                # (5000 req/hr vs 60 without)
```

### Configuration Defaults (from code)

When a field is absent from both `config.yaml` and environment
variables, these defaults apply:

| Key | Default |
|-----|---------|
| `server.port` | 8443 |
| `server.name` | "OwnCord Server" |
| `server.data_dir` | "data" |
| `server.allowed_origins` | ["*"] |
| `server.trusted_proxies` | [] |
| `server.admin_allowed_cidrs` | [private networks] |
| `database.path` | "data/chatserver.db" |
| `tls.mode` | "self_signed" |
| `tls.cert_file` | "data/cert.pem" |
| `tls.key_file` | "data/key.pem" |
| `tls.acme_cache_dir` | "data/acme_certs" |
| `upload.max_size_mb` | 100 |
| `upload.storage_dir` | "data/uploads" |
| `voice.livekit_url` | "ws://localhost:7880" |
| `voice.quality` | "medium" |

### Voice Credential Behavior

When `voice.livekit_api_key` and `voice.livekit_api_secret` are empty:
1. The server generates random credentials on each startup
2. A warning is logged: tokens break on restart
3. Set stable credentials in `config.yaml` for production use

When default dev credentials (`devkey` / `owncord-dev-secret-key-min-32chars`)
are detected, voice is disabled entirely with a warning.

---

## 7. TLS / Certificate Setup

### TLS Modes

```
+------------------------------------------------------------------------+
| Mode          | Behavior                                               |
|---------------|--------------------------------------------------------|
| self_signed   | Auto-generates ECDSA P-256 cert (10-year validity)     |
|               | Clients must trust or bypass cert warnings              |
| acme          | Automatic Let's Encrypt cert via HTTP-01 challenge     |
|               | Requires port 80 open + valid public domain             |
| manual        | Load existing cert_file + key_file paths                |
| off           | No TLS -- HTTP only (development/testing only)          |
+------------------------------------------------------------------------+
```

### Self-Signed (Default)

On first run with `tls.mode: "self_signed"`:
1. Server checks for `data/cert.pem` and `data/key.pem`
2. If either is missing, generates ECDSA P-256 self-signed cert
3. Certificate is valid for 10 years, CN=OwnCord Self-Signed
4. The Tauri client's WS proxy handles this via TOFU cert pinning

**Data flow**:

```
Client (Tauri)                   Server
     |                              |
     |-- ws_connect(wss://...)  --> |  (ws_proxy.rs)
     |   TofuVerifier captures      |
     |   SHA-256 fingerprint         |
     |                              |
     |   if first connect:           |
     |     store fingerprint         |
     |   if same fingerprint:        |
     |     "trusted"                 |
     |   if DIFFERENT fingerprint:   |
     |     REJECT (possible MitM)    |
     |     user can accept_cert      |
```

### ACME (Let's Encrypt)

```yaml
tls:
  mode: "acme"
  domain: "chat.example.com"
  acme_cache_dir: "data/acme_certs"
```

Requirements:
- Port 80 must be open and reachable from the internet
- A valid public domain pointing to the server
- No wildcard domains (HTTP-01 does not support them)
- No IP addresses (Let's Encrypt does not issue for IPs)

The server starts an HTTP-01 challenge server on :80 that also
redirects all non-ACME traffic to HTTPS.

### Manual Certificates

```yaml
tls:
  mode: "manual"
  cert_file: "/path/to/fullchain.pem"
  key_file: "/path/to/privkey.pem"
```

Use for externally managed certificates (e.g., from a corporate CA
or a separate ACME client like certbot).

---

## 8. LiveKit Voice Server Setup

LiveKit is a WebRTC SFU (Selective Forwarding Unit) that handles
voice and video relay. OwnCord uses it for all real-time media.

### Option A: Auto-Start (Managed Process)

Download the LiveKit server binary and point to it in config:

```yaml
voice:
  livekit_api_key: "my-api-key"
  livekit_api_secret: "my-secret-at-least-32-characters-long"
  livekit_url: "ws://localhost:7880"
  livekit_binary: "livekit-server.exe"
```

The server will:
1. Start `livekit-server.exe` as a child process
2. Configure it with matching API key/secret
3. Stop it on server shutdown

### Option B: External LiveKit Server

Run LiveKit separately (Docker, cloud, etc.):

```bash
# Docker example
docker run --rm -p 7880:7880 -p 7881:7881 \
  -e LIVEKIT_KEYS="my-api-key: my-secret-at-least-32-characters-long" \
  livekit/livekit-server
```

Configure OwnCord to connect to it:

```yaml
voice:
  livekit_api_key: "my-api-key"
  livekit_api_secret: "my-secret-at-least-32-characters-long"
  livekit_url: "ws://localhost:7880"
  # livekit_binary: ""  (empty = don't auto-start)
```

### LiveKit Signal Path

The client connects to LiveKit through two possible paths:

```
Path 1: OwnCord HTTPS Reverse Proxy (default)
  Client  --wss://{server}:8443/livekit/*--> OwnCord
          OwnCord  --ws://localhost:7880/*--> LiveKit

Path 2: LiveKit TLS Proxy (self-signed cert workaround)
  Client  --ws://127.0.0.1:{port}/livekit/*--> Rust Proxy
          Rust Proxy --TLS--> Remote Server --ws://--> LiveKit
```

Path 2 is used when connecting to a remote server with a self-signed
certificate, because the LiveKit JS SDK opens its own WebSocket and
WebView2 rejects self-signed certs. The Rust-side `livekit_proxy.rs`
module creates a local TCP listener that tunnels to the remote server
over TLS.

---

## 9. Database Setup

### Automatic Migration

The database is created and migrated automatically on server startup.
No manual intervention is required.

**Migration files** (`Server/migrations/`):

| File | Purpose |
|------|---------|
| `001_initial_schema.sql` | Core tables: users, sessions, channels, messages, roles, settings, etc. |
| `002_voice_states.sql` | Voice state tracking table |
| `003_audit_log.sql` | Audit logging table |
| `003_voice_optimization.sql` | Voice query indexes |
| `004_fix_member_permissions.sql` | Permission bitfield corrections |
| `005_channel_overrides_index.sql` | Channel override indexes |
| `006_member_video_permissions.sql` | Video/screenshare permissions |
| `007_attachment_dimensions.sql` | Image width/height columns |
| `008_dm_tables.sql` | Direct message tables |

**Migration tracking**: The `schema_versions` table records applied
migrations. On first upgrade to tracked migrations, existing databases
are seeded (all migrations marked as applied without re-executing).

### SQLite Configuration

Applied via PRAGMAs in `db.Open()`:

| PRAGMA | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | WAL | Write-Ahead Logging for concurrent reads |
| `busy_timeout` | 5000ms | Wait for write lock instead of failing |
| `foreign_keys` | ON | Enforce referential integrity |
| `synchronous` | NORMAL | Safe with WAL, better performance |
| `temp_store` | MEMORY | In-memory temporary tables |
| `mmap_size` | 256 MB | Memory-mapped I/O for reads |
| `cache_size` | -64000 | 64 MB page cache |
| `MaxOpenConns` | 1 | Single writer (SQLite limitation) |

On close, `PRAGMA optimize` is run to update query planner statistics.

### Database File Location

Default: `data/chatserver.db` (relative to server working directory).
Override via `database.path` in config or `OWNCORD_DATABASE_PATH` env.
Use `:memory:` for in-memory databases in tests.

---

## 10. Build Commands

### Server (Go)

```bash
cd Server

# Development build (with debug info)
go build -o chatserver.exe .

# Release build (stripped, with version)
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.3.0" .

# Run all tests
go test ./...

# Run tests with coverage
go test ./... -cover

# Run tests with race detector
go test -race ./...

# Run specific package tests
go test ./ws/...
go test ./db/...

# Verbose test output
go test -v ./...
```

### Client (Tauri v2)

```bash
cd Client/tauri-client

# Install dependencies (first time)
npm install

# Development mode (hot reload — Vite + Tauri)
npm run tauri dev

# Production build (NSIS installer)
npm run tauri build

# TypeScript-only build (no Tauri, for CI checks)
npm run build           # tsc && vite build

# ─── Tests ────────────────────────────────────
npm test                        # all tests (vitest run)
npm run test:unit               # unit tests only
npm run test:integration        # integration tests
npm run test:e2e                # Playwright E2E (mocked Tauri)
npm run test:e2e:prod           # E2E against production build
npm run test:e2e:native         # Native E2E (real Tauri exe + CDP)
npm run test:e2e:ui             # Playwright UI mode (interactive)
npm run test:watch              # vitest watch mode
npm run test:coverage           # coverage report (V8 provider)
```

### Rust Backend

```bash
cd Client/tauri-client/src-tauri

# Run Rust tests (credentials, etc.)
cargo test

# Check compilation without building
cargo check

# Build release (called by `npm run tauri build`)
cargo build --release
```

---

## 11. IDE Setup

### VS Code (Recommended)

**Essential extensions**:

| Extension | Purpose |
|-----------|---------|
| Go (golang.go) | Go language support, debugging, formatting |
| rust-analyzer | Rust LSP, inline types, error highlighting |
| Tauri (tauri-apps.tauri-vscode) | Tauri project integration |
| TypeScript (built-in) | TypeScript language service |
| Playwright Test for VS Code | Run/debug E2E tests from editor |
| SQLite Viewer | Browse the chatserver.db file |

**Recommended settings** (`.vscode/settings.json`):

```json
{
  "go.formatTool": "goimports",
  "go.lintTool": "golangci-lint",
  "editor.formatOnSave": true,
  "[go]": {
    "editor.defaultFormatter": "golang.go"
  },
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "rust-analyzer.cargo.features": ["devtools"]
}
```

---

## 12. Environment Variables

All configuration values can be overridden with environment variables
using the `OWNCORD_` prefix. The mapping rule: `OWNCORD_{SECTION}_{KEY}`.

| Environment Variable | Config Path | Example |
|---------------------|-------------|---------|
| `OWNCORD_SERVER_PORT` | `server.port` | `9443` |
| `OWNCORD_SERVER_NAME` | `server.name` | `"My Server"` |
| `OWNCORD_SERVER_DATA_DIR` | `server.data_dir` | `/opt/owncord/data` |
| `OWNCORD_DATABASE_PATH` | `database.path` | `/data/chat.db` |
| `OWNCORD_TLS_MODE` | `tls.mode` | `acme` |
| `OWNCORD_TLS_DOMAIN` | `tls.domain` | `chat.example.com` |
| `OWNCORD_TLS_CERT_FILE` | `tls.cert_file` | `/etc/ssl/cert.pem` |
| `OWNCORD_TLS_KEY_FILE` | `tls.key_file` | `/etc/ssl/key.pem` |
| `OWNCORD_UPLOAD_MAX_SIZE_MB` | `upload.max_size_mb` | `50` |
| `OWNCORD_UPLOAD_STORAGE_DIR` | `upload.storage_dir` | `/data/files` |
| `OWNCORD_VOICE_LIVEKIT_API_KEY` | `voice.livekit_api_key` | `mykey` |
| `OWNCORD_VOICE_LIVEKIT_API_SECRET` | `voice.livekit_api_secret` | `mysecret...` |
| `OWNCORD_VOICE_LIVEKIT_URL` | `voice.livekit_url` | `ws://lk:7880` |
| `OWNCORD_VOICE_QUALITY` | `voice.quality` | `high` |
| `OWNCORD_GITHUB_TOKEN` | `github.token` | `ghp_xxx` |

**E2E test environment variables**:

| Variable | Purpose |
|----------|---------|
| `OWNCORD_SERVER_URL` | Server address for native E2E tests |
| `OWNCORD_TEST_USER` | Test user credentials |
| `OWNCORD_TEST_PASS` | Test user password |
| `OWNCORD_SKIP_SERVER_TESTS` | Skip server-dependent tests |
| `CI` | Detected by Playwright for CI-specific config |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | Set by native fixture for CDP |

---

## 13. Port Requirements

| Port | Service | Protocol | Required |
|------|---------|----------|----------|
| 8443 | OwnCord HTTPS server | TCP | Yes |
| 80 | ACME HTTP-01 challenges | TCP | Only in `tls.mode: acme` |
| 7880 | LiveKit signaling (WebSocket) | TCP | If voice is enabled |
| 7881 | LiveKit RTC (WebRTC) | UDP/TCP | If voice is enabled |
| 1420 | Vite dev server | TCP | Development only |
| 4173 | Vite preview server | TCP | E2E prod testing only |
| 9222 | WebView2 CDP (remote debugging) | TCP | Native E2E testing only |

The LiveKit proxy in `livekit_proxy.rs` binds to a random available
port on `127.0.0.1` (assigned by the OS) for the TCP-to-TLS tunnel.

---

## 14. Troubleshooting

### Server Issues

**"address already in use" on startup**:
The server retries port binding up to 20 times with 500ms delays.
This handles the common case where a previous process has not
released the port yet. If it persists, kill the old process:
`taskkill /F /IM chatserver.exe`

**"default LiveKit dev credentials" warning**:
Set unique `voice.livekit_api_key` and `voice.livekit_api_secret`
in `config.yaml`. Random credentials are generated per-startup as a
fallback but tokens break on server restart.

**Database locked errors**:
SQLite is configured with `MaxOpenConns(1)` and `busy_timeout(5000ms)`.
Under extreme write load, operations may queue. This is expected.

**Migration errors**:
Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).
If a migration fails, fix the issue and restart. The `schema_versions`
table tracks which migrations have been applied.

### Client Issues

**"wasm-unsafe-eval" CSP error**:
The CSP allows `wasm-unsafe-eval` for the RNNoise WASM noise suppression
module. If you see CSP violations, check that `tauri.conf.json`'s CSP
includes `script-src 'self' 'wasm-unsafe-eval'`.

**WebSocket connection fails**:
The client's WS proxy (`ws_proxy.rs`) handles self-signed certs via TOFU.
On first connect, the cert fingerprint is stored. If the server regenerates
its cert, the client will reject the connection with a cert-mismatch error.
The user must acknowledge the new cert via `accept_cert_fingerprint`.

**LiveKit "could not establish signal connection"**:
This means WebView2's native fetch is rejecting the self-signed cert.
The `livekit_proxy.rs` module solves this by proxying through localhost.
Ensure the proxy is starting correctly (check Rust logs).

**Tauri build fails on `windows` crate**:
Ensure "Desktop development with C++" is installed in VS Build Tools.
The `windows` crate uses Win32 API bindings that require the Windows SDK.

**"npm run tauri dev" is slow to start**:
First Rust compilation takes 2-5 minutes (downloading + compiling crates).
Subsequent builds are incremental (10-30 seconds). Use `cargo check` for
faster feedback during Rust-only changes.

---

## Summary Table

| Tool | You Install | Claude Code Installs |
|------|:-----------:|:--------------------:|
| Git | X | |
| Go 1.25+ | X | |
| Node.js 20 LTS | X | |
| Rust (stable) | X | |
| VS Build Tools 2022 | X | |
| Windows Terminal | (optional) | |
| VS Code | (optional) | |
| Go libraries | | X (go mod download) |
| NPM packages | | X (npm install) |
| Rust crates | | X (cargo build) |
| NSIS | | X (winget) |
| Playwright browsers | | X (npx playwright install) |
| Linters (air, golangci-lint) | | X (go install) |
| LiveKit server binary | X or Docker | |
