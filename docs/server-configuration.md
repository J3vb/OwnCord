# Server Configuration Reference

Complete reference for all OwnCord server configuration options.

## Overview

OwnCord server reads configuration from `config.yaml` in the working directory. On first run, if the file does not exist, a default `config.yaml` is created automatically.

Configuration is loaded in three layers (later layers override earlier ones):

1. **Built-in defaults** (compiled into the binary)
2. **YAML file** (`config.yaml`)
3. **Environment variables** (prefix: `OWNCORD_`)

## Config Key Reference

### Server (`server`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `server.port` | int | `8443` | HTTP(S) listen port |
| `server.name` | string | `"OwnCord Server"` | Server display name (shown in `/api/v1/info` and admin panel) |
| `server.data_dir` | string | `"data"` | Directory for database, certs, uploads, backups |
| `server.allowed_origins` | string[] | `["*"]` | WebSocket CORS allowed origins; restrict in production |
| `server.trusted_proxies` | string[] | `[]` | CIDRs of trusted reverse proxies (for X-Forwarded-For) |
| `server.admin_allowed_cidrs` | string[] | private networks | CIDRs allowed to access `/admin` routes. Default: `127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` |

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
| `database.path` | string | `"data/chatserver.db"` | Path to SQLite database file |

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
| `voice.livekit_binary` | string | `""` | Path to `livekit-server` binary; empty = don't auto-start |
| `voice.node_ip` | string | `""` | Public IP for WebRTC ICE candidates; empty = auto-detect. Required for remote users behind NAT. |
| `voice.quality` | string | `"medium"` | Voice quality preset: `low`, `medium`, `high` |

> **Warning:** If `livekit_api_key` or `livekit_api_secret` are left empty, random credentials are generated on each startup. This means voice tokens break on restart. Always set stable credentials in production. See [LiveKit Setup](livekit-setup.md) for details.

### GitHub / Updates (`github`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `github.token` | string | `""` | Optional GitHub API token for higher rate limits on update checks (5000 req/hr vs 60) |

## Environment Variable Overrides

Every config key can be overridden via environment variables using the prefix `OWNCORD_`.

**Format:** `OWNCORD_<SECTION>_<KEY>`

| Environment Variable | Config Path |
|---------------------|-------------|
| `OWNCORD_SERVER_PORT` | `server.port` |
| `OWNCORD_SERVER_NAME` | `server.name` |
| `OWNCORD_SERVER_DATA_DIR` | `server.data_dir` |
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
| `OWNCORD_VOICE_QUALITY` | `voice.quality` |
| `OWNCORD_GITHUB_TOKEN` | `github.token` |

## Example config.yaml

```yaml
# OwnCord Server Configuration
server:
  port: 8443
  name: "OwnCord Server"
  data_dir: "data"
  allowed_origins: ["*"]          # restrict in production
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
  quality: "medium"                # low | medium | high

github:
  token: ""                        # optional GitHub PAT for update check rate limits
```

## See Also

- [Deployment Guide](deployment.md) -- production deployment guide
- [LiveKit Setup](livekit-setup.md) -- voice/video setup
- [Quick Start](quick-start.md) -- getting started
