# Quick Start Guide

Get OwnCord running with the fewest possible steps.

## Choose Your Setup Path

| Goal | Best path |
| ---- | --------- |
| Fastest local/LAN setup | Prebuilt binaries |
| Linux server with easiest operations | Docker |
| Custom dev build | Build from source |

## Platform Support (Current Releases)

| Component | Windows x64 | Linux x64 | Linux ARM64 |
| --------- | ----------- | --------- | ----------- |
| Server binary | Yes | Yes | Not published yet |
| Desktop client | Yes | Yes | Yes |

## Prerequisites

- Go 1.26+ (only if building server from source)
- Node.js 20+ and Rust (only if building client from source)
- Docker + Compose v2 (Docker path only)
- LiveKit (optional, required for voice/video)

## Option A: Prebuilt binaries (recommended)

1. Download from [GitHub Releases](https://github.com/J3vb/OwnCord/releases).
2. Start the server:
	 - Windows: `chatserver.exe`
	 - Linux: `./chatserver`
3. Open `https://localhost:8443/admin`.
4. Create the Owner account.
5. Create invite codes and share them.

## Option B: Docker (Linux server)

```bash
cd Server
cp .env.example .env
cp livekit.yaml.example livekit.yaml
# Edit both files before start
docker compose up -d
```

Then open `https://localhost:8443/admin` and create the Owner account.

Full Docker details: [Deployment Guide](deployment.md#docker-linux).

## Option C: Build from source

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

## What Happens on First Server Start

- `config.yaml` is created with defaults.
- `data/` is created for DB, certs, uploads, and backups.
- A self-signed TLS certificate is generated.
- SQLite schema and migrations are applied.

## Client Connection Notes

- The default server address is `https://<server-ip>:8443`.
- The desktop client uses TOFU certificate pinning:
	- First connection prompts for trust.
	- Future connections require the same cert fingerprint.
- Linux/Wayland: the client automatically sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
	on Wayland sessions to work around WebKitGTK rendering crashes. Export the
	variable yourself (any value) before launching to override this.

## If Remote Users Cannot Connect

1. Use [Tailscale](tailscale.md) for the simplest remote setup.
2. Or configure [Port Forwarding](port-forwarding.md).

## Optional: enable the GIF picker

GIFs are **off by default** and each server supplies its own key — OwnCord does
not ship one, so nothing is shared between servers.

1. Request a key at [partner.klipy.com](https://partner.klipy.com).
2. Set it on the server, then restart:

```bash
# Preferred — keeps the credential out of config.yaml
OWNCORD_GIF_API_KEY=your_key_here
```

Or in `config.yaml`:

```yaml
gif:
  api_key: "your_key_here"
```

The key stays server-side; clients only ever call `/api/v1/gif/*` on their own
server. Until one is set, the client's GIF button is disabled with
"GIFs are not enabled on this server" — nothing else is affected.

## Next Steps

- [Server Configuration](server-configuration.md)
- [Deployment Guide](deployment.md)
- [LiveKit Setup](livekit-setup.md)
