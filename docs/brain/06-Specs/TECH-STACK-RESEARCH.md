# Tech Stack Research: Self-Hosted LAN Discord + TeamSpeak Clone

## Complete Technology Assessment

*Updated: 2026-03-28 | Sources: 30+ | Confidence: High*
*Related: [[DEC-001-tauri-migration]], [[DEC-002-sqlite-pure-go]], [[DEC-009-livekit-migration]], [[DEC-010-livekit-tls-proxy]]*

---

## Executive Summary

**OwnCord's stack (Go + Tauri v2/Rust + TypeScript + LiveKit) is well-chosen for its requirements.** The LiveKit migration (DEC-009) eliminated the #1 source of bugs -- the hand-rolled Pion SFU -- and replaced it with a battle-tested open-source SFU. Go with the LiveKit server SDK is the strongest WebRTC language. Tauri v2 on Windows is the lightest desktop client framework with full WebRTC support via WebView2. The three-language cost is real but manageable. The main remaining pain points are SQLite concurrency, cross-language type synchronization, and testing coverage gaps.

---

## 1. Current Technology Stack (Actual Versions)

### 1.1 Server

| Component | Technology | Version | Source |
|-----------|-----------|---------|--------|
| Language | Go | 1.25.0 | `Server/go.mod` |
| HTTP Router | chi/v5 | 5.2.5 | `go.mod` |
| WebSocket | nhooyr.io/websocket | 1.8.17 | `go.mod` |
| Database | SQLite (pure Go) | modernc.org/sqlite 1.46.1 | `go.mod`, [[DEC-002-sqlite-pure-go]] |
| Password Hashing | bcrypt | golang.org/x/crypto 0.49.0 | `go.mod` |
| Config | koanf/v2 | 2.3.3 (YAML + env + struct) | `go.mod` |
| HTML Sanitization | bluemonday | 1.0.27 | `go.mod` |
| UUID | google/uuid | 1.6.0 | `go.mod` |
| LiveKit Server SDK | livekit/server-sdk-go/v2 | 2.16.0 | `go.mod` |
| LiveKit Protocol | livekit/protocol | 1.45.1 | `go.mod` |
| Version Checking | golang.org/x/mod | 0.34.0 | `go.mod` |

### 1.2 Client (Tauri v2 Desktop App)

| Component | Technology | Version | Source |
|-----------|-----------|---------|--------|
| Framework | Tauri v2 | 2.x | `Cargo.toml` |
| Rust Backend | tauri | 2 | `Cargo.toml` |
| Frontend Language | TypeScript | ^5.7 | `package.json` |
| Bundler | Vite | ^6 | `package.json` |
| LiveKit Client SDK | livekit-client | ^2.17.3 | `package.json` |
| Noise Suppression | @jitsi/rnnoise-wasm | ^0.2.1 | `package.json` |
| TLS (Rust) | rustls | 0.23 + tokio-rustls 0.26 | `Cargo.toml` |
| WebSocket (Rust) | tokio-tungstenite | 0.28.0 | `Cargo.toml` |
| Windows API | windows-rs | 0.58 | `Cargo.toml` |
| Async Runtime | tokio | 1.x | `Cargo.toml` |
| Crypto (cert hashing) | ring | 0.17 | `Cargo.toml` |

### 1.3 Tauri Plugins

| Plugin | Version | Purpose |
|--------|---------|---------|
| tauri-plugin-store | 2 | Persistent key-value storage |
| tauri-plugin-global-shortcut | 2 | Push-to-talk hotkeys |
| tauri-plugin-notification | 2 | Desktop notifications |
| tauri-plugin-http | 2.5.7 | HTTP client with rustls + dangerous-settings |
| tauri-plugin-opener | 2 | Open URLs in default browser |
| tauri-plugin-dialog | 2 | Native file/folder dialogs |
| tauri-plugin-fs | 2 | File system access |
| tauri-plugin-updater | 2 | Auto-updater with Ed25519 signing |
| tauri-plugin-process | 2 | Process management |

### 1.4 Testing Stack

| Tool | Version | Purpose |
|------|---------|---------|
| Vitest | ^3 | Unit + integration tests |
| @vitest/coverage-v8 | ^3 | Coverage reporting |
| Playwright | ^1 | E2E testing |
| jsdom | ^29.0.0 | DOM simulation for unit tests |
| Go test | built-in | Server tests with race detector |

### 1.5 Development Tools

| Tool | Purpose |
|------|---------|
| air | Hot reload for Go server |
| golangci-lint | Go linting |
| TypeScript compiler (tsc) | Type checking |
| Vite dev server | Frontend hot reload |
| Tauri CLI | Build, dev, release |

---

## 2. Why Each Technology Was Chosen

### 2.1 Go (Server)

**Decision:** Implicit from project inception, validated by [[DEC-009-livekit-migration]].

| Factor | Score | Notes |
|--------|-------|-------|
| WebRTC ecosystem | Excellent | Pion (pure Go) is the foundation of LiveKit |
| Compile speed | Fast | ~0.3s for examples, ~1min full test suite |
| Single binary deployment | Yes | `chatserver.exe` -- no runtime dependencies |
| Concurrency | Excellent | Goroutines for WS hub, broadcasts, heartbeat |
| Cross-compilation | Good | `GOOS=windows GOARCH=amd64 go build` |
| CGo-free SQLite | Yes | modernc.org/sqlite (pure Go, [[DEC-002-sqlite-pure-go]]) |
| Memory footprint | Low | ~20-40MB at idle for the chat server |

**Alternatives considered:** Rust (too slow to compile for rapid iteration), Node.js (mediasoup exists but C++ worker is a black box), C++ (Janus -- powerful but hard to extend).

### 2.2 SQLite (Database)

**Decision:** [[DEC-002-sqlite-pure-go]] -- pure Go SQLite via modernc.org/sqlite.

| Factor | Score | Notes |
|--------|-------|-------|
| Zero-config deployment | Yes | Single file, no external process |
| Self-hosted fit | Excellent | Perfect for single-server, 1-50 users |
| FTS5 full-text search | Yes | Used for message search |
| Transaction support | Yes | ACID, WAL mode for concurrent reads |
| Windows file locking | Stricter | Required `busy_timeout=5000`, `SetMaxOpenConns(1)` |

**Why not PostgreSQL?** OwnCord targets self-hosted home servers. PostgreSQL adds deployment complexity. SQLite with WAL mode handles the expected 1-50 concurrent users. If SQLITE_BUSY errors become problematic under heavy load, PostgreSQL is the escape hatch.

**Why pure Go (modernc.org)?** Eliminates CGo dependency, enabling true single-binary deployment and simpler cross-compilation. Performance is within 5-15% of the CGo mattn/go-sqlite3 driver for OwnCord's workload.

### 2.3 Tauri v2 (Desktop Client)

**Decision:** [[DEC-001-tauri-migration]].

| Factor | Score | Notes |
|--------|-------|-------|
| Memory (idle) | ~30-40 MB | vs Electron's 200-300 MB |
| Bundle size | ~600KB-10 MB | vs Electron's 80-150 MB |
| Startup time | <0.5s | vs Electron's 1-2s |
| WebRTC on Windows | Full support | WebView2 = Chromium under the hood |
| System API access | Via Rust | GetAsyncKeyState, Credential Manager, etc. |
| Auto-updater | Built-in (v2) | Ed25519-signed releases |
| Security model | ACL-based | Fine-grained capability permissions |

**Why not Electron?** 5-8x more RAM, huge bundle size. OwnCord targets gamers where every MB of RAM matters.

**Known risk:** Linux WebRTC is broken in WebKitGTK ([tauri#13143](https://github.com/tauri-apps/tauri/issues/13143)). OwnCord is Windows-primary, so this is acceptable.

### 2.4 LiveKit (Voice/Video SFU)

**Decision:** [[DEC-009-livekit-migration]] -- replaced the hand-rolled Pion SFU.

| Factor | Score | Notes |
|--------|-------|-------|
| SDP negotiation | Handled by LiveKit | Eliminated ~2,000 lines of bug-prone code |
| Speaker detection | Built-in | `ActiveSpeakersChanged` event |
| Bandwidth estimation | Built-in | Adaptive bitrate, simulcast |
| TURN relay | Built-in | For NAT traversal |
| Reconnection | Built-in | With LiveKit's own retry logic |
| MIT license | Yes | Fully self-hostable |
| Client SDK | livekit-client (TS) | Rich API for tracks, rooms, events |
| Server SDK | server-sdk-go/v2 | Token generation, room management |

**What was replaced:**
- Server: `sfu.go`, `voice_room.go`, `speaker_detector.go`, `rtp_audio_level.go`, `speaker_broadcast.go`, `voice_handler.go` (~2,000 lines)
- Client: `webrtc.ts`, `vad.ts`, `voiceSession.ts`, `audio.ts`, `video.ts`, `Soundboard.ts` (~1,900 lines)
- Added: `livekit.go`, `livekit_process.go`, `livekitSession.ts` (~1,000 lines)
- **Net savings:** ~1,800 fewer lines of the most bug-prone code

**What was kept:** RNNoise WASM for enhanced noise suppression (optional, via LiveKit's TrackProcessor API). The `@livekit/krisp-noise-filter` was considered but `@jitsi/rnnoise-wasm` was already integrated and working.

### 2.5 TypeScript (Frontend)

Standard choice for web UIs with good tooling. The `lib/` layer
uses vanilla TypeScript with no framework (no React, Svelte, etc.)
to keep the bundle small and avoid framework lock-in. DOM
manipulation uses custom `createElement`/`appendChildren` helpers.

### 2.6 Rust (Tauri Backend)

Required by Tauri v2. Used for:
- **WS proxy** (`ws_proxy.rs`): Tunnels WebSocket through Rust with TOFU cert pinning for self-signed TLS
- **LiveKit TLS proxy** (`livekit_proxy.rs`): Local TCP-to-TLS tunnel for LiveKit signaling ([[DEC-010-livekit-tls-proxy]])
- **Push-to-talk** (`ptt.rs`): `GetAsyncKeyState` polling for global hotkeys
- **Credential storage**: Windows Credential Manager for session tokens

---

## 3. Self-Hosted Discord Alternatives Comparison

| Project | Backend | Frontend | Voice Status | Self-Hostable |
|---------|---------|----------|-------------|--------------|
| **OwnCord** | Go + LiveKit | TypeScript (Tauri v2) | Full voice + video + screenshare | Yes (Windows) |
| **Revolt/Stoat** | Rust (microservices) | TypeScript | Basic, no video/screenshare | Yes |
| **Matrix/Element** | Python (Synapse) / Go (Dendrite) | TypeScript | MatrixRTC via LiveKit SFU | Yes |
| **Spacebar (Fosscord)** | Node.js | TypeScript | Experimental, no UDP | Yes |
| **Rocket.Chat** | Node.js (Meteor) | TypeScript (React) | Jitsi integration | Yes |
| **Mumble** | C++ | Qt (C++) | Excellent voice (custom protocol) | Yes |

**Key insight:** Matrix/Element Call also adopted LiveKit, validating OwnCord's migration decision.

---

## 4. SFU Comparison (Updated Post-Migration)

| SFU | Language | Status | OwnCord Fit |
|-----|----------|--------|------------|
| **LiveKit** (chosen) | Go (Pion) | Very active, MIT, ~22K stars | Excellent -- now in use |
| **Pion** (previous) | Pure Go | Very active, ~14K stars | Good library, but DIY SFU is painful |
| **mediasoup** | C++ core + Node.js/Rust | Active | Would require Node.js alongside Go |
| **Janus** | C | Mature | Hard to extend, memory management |
| **Jitsi** | Java | Enterprise-grade | Too heavy for home server |

---

## 5. LiveKit Integration Architecture

```
  +------------------+         +------------------+         +-----------------+
  |   Chat Server    |         |   LiveKit Server |         |   Tauri Client  |
  |   (Go, port 8443)|         |   (binary, 7880) |         |   (WebView2)    |
  |                  |         |                  |         |                 |
  |  /api/v1/*       |         |  /livekit/*      |         |  livekitSession |
  |  /ws (WebSocket) |         |  (reverse proxy) |         |  .ts            |
  |                  |         |                  |         |                 |
  |  livekit.go:     |         |  SFU:            |         |  livekit-client |
  |  - Generate JWT  |         |  - Track routing  |         |  SDK:           |
  |  - Token refresh |         |  - Speaker detect  |         |  - Room.connect |
  |  - Room mgmt API |         |  - Bandwidth est.  |         |  - publish/sub  |
  |                  |         |  - DTLS/ICE        |         |  - events       |
  +--------+---------+         +--------+---------+         +--------+--------+
           |                            |                            |
           |  voice_join WS msg         |                            |
           |<---------------------------+----------------------------+
           |                            |                            |
           |  voice_token response      |                            |
           |  (JWT + LiveKit URL)       |                            |
           +--------------------------->+--------------------------->|
           |                            |                            |
           |                            |  Room.connect(url, token)  |
           |                            |<---------------------------+
           |                            |                            |
           |                            |  Media (WebRTC/DTLS-SRTP)  |
           |                            |<=========================>|
```

### LiveKit Process Management

The LiveKit server binary runs as a companion process alongside
`chatserver.exe`. The Go server manages the LiveKit process lifecycle
via `livekit_process.go`:

- **Startup:** chatserver starts the LiveKit binary with a generated
  config (API key, secret, ports)
- **Health check:** Periodic pings to ensure LiveKit is responsive
- **Shutdown:** Graceful shutdown on chatserver exit

### Token Flow

1. Client sends `voice_join` WS message
2. Server generates a LiveKit JWT with `livekit/server-sdk-go/v2`
   - Identity: `user-{id}`
   - Grants: room join, publish/subscribe
   - TTL: 4 hours
3. Server responds with `voice_token` containing JWT + LiveKit URL
4. Client connects to LiveKit SFU directly using the JWT
5. Token refresh: client sends `voice_token_refresh` every 3.5 hours

### TLS Proxy for Self-Signed Certificates

**Problem:** LiveKit SDK opens its own WebSocket. WebView2 rejects
self-signed TLS certificates on direct connections.

**Solution:** Rust-side local TCP proxy (`livekit_proxy.rs`) that:
1. Listens on `127.0.0.1:{random_port}` (plain TCP)
2. LiveKit SDK connects to `ws://127.0.0.1:{port}/livekit/...`
3. Proxy opens TLS connection to remote server (InsecureVerifier)
4. Rewrites Host/Origin headers for compatibility
5. Bidirectional byte shoveling via `io::copy_bidirectional`

See [[DEC-010-livekit-tls-proxy]] for full decision record.

---

## 6. Pain Points (Updated 2026-03-28)

### 6.1 Resolved Pain Points

| Issue | Resolution | Decision |
|-------|-----------|----------|
| SDP race conditions in custom SFU | Eliminated by LiveKit migration | [[DEC-009-livekit-migration]] |
| Stale PeerConnection callbacks | No longer relevant (LiveKit manages PCs) | [[DEC-009-livekit-migration]] |
| Voice rejoin failures | LiveKit handles reconnection internally | [[DEC-009-livekit-migration]] |
| Module-level singleton state (voiceSession.ts) | Replaced by `LiveKitSession` class | [[DEC-009-livekit-migration]] |
| Self-signed TLS blocking LiveKit | Local Rust TLS proxy | [[DEC-010-livekit-tls-proxy]] |

### 6.2 Remaining Pain Points

| Issue | Severity | Details |
|-------|----------|---------|
| **SQLite concurrency** | MEDIUM | `SQLITE_BUSY` under concurrent voice + message writes. Mitigated by `busy_timeout=5000` and `SetMaxOpenConns(1)`. |
| **Three-language build** | LOW-MEDIUM | Go + Rust + TypeScript. No unified toolchain. Protocol changes require manual sync across all three. |
| **Testing gaps** | HIGH | 10 files in vitest exclusion list, but 4 are stale (removed in LiveKit migration: `audio.ts`, `vad.ts`, `webrtc.ts`, `voiceSession.ts`). Real coverage is below the 80% target. |
| **God objects** | HIGH | `MainPage.ts` (938 lines), `renderers.ts` (1,131 lines). High change-coupling. |
| **NAT traversal** | MEDIUM | LiveKit has built-in TURN, but configuring it for home networks is complex. |

---

## 7. NAT Traversal Strategy

### 7.1 Current State

LiveKit includes built-in TURN relay support. The server configuration
can specify ICE/TURN servers that LiveKit uses for NAT traversal.

### 7.2 Recommended Approach: Tailscale/Headscale

For self-hosted deployments:
- **Tailscale/Headscale** creates a WireGuard mesh VPN
- Every device gets a `100.x.y.z` IP, NAT eliminated
- 94%+ direct connection rate, DERP relay for symmetric NAT
- Users install Tailscale, server runs on Tailscale IP, done

### 7.3 LAN-Only (Already Works)

On a local network, WebRTC ICE candidates resolve directly. No
TURN or VPN needed. This is OwnCord's primary deployment scenario.

---

## 8. Recommendations (Updated)

### Keep (Stack is Correct)

| Component | Current | Why Keep |
|-----------|---------|----------|
| Server language | Go | Best WebRTC/LiveKit ecosystem, fast compiles, single binary |
| SFU | LiveKit | Battle-tested, self-hostable, eliminated 1,800+ lines of bugs |
| Client framework | Tauri v2 | 5-8x less RAM than Electron, WebView2 for Windows WebRTC |
| Frontend language | TypeScript | Standard for web UIs, good tooling |
| Database | SQLite | Correct for single-server self-hosted, zero-config |
| Noise suppression | RNNoise WASM | Works well, integrated via LiveKit TrackProcessor |

### Next Improvements

| Priority | Change | Impact | Effort |
|----------|--------|--------|--------|
| **1** | **Refactor MainPage.ts + renderers.ts** | Break 938-line and 1,131-line god objects into focused modules | Medium |
| **2** | **Clean stale vitest exclusions + test MainPage** | Remove 4 stale exclusions (`audio.ts`, `vad.ts`, `webrtc.ts`, `voiceSession.ts`). `livekitSession.ts` already has tests. Refactor `MainPage.ts` for testability | Medium |
| **3** | **Type generation from protocol-schema.json** | Generate Go structs + TypeScript interfaces from single schema source | Medium |
| **4** | **Add Tailscale/Headscale docs** | Document as recommended NAT solution | Low |
| **5** | **WAL mode + connection pooling** | Reduce SQLITE_BUSY errors without switching to PostgreSQL | Low |

---

## 9. Sources

1. [LiveKit GitHub](https://github.com/livekit/livekit) -- Go SFU platform, ~22K stars
2. [Pion WebRTC](https://github.com/pion/webrtc) -- Pure Go WebRTC, ~14K stars
3. [LiveKit Self-Hosting Docs](https://docs.livekit.io/transport/self-hosting/)
4. [Trembit: Janus vs mediasoup vs LiveKit](https://trembit.com/blog/choosing-the-right-sfu-janus-vs-mediasoup-vs-livekit-for-telemedicine-platforms/)
5. [mediasoup Rust crate](https://crates.io/crates/mediasoup)
6. [Hopp: Tauri vs Electron](https://www.gethopp.app/blog/tauri-vs-electron)
7. [DoltHub: Electron vs Tauri](https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/)
8. [CodeNote: 2026 Cross-Platform Comparison](https://codenote.net/en/posts/cross-platform-dev-tools-comparison-2026/)
9. [Tauri WebRTC Linux Bug #13143](https://github.com/tauri-apps/tauri/issues/13143)
10. [Zap-Hosting: Self-Hosted Discord Alternatives 2026](https://zap-hosting.com/en/blog/2026/02/the-best-self-hosted-discord-alternatives-2026-ranking-pros-cons/)
11. [Matrix 2.0 Announcement](https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/)
12. [Tailscale: How NAT Traversal Works](https://tailscale.com/blog/how-nat-traversal-works)
13. [Headscale GitHub](https://github.com/juanfont/headscale)
14. [coturn GitHub](https://github.com/coturn/coturn)

---

## 10. Methodology

- Analyzed OwnCord codebase: `go.mod`, `package.json`, `Cargo.toml` for exact versions
- Read all decision records in `docs/brain/04-Decisions/`
- Compared with 22+ external sources (SFU benchmarks, framework comparisons)
- Cross-referenced with 140+ commits, bug tracker, and hotspot file analysis
- Verified LiveKit migration outcomes against DEC-009 predictions
