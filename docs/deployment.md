# Deployment Guide

Production deployment guide for OwnCord server on Windows and Linux.

## Prerequisites

- **Windows 10+** (x64) or **Linux** (x64)
- **Go 1.25+** (only if building from source)
- **LiveKit Server** binary (for voice/video) -- see [LiveKit Setup](livekit-setup.md)
- Ports available: `8443` (default), `7880` (LiveKit), `80` (if using ACME/Let's Encrypt)

## Building from Source

**Windows:**
```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
```

**Linux:**
```bash
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.0.0" .
```

- `-s -w` strips debug info (smaller binary)
- `-X main.version=...` embeds the version string
- `CGO_ENABLED=0` produces a fully static binary on Linux

Alternatively, download a pre-built binary from GitHub Releases:
- **Windows**: `chatserver.exe`
- **Linux**: `chatserver-linux-amd64.tar.gz` (extract to get `chatserver`)

## Docker (Linux)

The easiest way to run OwnCord on Linux. Includes the chat server and LiveKit voice/video as separate containers on a shared internal network.

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Ports available: `8443` (chat), `7880-7881` TCP, `50000-60000` UDP (LiveKit media)

### Quick Start

```bash
cd Server

# 1. Create your secrets file
cp .env.example .env
# Edit .env — set LIVEKIT_API_KEY and LIVEKIT_API_SECRET (secret must be 32+ chars)

# 2. Create your LiveKit config
cp livekit.yaml.example livekit.yaml
# Edit livekit.yaml — set node_ip to your server's public IP, and paste the same key/secret

# 3. Create a minimal config.yaml for OwnCord (server name, TLS, etc.)
# Leave voice.livekit_url and voice.livekit_binary unset — compose injects these via env vars

# 4. Start
docker compose up -d
```

On first start OwnCord creates its database and writes defaults into `/app/data`. Navigate to `https://<your-ip>:8443/admin` to create the Owner account.

### config.yaml for Docker

You do **not** need to set `voice.livekit_api_key`, `voice.livekit_api_secret`, or `voice.livekit_binary` in your `config.yaml` when using Docker — these are injected via environment variables from `.env`. Set everything else as normal:

```yaml
server:
  name: "My OwnCord"
  port: 8443

voice:
  livekit_url: "ws://livekit:7880"   # Docker service DNS — do not change
  quality: "medium"

tls:
  mode: "self_signed"   # or "acme" / "manual" for production
```

### Data Persistence

The `owncord-data` Docker volume maps to `/app/data` inside the container. This holds the SQLite database, TLS certs, uploads, and backups. It persists across container restarts and upgrades.

To back up, use the admin backup endpoint as normal — backups land in `/app/data/backups/` which is part of the named volume.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The named volume is preserved — no data loss.

### LiveKit in Docker

LiveKit runs as its own container (`livekit/livekit-server:v1`) and is **not** managed by OwnCord's companion-process system. Leave `voice.livekit_binary` unset. See [LiveKit Setup — Docker](livekit-setup.md#docker) for details.

---

## First Run Behavior

When `chatserver.exe` starts for the first time:

1. **Config creation** -- `config.yaml` is written to the working directory with defaults
2. **Data directory** -- `data/` is created (database, certs, uploads, backups)
3. **TLS certificate** -- A self-signed certificate is generated at `data/cert.pem` / `data/key.pem`
4. **Database migration** -- SQLite database is created and all migrations run
5. **Status reset** -- All user statuses are set to `offline`, stale voice states are cleared
6. **Admin setup page** -- Navigate to `https://localhost:8443/admin` to create the Owner account

The server listens on `https://0.0.0.0:8443` by default. See [Server Configuration](server-configuration.md) for all options.

## Running as a Windows Service

### Option 1: NSSM (Non-Sucking Service Manager)

```powershell
# Install NSSM (via Chocolatey or download from nssm.cc)
choco install nssm

# Create service
nssm install OwnCord "C:\OwnCord\chatserver.exe"
nssm set OwnCord AppDirectory "C:\OwnCord"
nssm set OwnCord DisplayName "OwnCord Chat Server"
nssm set OwnCord Start SERVICE_AUTO_START

# Manage
nssm start OwnCord
nssm stop OwnCord
nssm restart OwnCord
```

### Option 2: Task Scheduler

1. Open Task Scheduler, create a new task
2. Trigger: **At startup**
3. Action: Start `chatserver.exe`
4. Set "Start in" to the directory containing `config.yaml`
5. Check "Run whether user is logged on or not"
6. Check "Run with highest privileges"

## TLS Setup

### Self-Signed (default)

Auto-generated on first run. The Tauri client uses TOFU pinning to accept the cert on first connect.

```yaml
tls:
  mode: "self_signed"
```

### Let's Encrypt (ACME)

Automatic certificate issuance and renewal. Requires port 80 open and a public domain.

```yaml
tls:
  mode: "acme"
  domain: "chat.example.com"
  acme_cache_dir: "data/acme_certs"
```

### Manual Certificate

Use your own certificate files:

```yaml
tls:
  mode: "manual"
  cert_file: "path/to/cert.pem"
  key_file: "path/to/key.pem"
```

### TLS Off

Not recommended. For development or when behind a TLS-terminating reverse proxy:

```yaml
tls:
  mode: "off"
```

## Backup Strategy

### SQLite WAL Considerations

The database uses SQLite WAL mode. Do NOT copy the `.db` file directly while the server is running -- use the backup endpoint instead.

### Admin Backup Endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/api/backup` | POST | Create a new backup (owner-only) |
| `/admin/api/backups` | GET | List all backups (newest first) |
| `/admin/api/backups/{name}` | DELETE | Delete a backup (owner-only) |
| `/admin/api/backups/{name}/restore` | POST | Restore from backup (owner-only; creates pre-restore safety backup first) |

Backups are stored in `data/backups/` with timestamps.

### Scheduled Backups

Use Windows Task Scheduler with PowerShell:

```powershell
$headers = @{ "Cookie" = "session=<admin-session-token>" }
Invoke-RestMethod -Uri "https://localhost:8443/admin/api/backup" -Method POST -Headers $headers -SkipCertificateCheck
```

### Restore

Restoring replaces the live database file. A pre-restore safety backup is created automatically. A server restart is recommended after restore.

## Monitoring

### Health Endpoint

`GET /health` -- public, no authentication required.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 86400,
  "online_users": 12
}
```

### Metrics Endpoint

`GET /api/v1/metrics` -- admin IP restricted.

```json
{
  "uptime": "24h0m0s",
  "uptime_seconds": 86400,
  "goroutines": 42,
  "heap_alloc_mb": 15.3,
  "heap_sys_mb": 24.0,
  "num_gc": 150,
  "connected_users": 12,
  "voice_sessions": 3,
  "livekit_healthy": true
}
```

### LiveKit Health

`GET /api/v1/livekit/health` -- checks LiveKit companion process reachability.

### Diagnostics

`GET /api/v1/diagnostics/connectivity` -- connectivity diagnostics for troubleshooting.

## Auto-Update

### Server

The server checks GitHub Releases for updates:
- Compares semver versions
- Results are cached for 1 hour
- Downloads `chatserver.exe` with detached Ed25519/minisign signature verification
- Verifies a signed `server-update-manifest.json` that binds the binary hash to the release version
- Cross-checks the binary SHA256 against `checksums.sha256`
- On restart, the current binary is rotated to `chatserver.exe.old` before the new binary takes its place

Set `github.token` in config for higher API rate limits (5000/hr vs 60/hr unauthenticated).

### Client

The Tauri client uses NSIS installer updates:
- Server exposes client update assets from GitHub Releases
- Ed25519 signature verification before applying

## Firewall and Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| `8443` | TCP | HTTPS server (configurable via `server.port`) |
| `80` | TCP | ACME HTTP-01 challenge (only if `tls.mode: acme`) |
| `7880` | TCP | LiveKit server (WebSocket signaling) |
| `7881` | TCP | LiveKit server (RTC/TURN over TCP) |
| `50000-60000` | UDP | LiveKit WebRTC media (ICE candidates) |

For remote access, see the [Port Forwarding Guide](port-forwarding.md) or [Tailscale Guide](tailscale.md).

## Hardening Checklist

- [ ] **Change default admin password** -- create a strong Owner password during setup
- [ ] **Set `admin_allowed_cidrs`** -- restrict admin access to specific IPs if needed
- [ ] **Enable TLS** -- use `acme` or `manual` mode; avoid `off` in production
- [ ] **Set `allowed_origins`** -- restrict WebSocket origins to your domain
- [ ] **Set `trusted_proxies`** -- configure if behind a reverse proxy
- [ ] **Set stable voice credentials** -- set `livekit_api_key` and `livekit_api_secret` to avoid token breakage on restart
- [ ] **Set `voice.node_ip`** -- required for remote users behind NAT
- [ ] **Review upload limits** -- adjust `upload.max_size_mb` for your use case
- [ ] **Configure GitHub token** -- optional, for reliable update checks
- [ ] **Schedule backups** -- use the admin backup endpoint on a cron schedule
- [ ] **Monitor health** -- poll `/health` for uptime monitoring

## Background Maintenance

The server runs a maintenance loop every 15 minutes that:
- Purges expired user sessions
- Deletes orphaned file attachments (uploaded but never linked to a message, older than 1 hour)
- Uses a circuit breaker (pauses after 5 consecutive failures)

## Graceful Shutdown

The server handles `Ctrl+C` (SIGINT) and `SIGTERM`:
1. Stops accepting new connections
2. Closes all WebSocket connections and voice rooms
3. Drains HTTP connections with a 30-second timeout
4. Stops the maintenance loop
5. Closes the database

## See Also

- [Server Configuration](server-configuration.md) -- full config key reference
- [LiveKit Setup](livekit-setup.md) -- voice/video setup
- [Quick Start](quick-start.md) -- getting started
- [Port Forwarding](port-forwarding.md) -- port forwarding for remote access
- [Tailscale](tailscale.md) -- zero-config networking
- [Security](security.md) -- security guidelines
