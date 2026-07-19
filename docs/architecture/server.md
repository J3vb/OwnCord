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
        WS["ws<br/>Hub, pub/sub, replay,<br/>V1+V2 dispatch, LiveKit, E2EE relay"]
    end

    subgraph domain ["Domain"]
        SVC["service<br/>Message/Channel/Permission/User/<br/>DM/Invite/Block/Moderation/Voice"]
        PERM["permissions<br/>bitfield + Checker"]
        PLUGIN["plugin<br/>wazero runtime, registry,<br/>manifest, host APIs"]
    end

    subgraph data ["Data"]
        STORE["store<br/>Store interface,<br/>SQLiteStore, MemStore"]
        DB[("db<br/>raw SQL queries,<br/>migration runner, models")]
        DBGEN["db/dbgen<br/>sqlc-generated"]
        MIG["migrations<br/>001–015 embedded SQL"]
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
    MAIN --> STORE
    API --> ADMIN
    API --> WS
    API --> SVC
    API --> AUTH
    API --> STORAGE
    API --> UPD
    API --> PLUGIN
    SVC --> STORE
    SVC --> PERM
    STORE --> DB
    DB --> MIG
    WS --> SVC
    WS --> PLUGIN

    %% Layering violations (dashed red): raw *db.DB used above the store seam
    API -.->|"handlers take *db.DB directly"| DB
    ADMIN -.->|"raw *db.DB"| DB
    WS -.->|"inline SQL for settings"| DB
    DBGEN -.-|"generated but imported by nothing"| DB

    classDef dead fill:none,stroke-dasharray: 5 5,opacity:0.6
    class DBGEN dead
```

**What this shows.** The intended layering is
`api → service → store → db`, and the `service` layer does follow it. But three
dashed edges mark where the seam is bypassed: nearly every REST handler receives
both `svc` *and* a raw `*db.DB`; the `admin` package operates on `*db.DB`
almost exclusively; and the `ws.Hub` runs inline SQL against the `settings`
table. `db/dbgen` (sqlc output) is generated and CI-verified but referenced by
no code. In effect the server has three coexisting data-access styles — see
[data-model.md](data-model.md) and the audit for the consolidation
recommendation.

`api.NewRouter` (`Server/api/router.go`) is the composition root: it constructs
the rate limiter, TOTP key, storage, `service.New`, the `ws.Hub`, the LiveKit
client/subprocess, the updater, the admin handler, and the plugin admin handler;
spawns background goroutines; and mounts all routes. `main.go` performs only
process-level wiring (config, TLS, DB, event persistence, HTTP server,
shutdown).

**Source of truth:** `Server/main.go`, `Server/api/router.go`, package import
graph (`go list -deps`), `Server/store/store.go`, `sqlc.yaml`.

## D3 — REST request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant MW as Global middleware<br/>(api/router.go)
    participant RT as Route mount<br/>(Mount*Routes)
    participant H as Handler
    participant S as service.*
    participant ST as store.Store
    participant DB as SQLite

    C->>MW: HTTPS request
    Note over MW: RequestID → Recoverer → requestLogger<br/>→ telemetry → SecurityHeadersWithTLS<br/>→ MaxBodySizeUnless(uploads exempt)<br/>→ optional Coraza WAF
    MW->>RT: routed by chi
    Note over RT: AuthMiddleware(database)<br/>+ per-route rate limits<br/>+ RequirePermission(...) where mounted
    RT->>H: authenticated request
    H->>S: domain call (svc.Messages, svc.Permissions, …)
    S->>ST: Store interface method
    ST->>DB: SQL (via db.DB)
    DB-->>C: JSON response (errorResponse envelope on failure)

    rect rgba(200,120,120,0.15)
        Note over H,DB: Deviation — auth routes: MountAuthRoutes(r, database, …)<br/>bypasses service/store and queries *db.DB directly.<br/>Admin REST (Server/admin) does the same behind<br/>AdminIPRestrict + RequireAdminAuth.
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
