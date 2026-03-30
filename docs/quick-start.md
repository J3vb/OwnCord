# Quick Start Guide

Get OwnCord up and running in minutes.

## Prerequisites

- **Windows 10+** (x64)
- **Go 1.25+** (only if building the server from source)
- **Node.js 20+** (only if building the client from source)
- **Rust / Cargo** (only if building the Tauri client from source)
- **LiveKit Server** binary (optional, for voice/video) -- see [LiveKit Setup](livekit-setup.md)

## Step 1: Download

Get the latest release from GitHub Releases. Download `chatserver.exe` and the `OwnCord` installer.

Or build from source:

```bash
# Server
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .

# Client
cd Client/tauri-client
npm install
npm run tauri build
```

## Step 2: Run the Server

Run `chatserver.exe`. On first run:

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
