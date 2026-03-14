---
name: go-server
description: Patterns and best practices for building the Go chat server backend (chatserver.exe). Use this skill whenever working on the server side of the ChatServer project — API handlers, middleware, config loading, file serving, authentication, or any Go code in the server/ directory. Also use when creating new REST endpoints, adding middleware, embedding static files, or structuring Go packages. Trigger on any Go server task even if the user just says "add an endpoint" or "fix the server."
---

# Go Server Patterns

Read this before writing any Go code in the `server/` directory. These patterns keep the codebase consistent.

## Project Layout

```
server/
├── main.go              ← entry point, wires everything together
├── go.mod
├── config/
│   └── config.go        ← load config.yaml, env overrides, defaults
├── db/
│   ├── db.go            ← open SQLite, run migrations
│   ├── queries.go       ← all SQL queries as methods on a DB struct
│   └── migrations/      ← numbered .sql files (001_init.sql, etc.)
├── auth/
│   ├── auth.go          ← bcrypt, session create/validate/revoke
│   ├── middleware.go     ← RequireAuth, RequireRole, RateLimit middleware
│   └── totp.go          ← TOTP setup, verify
├── api/
│   ├── router.go        ← chi router setup, mount all routes
│   ├── auth_handlers.go
│   ├── channel_handlers.go
│   ├── message_handlers.go
│   ├── upload_handlers.go
│   ├── admin_handlers.go
│   └── helpers.go       ← JSON response helpers, error formatting
├── ws/
│   ├── hub.go           ← central hub, channel subscriptions, broadcast
│   ├── client.go        ← per-connection read/write goroutines
│   ├── handlers.go      ← handle each message type
│   └── types.go         ← message structs matching PROTOCOL.md
├── voice/
│   ├── sfu.go           ← Pion SFU setup
│   ├── turn.go          ← built-in TURN relay
│   └── signaling.go     ← WebRTC signaling via WebSocket
├── storage/
│   └── files.go         ← upload validation, EXIF strip, serve with auth
├── admin/
│   └── static/          ← HTML/CSS/JS for admin panel (embedded)
└── migrations/
    ├── 001_init.sql
    └── 002_fts.sql
```

## Conventions

### Entry Point (main.go)

```go
package main

import (
    "embed"
    // ...
)

//go:embed admin/static/*
var adminFS embed.FS

var version = "dev" // set via -ldflags at build time

func main() {
    cfg := config.Load("config.yaml")
    database := db.Open(cfg.DataDir + "/chatserver.db")
    database.Migrate()

    hub := ws.NewHub(database)
    go hub.Run()

    router := api.NewRouter(database, hub, adminFS, cfg)

    // TLS or plain HTTP based on config
    server := &http.Server{Addr: ":" + cfg.Port, Handler: router}
    // ... start server with appropriate TLS mode
}
```

### Config Loading

```go
// Always provide sensible defaults. Never crash on missing config.
type Config struct {
    Port          string `yaml:"port" env:"PORT" default:"8443"`
    ServerName    string `yaml:"server_name" default:"My Server"`
    DataDir       string `yaml:"data_dir" default:"data"`
    MaxUploadMB   int    `yaml:"max_upload_mb" default:"25"`
    VoiceQuality  string `yaml:"voice_quality" default:"medium"` // low, medium, high
    TLSMode       string `yaml:"tls_mode" default:"self-signed"` // self-signed, acme, manual, off
    TLSDomain     string `yaml:"tls_domain"`
    TLSCert       string `yaml:"tls_cert"`
    TLSKey        string `yaml:"tls_key"`
}
```

### API Handler Pattern

Every handler follows this structure:

```go
func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
    // 1. Get authenticated user from context (set by auth middleware)
    user := auth.UserFromContext(r.Context())

    // 2. Check permissions
    if !user.HasPermission(permissions.ManageChannels) {
        respondError(w, http.StatusForbidden, "FORBIDDEN", "Insufficient permissions")
        return
    }

    // 3. Parse and validate input
    var input struct {
        Name     string `json:"name"`
        Type     string `json:"type"`
        Category string `json:"category"`
    }
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        respondError(w, http.StatusBadRequest, "INVALID_INPUT", "Invalid JSON")
        return
    }
    input.Name = sanitize(input.Name)

    // 4. Business logic (database call)
    channel, err := h.db.CreateChannel(input.Name, input.Type, input.Category)
    if err != nil {
        respondError(w, http.StatusInternalServerError, "SERVER_ERROR", "Failed to create channel")
        return
    }

    // 5. Side effects (broadcast via WebSocket, audit log)
    h.hub.BroadcastAll(ws.Message{Type: "channel_create", Payload: channel})
    h.db.AuditLog(user.ID, "channel_create", "channel", channel.ID, nil)

    // 6. Respond
    respondJSON(w, http.StatusCreated, channel)
}
```

### Response Helpers

```go
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, code, message string) {
    respondJSON(w, status, map[string]string{"error": code, "message": message})
}
```

### Middleware Stack

```go
r := chi.NewRouter()

// Global middleware
r.Use(middleware.RealIP)
r.Use(middleware.Logger)          // or custom slog middleware
r.Use(middleware.Recoverer)
r.Use(securityHeaders)            // HSTS, CSP, X-Frame-Options
r.Use(rateLimiter(30))            // 30 req/sec per IP globally

// Public routes
r.Post("/api/auth/register", h.Register)
r.Post("/api/auth/login", h.Login)
r.Get("/api/health", h.Health)

// Authenticated routes
r.Group(func(r chi.Router) {
    r.Use(auth.RequireAuth(db))   // validates session token
    r.Get("/api/channels", h.ListChannels)
    r.Get("/api/channels/{id}/messages", h.GetMessages)
    // ...
})

// Admin routes
r.Group(func(r chi.Router) {
    r.Use(auth.RequireAuth(db))
    r.Use(auth.RequireRole("admin", "owner"))
    r.Get("/api/admin/stats", h.AdminStats)
    // ...
})

// Admin panel static files
r.Handle("/admin/*", http.StripPrefix("/admin/", http.FileServer(http.FS(adminSubFS))))
```

### Permission Checking

```go
// Permissions are bitfields. Check with bitwise AND.
type Permission uint32

const (
    PermSendMessages   Permission = 1 << 0
    PermReadMessages   Permission = 1 << 1
    PermAttachFiles    Permission = 1 << 5
    PermAddReactions   Permission = 1 << 6
    // ... see SCHEMA.md for full list
    PermAdministrator  Permission = 1 << 30
)

func (u *User) HasPermission(p Permission) bool {
    if u.Permissions&PermAdministrator != 0 {
        return true // admin bypasses all
    }
    return u.Permissions&p != 0
}

// For channel-specific overrides:
func (u *User) HasChannelPermission(channelID int, p Permission, db *DB) bool {
    if u.HasPermission(PermAdministrator) {
        return true
    }
    base := u.Permissions
    override := db.GetChannelOverride(channelID, u.RoleID)
    effective := (base | override.Allow) & ^override.Deny
    return effective&p != 0
}
```

### Input Sanitization

```go
import "github.com/microcosm-cc/bluemonday"

var sanitizer = bluemonday.StrictPolicy() // strips ALL HTML

func sanitize(input string) string {
    // Strip HTML
    clean := sanitizer.Sanitize(input)
    // Remove null bytes and control characters
    clean = strings.Map(func(r rune) rune {
        if r < 32 && r != '\n' && r != '\r' && r != '\t' {
            return -1
        }
        return r
    }, clean)
    return strings.TrimSpace(clean)
}
```

### File Upload Validation

```go
func validateUpload(file multipart.File, header *multipart.FileHeader, maxBytes int64) error {
    // 1. Size check
    if header.Size > maxBytes {
        return errors.New("file too large")
    }

    // 2. Read first 512 bytes for magic byte detection
    buf := make([]byte, 512)
    n, _ := file.Read(buf)
    file.Seek(0, 0) // reset reader

    // 3. Detect real content type (not from extension)
    mime := http.DetectContentType(buf[:n])

    // 4. Block dangerous types
    blocked := []string{".exe", ".bat", ".cmd", ".ps1", ".scr", ".msi", ".com", ".vbs", ".js", ".wsf"}
    ext := strings.ToLower(filepath.Ext(header.Filename))
    for _, b := range blocked {
        if ext == b {
            return errors.New("file type not allowed")
        }
    }

    // 5. Block if MIME doesn't match safe list
    if !isAllowedMIME(mime) {
        return errors.New("file type not allowed")
    }

    return nil
}
```

### Build Command

```bash
# Development
go run .

# Production build
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .

# Cross-compile (if building on Linux/Mac for Windows)
GOOS=windows GOARCH=amd64 go build -o chatserver.exe -ldflags "-s -w" .
```

## Security Checklist (for every new feature)

- [ ] Input sanitized with bluemonday before storage
- [ ] Permissions checked server-side before any action
- [ ] Rate limiting applied to the endpoint
- [ ] Audit log entry for destructive/admin actions
- [ ] Error messages don't leak internal details
- [ ] File paths don't allow traversal (use UUIDs, not user filenames)
- [ ] SQL queries use parameterized statements (never string concat)
