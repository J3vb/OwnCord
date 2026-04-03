![stability-experimental](https://img.shields.io/badge/stability-experimental-orange.svg?style=for-the-badge)

![Go](https://img.shields.io/badge/go-%2300ADD8.svg?style=for-the-badge&logo=go&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)
![NPM](https://img.shields.io/badge/NPM-%23CB3837.svg?style=for-the-badge&logo=npm&logoColor=white)

# OwnCord

The gaming chat platform you actually own.

> **Early Alpha / Work in Progress**
> OwnCord is in active development and is not production-ready. Expect rough edges, rapid changes, and occasional breaking behavior.
>
> Do not use it for sensitive communications yet.

## Development Model

OwnCord is built with an AI-first development workflow.
Most implementation is generated through autonomous AI tooling, with quality validated primarily through automated checks (CI, tests, linting) and real-world feedback during alpha.

This approach enables fast iteration, but it also means behavior may change quickly between releases.

OwnCord is a self-hosted chat stack with a Go server and a Tauri desktop client.
It includes real-time messaging, voice/video via LiveKit, file sharing, and a web admin panel.

<p align="center">
  <img src=".github/images/Client.png" alt="OwnCord Client" width="700">
</p>

<p align="center">
  <img src=".github/images/loginpage.png" alt="Login Page" width="340">
  <img src=".github/images/Admin_Panel.png" alt="Admin Panel" width="340">
</p>

## Current Project Status

| Area | Status |
| ---- | ------ |
| Core chat flow | Working in alpha |
| Voice/video | Working in alpha |
| Admin panel | Working in alpha |
| Security hardening | In progress |

## Platform Support (Current Releases)

| Component | Windows x64 | Linux x64 | Linux ARM64 |
| --------- | ----------- | --------- | ----------- |
| Server binary | Yes | Yes | Not published yet |
| Desktop client | Yes | Yes | Yes |
| Docker server | N/A | Yes | N/A |

## Start Here

- New user quick path: [docs/quick-start.md](docs/quick-start.md)
- Linux Docker deployment: [docs/deployment.md](docs/deployment.md)
- Remote access without router config: [docs/tailscale.md](docs/tailscale.md)
- Manual router/network setup: [docs/port-forwarding.md](docs/port-forwarding.md)

## Quick Start

### Option A: Prebuilt binaries

1. Download assets from [GitHub Releases](https://github.com/J3vb/OwnCord/releases).
2. Run the server binary:
   - Windows: `chatserver.exe`
   - Linux: `./chatserver`
3. Open `https://localhost:8443/admin` and create your Owner account.
4. Generate invite codes in the admin panel and share them with friends.

### Option B: Docker (Linux server)

```bash
cd Server
cp .env.example .env
cp livekit.yaml.example livekit.yaml
# Edit both files before starting
docker compose up -d
```

See the full setup guide in [docs/deployment.md](docs/deployment.md).

The client uses TOFU (Trust On First Use) for self-signed certificates: it prompts once, then pins the certificate for future connections.

## What OwnCord Already Has

- Real-time channels and direct messages over WebSocket
- Voice/video channels via LiveKit
- Invite-only registration and role-based permissions
- Web admin panel with logs, backups, and update tooling
- File uploads and inline media rendering
- TOTP 2FA support and API rate limiting
- Desktop client auto-update with signature verification

See deeper feature and architecture docs in [docs/client-architecture.md](docs/client-architecture.md) and [docs/protocol.md](docs/protocol.md).

## Architecture

Two main components:

- Go server (REST API, WebSocket hub, SQLite, admin panel)
- Tauri v2 desktop client (Rust backend + TypeScript frontend)

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

## Build and Test

### Prerequisites

- Go 1.25+
- Node.js 20+
- Rust stable (client builds)

### Build from source

```bash
# Server (Windows)
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .

# Server (Linux)
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.0.0" .

# Client
cd Client/tauri-client
npm install
npm run tauri build
```

### Core verification commands

```bash
# Server
cd Server
go test ./...

# Client
cd Client/tauri-client
npm run typecheck
npm run lint
npm test
```

For the full command set, use [docs/contributing.md](docs/contributing.md).

## Configuration

On first run, the server generates `config.yaml` and a local `data/` directory:

```text
data/
├── chatserver.db
├── certs/
├── uploads/
└── backups/
```

Key options include TLS mode, upload limits, LiveKit settings, and admin CIDR restrictions.
See [docs/server-configuration.md](docs/server-configuration.md).

## Security and Vulnerability Reporting

- For vulnerabilities, use GitHub Security Advisories (private disclosure flow).
- Do not open public issues for security bugs.
- Read full policy and hardening notes in [docs/security.md](docs/security.md).

## Update Signing Notes (Maintainers)

Client and server update signing keys are intentionally separate.

Required Actions secrets for release signing:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`

When rotating the server updater key, update [Server/updater/server_update_public_key.txt](Server/updater/server_update_public_key.txt) and use staged rollover for live fleets.

## Docs Index

- [docs/quick-start.md](docs/quick-start.md)
- [docs/deployment.md](docs/deployment.md)
- [docs/livekit-setup.md](docs/livekit-setup.md)
- [docs/port-forwarding.md](docs/port-forwarding.md)
- [docs/tailscale.md](docs/tailscale.md)
- [docs/api.md](docs/api.md)
- [docs/protocol.md](docs/protocol.md)
- [docs/schema.md](docs/schema.md)
- [docs/client-architecture.md](docs/client-architecture.md)
- [docs/contributing.md](docs/contributing.md)
- [docs/security.md](docs/security.md)

## Contributing

1. Create a branch from `dev`.
2. Keep changes focused and tested.
3. Open a PR targeting `dev`.

See [docs/contributing.md](docs/contributing.md) for the full process.

## License

AGPL-3.0
