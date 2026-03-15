# OwnCord

Self-hosted Windows chat platform with voice, video, and
an admin panel.

## Features

- Real-time text chat with threads and reactions
- Voice and video channels (WebRTC)
- Role-based permissions with custom roles
- File sharing with inline previews
- Full-text message search
- Web-based admin panel
- Invite-only registration
- TLS encryption (self-signed or custom cert)

## Quick Start

1. Download the latest release from GitHub Releases
2. Run `chatserver.exe` -- generates `config.yaml` on first run
3. Open `https://localhost:8443/admin` to access the admin panel
4. Generate an invite code, share it with friends
5. Friends download the client installer and connect using
   your server address

## Building from Source

### Server

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
```

### Client (Tauri v2)

```bash
cd Client/tauri-client
npm install
npm run tauri build
```

The installer is output to
`Client/tauri-client/src-tauri/target/release/bundle/nsis/`.

## Architecture

OwnCord consists of a Go server and a Tauri v2 desktop
client. The server handles all business logic, storage,
and real-time communication. Clients connect over WebSocket
for chat events, REST for history and uploads, and WebRTC
for voice/video.

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
|  +---------------+  |  WebRTC |  +---------------+  |
|  |  Voice/Video  |--+------->|  |  TURN/STUN    |  |
|  +---------------+  |         |  +---------------+  |
+---------------------+         |  +---------------+  |
                                |  |  SQLite DB    |  |
                                |  +---------------+  |
                                +---------------------+
```

## Documentation

- [Quick Start Guide](docs/quick-start.md)
- [Port Forwarding Guide](docs/port-forwarding.md)
- [Tailscale Guide](docs/tailscale.md)
- [Client Architecture](CLIENT-ARCHITECTURE.md)
- [Migration Plan](MIGRATION-PLAN.md)
- [Testing Strategy](TESTING-STRATEGY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

MIT
