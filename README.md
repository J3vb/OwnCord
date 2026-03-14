# OwnCord

Self-hosted Windows chat platform with voice, video, and an admin panel.

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
2. Run `chatserver.exe` — generates `config.yaml` on first run
3. Open `https://localhost:8443/admin` to access the admin panel
4. Generate an invite code, share it with friends
5. Friends download `OwnCord.Client.exe` and connect using your server address

## Building from Source

### Server

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
```

### Client

```bash
dotnet publish Client/OwnCord.Client/OwnCord.Client.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

## Architecture

OwnCord consists of a Go server and a WPF/.NET 8 desktop client. The server handles all business logic, storage, and real-time communication. Clients connect over WebSocket for chat events, REST for history and uploads, and WebRTC for voice/video.

```
┌─────────────────────┐         ┌─────────────────────┐
│   OwnCord Client    │         │   OwnCord Server    │
│   (WPF / .NET 8)    │         │       (Go)          │
│                     │         │                     │
│  ┌───────────────┐  │  WSS    │  ┌───────────────┐  │
│  │  Chat UI      │──┼────────►│  │  WebSocket Hub│  │
│  └───────────────┘  │         │  └───────────────┘  │
│  ┌───────────────┐  │  HTTPS  │  ┌───────────────┐  │
│  │  REST Client  │──┼────────►│  │  REST API     │  │
│  └───────────────┘  │         │  └───────────────┘  │
│  ┌───────────────┐  │  WebRTC │  ┌───────────────┐  │
│  │  Voice/Video  │──┼────────►│  │  TURN/STUN    │  │
│  └───────────────┘  │         │  └───────────────┘  │
└─────────────────────┘         │  ┌───────────────┐  │
                                │  │  SQLite DB    │  │
                                │  └───────────────┘  │
                                └─────────────────────┘
```

## Documentation

- [Quick Start Guide](docs/quick-start.md)
- [Port Forwarding Guide](docs/port-forwarding.md)
- [Tailscale Guide](docs/tailscale.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

MIT
