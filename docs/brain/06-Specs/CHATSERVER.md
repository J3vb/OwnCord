# ChatServer -- Detailed Server Specification

> **Status:** v1.2.0 -- Phases 1-6 complete. See [[02-Tasks/Done|Done]]
> for the task completion list and [[00-Overview/Changelog|Changelog]]
> for version history.

OwnCord's server is a single Go binary (`chatserver.exe`) that provides
REST APIs, real-time WebSocket messaging, LiveKit voice/video integration,
file storage, and an embedded admin panel. Two executables constitute the
full platform: `chatserver.exe` (server) and `OwnCord.exe` (Tauri v2
desktop client).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Go Package Map](#go-package-map)
3. [Server Startup Flow](#server-startup-flow)
4. [Configuration System](#configuration-system)
5. [Database Layer](#database-layer)
6. [HTTP Router and Middleware Stack](#http-router-and-middleware-stack)
7. [REST API Endpoints](#rest-api-endpoints)
8. [WebSocket Hub Architecture](#websocket-hub-architecture)
9. [WebSocket Message Dispatch](#websocket-message-dispatch)
10. [Reconnection and Ring Buffer](#reconnection-and-ring-buffer)
11. [Heartbeat Monitoring](#heartbeat-monitoring)
12. [LiveKit Integration](#livekit-integration)
13. [Voice System](#voice-system)
14. [Direct Messages (DM System)](#direct-messages-dm-system)
15. [File Upload Handling](#file-upload-handling)
16. [Admin Panel](#admin-panel)
17. [Authentication and Sessions](#authentication-and-sessions)
18. [Permission System](#permission-system)
19. [Rate Limiting](#rate-limiting)
20. [Security Measures](#security-measures)
21. [Error Handling Patterns](#error-handling-patterns)
22. [Background Maintenance](#background-maintenance)
23. [Graceful Shutdown](#graceful-shutdown)
24. [Server Libraries](#server-libraries)

---

## Architecture Overview

```text
+---------------------------------------------------------------+
|                    chatserver.exe (Go)                         |
|                                                               |
|  +-------------------+   +------------------+                 |
|  |  HTTP Server      |   |  WebSocket Hub   |                 |
|  |  (chi router)     |   |  (goroutine)     |                 |
|  |                   |   |                  |                 |
|  |  /api/v1/*        |   |  register/       |                 |
|  |  /admin/*         |   |  unregister/     |                 |
|  |  /health          |   |  broadcast       |                 |
|  |  /livekit/*       |   |  stale sweep     |                 |
|  +--------+----------+   +--------+---------+                 |
|           |                        |                          |
|           v                        v                          |
|  +-------------------+   +------------------+                 |
|  |  Auth Layer       |   |  Client Pool     |                 |
|  |  (bcrypt, tokens, |   |  map[userID]     |                 |
|  |   rate limiter)   |   |  *Client         |                 |
|  +--------+----------+   +--------+---------+                 |
|           |                        |                          |
|           v                        v                          |
|  +---------------------------------------------------+       |
|  |              SQLite Database (WAL mode)            |       |
|  |  users | sessions | channels | messages | roles    |       |
|  |  invites | voice_states | reactions | attachments  |       |
|  |  channel_overrides | read_states | settings        |       |
|  |  audit_log | dm_participants | schema_versions     |       |
|  +---------------------------------------------------+       |
|                                                               |
|  +-------------------+   +------------------+                 |
|  |  File Storage     |   |  LiveKit Client  |                 |
|  |  data/uploads/    |   |  (token gen,     |                 |
|  |  UUID filenames   |   |   room mgmt,     |                 |
|  +-------------------+   |   webhook sync)  |                 |
|                          +--------+---------+                 |
|                                   |                           |
+-----------------------------------+---------------------------+
                                    |
                                    v
                          +-------------------+
                          |  LiveKit Server   |
                          |  (companion proc  |
                          |   or external)    |
                          |  :7880            |
                          +-------------------+
```

### How It Works

1. Server operator runs `chatserver.exe` on their PC or home server
2. On first run, `config.yaml` is auto-generated with sane defaults
3. SQLite database is created and migrations are applied automatically
4. TLS certificates are generated (self-signed by default)
5. Friends download and install `OwnCord.exe` (the Tauri v2 client)
6. Client connects to the server via `wss://server-ip:port/api/v1/ws`
7. All chat, voice, video, and file transfers go through the server
8. Admin manages the server through a browser at `https://server-ip:port/admin`

---

## Go Package Map

```text
Server/
+-- main.go                  # Entrypoint: config, DB, router, server lifecycle
+-- config/
|   +-- config.go            # YAML + env config loading via koanf
+-- auth/
|   +-- auth.go              # Package declaration
|   +-- session.go           # Token generation (256-bit random) and hashing (SHA-256)
|   +-- password.go          # bcrypt hashing (cost 12), validation, timing-safe compare
|   +-- helpers.go           # ExtractBearerToken, IsEffectivelyBanned, IsSessionExpired
|   +-- ratelimit.go         # In-memory sliding-window rate limiter with lockout
|   +-- tls.go               # TLS certificate loading/generation (self-signed, ACME, manual)
+-- db/
|   +-- db.go                # SQLite open, WAL mode, pragmas, connection setup
|   +-- migrate.go           # Schema migration runner (embedded FS, version tracking)
|   +-- models.go            # Go structs: User, Session, Channel, Message, Role, etc.
|   +-- errors.go            # Sentinel errors: ErrNotFound, ErrForbidden, ErrConflict, ErrBanned
|   +-- auth_queries.go      # User CRUD, session CRUD, status updates
|   +-- channel_queries.go   # Channel CRUD, permission overrides, read states
|   +-- message_queries.go   # Message CRUD, FTS5 search, reactions, pins
|   +-- voice_queries.go     # Voice state join/leave/update, camera/screenshare counts
|   +-- role_queries.go      # Role CRUD, hierarchy management
|   +-- invite_queries.go    # Invite code CRUD, atomic consumption
|   +-- attachment_queries.go # Attachment CRUD, orphan cleanup
|   +-- dm_queries.go        # DM channel get-or-create, participants, open/close
|   +-- admin_queries.go     # Admin stats, audit log, user management, backup/restore
+-- api/
|   +-- router.go            # chi router assembly, all route mounting
|   +-- middleware.go         # AuthMiddleware, RequirePermission, RateLimitMiddleware,
|   |                        # AdminIPRestrict, SecurityHeaders, MaxBodySize(Unless),
|   |                        # clientIP, clientIPWithProxies
|   +-- auth_handler.go      # POST /register, POST /login, POST /logout, GET /me
|   +-- channel_handler.go   # GET /channels, GET /channels/{id}/messages, search, pins
|   +-- upload_handler.go    # POST /uploads, GET /files/{id}
|   +-- invite_handler.go    # POST /invites, GET /invites, DELETE /invites/{code}
|   +-- dm_handler.go        # POST /dms, GET /dms, DELETE /dms/{channelId}
|   +-- metrics_handler.go   # GET /metrics (admin-only runtime stats)
|   +-- client_update.go     # GET /updates/latest (client auto-update check)
|   +-- livekit_proxy.go     # /livekit/* reverse proxy (HTTPS->WS to LiveKit)
+-- ws/
|   +-- hub.go               # Hub: client tracking, broadcast dispatch, settings cache
|   +-- client.go            # Client struct: send buffer, channel/voice state, mutexes
|   +-- serve.go             # ServeWS: upgrade, in-band auth, readPump/writePump,
|   |                        # reconnection replay, ready payload
|   +-- handlers.go          # Message dispatch switch, chat_send/edit/delete, typing,
|   |                        # presence, channel_focus, reactions
|   +-- messages.go          # Message builder functions, envelope/payload structs
|   +-- errors.go            # WebSocket error code constants
|   +-- ringbuffer.go        # EventRingBuffer for reconnection replay
|   +-- voice_join.go        # handleVoiceJoin, token generation, rollback logic
|   +-- voice_leave.go       # handleVoiceLeave, DB cleanup, LiveKit removal
|   +-- voice_controls.go    # handleVoiceMute/Deafen/Camera/Screenshare
|   +-- voice_broadcast.go   # Voice quality map, broadcastVoiceStateUpdate
|   +-- livekit.go           # LiveKitClient: token gen, room management, health check
|   +-- livekit_process.go   # LiveKitProcess: companion binary lifecycle, restart loop
|   +-- livekit_webhook.go   # LiveKit webhook handler (participant_joined/left sync)
|   +-- origin.go            # WebSocket origin validation
+-- permissions/
|   +-- permissions.go       # Permission bit constants, role IDs, EffectivePerms
+-- storage/
|   +-- storage.go           # File storage: Save, Open, Delete, magic byte validation
+-- admin/
|   +-- admin.go             # NewHandler: chi router, embedded static files
|   +-- api.go               # NewAdminAPI: admin REST routes, auth middleware
|   +-- handlers_users.go    # Admin user management (list, ban, unban, role change, etc.)
|   +-- handlers_channels.go # Admin channel management (create, update, delete, reorder)
|   +-- handlers_settings.go # Admin settings (get/patch server settings)
|   +-- handlers_backup.go   # Backup/restore endpoints
|   +-- update_handlers.go   # Server update check/apply
|   +-- setup_handler.go     # First-run setup wizard
|   +-- logstream.go         # Log ring buffer, MultiHandler for admin log viewer
+-- updater/
|   +-- (updater logic)      # GitHub release checking, binary download, hot-swap
+-- migrations/
|   +-- *.sql                # Embedded SQL migration files (ordered)
```

---

## Server Startup Flow

The `main()` function in `main.go` orchestrates startup in this exact order:

```text
1. Initialize logging
   +-- Create admin log ring buffer (2000 entries)
   +-- Create multi-handler: stdout (INFO+) + ring buffer (DEBUG+)
   +-- Set as default slog logger

2. Clean up old binary
   +-- Remove chatserver.exe.old from previous update (if exists)

3. Load configuration
   +-- config.Load("config.yaml")
   +-- Layer 1: struct defaults
   +-- Layer 2: YAML file (auto-created if missing)
   +-- Layer 3: OWNCORD_* environment variable overrides
   +-- Validate YAML syntax
   +-- Apply voice defaults, reject default dev credentials

4. Ensure data directory
   +-- os.MkdirAll(cfg.Server.DataDir, 0755)

5. Configure TLS
   +-- auth.LoadOrGenerate(cfg.TLS)
   +-- self_signed: generate cert+key if not present
   +-- acme: Let's Encrypt via autocert
   +-- manual: load user-provided cert/key files
   +-- off: no TLS (for Tailscale/local use)

6. Print startup banner to stderr

7. Open database + run migrations
   +-- db.Open(path) with WAL, foreign keys, pragmas
   +-- db.Migrate(database) -- apply all unapplied .sql files
   +-- Reset all user statuses to "offline" (clear stale state)
   +-- Clear all voice states (clear stale state)

8. Build HTTP router
   +-- api.NewRouter(cfg, database, version, logBuf)
   +-- Returns (http.Handler, *ws.Hub)
   +-- Hub.Run() started in goroutine inside NewRouter

9. Create HTTP server
   +-- ReadTimeout:  30s
   +-- WriteTimeout: 30s
   +-- IdleTimeout:  120s
   +-- ErrorLog:     discard (suppress TLS handshake noise)

10. Start ACME challenge server on :80 (if tls.mode == "acme")

11. Start background maintenance goroutine
    +-- Every 15 minutes: purge expired sessions, clean orphan attachments
    +-- Circuit breaker: skip after 5 consecutive failures

12. Listen for OS signals (SIGINT, SIGTERM)

13. Start serving (with port retry)
    +-- Up to 20 retries if port is in use (500ms delay)
    +-- ListenAndServeTLS or ListenAndServe

14. Wait for shutdown signal or server error
```

---

## Configuration System

Configuration is loaded via koanf in three layers (later layers override):

| Layer | Source | Example |
|-------|--------|---------|
| 1 | Go struct defaults | `config.defaults()` |
| 2 | `config.yaml` file | Auto-created on first run |
| 3 | Environment variables | `OWNCORD_SERVER_PORT=9443` |

### All Configuration Options

```yaml
server:
  port: 8443                        # HTTPS listen port
  name: "OwnCord Server"            # Server display name
  data_dir: "data"                   # Base directory for DB, uploads, certs
  allowed_origins: ["*"]             # WebSocket origin whitelist
  trusted_proxies: []                # CIDRs for X-Forwarded-For trust
  admin_allowed_cidrs:               # CIDRs that can access /admin
    - "127.0.0.0/8"                  # localhost IPv4
    - "::1/128"                      # localhost IPv6
    - "10.0.0.0/8"                   # private class A
    - "172.16.0.0/12"                # private class B
    - "192.168.0.0/16"               # private class C
    - "fc00::/7"                     # IPv6 unique local

database:
  path: "data/chatserver.db"         # SQLite database file path

tls:
  mode: "self_signed"                # self_signed | acme | manual | off
  cert_file: "data/cert.pem"         # cert path (self_signed and manual)
  key_file: "data/key.pem"           # key path (self_signed and manual)
  domain: ""                         # required for acme mode
  acme_cache_dir: "data/acme_certs"  # Let's Encrypt cert cache

upload:
  max_size_mb: 100                   # max file upload size
  storage_dir: "data/uploads"        # file storage directory

voice:
  livekit_api_key: ""                # LiveKit API key (REQUIRED for voice)
  livekit_api_secret: ""             # LiveKit API secret (REQUIRED, min 32 chars)
  livekit_url: "ws://localhost:7880" # LiveKit server WebSocket URL
  livekit_binary: ""                 # path to livekit-server binary (empty = external)
  quality: "medium"                  # default voice quality: low|medium|high

github:
  token: ""                          # optional: GitHub API token for update checks
```

### Environment Variable Mapping

Environment variables use the `OWNCORD_` prefix with the pattern
`OWNCORD_{SECTION}_{KEY}`. The first underscore separates section from key:

- `OWNCORD_SERVER_PORT=9443` maps to `server.port`
- `OWNCORD_DATABASE_PATH=mydb.db` maps to `database.path`
- `OWNCORD_TLS_MODE=off` maps to `tls.mode`
- `OWNCORD_UPLOAD_MAX_SIZE_MB=50` maps to `upload.max_size_mb`

### Voice Credential Safety

The server rejects the well-known default dev credentials (`devkey` /
`owncord-dev-secret-key-min-32chars`). If no credentials are configured,
random keys are generated at startup with a warning -- these break on
restart since LiveKit tokens become invalid. Operators must set stable
credentials in `config.yaml` for production use.

---

## Database Layer

### SQLite Configuration

The `db.Open()` function configures SQLite with these PRAGMAs:

| PRAGMA | Value | Purpose |
|--------|-------|---------|
| `journal_mode` | WAL | Better concurrent read performance |
| `busy_timeout` | 5000ms | Wait for write lock instead of SQLITE_BUSY |
| `foreign_keys` | ON | Enforce referential integrity |
| `synchronous` | NORMAL | Safe with WAL, better write performance |
| `temp_store` | MEMORY | Temp tables in RAM |
| `mmap_size` | 256 MB | Memory-mapped I/O for reads |
| `cache_size` | -64000 | 64 MB page cache |
| `MaxOpenConns` | 1 | Single writer -- Go queues concurrent writes |

### Connection Model

SQLite is pinned to a single connection (`SetMaxOpenConns(1)`) so
concurrent goroutines queue on the Go side rather than getting
`SQLITE_BUSY`. For `:memory:` databases this also ensures all callers
share the same in-memory state.

### On Close

`PRAGMA optimize` is run before closing to update query planner statistics.

### Migration System

Migrations are embedded SQL files in `Server/migrations/` loaded via
`embed.FS`. The `Migrate()` function (calls `MigrateFS()` internally):

1. Creates a `schema_versions` tracking table (if not exists)
2. Lists all `.sql` files in lexicographic order
3. Checks each file against `schema_versions`
4. Applies unapplied files within a transaction
5. Records each applied migration in `schema_versions`

### Database Models

Key Go structs in `db/models.go`:

- **User**: id, username, password_hash, avatar, role_id, totp_secret,
  status, banned, ban_reason, ban_expires
- **Session**: id, user_id, token_hash, device, ip, expires_at (30-day TTL)
- **Channel**: id, name, type (text/voice/dm), category, topic, position,
  slow_mode, archived, voice_max_users, voice_quality, voice_max_video
- **Message**: id, channel_id, user_id, content, reply_to, edited_at,
  deleted, pinned, timestamp
- **Role**: id, name, color, permissions (bitfield), position, is_default
- **VoiceState**: user_id, channel_id, username, muted, deafened,
  speaking, camera, screenshare
- **Invite**: id, code, created_by, uses, max_uses, expires_at, revoked

### Sentinel Errors

`db/errors.go` defines four sentinel errors used throughout the DB layer:

- `ErrNotFound` -- resource does not exist
- `ErrForbidden` -- caller lacks permission
- `ErrConflict` -- uniqueness constraint violation
- `ErrBanned` -- user is banned

### Query Organization

Database queries are split across focused files by domain:

| File | Responsibilities |
|------|------------------|
| `auth_queries.go` | CreateUser, GetUserByID/Username, CreateSession, DeleteSession, GetSessionByTokenHash, UpdateUserStatus, ResetAllUserStatuses |
| `channel_queries.go` | ListChannels, GetChannel, channel CRUD, GetChannelPermissions, UpdateReadState, GetChannelUnreadCounts |
| `message_queries.go` | CreateMessage, GetMessage, EditMessage, DeleteMessage, SearchMessages (FTS5), reactions, pins |
| `voice_queries.go` | JoinVoiceChannel, LeaveVoiceChannel, UpdateVoiceMute/Deafen/Camera/Screenshare, GetVoiceState, GetAllVoiceStates, CountActiveCameras, ClearAllVoiceStates |
| `dm_queries.go` | GetOrCreateDMChannel, GetUserDMChannels, OpenDM, CloseDM, IsDMParticipant, GetDMParticipantIDs |
| `invite_queries.go` | CreateInvite, UseInviteAtomic, ListInvites |
| `attachment_queries.go` | CreateAttachment, LinkAttachmentsToMessage, GetAttachmentsByMessageIDs, DeleteOrphanedAttachments |
| `admin_queries.go` | GetServerStats, LogAudit, GetAuditLog, user management, backup/restore |

---

## HTTP Router and Middleware Stack

### Router Assembly (`api.NewRouter`)

The router is assembled using `go-chi/chi/v5`:

```text
Global middleware stack (applied to ALL routes):
  1. middleware.RequestID        -- generates unique request ID
  2. setRequestIDHeader          -- echoes request ID in X-Request-Id header
  3. middleware.Recoverer        -- panic recovery (returns 500)
  4. requestLogger               -- structured logging (Debug for /health)
  5. SecurityHeaders             -- defensive headers on every response
  6. MaxBodySizeUnless(1MB)      -- 1 MiB body limit (upload route exempt)

NOTE: middleware.RealIP is intentionally OMITTED to prevent IP spoofing
for rate-limit bypass. IP resolution uses clientIPWithProxies with
explicit trusted_proxies config.
```

### Middleware Details

#### AuthMiddleware

Reads `Authorization: Bearer <token>`, validates the session:

1. Extract bearer token from header
2. SHA-256 hash the token
3. Look up session by token hash in DB
4. Check session expiry
5. Load user by session's user_id
6. Check ban status (including temp ban expiry)
7. Load user's role
8. Touch session (update last_used timestamp)
9. Inject User, Session, Role into request context

#### RequirePermission(perm)

Checks the context role's permission bitfield. The `ADMINISTRATOR` bit
(`0x40000000`) bypasses all checks. Returns 403 FORBIDDEN if missing.

#### RateLimitMiddleware(limiter, limit, window, trustedProxies...)

Sliding-window rate limiter per IP. Resolves client IP via
`clientIPWithProxies` which only trusts `X-Real-IP` / `X-Forwarded-For`
headers when the connecting IP is in `trusted_proxies`. Returns 429
with `Retry-After` header.

#### AdminIPRestrict(allowedCIDRs)

Blocks requests from IPs not matching the allowed CIDR list. Returns
403 Forbidden. If the CIDR list is empty, all requests are allowed.
Default CIDRs: private networks + localhost.

#### SecurityHeaders

Applied to every response:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Block clickjacking |
| `X-XSS-Protection` | `0` | Disable legacy XSS filter |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer |
| `Content-Security-Policy` | `default-src 'self'` | CSP baseline |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Restrict features |
| `Cache-Control` | `no-store` | Prevent caching |

#### MaxBodySizeUnless(maxBytes, exemptPaths...)

Wraps `r.Body` with `http.MaxBytesReader`. Upload route (`/api/v1/uploads`)
is exempt from the 1 MiB default -- it applies its own 100 MiB limit.

---

## REST API Endpoints

All REST routes live under `/api/v1/`. Documented in detail in API.md.

### Unauthenticated Routes

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/health` | `handleHealth` | Status, version, uptime |
| GET | `/api/v1/health` | `handleHealth` | Same as above |
| GET | `/api/v1/info` | `handleInfo` | Server name, version |

### Auth Routes (`/api/v1/auth/`)

| Method | Path | Handler | Rate Limit | Notes |
|--------|------|---------|------------|-------|
| POST | `/register` | `handleRegister` | 3/min/IP | Invite code required |
| POST | `/login` | `handleLogin` | 60/min/IP | Lockout after 10 failures |
| POST | `/logout` | `handleLogout` | AuthMiddleware | Deletes session |
| GET | `/me` | `handleMe` | AuthMiddleware | Returns current user |

### Channel Routes (`/api/v1/channels/`)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/` | `handleListChannels` | Filtered by ReadMessages perm |
| GET | `/{id}/messages` | `handleGetMessages` | Paginated, 50 default, 100 max |
| GET | `/{id}/pins` | `handleGetPins` | Pinned messages |
| POST | `/{id}/pins/{messageId}` | `handleSetPinned(true)` | Pin a message |
| DELETE | `/{id}/pins/{messageId}` | `handleSetPinned(false)` | Unpin a message |

### DM Routes (`/api/v1/dms/`)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| POST | `/` | `handleCreateDM` | Get or create DM channel |
| GET | `/` | `handleListDMs` | List user's open DMs |
| DELETE | `/{channelId}` | `handleCloseDM` | Close DM (hides, does not delete) |

### Upload Routes

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| POST | `/api/v1/uploads` | `handleUpload` | Multipart, 100 MB limit |
| GET | `/api/v1/files/{id}` | `handleServeFile` | Public (UUID-based security) |

### Search

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/api/v1/search` | `handleSearch` | FTS5 full-text search |

### Invite Routes (`/api/v1/invites/`)

Require `MANAGE_INVITES` permission.

### Admin-Restricted Routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/metrics` | Runtime stats (goroutines, heap, clients) |
| POST | `/api/v1/livekit/webhook` | LiveKit webhook receiver |
| GET | `/api/v1/livekit/health` | LiveKit health probe |

### LiveKit Proxy

| Pattern | Notes |
|---------|-------|
| `/livekit/*` | Reverse proxy to LiveKit (30/min rate limit) |

### Client Update

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/client-update/{target}/{current_version}` | Tauri-compatible auto-update check |

---

## WebSocket Hub Architecture

### Hub Structure

The Hub (`ws/hub.go`) is the central message router. It runs in its own
goroutine and manages all connected clients.

```text
Hub struct:
  clients      map[int64]*Client    -- one client per user ID
  mu           sync.RWMutex         -- guards clients map
  db           *db.DB               -- database handle
  limiter      *auth.RateLimiter    -- shared rate limiter
  broadcast    chan broadcastMsg     -- buffered (256), message delivery queue
  register     chan *Client          -- buffered (32), new client queue
  unregister   chan *Client          -- buffered (32), departing client queue
  stop         chan struct{}         -- shutdown signal
  livekit      *LiveKitClient       -- voice token generation + room mgmt
  lkProcess    *LiveKitProcess      -- companion process manager
  seq          uint64               -- atomic monotonic sequence counter
  replayBuf    *EventRingBuffer     -- 1000-event ring buffer for reconnection
  settings*    string/time          -- cached server_name and motd (30s TTL)
```

### Hub.Run() Event Loop

The hub processes events in a single-goroutine select loop:

```text
for {
    select {
    case <-stop:        -> exit
    case c := <-register:    -> clients[c.userID] = c
    case c := <-unregister:  -> delete(clients, c.userID) [if same ptr]
    case bm := <-broadcast:  -> deliverBroadcast(bm)
    case <-staleTicker.C:    -> sweepStaleClients() [every 30s]
    }
}
```

**Panic recovery**: If the select loop panics, it recovers and restarts.
After 3 panics within 60 seconds, the hub stops permanently to prevent
a tight crash loop.

### Client Structure

Each WebSocket connection is represented by a Client (`ws/client.go`):

```text
Client struct:
  hub          *Hub              -- back-reference to hub
  conn         wsConn            -- nhooyr.io/websocket connection (nil in tests)
  userID       int64             -- authenticated user ID
  user         *db.User          -- full user record
  channelID    int64             -- currently focused channel (channel-scoped broadcasts)
  voiceChID    int64             -- voice channel ID (0 = not in voice)
  roleName     string            -- cached role name (for chat_message payloads)
  tokenHash    string            -- SHA-256 of session token (periodic revalidation)
  msgCount     int               -- messages since last session check
  invalidCount int               -- consecutive invalid JSON messages
  lastActivity time.Time         -- for stale connection detection
  send         chan []byte        -- buffered (256), outbound message queue
  sendClosed   bool              -- prevents double-close of send channel
  mu           sync.Mutex        -- guards sendClosed, msgCount, channelID, lastActivity
  voiceMu      sync.Mutex        -- guards voiceChID
```

### Message Delivery

The `deliverBroadcast()` method:

1. Stamps the message with a monotonic sequence number via `wrapWithSeq()`
2. Stores the sequenced message in the replay ring buffer
3. Iterates all clients under RLock:
   - `channelID == 0` broadcasts to everyone
   - Otherwise, only clients whose `channelID` or `voiceChID` matches

`sendMsg()` is non-blocking: if the client's 256-slot send buffer is
full, the message is silently dropped. `BroadcastToChannel()` and
`BroadcastToAll()` are also non-blocking -- if the hub's 256-slot
broadcast channel is full, the message is dropped with a warning log.

### WebSocket Connection Lifecycle

```text
1. HTTP upgrade via websocket.Accept (origin validation applied)
2. Set read limit to 1 MB
3. authenticateConn():
   a. Read first message within 10s deadline
   b. Expect type "auth" with { token, last_seq }
   c. SHA-256 hash the token
   d. Look up session by hash, check expiry
   e. Load user, check ban status
   f. Return (user, tokenHash, lastSeq)
4. Reject duplicate connections (one client per user)
5. Create Client, register with hub
6. Look up and cache role name
7. Log ws_connect in audit log
8. If lastSeq > 0 (reconnection):
   a. Try EventsSince(lastSeq) from ring buffer
   b. If events found: send auth_ok, replay events, skip ready
   c. If too old: fall through to full ready
9. Full ready flow:
   a. Set user status to "online" in DB
   b. Send auth_ok (user info, server_name, motd)
   c. Send ready (channels, members, voice_states, roles, dm_channels)
   d. Broadcast member_join and presence to all clients
10. Start writePump (goroutine) and readPump (blocking)
11. On disconnect: unregister, leave voice, set offline, broadcast
```

### readPump and writePump

**readPump** (blocking): reads messages from the WebSocket, calls
`client.touch()` on each message, dispatches to `hub.handleMessage()`.
On return: unregister, voice leave, set offline, broadcast presence.

**writePump** (goroutine): reads from `client.send` channel, writes to
WebSocket with 10s timeout. Exits when send channel is closed or context
is cancelled.

---

## WebSocket Message Dispatch

The `handleMessage()` function in `ws/handlers.go` is the central dispatcher:

### Periodic Session Check

Every `SessionCheckInterval` (10) messages, the session token is
revalidated against the database. This catches:

- Sessions revoked by admin while WS is open
- Sessions that expire during a long connection
- Users banned while connected

If the session is invalid or user is banned, the client is kicked.

### Invalid Message Protection

Consecutive invalid JSON messages are tracked. After 10 in a row, the
client is kicked to prevent abuse.

### Message Type Routing

| Type | Handler | Rate Limit |
|------|---------|------------|
| `chat_send` | `handleChatSend` | 10/sec/user |
| `chat_edit` | `handleChatEdit` | 10/sec/user |
| `chat_delete` | `handleChatDelete` | 10/sec/user |
| `reaction_add` | `handleReaction(true)` | 5/sec/user |
| `reaction_remove` | `handleReaction(false)` | 5/sec/user |
| `typing_start` | `handleTyping` | 1/3sec/user/channel |
| `presence_update` | `handlePresence` | 1/10sec/user |
| `channel_focus` | `handleChannelFocus` | -- |
| `voice_join` | `handleVoiceJoin` | -- |
| `voice_leave` | `handleVoiceLeave` | -- |
| `voice_token_refresh` | `handleVoiceTokenRefresh` | 1/60sec/user |
| `voice_mute` | `handleVoiceMute` | -- |
| `voice_deafen` | `handleVoiceDeafen` | -- |
| `voice_camera` | `handleVoiceCamera` | 2/sec/user |
| `voice_screenshare` | `handleVoiceScreenshare` | 2/sec/user |
| `ping` | (inline pong) | -- |

### Chat Send Flow (Detailed)

1. Rate limit check (10 msgs/sec)
2. Parse payload: channel_id, content, reply_to, attachments
3. Validate channel_id (positive integer, channel exists)
4. Permission check:
   - DM channels: `IsDMParticipant` check
   - Regular channels: `SEND_MESSAGES` permission
5. Slow mode enforcement (moderators with `MANAGE_MESSAGES` bypass)
6. HTML sanitization via bluemonday strict policy
7. Content validation: non-empty (unless attachments), max 4000 runes
8. Attachment permission check (`ATTACH_FILES`)
9. Persist message in DB
10. Link attachments to message (rollback on failure)
11. Retrieve message to get timestamp
12. Send `chat_send_ok` ack to sender (with request ID)
13. Build `chat_message` broadcast
14. Deliver:
    - DM: `SendToUser` to each participant + auto-reopen for recipient
    - Regular: `BroadcastToChannel`

---

## Reconnection and Ring Buffer

### EventRingBuffer

`ws/ringbuffer.go` implements a bounded, thread-safe ring buffer:

```text
EventRingBuffer:
  entries  []eventEntry       -- fixed-size array (default 1000)
  size     int                -- capacity
  pos      int                -- next write position (circular)
  count    int                -- total stored (up to size)
  mu       sync.RWMutex       -- read/write lock
```

- **Push(seq, data)**: writes event at `pos`, advances `pos % size`
- **EventsSince(afterSeq)**: returns all events with `seq > afterSeq`,
  in order. Returns `nil` if `afterSeq` is older than the oldest buffered
  event (client is too far behind -- needs full ready).
- **OldestSeq()**: returns the oldest sequence number in the buffer.

### Reconnection Flow

1. Client disconnects (network issue, browser refresh, etc.)
2. Client reconnects, sends auth with `last_seq` (the seq of the last
   received message)
3. Server calls `EventsSince(last_seq)`:
   - If events are available: send `auth_ok`, then replay all missed
     events. No `ready` payload or `member_join` -- the client already
     has base state.
   - If `last_seq` is too old (not in buffer): fall through to full
     ready payload, as if it were a fresh connection.

### Sequence Numbers

Every broadcast message is stamped with a monotonic sequence number using
`wrapWithSeq()`, which injects `"seq":N` into the JSON without
re-serializing. The counter is `uint64` and uses `atomic.AddUint64`.

---

## Heartbeat Monitoring

### Client-Side Ping

The client sends a `{"type":"ping"}` message every 30 seconds.
The server responds with `{"type":"pong"}`.

### Server-Side Stale Sweep

Every 30 seconds (`staleTicker` in `Hub.Run()`), the hub calls
`sweepStaleClients()`:

1. Read-lock the clients map
2. Find any client whose `lastActivity` is older than 90 seconds
3. Release read lock
4. Kick each stale client: remove from map, close send channel

The 90-second timeout is 3x the client's 30-second ping interval,
giving plenty of margin for network jitter.

---

## LiveKit Integration

### LiveKitClient (`ws/livekit.go`)

Wraps the LiveKit server SDK. Created from `config.VoiceConfig`:

- Rejects empty credentials and well-known default dev credentials
- Converts `ws://` to `http://` for the REST API URL
- Creates a `RoomServiceClient` for room/participant management

**Methods:**

| Method | Purpose |
|--------|---------|
| `GenerateToken(userID, username, channelID, canPublish, canSubscribe)` | Creates a LiveKit JWT (4-hour TTL) with permissions derived from the user's role |
| `RemoveParticipant(channelID, userID)` | Force-disconnects a user from a room |
| `ListParticipants(channelID)` | Returns all participants in a room |
| `CountVideoTracks(channelID)` | Counts active video tracks (for MaxVideo enforcement) |
| `HealthCheck()` | Probes LiveKit by listing rooms (3s timeout) |
| `URL()` | Returns the LiveKit WebSocket URL |

**Room naming convention:** `channel-{channelID}` (e.g., `channel-42`)

**Identity format:** `user-{userID}` (e.g., `user-7`)

**Token permissions:**

- `canPublish` and `CanPublishData` are derived from `SPEAK_VOICE`
  permission -- prevents SFU-level bypass if a user connects to LiveKit
  directly via `direct_url`
- `canSubscribe` is always `true`

### LiveKitProcess (`ws/livekit_process.go`)

Manages a companion `livekit-server` binary alongside `chatserver.exe`:

1. **generateConfig()**: auto-generates a minimal `data/livekit.yaml`
   with API keys, port range 50000-60000, and logging config. Validates
   credentials against YAML-unsafe characters to prevent injection.
2. **Start()**: launches `livekit-server --config data/livekit.yaml`
   in a background goroutine.
3. **runLoop()**: supervises the process with exponential backoff:
   - Base delay: 3 seconds, doubles on each rapid failure, caps at 60s
   - A failure is "rapid" if the process exits within 30 seconds
   - After 10 rapid failures, gives up permanently
   - If the process runs for 30+ seconds, the failure count resets
4. **Stop()**: cancels context, waits up to 5 seconds for exit, then
   kills the process.

### LiveKit Proxy (`api/livekit_proxy.go`)

A reverse proxy that forwards both HTTP and WebSocket requests from
`wss://server:8443/livekit/*` to `ws://localhost:7880/*`. This solves
the mixed-content block in WebView2 (secure page connecting to insecure
WebSocket).

- WebSocket upgrade requests are detected and proxied via bidirectional
  `copyWS()` shoveling
- HTTP requests use `httputil.ReverseProxy`
- Rate limited to 30 requests/minute
- No AuthMiddleware -- authentication is handled by the LiveKit JWT
  (`access_token` query param). Users can only obtain a valid JWT through
  the authenticated `voice_join` WS flow.

### LiveKit Webhook (`ws/livekit_webhook.go`)

Handles `POST /api/v1/livekit/webhook` (admin-IP-restricted):

1. Reads body (max 64 KB)
2. Extracts and validates the LiveKit JWT from Authorization header
3. Verifies API key match and HMAC signature
4. Processes events:
   - **participant_joined**: log only (state already persisted by handleVoiceJoin)
   - **participant_left**: clean up ghost voice state if user disconnected
     from LiveKit without sending a WS `voice_leave` (crash recovery)

---

## Voice System

### Voice Join Flow

```text
1. Parse channel_id from payload
2. Check CONNECT_VOICE permission (with channel overrides)
3. Validate target channel exists
4. Hard-fail if LiveKit is not configured
5. Hard-fail if companion LiveKit process has crashed
6. If already in same channel: no-op error
7. If in different channel: leave it first (handleVoiceLeave)
8. Check channel capacity (voice_max_users)
9. Persist join in DB (voice_states table)
10. Set voiceChID on the client
11. Generate LiveKit token:
    - canPublish derived from SPEAK_VOICE permission
    - On failure: rollback DB join + clear client state
12. Send voice_token to client (both proxy path and direct URL)
13. Get and broadcast joiner's voice_state to all clients
14. Send existing channel voice states to the joiner
15. Send voice_config (quality, bitrate, max_users)
```

### Voice Leave Flow

```text
1. clearVoiceChID() -- atomic swap to 0, returns old value
2. If was not in voice: no-op
3. Remove from DB (voice_states)
4. Broadcast voice_leave to all clients
5. RemoveParticipant from LiveKit (best-effort)
```

### Voice Controls

| Control | Handler | Permission Check | Notes |
|---------|---------|-------------------|-------|
| Mute | `handleVoiceMute` | -- | Toggle muted bool |
| Deafen | `handleVoiceDeafen` | -- | Toggle deafened bool |
| Camera | `handleVoiceCamera` | `USE_VIDEO` | MaxVideo limit enforced via DB count |
| Screenshare | `handleVoiceScreenshare` | `SHARE_SCREEN` | Rate limited 2/sec |

All voice controls follow the same pattern:
1. Verify user is in a voice channel
2. Parse the boolean state from payload
3. Permission check (camera/screenshare only)
4. Update voice_states in DB
5. Broadcast updated voice_state to all clients

### Voice Quality Presets

| Preset | Bitrate (Opus) |
|--------|----------------|
| `low` | 32,000 bps |
| `medium` | 64,000 bps |
| `high` | 128,000 bps |

Quality is configured per-channel (`voice_quality` column) or falls
back to the server default.

### Rollback on Failure

`rollbackVoiceJoin()` undoes a partially-completed voice join:
1. Clears client `voiceChID`
2. Removes DB voice state row
3. Broadcasts `voice_leave` so other clients don't see a ghost participant

---

## Direct Messages (DM System)

### Server-Side Architecture

DM channels are regular channels with `type = "dm"`. They are never
shown in the channel list -- they appear only via the DM-specific APIs
and in the `ready` payload's `dm_channels` array.

### DM Authorization Model

DM channels use **participant-based** auth instead of role-based
permissions. Every handler that touches a channel must branch on
`ch.Type == "dm"` and verify participant membership via
`db.IsDMParticipant(userID, channelID)`.

Affected handlers (both WS and REST):
- `channel_focus`, `typing`, `chat_send`, `chat_edit`, `chat_delete`,
  `reaction_add/remove` (WS)
- `GET /channels/{id}/messages`, `GET /channels/{id}/pins` (REST)

### DM Message Delivery

DM messages bypass the channel-subscription broadcast model. Instead of
`BroadcastToChannel()`, the server uses `SendToUser()` for each
participant. This is correct because users may not be "focused" on the
DM channel.

### Auto-Reopen

When a message is sent to a DM that the recipient has closed, the server
automatically reopens it for the recipient:
1. Calls `db.OpenDM(recipientID, channelID)`
2. Sends a `dm_channel_open` WebSocket event to the recipient

### REST Endpoints

- **POST /api/v1/dms**: Get-or-create a DM channel with a recipient.
  Returns the channel ID, recipient info, and whether it was newly
  created. Self-DM is rejected.
- **GET /api/v1/dms**: List all open DM channels for the current user.
- **DELETE /api/v1/dms/{channelId}**: Close (hide) a DM. Does not delete
  messages. Sends a `dm_channel_close` WebSocket event so the sidebar
  updates immediately.

---

## File Upload Handling

### Upload Flow (`POST /api/v1/uploads`)

1. Authenticated via `AuthMiddleware`
2. 100 MiB body size limit (route-scoped)
3. Parse multipart form (10 MB in memory, rest on disk)
4. Generate UUID filename
5. Detect MIME type from Content-Type header
6. **Magic byte validation**: reads first 8 bytes, rejects:
   - PE executables (`MZ` header) -- `.exe`, `.dll`
   - ELF binaries (`\x7fELF`) -- Linux
   - Mach-O binaries -- macOS
   - Shell scripts (`#!` shebang)
7. Write file to `data/uploads/{uuid}` via `storage.Save()`
   - Validates size against `upload.max_size_mb`
   - Oversized files are deleted after detection
8. Extract image dimensions for `image/*` MIME types
9. Create attachment record in DB (unlinked -- `message_id` is NULL)
10. Return upload response with file URL

### File Serving (`GET /api/v1/files/{id}`)

- Public (no auth) -- security via unguessable UUID filenames
- Looks up attachment metadata from DB
- Sets correct MIME type, Content-Disposition, Cache-Control (1 year)
- CORS headers for WebView access
- Serves via `http.ServeContent` (supports range requests)

### Path Traversal Protection

`storage.sanitizeFilename()` rejects:
- Empty strings, `.`, `..`
- Filenames with path separators (`/`, `\`)
- Filenames starting with `.` (hidden files)

`storage.resolvedPath()` verifies the joined path stays within the
storage directory.

### Orphan Cleanup

Attachments uploaded but never linked to a message (NULL `message_id`)
are cleaned up by the background maintenance loop after 1 hour. The DB
rows are deleted first, then the files on disk (best-effort).

---

## Admin Panel

### Architecture

The admin panel is a browser-based SPA (HTML/CSS/JS) embedded in the
server binary via Go's `embed.FS`. It is served at `/admin` and
restricted to `admin_allowed_cidrs` (default: private networks only).

### Admin Authentication

The admin panel uses OwnCord's own auth system. The admin REST API
(`/admin/api/*`) requires both:
1. A valid session token (same Bearer auth as the main API)
2. The user's role must have the `ADMINISTRATOR` permission bit

### Admin REST API Endpoints (`/admin/api/`)

| Domain | Key Endpoints |
|--------|---------------|
| Setup | `GET /setup/status`, `POST /setup` (unauthenticated, first-run only) |
| Dashboard | `GET /stats` -- user/message/channel/invite counts, DB size |
| Users | `GET /users`, `PATCH /users/{id}` (role change, ban/unban via `banned` field), `DELETE /users/{id}/sessions` (force logout) |
| Channels | `GET /channels`, `POST /channels`, `PATCH /channels/{id}`, `DELETE /channels/{id}` |
| Settings | `GET /settings`, `PATCH /settings` (whitelisted keys only) |
| Audit Log | `GET /audit-log` |
| Backup | `POST /backup`, `GET /backups`, `DELETE /backups/{name}`, `POST /backups/{name}/restore` (owner-only) |
| Updates | `GET /updates`, `POST /updates/apply` (owner-only) |
| Logs | `GET /logs/stream` (SSE, token via query param) |

Note: Invite management is handled via the main API (`/api/v1/invites`),
not via admin endpoints.

### Settings Whitelist

Only these keys can be written via `PATCH /admin/api/settings`:
`server_name`, `server_icon`, `motd`, `max_upload_bytes`,
`voice_quality`, `require_2fa`, `registration_open`,
`backup_schedule`, `backup_retention`.

### Server Update Flow

1. `GET /admin/api/updates/check` queries GitHub Releases for the latest
   version (compares via semver)
2. `POST /admin/api/updates/apply` downloads the new binary, renames the
   current exe to `.old`, writes the new binary, then restarts the process
3. On next startup, the `.old` file is cleaned up

### Live Log Streaming

The admin panel can stream server logs in real-time via SSE (Server-Sent
Events) at `GET /admin/api/logs/stream`. Logs are sourced from the
`admin.RingBuffer` (2000 entries) which receives all log records at
DEBUG level via a `MultiHandler`.

---

## Authentication and Sessions

### Password Handling

- Hashed with bcrypt at cost 12
- Minimum 8 characters, maximum 72 (bcrypt truncation limit)
- `ValidatePasswordStrength()` enforces length rules before hashing
- **Timing-safe**: `CheckPassword()` always performs a bcrypt comparison,
  even when the user doesn't exist (compares against a precomputed dummy
  hash to prevent timing-based username enumeration)

### Session Tokens

- 256-bit random token generated via `crypto/rand`
- Stored as SHA-256 hex digest in the DB (never plaintext)
- 30-day TTL (`sessionTTL = 30 * 24 * time.Hour`)
- `last_used` is updated on each API request (session touch)
- Expired sessions are purged every 15 minutes by the maintenance loop

### Login Flow

1. Rate limit check (60 attempts/min/IP)
2. Check lockout status (`login_lock:{ip}`)
3. Constant-time lookup: always attempt bcrypt compare
4. On failure: track via `login_fail:{ip}`, lockout after 10 failures
   (15-minute lockout)
5. On success: reset failure counter, check ban status
6. **2FA Check**: If user has `totp_enabled = true` OR server enforces
   `require_2fa` policy:
   - Issue a **partial token** (10-minute TTL, stored as UUID)
   - Return `requires_2fa: true` + `partial_token` to client
   - Client shows TOTP overlay (QR code during enrollment, or code input
     for login challenge)
7. **2FA Verification** (if required): On receipt of TOTP code:
   - Validate code against user's `totp_secret` (6-digit, 30s window ±1)
   - Rate limit: 5 attempts per challenge, 10 req/min per IP
   - On success: exchange partial token for full session token
   - On failure: return error, remain in challenge state
8. On success (no 2FA or after 2FA): reset failure counter, issue session
   token, log audit event
9. Return token + user object

### WebSocket Authentication

WebSocket connections do NOT use the `AuthMiddleware`. Instead, the first
message must be `{"type":"auth","payload":{"token":"...","last_seq":0}}`.
The token is validated in-band via `authenticateConn()`.

Duplicate connections are rejected: only one WebSocket connection per
user ID is allowed. This prevents ping-pong reconnect loops.

---

## Permission System

### Permission Bitfield

Permissions are a 64-bit integer bitfield defined in `permissions/permissions.go`:

| Bit | Value | Name | Description |
|-----|-------|------|-------------|
| 0 | `0x0001` | `SEND_MESSAGES` | Send text messages |
| 1 | `0x0002` | `READ_MESSAGES` | View channel content |
| 5 | `0x0020` | `ATTACH_FILES` | Upload file attachments |
| 6 | `0x0040` | `ADD_REACTIONS` | Add emoji reactions |
| 8 | `0x0100` | `USE_SOUNDBOARD` | Use soundboard |
| 9 | `0x0200` | `CONNECT_VOICE` | Join voice channels |
| 10 | `0x0400` | `SPEAK_VOICE` | Speak in voice (publish audio) |
| 11 | `0x0800` | `USE_VIDEO` | Enable camera |
| 12 | `0x1000` | `SHARE_SCREEN` | Share screen |
| 16 | `0x10000` | `MANAGE_MESSAGES` | Edit/delete others' messages |
| 17 | `0x20000` | `MANAGE_CHANNELS` | Create/edit/delete channels |
| 18 | `0x40000` | `KICK_MEMBERS` | Kick users |
| 19 | `0x80000` | `BAN_MEMBERS` | Ban users |
| 20 | `0x100000` | `MUTE_MEMBERS` | Server-mute users |
| 24 | `0x1000000` | `MANAGE_ROLES` | Create/edit roles |
| 25 | `0x2000000` | `MANAGE_SERVER` | Edit server settings |
| 26 | `0x4000000` | `MANAGE_INVITES` | Manage invite codes |
| 27 | `0x8000000` | `VIEW_AUDIT_LOG` | View audit history |
| 30 | `0x40000000` | `ADMINISTRATOR` | Bypasses ALL checks |

### Default Roles (inserted on first run)

| ID | Name | Position | Notes |
|----|------|----------|-------|
| 1 | Owner | 100 | All 31 bits set including ADMINISTRATOR |
| 2 | Admin | 80 | Bits 0-29 (everything except ADMINISTRATOR) |
| 3 | Moderator | 60 | Manage messages, kick, ban, mute |
| 4 | Member | 40 | Default for new users |

### Channel Permission Overrides

Per-channel overrides use allow/deny semantics following Discord's model:

```
effective = (rolePerm & ^deny) | allow
```

- `deny` is applied first (strips bits)
- `allow` is applied second (adds bits)
- Allow takes precedence when both target the same bit
- `ADMINISTRATOR` bypasses all override calculations

### Permission Check Flow

```text
1. Load role from DB by user's role_id
2. Check ADMINISTRATOR bit -> bypass all if set
3. Load channel overrides (allow, deny) for role + channel
4. Compute effective permissions
5. Test required permission bit(s)
```

For REST endpoints, `hasChannelPermBatch()` pre-fetches all overrides
in a single query to eliminate N+1 patterns.

---

## Rate Limiting

### Implementation

`auth/ratelimit.go` provides an in-memory sliding-window rate limiter:

- **Thread-safe**: `sync.Mutex` guards all state
- **Sliding window**: tracks individual timestamps, prunes expired ones
- **Lockout support**: `Lockout(key, duration)` blocks all requests
  regardless of window
- **Cleanup**: `Cleanup(maxWindow)` evicts stale entries to prevent
  unbounded memory growth

### Rate Limits by Feature

| Feature | Key Pattern | Limit | Window |
|---------|-------------|-------|--------|
| Registration | per-IP | 3 | 1 min |
| Login | per-IP | 60 | 1 min |
| Login failure lockout | `login_lock:{ip}` | lockout | 15 min |
| 2FA challenge attempts | per-challenge | 5 | per challenge |
| 2FA challenge requests | per-IP | 10 | 1 min |
| Chat messages | `chat:{userID}` | 10 | 1 sec |
| Chat edits | `chat_edit:{userID}` | 10 | 1 sec |
| Chat deletes | `chat_delete:{userID}` | 10 | 1 sec |
| Typing indicators | `typing:{userID}:{chID}` | 1 | 3 sec |
| Presence updates | `presence:{userID}` | 1 | 10 sec |
| Reactions | `reaction:{userID}` | 5 | 1 sec |
| Voice camera toggle | `voice_camera:{userID}` | 2 | 1 sec |
| Voice screenshare toggle | `voice_screenshare:{userID}` | 2 | 1 sec |
| Voice token refresh | `voice_token_refresh:{userID}` | 1 | 60 sec |
| LiveKit proxy | per-IP | 30 | 1 min |
| Channel slow mode | `slow:{userID}:{chID}` | 1 | {N} sec |

---

## Security Measures

### Transport Security

- **TLS by default**: self-signed certificate generated on first run
- **Four TLS modes**: self_signed, acme (Let's Encrypt), manual, off
- **ACME**: automatic HTTP-01 challenge server on :80 with redirect

### Authentication Security

- **Invite-only registration**: no open sign-ups without a valid invite code
- **Atomic invite consumption**: `UseInviteAtomic()` prevents TOCTOU races
- **bcrypt cost 12**: password hashing
- **Timing-safe login**: dummy bcrypt comparison for non-existent users
- **SHA-256 token hashing**: plaintext tokens never stored
- **30-day session TTL**: with periodic revalidation every 10 WS messages
- **Brute-force lockout**: 10 failed logins -> 15-minute IP lockout
- **Ban enforcement**: checked on login, on WS auth, and periodically
  during WS connections
- **Duplicate connection rejection**: prevents reconnect loops

### Input Validation

- **HTML sanitization**: bluemonday strict policy strips all HTML
- **Message length limit**: 4000 Unicode code points
- **Emoji validation**: max 32 chars, no control characters (U+0000-U+001F, U+007F)
- **File upload validation**: magic byte checks block executables and scripts
- **Body size limits**: 1 MiB default, 100 MiB for uploads
- **YAML config validation**: syntax check before loading

### Network Security

- **IP spoofing prevention**: X-Forwarded-For only trusted from
  `trusted_proxies` CIDRs
- **Admin IP restriction**: `/admin` routes restricted to private
  networks by default
- **Origin validation**: WebSocket origin checking via config
- **CORS**: restrictive by default, file serving allows `*` for WebView

### Application Security

- **Generic auth errors**: same error for wrong username and wrong password
  (prevents username enumeration)
- **No error detail leakage**: sanitized error messages to clients,
  detailed errors logged server-side
- **Audit logging**: all security-relevant actions are logged
- **IDOR prevention**: reaction errors are normalized regardless of
  whether the message exists or the user lacks permission
- **LiveKit credential validation**: default dev credentials are rejected
- **Path traversal protection**: filename sanitization + resolved path
  validation for file storage
- **YAML injection prevention**: LiveKit credentials validated against
  unsafe characters before interpolation

### HTTP Security Headers

See the SecurityHeaders middleware section above for the full list.

---

## Error Handling Patterns

### WebSocket Error Codes

All WebSocket errors use structured envelopes with string error codes:

| Code | Meaning |
|------|---------|
| `BAD_REQUEST` | Invalid payload or missing required field |
| `INTERNAL` | Server-side failure |
| `NOT_FOUND` | Resource does not exist |
| `FORBIDDEN` | Permission denied |
| `RATE_LIMITED` | Rate limit exceeded (includes `retry_after`) |
| `ALREADY_JOINED` | Already in the target voice channel |
| `CHANNEL_FULL` | Voice channel at capacity |
| `VOICE_ERROR` | Voice system unavailable |
| `VIDEO_LIMIT` | Maximum video streams reached |
| `BANNED` | User is banned |
| `INVALID_JSON` | Message is not valid JSON |
| `UNKNOWN_TYPE` | Unrecognized message type |
| `SLOW_MODE` | Channel slow mode active |
| `CONFLICT` | Operation conflicts (e.g., duplicate reaction) |

### REST Error Format

```json
{
  "error": "ERROR_CODE",
  "message": "human-readable description"
}
```

### Go Error Wrapping

All errors are wrapped with `fmt.Errorf("context: %w", err)` to
preserve the error chain for debugging while providing context.

### Fail-Safe Defaults

- Unparseable ban expiry -> treated as still banned
- Unparseable session expiry -> treated as expired
- Failed rate limiter CIDR parse -> silently skipped (fallback to RemoteAddr)
- Failed buildReady -> send error message instead of dropping connection
- Failed voice leave DB update -> still broadcast leave to peers
- Failed orphan file deletion -> log warning, continue

---

## Background Maintenance

A goroutine runs every 15 minutes and performs:

1. **Delete expired sessions**: removes sessions past their 30-day TTL
2. **Clean orphaned attachments**: files uploaded but never linked to a
   message (older than 1 hour) are deleted from DB, then from disk

### Circuit Breaker

If the maintenance loop fails 5 consecutive times, it skips one tick
(logs an error) then resets to 4 to allow retry. Successful ticks
reset the counter to 0.

---

## Graceful Shutdown

On SIGINT or SIGTERM:

```text
1. Log "shutdown signal received"
2. hub.GracefulStop():
   a. Broadcast server_restart("shutdown", 5) to all clients
   b. Stop LiveKit companion process (if managed)
   c. Wait 5 seconds for clients to disconnect gracefully
   d. Close all remaining client connections (close send channels)
   e. Stop the hub dispatch loop
3. srv.Shutdown(30s timeout):
   a. Stop accepting new connections
   b. Wait for in-flight requests to complete
4. Stop ACME server (if running)
5. Close maintenance goroutine
6. Log "server stopped cleanly"
```

---

## Server Libraries

| Purpose | Library | Notes |
|---------|---------|-------|
| HTTP routing | `go-chi/chi/v5` | Lightweight, stdlib-compatible |
| WebSocket | `nhooyr.io/websocket` | Modern Go WebSocket library |
| LiveKit SDK | `livekit/server-sdk-go/v2` | Token generation, room management |
| LiveKit protocol | `livekit/protocol` | Webhook types, auth tokens |
| SQLite | `modernc.org/sqlite` | Pure Go, no CGO required |
| Password hashing | `golang.org/x/crypto/bcrypt` | Cost 12 |
| HTML sanitization | `microcosm-cc/bluemonday` | Strict (strip-all) policy |
| TLS/ACME | `golang.org/x/crypto/acme/autocert` | Let's Encrypt integration |
| Config loading | `knadh/koanf/v2` | YAML + env layered config |
| YAML parsing | `go.yaml.in/yaml/v3` | Config validation |
| Structured logging | `log/slog` (stdlib) | Multi-handler via admin.MultiHandler |
| UUID generation | `google/uuid` | File attachment IDs |
| Semver comparison | `golang.org/x/mod/semver` | Update version checking |
