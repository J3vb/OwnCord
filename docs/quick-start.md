# Quick Start Guide

Get OwnCord up and running in minutes.

## Prerequisites

| | Windows x64 | Linux x64 | Linux ARM64 |
|-|:-----------:|:---------:|:-----------:|
| Server | ✅ | ✅ | ✅ |
| Client | ✅ | ✅ | ✅ |

- **Go 1.25+** (only if building the server from source)
- **Node.js 20+** + **Rust / Cargo** (only if building the client from source)
- **Docker + Compose v2** (alternative to building the server — Linux only)
- **LiveKit Server** (optional, for voice/video) -- see [LiveKit Setup](livekit-setup.md)

## Step 1: Download

### Option A — Pre-built binaries (recommended)

Download from [GitHub Releases](https://github.com/J3vb/OwnCord/releases):

| Platform | Server | Client |
|----------|--------|--------|
| Windows x64 | `chatserver.exe` | `OwnCord_x.x.x_x64-setup.exe` |
| Linux x64 | `chatserver-linux-amd64.tar.gz` | `OwnCord_x.x.x_x86_64.AppImage` or `_amd64.deb` |
| Linux ARM64 | _(included in server tar)_ | `OwnCord_x.x.x_aarch64.AppImage` or `_arm64.deb` |

### Option B — Docker (Linux server only)

```bash
cd Server
cp .env.example .env          # set LIVEKIT_API_KEY + LIVEKIT_API_SECRET
cp livekit.yaml.example livekit.yaml  # set node_ip + matching keys
docker compose up -d
```

See [Deployment Guide — Docker](deployment.md#docker-linux) for full details.

### Option C — Build from source

```bash
# Server (Windows)
cd Server && go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .

# Server (Linux)
cd Server && CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.0.0" .

# Client
cd Client/tauri-client && npm install && npm run tauri build
```

## Step 2: Run the Server

**Windows/Linux binary:** Run `chatserver.exe` (Windows) or `./chatserver` (Linux). On first run:

1. `config.yaml` is created in the working directory with default settings
2. `data/` directory is created for the database, TLS certs, uploads, and backups
3. A self-signed TLS certificate is generated automatically
4. SQLite database is created and all migrations are applied
5. All user statuses are reset to offline (clean slate)

The server starts on `https://0.0.0.0:8443`.

See [Server Configuration](server-configuration.md) for the full config key reference and environment variable overrides.

## Step 3: Admin Setup

Open `https://localhost:8443/admin` in a browser. The first-run setup page will prompt you to create the Owner account (username + password). This user gets the Owner role with full server control.

## Step 4: Create Invites

In the admin panel, go to invite management and generate invite codes for your friends.

## Step 5: Connect Clients

Friends install OwnCord, enter your server address (IP or domain + port 8443), and redeem their invite code to register.

The client uses TOFU (Trust On First Use) for self-signed certificates -- it will prompt to trust the server's certificate on first connection, then pin it for future sessions.

## Networking

If friends are outside your local network, see the [Port Forwarding Guide](port-forwarding.md) or use [Tailscale](tailscale.md) for zero-config networking.

## Next Steps

- [Server Configuration](server-configuration.md) -- customize ports, TLS, uploads, voice
- [Deployment Guide](deployment.md) -- production hardening, backups, monitoring, Windows service setup
- [LiveKit Setup](livekit-setup.md) -- enable voice and video chat
