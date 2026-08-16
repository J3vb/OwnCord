# Server Configuration Reference

Complete reference for all OwnCord server configuration options.

## Overview

OwnCord server reads configuration from `config.yaml` in the working directory. On first run, if the file does not exist, a default `config.yaml` is created automatically.

Configuration is loaded in three layers (later layers override earlier ones):

1. **Built-in defaults** (compiled into the binary)
2. **YAML file** (`config.yaml`)
3. **Environment variables** (prefix: `OWNCORD_`)

### First-run setup wizard

The admin panel's first-time setup wizard (shown at `/admin` until the Owner
account exists) writes a subset of these keys into `config.yaml` for you:
`server.port`, `server.name`, `tls.mode`, `tls.domain`, `upload.max_size_mb`,
`voice.quality` and `voice.auto_download_livekit`. It also persists the auto-generated
`voice.livekit_api_key` / `voice.livekit_api_secret` (only when the file has
none) so voice tokens survive restarts. The wizard patches the file in place —
comments and hand-edited values it doesn't manage are preserved — and restarts
the server automatically when a startup-only value changed. Note that
`OWNCORD_*` environment variables still override anything the wizard writes.

## Config Key Reference

### Server (`server`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `server.port` | int | `8443` | HTTP(S) listen port |
| `server.name` | string | `"OwnCord Server"` | Server display name (shown in `/api/v1/info` and admin panel) |
| `server.data_dir` | string | `"data"` | Directory for database, certs, uploads, backups |
| `server.max_ws_connections` | int | `0` | Cap on concurrently connected WebSocket clients; further upgrades get 503 until connections free up. `0` = unlimited. Every connection costs goroutines and buffered send queues — set a ceiling that matches the host's memory before opening the server to a large community. |
| `server.metrics_allowed_cidrs` | []string | `[]` | Separate allowlist for `/api/v1/metrics` and the Prometheus `/metrics` exporter, so a central scraper can be admitted without widening `/admin` to its network. Empty = falls back to `admin_allowed_cidrs`. |
| `server.livekit_webhook_allowed_cidrs` | []string | `[]` | Separate allowlist for the LiveKit webhook/health endpoints (which also authenticate cryptographically) — an externally-hosted LiveKit's IP goes here, not in the admin allowlist. Empty = falls back to `admin_allowed_cidrs`. |
| `server.allowed_origins` | string[] | `[]` | WebSocket CORS allowed origins for **web/browser** clients; empty list DENIES all cross-origin (set to `["*"]` to allow any origin). The OwnCord desktop client needs no entry here — its webview origins (`http(s)://tauri.localhost`, `tauri://localhost`) are always accepted. |
| `server.trusted_proxies` | string[] | `[]` | CIDRs of trusted reverse proxies (for X-Forwarded-For) |
| `server.admin_allowed_cidrs` | string[] | private networks | CIDRs allowed to access `/admin` routes. Default: `127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` |
| `server.waf_enabled` | bool | `false` | Enable the Coraza WAF middleware (inline rules + OWASP Core Rule Set) |
| `server.waf_paranoia_level` | int | `2` | OWASP CRS paranoia level 1–4; values outside that range fall back to 2 |
| `server.waf_crs_mode` | string | `"detect"` | CRS layer mode: `off` (inline rules only), `detect` (matches logged, never blocks), `block` (anomaly-scoring blocking). Unknown values fall back to `detect`. |
| `server.restart_mode` | string | `"auto"` | How self-restarts (update apply, backup restore, setup wizard) hand off after the server drains: `supervised` exits cleanly and relies on systemd/NSSM/Docker to relaunch; `spawn` starts the replacement binary directly; `auto` picks `supervised` when a supervisor or container is detected, else `spawn`. NSSM deployments must set `supervised` explicitly (see [Deployment](deployment.md)). |

### TLS (`tls`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tls.mode` | string | `"self_signed"` | TLS mode: `self_signed`, `acme`, `manual`, `off` |
| `tls.cert_file` | string | `"data/cert.pem"` | Path to TLS certificate (used by `manual` and `self_signed`) |
| `tls.key_file` | string | `"data/key.pem"` | Path to TLS private key |
| `tls.domain` | string | `""` | Domain for ACME/Let's Encrypt (required when `mode: acme`) |
| `tls.acme_cache_dir` | string | `"data/acme_certs"` | Directory for cached Let's Encrypt certificates |

### Database (`database`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `database.type` | string | `"sqlite"` | Database backend. `sqlite` (or empty) is the only supported value — any other value makes the server refuse to start. |
| `database.path` | string | `"data/chatserver.db"` | Path to SQLite database file |
| `database.max_readers` | int | `0` | Bound on the read-only connection pool. `0` = automatic (`max(4, CPU count)`); clamped to 1–64. Readers beyond the CPU count mostly buy queueing, not throughput. |

### Backups (`backup`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backup.dir` | string | `"data/backups"` | Directory where database backups are written and pruned. Point it at another disk or an off-host mount so backups don't share a single point of failure with the live database. The admin panel's Backup Schedule and Retention settings operate on this directory. |

### Security (`security`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `security.auth_rate_limit_multiplier` | float | `1.0` | Scales the per-IP auth rate limits and failure thresholds (registration, login, TOTP, sensitive endpoints). The defaults assume roughly one person per IP; raise this for communities behind a shared NAT (office, school). Clamped to 0.1–100. |

### Uploads (`upload`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `upload.max_size_mb` | int | `100` | Maximum file upload size in megabytes |
| `upload.storage_dir` | string | `"data/uploads"` | Directory where uploaded files are stored |

### Voice / LiveKit (`voice`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `voice.livekit_api_key` | string | *(random per run)* | LiveKit API key. Set a stable value for persistent voice tokens. |
| `voice.livekit_api_secret` | string | *(random per run)* | LiveKit API secret (min 32 chars). Set a stable value for persistent tokens. |
| `voice.livekit_url` | string | `"ws://localhost:7880"` | LiveKit server WebSocket URL |
| `voice.livekit_binary` | string | `""` | Path to an existing `livekit-server` binary; set to skip auto-download and run your own build |
| `voice.auto_download_livekit` | bool | `false` (compiled) / `true` in the generated config | When no `livekit_binary` is set, download a pinned `livekit-server` release from the official LiveKit GitHub releases (verified against the release `checksums.txt`) into `data/livekit/` and run it automatically |
| `voice.livekit_version` | string | `""` | Override the pinned `livekit-server` version used by auto-download (e.g. `"1.13.5"`); empty = built-in pin |
| `voice.node_ip` | string | `""` | Public IP for WebRTC ICE candidates; empty = auto-detect. Required for remote users behind NAT. |
| `voice.advertise_internal_ip` | bool | `false` | Also advertise internal (LAN) IPs as ICE candidates. Enable when the server is reachable via both a LAN IP and a public IP so local-network clients can connect to voice. |
| `voice.quality` | string | `"medium"` | Voice quality preset: `low`, `medium`, `high` |

> **Warning:** If `livekit_api_key` or `livekit_api_secret` are left empty, random credentials are generated on each startup. This means voice tokens break on restart. Always set stable credentials in production. See [LiveKit Setup](livekit-setup.md) for details.

#### Server with both a LAN and a public IP

If your server is dual-homed (e.g. `192.168.1.10` on the LAN and `47.x.x.x` public), set `voice.node_ip` to the public IP **and** `voice.advertise_internal_ip: true`. LiveKit then advertises the LAN address in addition to the public one, so clients on the local network connect directly while remote clients use the public IP.

For LiveKit options OwnCord does not model, you can take ownership of the auto-started server's config: edit `data/livekit.yaml` and delete the header line containing the auto-generated marker — OwnCord will stop regenerating the file on startup (your `keys:` entry must still match `voice.livekit_api_key` / `voice.livekit_api_secret`).

### GitHub / Updates (`github`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `github.token` | string | `""` | Optional GitHub API token for higher rate limits on update checks (5000 req/hr vs 60) |
| `github.owner` | string | `"J3vb"` | Owner of the GitHub repository server and client updates are fetched from |
| `github.repo` | string | `"OwnCord"` | Repository whose releases carry update assets. Must stay publicly readable — both the server self-update and the client auto-update chain fetch release assets from it |

### Event Persistence (`event_persistence`)

Controls the tiered event log used for WebSocket reconnection replay. When enabled, missed events are stored in the database so clients that reconnect after the in-memory ring buffer window (`replay_ring_size` events) can still replay missed events from the DB tier.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `event_persistence.enabled` | bool | `true` | Enable cold-storage event persistence. When `false`, only the in-memory ring buffer is used (lower durability). |
| `event_persistence.retention_hours` | int | `24` | How long persisted events are kept before the pruner deletes them |
| `event_persistence.batch_size` | int | `50` | Maximum events per database flush |
| `event_persistence.batch_flush_ms` | int | `100` | Maximum delay between flushes (milliseconds) |
| `event_persistence.pruner_interval_minutes` | int | `60` | How often the pruner goroutine wakes up to delete expired events |
| `event_persistence.replay_ring_size` | int | `1000` | Capacity of the in-memory reconnect replay ring. Larger rings bridge longer disconnects without touching the database, at ~1 message payload of memory per slot. |
| `event_persistence.replay_cold_limit` | int | `5000` | Maximum persisted events a single reconnect may replay; a larger gap falls back to a full resync. Watch the `reconnect_tier_full` metric before raising it. |

### Telemetry / OpenTelemetry (`telemetry`)

Controls the OpenTelemetry SDK. Requires building with `-tags otel` (see [Contributing](contributing.md)). When disabled, the server uses no-op tracer/meter providers; the legacy JSON `/api/v1/metrics` endpoint exists regardless of this setting (it is admin-IP-restricted, like all metrics surfaces).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `telemetry.enabled` | bool | `false` | Enable the OTel SDK |
| `telemetry.exporter` | string | `"none"` | Exporter backend: `none`, `prometheus`, `otlp` |
| `telemetry.otlp_endpoint` | string | `""` | gRPC endpoint for the OTLP exporter (e.g. `localhost:4317`). Only used when `exporter: otlp`. |
| `telemetry.otlp_insecure` | bool | `false` | Disable TLS for the OTLP gRPC connection. Only set `true` in development / private-network deployments. |
| `telemetry.service_name` | string | `"owncord-server"` | OTel `service.name` resource attribute |

> **Local development:** Run `make otel-up` (from `Server/`) to start Jaeger + Prometheus via Docker.
> Jaeger UI: `http://localhost:16686` — Prometheus UI: `http://localhost:9090`

### Plugins (`plugins`)

Controls the Wazero WASM plugin runtime. Requires building with `-tags wazero`. When disabled, no plugins are loaded; plugin admin lifecycle endpoints return `503 Service Unavailable` and the plugin list endpoint returns an empty list.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `plugins.enabled` | bool | `false` | Enable plugin loading at startup |
| `plugins.directory` | string | `"data/plugins"` | Directory scanned for plugin packages on startup |
| `plugins.max_memory_mb` | int | `64` | Maximum WASM linear memory per plugin (megabytes) |
| `plugins.cpu_budget_ms` | int | `100` | Maximum CPU time per plugin invocation (milliseconds) |
| `plugins.http_allowlist` | string[] | `[]` | Host suffixes plugins may reach via the `host_http` capability (e.g. `["api.steampowered.com"]`). Empty = no outbound HTTP. |

### GIF Picker (`gif`)

Powers the client's GIF picker. The server proxies the Klipy API so the key
never ships in the desktop bundle — the client only ever calls
`/api/v1/gif/*` on its own server.

**Disabled by default.** With no `gif.api_key` set, `/api/v1/gif/*` returns
`503 GIF_DISABLED` and clients hide their GIF button. Nothing else changes.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `gif.api_key` | string | `""` | Klipy API key. Get one at [partner.klipy.com](https://partner.klipy.com). Empty = feature off. |

> **Treat this as a credential.** Prefer `OWNCORD_GIF_API_KEY` (or a secrets
> manager) over writing it into `config.yaml`, and rotate it if it has ever
> been exposed to a client build.

### Logging (`logging`)

Controls server log verbosity. The level gates both stdout and the in-memory
ring buffer that backs the admin panel's live log view.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `logging.level` | string | `"info"` | Minimum level logged: `debug`, `info`, `warn`, `error`. Empty = `info`; an unrecognised value falls back to `info` with a startup warning. |

## Environment Variable Overrides

Every config key can be overridden via environment variables using the prefix `OWNCORD_`.

**Format:** `OWNCORD_<SECTION>_<KEY>` — the first `_` after the prefix maps to
the section/key dot; the scheme covers **every** key in the file, including ones
absent from the table below (it is a representative subset, not the full list).

| Environment Variable | Config Path |
|---------------------|-------------|
| `OWNCORD_SERVER_PORT` | `server.port` |
| `OWNCORD_SERVER_NAME` | `server.name` |
| `OWNCORD_SERVER_DATA_DIR` | `server.data_dir` |
| `OWNCORD_SERVER_RESTART_MODE` | `server.restart_mode` |
| `OWNCORD_DATABASE_PATH` | `database.path` |
| `OWNCORD_TLS_MODE` | `tls.mode` |
| `OWNCORD_TLS_CERT_FILE` | `tls.cert_file` |
| `OWNCORD_TLS_DOMAIN` | `tls.domain` |
| `OWNCORD_UPLOAD_MAX_SIZE_MB` | `upload.max_size_mb` |
| `OWNCORD_UPLOAD_STORAGE_DIR` | `upload.storage_dir` |
| `OWNCORD_VOICE_LIVEKIT_API_KEY` | `voice.livekit_api_key` |
| `OWNCORD_VOICE_LIVEKIT_API_SECRET` | `voice.livekit_api_secret` |
| `OWNCORD_VOICE_LIVEKIT_URL` | `voice.livekit_url` |
| `OWNCORD_VOICE_NODE_IP` | `voice.node_ip` |
| `OWNCORD_VOICE_ADVERTISE_INTERNAL_IP` | `voice.advertise_internal_ip` |
| `OWNCORD_VOICE_QUALITY` | `voice.quality` |
| `OWNCORD_GITHUB_TOKEN` | `github.token` |
| `OWNCORD_EVENT_PERSISTENCE_ENABLED` | `event_persistence.enabled` |
| `OWNCORD_EVENT_PERSISTENCE_RETENTION_HOURS` | `event_persistence.retention_hours` |
| `OWNCORD_TELEMETRY_ENABLED` | `telemetry.enabled` |
| `OWNCORD_TELEMETRY_EXPORTER` | `telemetry.exporter` |
| `OWNCORD_TELEMETRY_OTLP_ENDPOINT` | `telemetry.otlp_endpoint` |
| `OWNCORD_TELEMETRY_SERVICE_NAME` | `telemetry.service_name` |
| `OWNCORD_PLUGINS_ENABLED` | `plugins.enabled` |
| `OWNCORD_PLUGINS_DIRECTORY` | `plugins.directory` |
| `OWNCORD_GIF_API_KEY` | `gif.api_key` |
| `OWNCORD_SERVER_WAF_ENABLED` | `server.waf_enabled` |
| `OWNCORD_DATABASE_TYPE` | `database.type` |
| `OWNCORD_TELEMETRY_OTLP_INSECURE` | `telemetry.otlp_insecure` |
| `OWNCORD_LOGGING_LEVEL` | `logging.level` |

## Example config.yaml

```yaml
# OwnCord Server Configuration
server:
  port: 8443
  name: "OwnCord Server"
  data_dir: "data"
  allowed_origins: []             # empty = deny all cross-origin; set to ["*"] to allow any
  trusted_proxies: []              # e.g. ["10.0.0.0/8"] if behind a reverse proxy
  admin_allowed_cidrs:
    - "127.0.0.0/8"
    - "::1/128"
    - "10.0.0.0/8"
    - "172.16.0.0/12"
    - "192.168.0.0/16"

database:
  path: "data/chatserver.db"

tls:
  mode: "self_signed"              # self_signed | acme | manual | off
  cert_file: "data/cert.pem"
  key_file: "data/key.pem"
  domain: ""                       # required for acme mode
  acme_cache_dir: "data/acme_certs"

upload:
  max_size_mb: 100
  storage_dir: "data/uploads"

voice:
  livekit_api_key: "your-api-key"
  livekit_api_secret: "your-secret-at-least-32-characters-long"
  livekit_url: "ws://localhost:7880"
  livekit_binary: ""               # path to livekit-server binary
  node_ip: ""                      # public IP for remote users behind NAT
  advertise_internal_ip: false     # also advertise LAN IPs (dual-homed servers)
  quality: "medium"                # low | medium | high

github:
  token: ""                        # optional GitHub PAT for update check rate limits
  owner: "J3vb"                    # update source repo owner
  repo: "OwnCord"                  # repo holding release assets (binaries + source snapshots)

# Event persistence (tiered reconnect replay)
event_persistence:
  enabled: true
  retention_hours: 24
  batch_size: 50
  batch_flush_ms: 100
  pruner_interval_minutes: 60

# OpenTelemetry (requires build tag: -tags otel)
telemetry:
  enabled: false
  exporter: "none"                 # none | prometheus | otlp
  otlp_endpoint: ""                # e.g. "localhost:4317" for OTLP gRPC
  service_name: "owncord-server"

# Plugin runtime (requires build tag: -tags wazero)
plugins:
  enabled: false
  directory: "data/plugins"
  max_memory_mb: 64
  cpu_budget_ms: 100
  http_allowlist: []               # host suffixes plugins may reach, e.g. ["api.steampowered.com"]

# GIF picker (server-side Klipy proxy). Empty key = feature off.
# Prefer OWNCORD_GIF_API_KEY over storing the key in this file.
gif:
  api_key: ""

# Logging. "level" gates what is logged, to stdout and the admin panel's live
# log view alike. Override without editing this file via OWNCORD_LOGGING_LEVEL.
logging:
  level: "info"                    # debug | info | warn | error
```

## See Also

- [Deployment Guide](deployment.md) -- production deployment guide
- [LiveKit Setup](livekit-setup.md) -- voice/video setup
- [Quick Start](quick-start.md) -- getting started
