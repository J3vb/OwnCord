# Go Server Coding Patterns

Canonical patterns extracted from the OwnCord codebase. AI agents must
follow these exactly when writing new server code.

See also: [[06-Specs/CHATSERVER|CHATSERVER.md]],
[[06-Specs/SCHEMA|SCHEMA.md]], [[06-Specs/PROTOCOL|PROTOCOL.md]],
[[06-Specs/API|API.md]]

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [WebSocket Message Handler Pattern](#2-websocket-message-handler-pattern)
3. [REST API Handler Pattern](#3-rest-api-handler-pattern)
4. [Database Query Pattern](#4-database-query-pattern)
5. [Error Handling](#5-error-handling)
6. [Auth and Session Pattern](#6-auth-and-session-pattern)
7. [Permission Check Pattern](#7-permission-check-pattern)
8. [Configuration Pattern](#8-configuration-pattern)
9. [Router Pattern](#9-router-pattern)
10. [Middleware Pattern](#10-middleware-pattern)
11. [Migration Pattern](#11-migration-pattern)
12. [Logging Pattern](#12-logging-pattern)
13. [Import Conventions](#13-import-conventions)
14. [Concurrency Patterns](#14-concurrency-patterns)
15. [Audit Logging Pattern](#15-audit-logging-pattern)
16. [Transaction Pattern](#16-transaction-pattern)
17. [File Storage Pattern](#17-file-storage-pattern)
18. [Rate Limiting Pattern](#18-rate-limiting-pattern)
19. [LiveKit Integration Pattern](#19-livekit-integration-pattern)
20. [Testing Pattern](#20-testing-pattern)
21. [Model Structs Reference](#21-model-structs-reference)
22. [Checklist: Adding a New Feature](#22-checklist-adding-a-new-feature)

---

## 1. Project Structure

```
Server/
+-- main.go                 # Entry point, startup sequence, shutdown
+-- config/
|   +-- config.go           # Config struct, defaults, YAML/env loading
|   +-- config_test.go      # Config loading tests
+-- db/
|   +-- db.go               # DB wrapper, Open(), PRAGMAs, Migrate()
|   +-- migrate.go          # Tracked migration runner (schema_versions)
|   +-- models.go           # All struct types (User, Channel, Message, etc.)
|   +-- errors.go           # Sentinel errors (ErrNotFound, etc.)
|   +-- auth_queries.go     # User + session CRUD
|   +-- channel_queries.go  # Channel + override CRUD
|   +-- message_queries.go  # Message + reaction CRUD + FTS5 search
|   +-- voice_queries.go    # Voice state CRUD
|   +-- admin_queries.go    # Admin stats, audit log, settings
|   +-- invite_queries.go   # Invite CRUD
|   +-- role_queries.go     # Role CRUD
|   +-- attachment_queries.go # Attachment CRUD
|   +-- dm_queries.go       # DM channel + participant CRUD
+-- auth/
|   +-- auth.go             # Package declaration
|   +-- session.go          # Token generation + SHA-256 hashing
|   +-- password.go         # bcrypt hashing + verification
|   +-- helpers.go          # ExtractBearerToken, IsEffectivelyBanned, etc.
|   +-- ratelimit.go        # Token bucket rate limiter
|   +-- tls.go              # TLS cert generation + ACME + loading
+-- api/
|   +-- router.go           # NewRouter: chi router + middleware + mount
|   +-- middleware.go        # Auth, permission, rate limit, security, IP
|   +-- auth_handler.go     # Login, register, logout, /me handlers
|   +-- channel_handler.go  # Channel REST handlers + DM handlers
|   +-- invite_handler.go   # Invite CRUD handlers
|   +-- upload_handler.go   # File upload + download handlers
|   +-- metrics_handler.go  # Runtime metrics endpoint
|   +-- client_update.go    # Client auto-update endpoint
|   +-- livekit_proxy.go    # Reverse proxy: /livekit/* -> ws://localhost:7880
+-- ws/
|   +-- hub.go              # Hub: client registry, broadcast, sweep
|   +-- client.go           # Client struct, send/recv, voice state
|   +-- serve.go            # WS upgrade, auth, ready, read/write pump
|   +-- handlers.go         # Message dispatch + chat/typing/presence handlers
|   +-- messages.go         # JSON message builders
|   +-- errors.go           # WS error code constants
|   +-- ringbuffer.go       # Event ring buffer for reconnection replay
|   +-- origin.go           # WebSocket origin validation
|   +-- voice_join.go       # Voice join handler
|   +-- voice_leave.go      # Voice leave handler
|   +-- voice_controls.go   # Mute, deafen, camera, screenshare handlers
|   +-- voice_broadcast.go  # Voice state broadcast builders
|   +-- livekit.go          # LiveKit SDK client wrapper
|   +-- livekit_process.go  # LiveKit companion binary lifecycle + restart
|   +-- livekit_webhook.go  # LiveKit webhook handler
|   +-- export_test.go      # Unexported function exposure for tests
+-- permissions/
|   +-- permissions.go      # Bitfield constants + helpers
+-- storage/
|   +-- storage.go          # File save/delete/open + magic byte validation
+-- admin/
|   +-- admin.go            # Admin panel HTML handler
|   +-- api.go              # Admin REST API handlers
|   +-- handlers_*.go       # Feature-specific admin handlers
|   +-- logstream.go        # Log ring buffer for admin viewer
+-- migrations/
|   +-- migrations.go       # embed.FS for SQL files
|   +-- *.sql               # Migration files (001_ through 008_)
+-- updater/
|   +-- updater.go          # Server binary self-update via GitHub
+-- scripts/
    +-- voice-test.sh       # Voice testing script
```

### Package Responsibility Rules

- **db**: Pure data access (no HTTP, no WS). Returns Go types.
- **auth**: Authentication primitives (token, password, TLS). No DB queries.
- **api**: HTTP handlers. Call `db` methods. No WS knowledge.
- **ws**: WebSocket handlers. Call `db` methods. Own auth flow.
- **permissions**: Permission constants only. No business logic.
- **config**: Configuration loading. No side effects.
- **storage**: File I/O. No network knowledge.
- **admin**: Admin panel. Can call `ws` hub for stats.

---

## 2. WebSocket Message Handler Pattern

Receiver on `*Hub`. Parse payload with inline struct. Rate limit,
validate, permission-check, sanitize, persist, ACK sender, broadcast.

```go
func (h *Hub) handleChatSend(c *Client, reqID string, payload json.RawMessage) {
    // 1. Rate limit
    ratKey := fmt.Sprintf("chat:%d", c.userID)
    if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
        c.sendMsg(buildRateLimitError("too many messages", chatWindow.Seconds()))
        return
    }

    // 2. Parse payload with inline struct
    var p struct {
        ChannelID json.Number `json:"channel_id"`
        Content   string      `json:"content"`
        ReplyTo   *int64      `json:"reply_to"`
    }
    if err := json.Unmarshal(payload, &p); err != nil {
        c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid chat_send payload"))
        return
    }

    // 3. Validate each field explicitly
    channelID, err := p.ChannelID.Int64()
    if err != nil || channelID <= 0 {
        c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be positive"))
        return
    }

    // 4. Permission check (sends error + returns false if denied)
    if !h.requireChannelPerm(c, channelID, permissions.ReadMessages|permissions.SendMessages, "SEND_MESSAGES") {
        return
    }

    // 5. Sanitize user input
    content := sanitizer.Sanitize(p.Content)
    if content == "" {
        c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "content cannot be empty"))
        return
    }

    // 6. DB operation (slog.Error on failure, generic error to client)
    msgID, err := h.db.CreateMessage(channelID, c.userID, content, p.ReplyTo)
    if err != nil {
        slog.Error("ws handleChatSend CreateMessage", "err", err)
        c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to save message"))
        return
    }

    // 7. ACK sender with request ID
    c.sendMsg(buildChatSendOK(reqID, msgID, msg.Timestamp))

    // 8. Broadcast to channel
    broadcast := buildChatMessage(msgID, channelID, c.userID, username, avatar, ...)
    h.BroadcastToChannel(channelID, broadcast)
}
```

### Dispatch Registration

```go
func (h *Hub) handleMessage(c *Client, raw []byte) {
    // Periodic session expiry check every SessionCheckInterval messages
    // ... (session revalidation logic)

    var env envelope
    if err := json.Unmarshal(raw, &env); err != nil {
        c.sendMsg(buildErrorMsg(ErrCodeInvalidJSON, "invalid JSON"))
        return
    }

    switch env.Type {
    case "chat_send":       h.handleChatSend(c, env.ID, env.Payload)
    case "chat_edit":       h.handleChatEdit(c, env.ID, env.Payload)
    case "chat_delete":     h.handleChatDelete(c, env.ID, env.Payload)
    case "reaction_add":    h.handleReaction(c, true, env.Payload)
    case "reaction_remove": h.handleReaction(c, false, env.Payload)
    case "typing_start":    h.handleTyping(c, env.Payload)
    case "presence_update": h.handlePresence(c, env.Payload)
    case "channel_focus":   h.handleChannelFocus(c, env.Payload)
    case "voice_join":      h.handleVoiceJoin(c, env.Payload)
    case "voice_leave":     h.handleVoiceLeave(c)
    case "voice_token_refresh": h.handleVoiceTokenRefresh(c)
    case "voice_mute":      h.handleVoiceMute(c, env.Payload)
    case "voice_deafen":    h.handleVoiceDeafen(c, env.Payload)
    case "voice_camera":    h.handleVoiceCamera(c, env.Payload)
    case "voice_screenshare": h.handleVoiceScreenshare(c, env.Payload)
    case "ping":            c.sendMsg(buildJSON(map[string]any{"type": "pong"}))
    default:
        c.sendMsg(buildErrorMsg(ErrCodeUnknownType,
            fmt.Sprintf("unknown message type: %s", env.Type)))
    }
}
```

### Handler Signature Variants

| Signature | Used By |
|-----------|---------|
| `(c *Client, reqID string, payload json.RawMessage)` | chat_send, chat_edit, chat_delete (ACK the sender) |
| `(c *Client, payload json.RawMessage)` | typing, presence, voice_join, voice controls |
| `(c *Client, add bool, payload json.RawMessage)` | reaction_add/remove (shared handler) |
| `(c *Client)` | voice_leave, voice_token_refresh (no payload) |

### Rate Limit Constants

```go
const (
    chatRateLimit     = 10          // 10 messages per second
    chatWindow        = time.Second
    typingRateLimit   = 1           // 1 per 3 seconds
    typingWindow      = 3 * time.Second
    presenceRateLimit = 1           // 1 per 10 seconds
    presenceWindow    = 10 * time.Second
    reactionRateLimit = 5           // 5 per second
    reactionWindow    = time.Second
)
```

### Message Length Limit

```go
const maxMessageLen = 4000  // max runes (Unicode code points)
```

### HTML Sanitizer

```go
var sanitizer = bluemonday.StrictPolicy()
// Strips ALL HTML tags — only plain text survives
```

---

## 3. REST API Handler Pattern

Factory function returns `http.HandlerFunc`. Parse body with
`json.NewDecoder`. Validate, sanitize, call DB, respond with `writeJSON`.

```go
func handleRegister(database *db.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // 1. Parse request body
        var req registerRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            writeJSON(w, http.StatusBadRequest, errorResponse{
                Error:   "INVALID_INPUT",
                Message: "malformed request body",
            })
            return
        }

        // 2. Trim + sanitize input
        req.Username = strings.TrimSpace(sanitizer.Sanitize(req.Username))

        // 3. Validate required fields
        if req.Username == "" || req.Password == "" {
            writeJSON(w, http.StatusBadRequest, errorResponse{
                Error:   "INVALID_INPUT",
                Message: "username and password are required",
            })
            return
        }

        // 4. Business logic + DB operation
        uid, err := database.CreateUser(req.Username, hash, int(permissions.MemberRoleID))
        if err != nil {
            writeJSON(w, http.StatusBadRequest, errorResponse{
                Error:   "INVALID_INPUT",
                Message: "registration failed -- check your details",
            })
            return
        }

        // 5. Structured log
        slog.Info("user registered", "username", req.Username, "user_id", uid, "ip", ip)

        // 6. Success response
        writeJSON(w, http.StatusCreated, authSuccessResponse{
            Token: token,
            User:  toUserResponse(user),
        })
    }
}
```

### Context Extraction (Authenticated Routes)

```go
user, ok := r.Context().Value(UserKey).(*db.User)
if !ok || user == nil {
    writeJSON(w, http.StatusUnauthorized, errorResponse{
        Error:   "UNAUTHORIZED",
        Message: "not authenticated",
    })
    return
}
```

### Context Keys

```go
type contextKey int

const (
    UserKey    contextKey = iota  // *db.User
    SessionKey                    // *db.Session
    RoleKey                       // *db.Role
)
```

### Response Helpers

```go
// Standard error envelope
type errorResponse struct {
    Error   string `json:"error"`
    Message string `json:"message"`
}

// Generic auth error (prevents username enumeration)
var genericAuthError = errorResponse{
    Error:   "INVALID_CREDENTIALS",
    Message: "invalid invite or credentials",
}

// JSON writer
func writeJSON(w http.ResponseWriter, status int, v any) {
    w.Header().Set("Content-Type", "application/json; charset=utf-8")
    w.WriteHeader(status)
    _ = json.NewEncoder(w).Encode(v)
}
```

### URL Parameters

```go
code := chi.URLParam(r, "code")
```

---

## 4. Database Query Pattern

Methods on `*DB`. Always use `?` placeholders. Wrap errors with
`fmt.Errorf("FuncName: %w", err)`.

### Single-Row Query

```go
func (d *DB) GetRoleByID(id int64) (*Role, error) {
    row := d.sqlDB.QueryRow(
        `SELECT id, name, color, permissions, position, is_default
         FROM roles WHERE id = ?`, id,
    )
    r := &Role{}
    var isDefault int
    err := row.Scan(&r.ID, &r.Name, &r.Color, &r.Permissions, &r.Position, &isDefault)
    if errors.Is(err, sql.ErrNoRows) {
        return nil, nil  // not found is not an error
    }
    if err != nil {
        return nil, fmt.Errorf("GetRoleByID: %w", err)
    }
    r.IsDefault = isDefault != 0
    return r, nil
}
```

### Multi-Row Query

```go
func (d *DB) ListChannels() ([]Channel, error) {
    rows, err := d.sqlDB.Query(
        `SELECT id, name, type, COALESCE(category,''), COALESCE(topic,''),
                position, slow_mode, archived, created_at
         FROM channels ORDER BY position ASC, id ASC`,
    )
    if err != nil {
        return nil, fmt.Errorf("ListChannels: %w", err)
    }
    defer rows.Close()

    var channels []Channel
    for rows.Next() {
        ch, scanErr := scanChannel(rows)
        if scanErr != nil {
            return nil, fmt.Errorf("ListChannels scan: %w", scanErr)
        }
        channels = append(channels, ch)
    }
    if rows.Err() != nil {
        return nil, fmt.Errorf("ListChannels rows: %w", rows.Err())
    }
    // Return empty slice, never nil
    if channels == nil {
        channels = []Channel{}
    }
    return channels, nil
}
```

### Scanner Function (Reusable)

```go
func scanChannel(rows *sql.Rows) (Channel, error) {
    var ch Channel
    var archived int
    err := rows.Scan(
        &ch.ID, &ch.Name, &ch.Type, &ch.Category, &ch.Topic,
        &ch.Position, &ch.SlowMode, &archived, &ch.CreatedAt,
    )
    if err != nil {
        return Channel{}, err
    }
    ch.Archived = archived != 0
    return ch, nil
}
```

### Insert Returning ID

```go
func (d *DB) CreateChannel(name, chanType, category, topic string, position int) (int64, error) {
    res, err := d.sqlDB.Exec(
        `INSERT INTO channels (name, type, category, topic, position) VALUES (?, ?, ?, ?, ?)`,
        name, chanType, nullableString(category), nullableString(topic), position,
    )
    if err != nil {
        return 0, fmt.Errorf("CreateChannel: %w", err)
    }
    return res.LastInsertId()
}
```

### Nullable String Helper

```go
func nullableString(s string) any {
    if s == "" {
        return nil
    }
    return s
}
```

### DB Wrapper Methods

```go
func (d *DB) QueryRow(query string, args ...any) *sql.Row
func (d *DB) Exec(query string, args ...any) (sql.Result, error)
func (d *DB) Query(query string, args ...any) (*sql.Rows, error)
func (d *DB) Begin() (*sql.Tx, error)
func (d *DB) SQLDb() *sql.DB  // escape hatch for direct access
func (d *DB) Close() error    // runs PRAGMA optimize before close
```

---

## 5. Error Handling

### DB Sentinel Errors (`db/errors.go`)

```go
var (
    ErrNotFound  = errors.New("not found")
    ErrForbidden = errors.New("forbidden")
    ErrConflict  = errors.New("conflict")
    ErrBanned    = errors.New("banned")
)
```

Check with `errors.Is`:

```go
if errors.Is(err, db.ErrNotFound) {
    writeJSON(w, http.StatusNotFound, errorResponse{Error: "NOT_FOUND", Message: "..."})
    return
}
```

### WS Error Codes (`ws/errors.go`)

```go
const (
    ErrCodeBadRequest    = "BAD_REQUEST"
    ErrCodeInternal      = "INTERNAL"
    ErrCodeNotFound      = "NOT_FOUND"
    ErrCodeForbidden     = "FORBIDDEN"
    ErrCodeRateLimited   = "RATE_LIMITED"
    ErrCodeAlreadyJoined = "ALREADY_JOINED"
    ErrCodeChannelFull   = "CHANNEL_FULL"
    ErrCodeVoiceError    = "VOICE_ERROR"
    ErrCodeVideoLimit    = "VIDEO_LIMIT"
    ErrCodeBanned        = "BANNED"
    ErrCodeInvalidJSON   = "INVALID_JSON"
    ErrCodeUnknownType   = "UNKNOWN_TYPE"
    ErrCodeSlowMode      = "SLOW_MODE"
    ErrCodeConflict      = "CONFLICT"
)
```

### HTTP Error Codes

| Code | HTTP Status | Usage |
|------|-------------|-------|
| `INVALID_INPUT` | 400 | Validation failure |
| `UNAUTHORIZED` | 401 | Missing/invalid auth |
| `INVALID_CREDENTIALS` | 401 | Login failure (generic) |
| `FORBIDDEN` | 403 | Permission denied |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `SERVER_ERROR` | 500 | Internal error |

### Error Handling Rules

- DB methods: `return nil, nil` for not-found (not an error)
- DB methods: wrap all errors: `fmt.Errorf("FuncName: %w", err)`
- WS handlers: `slog.Error` for server failures, generic msg to client
- HTTP handlers: never leak internal error details to the client
- Auth endpoints: use generic error messages to prevent enumeration

---

## 6. Auth and Session Pattern

### Token Generation

```go
// auth/session.go
func GenerateToken() (string, error) {
    raw := make([]byte, 32) // 256 bits
    if _, err := rand.Read(raw); err != nil {
        return "", err
    }
    return hex.EncodeToString(raw), nil  // 64-char hex string
}

func HashToken(token string) string {
    sum := sha256.Sum256([]byte(token))
    return hex.EncodeToString(sum[:])
}
```

### Session Flow

```
Login/Register
  |
  +-- GenerateToken() -> plaintext token
  +-- HashToken(token) -> SHA-256 hash
  +-- database.CreateSession(userID, hash, device, ip)
  +-- Return plaintext token to client
  |
  +-- Client stores token, sends in Authorization header
  |
Auth Check (HTTP or WS)
  |
  +-- Extract "Bearer <token>" from header
  +-- HashToken(token) -> hash
  +-- database.GetSessionByTokenHash(hash)
  +-- Verify not expired: IsSessionExpired(sess.ExpiresAt)
  +-- Load user: database.GetUserByID(sess.UserID)
  +-- Check ban: IsEffectivelyBanned(user)
```

### Session TTL

```go
const sessionTTL = 30 * 24 * time.Hour  // 30 days
```

### Ban Check

```go
func IsEffectivelyBanned(u *db.User) bool {
    if u == nil || !u.Banned {
        return false
    }
    if u.BanExpires == nil {
        return true  // permanent ban
    }
    // Parse expiry, compare to now
    // If unparseable -> fail-safe: treat as banned
}
```

### Bearer Token Extraction

```go
func ExtractBearerToken(r *http.Request) (string, bool) {
    header := r.Header.Get("Authorization")
    parts := strings.SplitN(header, " ", 2)
    if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
        return "", false
    }
    return parts[1], true
}
```

### Password Hashing

Uses `golang.org/x/crypto/bcrypt`:

```go
// auth/password.go
func HashPassword(password string) (string, error)
func CheckPassword(hash, password string) error
```

---

## 7. Permission Check Pattern

Bitfield permissions with ADMINISTRATOR bypass.

### Permission Constants (`permissions/permissions.go`)

```go
const (
    SendMessages   = int64(0x0001)     // bit 0
    ReadMessages   = int64(0x0002)     // bit 1
    AttachFiles    = int64(0x0020)     // bit 5
    AddReactions   = int64(0x0040)     // bit 6
    UseSoundboard  = int64(0x0100)     // bit 8
    ConnectVoice   = int64(0x0200)     // bit 9
    SpeakVoice     = int64(0x0400)     // bit 10
    UseVideo       = int64(0x0800)     // bit 11
    ShareScreen    = int64(0x1000)     // bit 12
    ManageMessages = int64(0x10000)    // bit 16
    ManageChannels = int64(0x20000)    // bit 17
    KickMembers    = int64(0x40000)    // bit 18
    BanMembers     = int64(0x80000)    // bit 19
    MuteMembers    = int64(0x100000)   // bit 20
    ManageRoles    = int64(0x1000000)  // bit 24
    ManageServer   = int64(0x2000000)  // bit 25
    ManageInvites  = int64(0x4000000)  // bit 26
    ViewAuditLog   = int64(0x8000000)  // bit 27
    Administrator  = int64(0x40000000) // bit 30
)
```

### Default Roles

```go
const (
    OwnerRoleID     = int64(1)  // position 100, all perms
    AdminRoleID     = int64(2)  // position 80
    ModeratorRoleID = int64(3)  // position 60
    MemberRoleID    = int64(4)  // position 40, default
)
```

### Helper Functions

```go
func HasPerm(rolePerms, requiredPerm int64) bool {
    if requiredPerm == 0 { return false }
    return rolePerms&requiredPerm == requiredPerm
}

func HasAdmin(rolePerms int64) bool {
    return rolePerms&Administrator != 0
}

// Channel override: deny strips, then allow adds (allow wins ties)
func EffectivePerms(rolePerm, allow, deny int64) int64 {
    return (rolePerm &^ deny) | allow
}
```

### WS Permission Check

```go
func (h *Hub) hasChannelPerm(c *Client, channelID int64, perm int64) bool {
    if c.user == nil { return false }
    role, err := h.db.GetRoleByID(c.user.RoleID)
    if err != nil || role == nil { return false }
    if role.Permissions&permissions.Administrator != 0 {
        return true  // admin bypasses everything
    }
    allow, deny, err := h.db.GetChannelPermissions(channelID, role.ID)
    if err != nil { return false }
    effective := permissions.EffectivePerms(role.Permissions, allow, deny)
    return effective&perm == perm
}

func (h *Hub) requireChannelPerm(c *Client, channelID int64, perm int64, permLabel string) bool {
    if h.hasChannelPerm(c, channelID, perm) { return true }
    slog.Warn("ws permission denied", "user_id", c.userID, "channel_id", channelID, "perm", permLabel)
    c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing "+permLabel+" permission"))
    return false
}
```

### HTTP Permission Middleware

```go
func RequirePermission(perm int64) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            role := r.Context().Value(RoleKey).(*db.Role)
            if permissions.HasAdmin(role.Permissions) {
                next.ServeHTTP(w, r)
                return
            }
            if role.Permissions&perm == 0 {
                writeJSON(w, http.StatusForbidden, errorResponse{
                    Error: "FORBIDDEN", Message: "insufficient permissions",
                })
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

---

## 8. Configuration Pattern

Nested structs with `koanf` tags. Three-layer loading.

### Config Struct

```go
type Config struct {
    Server   ServerConfig   `koanf:"server"`
    Database DatabaseConfig `koanf:"database"`
    TLS      TLSConfig      `koanf:"tls"`
    Upload   UploadConfig   `koanf:"upload"`
    Voice    VoiceConfig    `koanf:"voice"`
    GitHub   GitHubConfig   `koanf:"github"`
}

type ServerConfig struct {
    Port              int      `koanf:"port"`
    Name              string   `koanf:"name"`
    DataDir           string   `koanf:"data_dir"`
    AllowedOrigins    []string `koanf:"allowed_origins"`
    TrustedProxies    []string `koanf:"trusted_proxies"`
    AdminAllowedCIDRs []string `koanf:"admin_allowed_cidrs"`
}

type VoiceConfig struct {
    LiveKitAPIKey     string `koanf:"livekit_api_key"`
    LiveKitAPISecret  string `koanf:"livekit_api_secret"`
    LiveKitURL        string `koanf:"livekit_url"`
    LiveKitBinaryPath string `koanf:"livekit_binary"`
    Quality           string `koanf:"quality"`
}
```

### Loading Order

```go
func Load(cfgPath string) (*Config, error) {
    k := koanf.New(".")

    // Layer 1: struct defaults
    k.Load(structs.Provider(defaults(), "koanf"), nil)

    // Layer 2: YAML file (creates default if missing)
    k.Load(file.Provider(cfgPath), yaml.Parser())

    // Layer 3: environment variables (highest priority)
    k.Load(env.Provider("OWNCORD_", ".", envKeyToKoanf), nil)

    var cfg Config
    k.Unmarshal("", &cfg)

    // Post-processing
    applyVoiceDefaults(&cfg.Voice)

    return &cfg, nil
}
```

### Environment Variable Mapping

```go
func envKeyToKoanf(s string) string {
    // "server_port" -> "server.port"
    // First underscore separates section from key
    idx := strings.Index(s, "_")
    if idx < 0 { return s }
    return s[:idx] + "." + s[idx+1:]
}
```

### Voice Credential Safety

```go
// Default dev credentials are rejected
const DefaultLiveKitAPIKey = "devkey"
const DefaultLiveKitAPISecret = "owncord-dev-secret-key-min-32chars"

func IsDefaultVoiceCredentials(v *VoiceConfig) bool {
    return v.LiveKitAPIKey == DefaultLiveKitAPIKey ||
        v.LiveKitAPISecret == DefaultLiveKitAPISecret
}

// Empty credentials -> generate random per-startup
func applyVoiceDefaults(v *VoiceConfig) {
    if v.LiveKitAPIKey == "" {
        v.LiveKitAPIKey = "key-" + generateRandomKey(8)
        slog.Warn("generated random LiveKit API key")
    }
    // ...
}
```

---

## 9. Router Pattern

chi router with middleware chains.

### Route Mounting

```go
func NewRouter(cfg *config.Config, database *db.DB, ver string, logBuf *admin.RingBuffer) (http.Handler, *ws.Hub) {
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.Recoverer)
    r.Use(requestLogger)
    r.Use(SecurityHeaders)
    r.Use(MaxBodySizeUnless(1<<20, "/api/v1/uploads"))

    // Health check (unauthenticated)
    r.Get("/health", handleHealth(ver))

    // Feature route mounting
    MountAuthRoutes(r, database, limiter, cfg.Server.TrustedProxies)
    MountInviteRoutes(r, database)
    MountChannelRoutes(r, database)
    MountUploadRoutes(r, database, store)
    MountDMRoutes(r, database, hub)

    // WebSocket (own auth)
    r.Get("/api/v1/ws", ws.ServeWS(hub, database, cfg.Server.AllowedOrigins))

    // Admin (IP-restricted)
    r.Group(func(r chi.Router) {
        r.Use(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs))
        r.Mount("/admin", adminHandler)
    })

    return r, hub
}
```

### Route Group Patterns

**Feature mounting** (factory function):

```go
func MountInviteRoutes(r chi.Router, database *db.DB) {
    r.Route("/api/v1/invites", func(r chi.Router) {
        r.Use(AuthMiddleware(database))
        r.Use(RequirePermission(permissions.ManageInvites))
        r.Post("/", handleCreateInvite(database))
        r.Get("/", handleListInvites(database))
        r.Delete("/{code}", handleRevokeInvite(database))
    })
}
```

**Per-endpoint rate limiting**:

```go
r.Route("/api/v1/auth", func(r chi.Router) {
    r.With(RateLimitMiddleware(limiter, 3, time.Minute)).
        Post("/register", handleRegister(database))
    r.With(RateLimitMiddleware(limiter, 5, time.Minute)).
        Post("/login", handleLogin(database, limiter))
    r.With(AuthMiddleware(database)).
        Post("/logout", handleLogout(database))
})
```

**Admin IP restriction**:

```go
r.With(AdminIPRestrict(cfg.Server.AdminAllowedCIDRs)).
    Get("/api/v1/metrics", handleMetrics(...))
```

---

## 10. Middleware Pattern

### Middleware Stack (Applied Order)

```
1. RequestID         -- assigns unique ID per request
2. setRequestIDHeader -- echoes ID into X-Request-Id response header
3. Recoverer         -- catches panics, returns 500
4. requestLogger     -- logs method, path, status, duration
5. SecurityHeaders   -- sets 7 defensive headers
6. MaxBodySizeUnless -- 1 MiB body limit (upload routes exempt)
```

### Security Headers

```go
func SecurityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        h := w.Header()
        h.Set("X-Content-Type-Options", "nosniff")
        h.Set("X-Frame-Options", "DENY")
        h.Set("X-XSS-Protection", "0")
        h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
        h.Set("Content-Security-Policy", "default-src 'self'")
        h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        h.Set("Cache-Control", "no-store")
        next.ServeHTTP(w, r)
    })
}
```

### Request Logger

Logs every request with structured key-value pairs.
Health checks at Debug level, errors at Warn/Error, normal at Info.

### Client IP Resolution

```go
func clientIPWithProxies(r *http.Request, trustedCIDRs []string) string {
    remoteHost := parseRemoteAddr(r.RemoteAddr)

    if len(trustedCIDRs) == 0 { return remoteHost }

    trusted := isTrustedProxy(remoteHost, trustedCIDRs)
    if !trusted { return remoteHost }

    // Only honour proxy headers from trusted proxies
    if xri := r.Header.Get("X-Real-IP"); xri != "" { return xri }
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        return leftmostEntry(xff)
    }
    return remoteHost
}
```

**Security model**: X-Real-IP and X-Forwarded-For are ONLY trusted
when the connecting IP matches a `trusted_proxies` CIDR. This prevents
clients from forging their IP to bypass rate limits.

---

## 11. Migration Pattern

SQL files in `Server/migrations/` with numeric prefix. Always idempotent.

### File Naming

`NNN_descriptive_name.sql` (e.g., `002_voice_states.sql`)

### Embedding

```go
package migrations
import "embed"
//go:embed *.sql
var FS embed.FS
```

### Migration Runner (`db/migrate.go`)

```
1. Check if schema_versions table exists
2. Create schema_versions if absent
3. If upgrading existing DB (users table exists, schema_versions new):
     Seed all migration filenames (mark as applied without executing)
4. For each .sql file in lexicographic order:
     If already recorded: skip
     Otherwise: BEGIN tx -> execute SQL -> record filename -> COMMIT
```

Each migration and its tracking record are in the same transaction,
ensuring atomicity.

### DDL Conventions

```sql
-- Tables: always IF NOT EXISTS
CREATE TABLE IF NOT EXISTS voice_states (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted      INTEGER NOT NULL DEFAULT 0,
    deafened   INTEGER NOT NULL DEFAULT 0,
    speaking   INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes: always IF NOT EXISTS
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);

-- Seed data: always INSERT OR IGNORE
INSERT OR IGNORE INTO roles (id, name, color, permissions, position, is_default)
VALUES
    (1, 'Owner',     '#E74C3C', 0x7FFFFFFF, 100, 0),
    (2, 'Admin',     '#F39C12', 0x3FFFFFFF,  80, 0),
    (3, 'Moderator', '#3498DB', 0x000FFFFF,  60, 0),
    (4, 'Member',    NULL,      0x00000663,  40, 1);
```

### Column Type Conventions

| Type | SQLite Type | Convention |
|------|------------|------------|
| Timestamps | `TEXT NOT NULL DEFAULT (datetime('now'))` | ISO 8601 |
| Booleans | `INTEGER NOT NULL DEFAULT 0` | 0=false, 1=true |
| Foreign keys | `REFERENCES table(id) ON DELETE CASCADE` | Always cascade or SET NULL |
| Nullable strings | `TEXT` (no NOT NULL) | Use `COALESCE(col,'')` in queries |

---

## 12. Logging Pattern

Use `log/slog` (stdlib). Structured key-value pairs. Never format strings.

```go
slog.Debug("channel_focus", "user_id", c.userID, "channel_id", chID)
slog.Info("user registered", "username", name, "user_id", uid, "ip", ip)
slog.Warn("ws permission denied", "user_id", c.userID, "channel_id", channelID)
slog.Error("ws handleChatSend CreateMessage", "err", err)
```

### Admin Log Viewer

A ring buffer (`admin/logstream.go`) captures all log records at
Debug+ level for the admin web panel. The main handler tees to both
stdout (Info+) and the ring buffer (Debug+).

```go
logBuf := admin.NewRingBuffer(2000)
stdoutHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
multiHandler := admin.NewMultiHandler(stdoutHandler, logBuf, slog.LevelDebug)
slog.SetDefault(slog.New(multiHandler))
```

### Conventions

- Prefix with subsystem: `"ws handleChatSend"`, `"handleCreateInvite"`
- Always include `"err"` key for error values
- Include relevant IDs: `"user_id"`, `"channel_id"`, `"msg_id"`, `"ip"`
- Login failures: log `"username_len"` not the username (PII)
- Health checks: logged at Debug level to reduce noise

---

## 13. Import Conventions

Three groups separated by blank lines:

```go
import (
    // Group 1: stdlib
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"

    // Group 2: third-party
    "github.com/go-chi/chi/v5"
    "github.com/microcosm-cc/bluemonday"

    // Group 3: internal
    "github.com/owncord/server/auth"
    "github.com/owncord/server/db"
    "github.com/owncord/server/permissions"
)
```

Driver imports use blank identifier:

```go
_ "modernc.org/sqlite" // register the sqlite3 driver
```

---

## 14. Concurrency Patterns

### Hub Dispatch Loop

```go
func (h *Hub) Run() {
    staleTicker := time.NewTicker(30 * time.Second)
    for {
        select {
        case <-h.stop:
            return
        case c := <-h.register:
            h.mu.Lock()
            h.clients[c.userID] = c
            h.mu.Unlock()
        case c := <-h.unregister:
            h.mu.Lock()
            if current, ok := h.clients[c.userID]; ok && current == c {
                delete(h.clients, c.userID)
            }
            h.mu.Unlock()
        case bm := <-h.broadcast:
            h.deliverBroadcast(bm)
        case <-staleTicker.C:
            h.sweepStaleClients()
        }
    }
}
```

### Panic Recovery in Hub

The hub wraps its select loop in a panic recovery that:
- Logs the panic with stack trace
- Counts panics in a 60-second window
- Restarts the loop if <3 panics
- Stops permanently after 3 panics (circuit breaker)

### Client Send Buffer

```go
const sendBufSize = 256

func (c *Client) sendMsg(msg []byte) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.sendClosed { return }
    select {
    case c.send <- msg:
    default:
        // Buffer full -- drop rather than block the hub
    }
}
```

### Broadcast with Sequence Numbers

```go
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
    seq := h.nextSeq()                     // atomic counter
    msg := wrapWithSeq(bm.msg, seq)        // inject seq field into JSON
    h.replayBuf.Push(seq, msg)             // store for reconnection

    h.mu.RLock()
    defer h.mu.RUnlock()
    for _, c := range h.clients {
        if bm.channelID != 0 && c.getChannelID() != bm.channelID {
            continue  // channel-scoped: skip clients not viewing this channel
        }
        c.sendMsg(msg)
    }
}
```

### Reconnection with State Recovery

```
Client reconnects with last_seq in auth message
  |
  +-- Hub looks up events since last_seq in ring buffer (1000 capacity)
  +-- If found: send auth_ok + replay missed events (skip full ready)
  +-- If too old: send full ready payload (fallback)
```

### Stale Client Sweep

```go
const staleClientTimeout = 90 * time.Second

func (h *Hub) sweepStaleClients() {
    // Every 30s, check for clients with no activity in 90s
    // Client sends ping every 30s, so 90s = 3x margin
}
```

### Graceful Shutdown

```go
func (h *Hub) GracefulStop() {
    h.BroadcastServerRestart("shutdown", 5)  // warn clients
    if h.lkProcess != nil {
        h.lkProcess.Stop()                    // stop LiveKit
    }
    time.Sleep(5 * time.Second)              // drain time
    h.mu.Lock()
    for _, c := range h.clients {
        c.closeSend()                         // close all connections
    }
    h.mu.Unlock()
    h.Stop()                                 // stop dispatch loop
}
```

### Lock Hierarchy

| Lock | Type | Guards |
|------|------|--------|
| `Hub.mu` | `sync.RWMutex` | `clients` map |
| `Client.mu` | `sync.Mutex` | `sendClosed`, `msgCount`, `channelID`, `lastActivity` |
| `Client.voiceMu` | `sync.Mutex` | `voiceChID` |
| `Hub.settingsMu` | `sync.RWMutex` | `settingsName`, `settingsMotd`, `settingsLastUpdate` |
| `Hub.seq` | `atomic.Uint64` | Sequence counter |

---

## 15. Audit Logging Pattern

Every state-changing handler calls `LogAudit` after the mutation.
Fire-and-forget: `_ =` discards the error.

```go
func (d *DB) LogAudit(actorID int64, action, targetType string, targetID int64, detail string) error
```

| Parameter | Examples |
|-----------|---------|
| `actorID` | `c.userID`, `user.ID` |
| `action` | `"message_delete"`, `"user_ban"`, `"channel_create"` |
| `targetType` | `"message"`, `"user"`, `"channel"`, `"server"`, `"setting"` |
| `targetID` | `msgID`, `id`, `0` (for server-wide) |
| `detail` | `"channel 5, mod_action=true"`, `"reason: spam"` |

### Usage

```go
// WS handler
_ = h.db.LogAudit(c.userID, "message_delete", "message", msgID,
    fmt.Sprintf("channel %d, mod_action=%v", msg.ChannelID, isMod))

// Admin handler
_ = database.LogAudit(actor, "user_ban", "user", id,
    fmt.Sprintf("reason: %s", reason))
```

### Rules

- Place `LogAudit` AFTER the mutation succeeds
- Use `_ =` to discard errors (never block on audit failure)
- Action names: `snake_case` verbs
- Include enough detail to reconstruct what happened

---

## 16. Transaction Pattern

```go
func (d *DB) DoAtomicThing(args ...) error {
    tx, err := d.sqlDB.Begin()
    if err != nil {
        return fmt.Errorf("DoAtomicThing begin: %w", err)
    }
    defer tx.Rollback() // no-op if already committed

    if _, err := tx.Exec(`INSERT INTO ...`, args...); err != nil {
        return fmt.Errorf("DoAtomicThing step1: %w", err)
    }

    if _, err := tx.Exec(`UPDATE ...`, args...); err != nil {
        return fmt.Errorf("DoAtomicThing step2: %w", err)
    }

    return tx.Commit()
}
```

### Rules

- Always `defer tx.Rollback()` immediately after `Begin()`
- Wrap each step with `fmt.Errorf("FuncName step: %w", err)`
- Return `tx.Commit()` as last statement
- Use `tx.Exec` / `tx.QueryRow` / `tx.Query` inside transactions

### Migration Transactions

Each migration runs within its own transaction. The migration
filename is recorded in the same transaction for atomicity.

---

## 17. File Storage Pattern

### Security Measures

```go
// 1. Filename sanitization
func sanitizeFilename(name string) error {
    // Reject: empty, ".", "..", starts with ".",
    // contains "/" or "\", differs from filepath.Base()
}

// 2. Path traversal prevention
func (s *Storage) resolvedPath(name string) (string, error) {
    absDir := filepath.Abs(s.dir)
    target := filepath.Join(absDir, name)
    // Verify target stays within absDir
}

// 3. Magic byte validation
func ValidateFileType(header []byte) error {
    // Reject: PE executables (MZ), ELF binaries, Mach-O, shell scripts (#!)
}

// 4. Size limit enforcement
written, err := io.Copy(f, io.LimitReader(full, maxBytes+1))
if written > maxBytes {
    os.Remove(dst)  // clean up oversized partial write
    return fmt.Errorf("file exceeds maximum size of %d MB", s.maxSizeMB)
}
```

---

## 18. Rate Limiting Pattern

Token bucket rate limiter (`auth/ratelimit.go`):

```go
type RateLimiter struct {
    mu      sync.Mutex
    buckets map[string]*bucket
}

func (rl *RateLimiter) Allow(key string, limit int, window time.Duration) bool {
    // Sliding window: count requests in last `window` duration
    // If count >= limit, deny
}
```

Used in both HTTP middleware and WS handlers:

```go
// HTTP: per-IP rate limiting
r.With(RateLimitMiddleware(limiter, 3, time.Minute)).
    Post("/register", handleRegister(database))

// WS: per-user rate limiting
ratKey := fmt.Sprintf("chat:%d", c.userID)
if !h.limiter.Allow(ratKey, chatRateLimit, chatWindow) {
    c.sendMsg(buildRateLimitError("too many messages", chatWindow.Seconds()))
    return
}
```

---

## 19. LiveKit Integration Pattern

### Token Generation

```go
func (c *LiveKitClient) GenerateToken(
    userID int64, username string, channelID int64,
    canPublish, canSubscribe bool,
) (string, error) {
    at := auth.NewAccessToken(c.apiKey, c.apiSecret)
    grant := &auth.VideoGrant{
        RoomJoin:     true,
        Room:         RoomName(channelID),
        CanPublish:   &canPublish,
        CanSubscribe: &canSubscribe,
    }
    at.AddGrant(grant).
        SetIdentity(fmt.Sprintf("user-%d", userID)).
        SetName(username).
        SetValidFor(tokenTTL) // 4 hours
    return at.ToJWT()
}
```

### Room Naming

```go
func RoomName(channelID int64) string {
    return fmt.Sprintf("channel-%d", channelID)
}
```

### URL Conversion

LiveKit SDK client uses HTTP URL for the REST API:

```go
func wsToHTTP(wsURL string) string {
    // ws://  -> http://
    // wss:// -> https://
}
```

### Health Check

```go
func (c *LiveKitClient) HealthCheck() (bool, error) {
    _, err := c.roomSvc.ListRooms(ctx, &livekit.ListRoomsRequest{})
    return err == nil, err
}
```

### Reverse Proxy Pattern

The server proxies LiveKit signaling through its own HTTPS:

```
Client -> wss://server:8443/livekit/* -> ws://localhost:7880/*
```

This avoids mixed-content blocks (secure page -> insecure WS).
No OwnCord auth middleware on the proxy route -- LiveKit JWT
handles authentication.

---

## 20. Testing Pattern

### File and Function Naming

- Test files: `xxx_test.go` alongside source
- Test functions: `TestFuncName(t *testing.T)`
- Package: same (white-box) or `_test` suffix (black-box)

### Database Setup

```go
func openMemory(t *testing.T) *db.DB {
    t.Helper()
    database, err := db.Open(":memory:")
    if err != nil { t.Fatalf("Open(':memory:'): %v", err) }
    t.Cleanup(func() { _ = database.Close() })
    return database
}
```

### Hub Setup

```go
func newTestHub(t *testing.T) (*ws.Hub, *db.DB) {
    t.Helper()
    database := openTestDB(t)
    limiter := auth.NewRateLimiter()
    hub := ws.NewHub(database, limiter)
    return hub, database
}
```

### Seed Helpers

```go
func seedTestUser(t *testing.T, database *db.DB, username string) int64
func seedOwnerUser(t *testing.T, database *db.DB, username string) *db.User
func seedTestChannel(t *testing.T, database *db.DB, name string) int64
func seedVoiceChan(t *testing.T, database *db.DB, name string) int64
```

### HTTP Handler Tests

```go
func TestSomeHandler(t *testing.T) {
    database := openMemory(t)
    db.Migrate(database)

    r := chi.NewRouter()
    r.Post("/api/v1/endpoint", handleEndpoint(database))

    body := `{"key": "value"}`
    req := httptest.NewRequest("POST", "/api/v1/endpoint", strings.NewReader(body))
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("got %d, want 200", w.Code)
    }
}
```

### Exposing Unexported Functions

```go
// ws/export_test.go
package ws // same package

func (h *Hub) BuildAuthOKForTest(user *db.User, roleName string) []byte {
    return h.buildAuthOK(user, roleName)
}

func (h *Hub) HandleMessageForTest(c *Client, raw []byte) {
    h.handleMessage(c, raw)
}
```

### Conventions

- `t.Helper()` in every helper function
- `t.Cleanup()` for teardown (not `defer`)
- `t.Fatalf()` for setup; `t.Errorf()` for assertions
- `t.TempDir()` for file tests
- `testing/fstest.MapFS` for custom migration schemas
- `go test ./... -race` for race detection

---

## 21. Model Structs Reference

All models live in `db/models.go`:

```go
type User struct {
    ID, Username, PasswordHash, Avatar*, RoleID, TOTPSecret*,
    Status, CreatedAt, LastSeen*, Banned, BanReason*, BanExpires*
}

type Session struct {
    ID, UserID, TokenHash, Device, IP, CreatedAt, LastUsed, ExpiresAt
}

type Role struct {
    ID, Name, Color*, Permissions, Position, IsDefault
}

type Channel struct {
    ID, Name, Type, Category, Topic, Position, SlowMode, Archived,
    CreatedAt, VoiceMaxUsers, VoiceQuality*, MixingThreshold*, VoiceMaxVideo
}

type Message struct {
    ID, ChannelID, UserID, Content, ReplyTo*, EditedAt*, Deleted, Pinned, Timestamp
}

type VoiceState struct {
    UserID, ChannelID, Username, Muted, Deafened, Speaking, Camera, Screenshare
}

type Invite struct {
    ID, Code, CreatedBy, Uses, MaxUses*, ExpiresAt*, Revoked, CreatedAt
}
```

(`*` = nullable/pointer field)

### API Response Types

```go
type MessageAPIResponse struct { ID, ChannelID, User, Content, ReplyTo, Attachments, Reactions, Pinned, EditedAt, Deleted, Timestamp }
type AttachmentInfo struct { ID, Filename, Size, Mime, URL, Width*, Height* }
type ReactionInfo struct { Emoji, Count, Me }
type UserPublic struct { ID, Username, Avatar* }
type ServerStats struct { UserCount, MessageCount, ChannelCount, InviteCount, DBSizeBytes, OnlineCount }
type AuditEntry struct { ID, ActorID, ActorName, Action, TargetType, TargetID, Detail, CreatedAt }
```

---

## 22. Checklist: Adding a New Feature

1. **WS handler**: Add `case "xxx"` in `handleMessage` switch
2. **Rate limit**: Define constants, use `h.limiter.Allow()`
3. **Payload**: Inline struct with `json.RawMessage`, validate every field
4. **Permissions**: Call `h.requireChannelPerm()` (handles error response)
5. **DM check**: If channel operation, branch on `ch.Type == "dm"` and
   verify participant membership via `IsDMParticipant` instead of roles
6. **Sanitize**: `sanitizer.Sanitize(content)` for user text
7. **DB query**: Add method to `db/` package, `?` placeholders, wrap errors
8. **Audit log**: `_ = h.db.LogAudit(...)` after every mutation
9. **REST handler**: Factory function returning `http.HandlerFunc`
10. **Migration**: Add `NNN_xxx.sql` in `migrations/`, `IF NOT EXISTS`
11. **Route**: Mount via `r.Route("/api/v1/xxx", ...)` with middleware
12. **Logging**: `slog` with structured key-value pairs
13. **Tests**: In-memory DB, `httptest` for HTTP, `NewTestClient` for WS
