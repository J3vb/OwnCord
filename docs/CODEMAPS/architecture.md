<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~750 -->

# Architecture Overview

## System Components

```
Tauri Client (Rust + TypeScript)
  |
  |-- WS Proxy (Rust) ----> Go Server :8443 (WS)
  |-- HTTP (Tauri plugin) -> Go Server :8443 (REST /api/v1/*)
  |-- LK Proxy (Rust) ----> LiveKit :7880 (via /livekit/* reverse proxy)
  |
  v
Go Server (chatserver.exe)
  |-- chi router: REST API + WS upgrade + admin panel
  |-- ws.Hub: real-time message dispatch, voice orchestration
  |-- SQLite (db.DB): all persistent state
  |-- LiveKit: companion process or external, voice/video media
  |-- storage/: file uploads on disk
  |-- updater/: client auto-update (GitHub releases)
```

## Data Flow

### REST (request/response)
`Client -> Tauri HTTP plugin -> Go chi router -> AuthMiddleware -> handler -> db.DB -> JSON response`

### WebSocket (bidirectional)
`Client -> Rust ws_proxy (TLS + TOFU) -> /api/v1/ws -> ws.ServeWS -> ws.Hub`
- Client sends: auth, chat_send, voice_join, etc. (17 client msg types)
- Server broadcasts: chat_message, presence, voice_state, etc. (27 server msg types)
- Reconnection: client sends last_seq, server replays from 1000-event ring buffer

### Voice/Video (LiveKit)
`Client -> Rust livekit_proxy -> /livekit/* reverse proxy -> LiveKit server :7880`
- Token issued via WS voice_join flow (24h TTL, 23h refresh)
- Webhook: LiveKit -> POST /api/v1/livekit/webhook -> ghost cleanup

## Key Boundaries

| Boundary | Mechanism |
|----------|-----------|
| Auth | Session tokens (SHA-256 hash in DB), 30-day TTL |
| 2FA | TOTP with partial_token (10min), 5-attempt limit |
| Rate limiting | Per-IP token bucket (auth.RateLimiter) |
| DM authz | IsDMParticipant check (not role-based) |
| Admin | IP CIDR restriction (AdminIPRestrict middleware) |
| Uploads | 10 MiB max, MIME allowlist, 1 MiB default body |
| TLS | Rust-side TOFU cert pinning (certs.json store) |

## Entry Points
- **Server:** `main.go` -> config -> TLS -> DB -> migrate -> router -> HTTP server
- **Client:** `main.ts` -> router -> ConnectPage (auth) -> MainPage (app)
- **LiveKit:** Auto-started by `livekit_process.go` alongside chatserver
