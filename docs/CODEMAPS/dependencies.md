<!-- Generated: 2026-03-20 | Token estimate: ~600 -->

# Dependencies Codemap

## Server (Go 1.25)

| Dependency | Purpose |
|------------|---------|
| go-chi/chi v5 | HTTP router |
| nhooyr.io/websocket | WebSocket server |
| modernc.org/sqlite | SQLite driver (pure Go) |
| livekit/server-sdk-go v2 | Token gen, room management |
| livekit/protocol | LiveKit protobuf types |
| knadh/koanf v2 | Config (YAML + env) |
| golang.org/x/crypto | bcrypt password hashing |
| google/uuid | UUID generation |
| microcosm-cc/bluemonday | HTML sanitization |

## Client TypeScript

| Dependency | Purpose |
|------------|---------|
| livekit-client ^2.17 | LiveKit JS SDK (WebRTC) |
| @jitsi/rnnoise-wasm ^0.2 | Noise suppression (WASM) |
| @tauri-apps/api ^2.10 | Tauri v2 core IPC |
| @tauri-apps/plugin-* | store, dialog, fs, http, notification, global-shortcut, opener, process, updater |

## Client Rust

| Crate | Purpose |
|-------|---------|
| tauri 2 | App framework |
| tokio-tungstenite 0.28 | WS client (TLS) |
| rustls 0.23 | TLS engine |
| windows 0.58 | Win32 API (PTT, credentials) |
| serde/serde_json | Serialization |

## External Services

| Service | Protocol | Config |
|---------|----------|--------|
| LiveKit SFU | WebRTC + gRPC | config.voice (api_key, api_secret, url, binary_path) |
| Tenor API v2 | HTTPS | Public key in lib/tenor.ts (not a secret) |
| GitHub API | HTTPS | Optional token for update checks |

## Service Topology
```
Client ──WSS──> Server ──gRPC──> LiveKit (companion process)
Client ──WebRTC (wss proxy)───> LiveKit
Client ──HTTPS──> Tenor API (GIFs)
Server ──HTTPS──> GitHub API (update checks)
Server ──file──> SQLite (local .db)
```
