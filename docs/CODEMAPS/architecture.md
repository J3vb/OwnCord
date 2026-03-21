<!-- Generated: 2026-03-20 | Files scanned: ~120 | Token estimate: ~800 -->

# OwnCord Architecture

## System Overview

```
+-------------------+          +-------------------+
|  Tauri Client     |  WSS     |   Go Server       |
|  (Rust + TS)      |--------->|  (chatserver.exe)  |
|                   |  HTTPS   |                   |
|  livekit-client   |---.      |  LiveKit SDK      |
+-------------------+   |      +-------------------+
                        |             |
                        v             v
                  +-------------------+
                  |  LiveKit Server   |
                  |  (companion proc) |
                  +-------------------+
```

## Data Flow

```
Client                        Server                      Storage
------                        ------                      -------
ConnectPage                   api/auth_handler.go         SQLite (WAL)
  login/register  ─HTTP──>      POST /api/v1/auth/*  ──>   users, sessions
                  <─token─

MainPage                      ws/serve.go
  ws.connect()    ─WSS──>       ServeWS() → Hub.register
  dispatcher.ts   <─ready─      handlers.go dispatcher
                                  ├─ chat_send  ──>        messages, attachments
                                  ├─ voice_join ──>        voice_states + LiveKit token
                                  └─ presence   ──>        users.status

livekitSession.ts             ws/livekit.go
  Room.connect()  ─WebRTC─>     GenerateToken(JWT)
                  <─media─>     LiveKit SFU (companion)
```

## Key Boundaries

| Boundary | Protocol | Auth |
|----------|----------|------|
| Client ↔ Server REST | HTTPS | Bearer token |
| Client ↔ Server WS | WSS (via Rust proxy) | In-band `auth` message |
| Client ↔ LiveKit | WebRTC (via wss proxy) | JWT access token |
| Server ↔ LiveKit | gRPC/HTTP | API key + secret |
| Server ↔ SQLite | In-process | Single-writer WAL |

## Entry Points

- **Server:** `main.go` → config → TLS → DB → migrate → router → HTTP server
- **Client:** `main.ts` → router → ConnectPage (auth) → MainPage (app)
- **LiveKit:** Auto-started by `livekit_process.go` alongside chatserver
