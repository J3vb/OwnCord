# System Overview

**Verified against:** commit `5630aa1`, 2026-08-04

OwnCord is a self-hosted chat stack: one Go server binary per community, a Tauri
desktop client that can hold profiles for many servers (one active connection at
a time), LiveKit for voice/video media, and an embedded web admin panel.

## D1 — System context and trust boundaries

```mermaid
flowchart LR
    subgraph desktop ["Desktop client (Tauri v2)"]
        WV["Webview (TS)<br/>UI, stores, dispatcher"]
        subgraph sidecars ["Rust commands"]
            WSP["ws_proxy<br/>TOFU-pinned WSS"]
            LKP["livekit_proxy<br/>TOFU-pinned TLS tunnel"]
            CRD["credentials<br/>OS keychain"]
            UPD["updater<br/>pinned TLS + minisign"]
        end
        WV --- sidecars
    end

    subgraph server ["Self-hosted Go server (single binary)"]
        RTR["api router<br/>REST /api/v1"]
        HUB["ws Hub<br/>real-time"]
        ADM["admin SPA + REST<br/>(IP-gated)"]
        PLG["plugin runtime<br/>(wazero, opt-in)"]
        DBF[("SQLite file<br/>WAL, single writer")]
        UPS["file storage<br/>uploads/"]
    end

    LK["LiveKit server<br/>(managed subprocess<br/>or external)"]
    REL["OwnCord releases<br/>(GitHub, minisign-signed)"]

    WV -->|"HTTPS REST<br/>⚠ accepts any cert<br/>(no pinning)"| RTR
    WSP -->|"WSS, fingerprint-pinned"| HUB
    LKP -->|"TLS, fingerprint-pinned"| LK
    WV -->|"admin panel (browser)"| ADM
    HUB <-->|"webhooks + server SDK"| LK
    RTR --> DBF
    HUB --> DBF
    RTR --> UPS
    PLG -.->|"allowlisted HTTP only"| NET["external hosts"]
    UPD -->|"via connected server URL"| REL
    server -->|"self-update check"| REL
```

**What this shows.** Three transport paths leave the client and only two are
certificate-pinned: the app WebSocket and the LiveKit tunnel go through Rust
proxies that pin a trust-on-first-use SHA-256 fingerprint per host; the HTTP
REST path currently accepts any certificate (an acknowledged gap tracked in the
audit). The admin panel is served by the same binary but gated to configured
CIDRs (private ranges by default), with bearer admin auth on top for the plugin
endpoints. Plugins run in a WASM sandbox whose HTTP capability is allowlisted
per manifest. Both the server self-updater and the client updater verify
minisign signatures against pinned embedded public keys.

## D8 — Deployment topology

```mermaid
flowchart TB
    subgraph hostbox ["Operator host (or Docker)"]
        BIN["owncord server binary"]
        BIN --> CFGF["config.yaml<br/>(koanf: defaults → YAML → OWNCORD_* env)"]
        BIN --> DATA["data dir<br/>SQLite DB + uploads + TLS certs"]
        BIN --> LKPROC["livekit-server<br/>(optional managed subprocess)"]
        BIN --> P1[":8443 HTTPS + WSS<br/>API, WS, admin, uploads"]
        BIN -.-> P80[":80 ACME HTTP-01<br/>(when TLS mode acme)"]
        LKPROC --> P2["LiveKit ports<br/>(WS + UDP media range)"]
    end

    C1["Tauri clients"] --> P1
    C1 --> P2
    ADMB["Admin browser<br/>(allowed CIDRs only)"] --> P1

    subgraph constraints ["Single-instance constraints (scale-out blockers)"]
        R1["in-memory rate-limiter windows<br/>(lockouts persisted, windows not)"]
        R2["in-memory pub/sub + replay ring buffer"]
        R3["process-local TOTP replay store"]
        R4["SQLite single-writer (MaxOpenConns=1)"]
        R5["process-local presence/voice state<br/>(wiped and rebuilt per process at boot)"]
    end
    BIN --- constraints
```

**What this shows.** The deployment unit is one process per community —
TLS (self-signed, custom, or ACME), the DB, uploads, the admin panel, and
optionally LiveKit are all owned by that process. The design is explicitly
single-instance: rate-limit windows, pub/sub, the replay ring buffer, the
TOTP replay store, and presence/voice state (derived from live hub membership
and cold-reset at every boot) are process-local, and SQLite runs with a
single writer — enforced by an OS-level lock beside the database file, so a
second process fails fast instead of silently fighting the first over that
state. Horizontal scaling is out of scope today; the constraint boxes name
exactly what would have to move to shared infrastructure if that ever
changes. A 15-minute maintenance goroutine (expired sessions, orphaned
attachments, scheduled backups, with a circuit breaker) and graceful drain on
SIGINT/SIGTERM round out the process lifecycle.

A note on client platforms while the deployment story is in view: the desktop
client ships for Windows and Linux (x86_64 + ARM64) only. macOS is a
deliberate scope decision, not an oversight — a trustworthy macOS build
requires Apple notarization (paid developer enrollment plus CI signing
secrets), and an unsigned bundle would train users to bypass Gatekeeper.
Revisit when that commitment is on the table.

**Source of truth:** `Server/main.go`, `Server/config/config.go`,
`Server/docker-compose.yml`, `docs/deployment.md`, `docs/server-configuration.md`,
`Client/tauri-client/src-tauri/src/lib.rs`.
