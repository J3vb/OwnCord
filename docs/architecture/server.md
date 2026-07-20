# Server Architecture

**Verified against:** commit `ddc49f0`, 2026-07-19

Single Go binary (`github.com/owncord/server`, Go 1.25). Pure-Go SQLite
(`modernc.org/sqlite`, no CGO), chi router, `nhooyr.io/websocket`, LiveKit for
voice, Wazero for plugins (build-tag gated), optional OpenTelemetry
(`-tags otel`). Roughly 29k LOC of production code and 46k LOC of tests.

## D2 — Package map

```mermaid
flowchart TB
    subgraph entry ["Process entry"]
        MAIN["main.go<br/>config, TLS, DB open+migrate,<br/>signal handling, maintenance loop"]
    end

    subgraph http ["HTTP layer"]
        API["api<br/>router, middleware, REST handlers,<br/>WAF, LiveKit proxy, uploads"]
        ADMIN["admin<br/>embedded SPA + admin REST,<br/>SSE log stream"]
    end

    subgraph realtime ["Real-time"]
        WS["ws<br/>Hub, pub/sub, replay,<br/>typed command dispatch, LiveKit, E2EE relay"]
    end

    subgraph domain ["Domain"]
        SVC["service<br/>Message/Channel/Permission/User/<br/>DM/Invite/Block/Moderation/Voice"]
        PERM["permissions<br/>bitfield + Checker"]
        PLUGIN["plugin<br/>wazero runtime, registry,<br/>manifest, host APIs"]
    end

    subgraph data ["Data"]
        DB[("db<br/>query methods (sqlc-backed),<br/>migration runner, models")]
        DBGEN["db/dbgen<br/>sqlc-generated queries"]
        MIG["migrations<br/>001–016 embedded SQL"]
    end

    subgraph support ["Support"]
        AUTH["auth<br/>bcrypt, tokens, TOTP,<br/>rate limiting, TLS"]
        CFG["config<br/>koanf: defaults→YAML→env"]
        STORAGE["storage<br/>upload files on disk"]
        TEL["telemetry<br/>OTel (no-op default)"]
        UPD["updater<br/>minisign-verified self-update"]
    end

    MAIN --> CFG
    MAIN --> API
    MAIN --> DB
    API --> ADMIN
    API --> WS
    API --> SVC
    API --> AUTH
    API --> STORAGE
    API --> UPD
    API --> PLUGIN
    SVC --> DB
    SVC --> PERM
    DB --> DBGEN
    DB --> MIG
    WS --> SVC
    WS --> PLUGIN

    %% Residual layering seam (dashed): raw *db.DB used above the service layer
    API -.->|"handlers take *db.DB directly"| DB
    ADMIN -.->|"raw *db.DB"| DB
```

**What this shows.** The layering is `api → service → db` (D3 removed the former
`store` seam). The `service` layer depends on a narrow `service.Store` interface
that `*db.DB` satisfies; `ws` and `plugin` depend on their own small interfaces
(`ws.EventStore`, `plugin.PluginStore`) the same way. The `db` package's query
methods delegate to the sqlc-generated `db/dbgen` code (D2), so sqlc is now the
type-checked query layer rather than dead generated code. Two dashed edges mark
the residual seam: many REST handlers still receive a raw `*db.DB` alongside
`svc`, and the `admin` package operates on `*db.DB` almost exclusively —
consolidating those behind the service layer is the remaining work (audit
A-2026-07-06). See [data-model.md](data-model.md).

`api.NewRouter` (`Server/api/router.go`) is the composition root: it constructs
the rate limiter, TOTP key, storage, `service.New`, the `ws.Hub`, the LiveKit
client/subprocess, the updater, the admin handler, and the plugin admin handler;
spawns background goroutines; and mounts all routes. `main.go` performs only
process-level wiring (config, TLS, DB, event persistence, HTTP server,
shutdown).

**Source of truth:** `Server/main.go`, `Server/api/router.go`, package import
graph (`go list -deps`), `Server/service/datastore.go`, `sqlc.yaml`.

## D3 — REST request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant MW as Global middleware<br/>(api/router.go)
    participant RT as Route mount<br/>(Mount*Routes)
    participant H as Handler
    participant S as service.*
    participant ST as service.Store<br/>(*db.DB)
    participant DB as SQLite

    C->>MW: HTTPS request
    Note over MW: RequestID → Recoverer → requestLogger<br/>→ telemetry → SecurityHeadersWithTLS<br/>→ MaxBodySizeUnless(uploads exempt)<br/>→ optional Coraza WAF
    MW->>RT: routed by chi
    Note over RT: AuthMiddleware(database)<br/>+ per-route rate limits<br/>+ RequirePermission(...) where mounted
    RT->>H: authenticated request
    H->>S: domain call (svc.Messages, svc.Permissions, …)
    S->>ST: narrow Store interface method
    ST->>DB: SQL (db.DB query method → sqlc dbgen)
    DB-->>C: JSON response (errorResponse envelope on failure)

    rect rgba(200,120,120,0.15)
        Note over H,DB: Deviation — auth routes: MountAuthRoutes(r, database, …)<br/>bypasses the service layer and queries *db.DB directly.<br/>Admin REST (Server/admin) does the same behind<br/>AdminIPRestrict + RequireAdminAuth.
    end
```

**What this shows.** The global chain is assembled in `NewRouter`; note that
chi's `middleware.RealIP` is deliberately omitted — client IP is resolved via
`clientIPWithProxies` against configured trusted proxies instead, so spoofed
`X-Real-IP`/`X-Forwarded-For` headers are not trusted by default. Authentication
is bearer-token (SHA-256-hashed opaque tokens); authorization is enforced
inconsistently — sometimes as `RequirePermission` middleware at mount time,
sometimes in-handler through `svc.Permissions` (an audit finding). The shaded
region marks the two documented bypass paths of the domain layer.

**Source of truth:** `Server/api/router.go`, `Server/api/middleware.go`,
`Server/api/auth_handler.go`, `Server/admin/middleware.go`, `Server/service/`.
