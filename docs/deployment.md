# Deployment Guide

Production deployment guide for OwnCord server on Windows and Linux.

## Prerequisites

- **Windows 10+** (x64) or **Linux** (x64)
- **Go 1.26+** (only if building from source)
- **LiveKit Server** binary (only if enabling voice/video) -- see [LiveKit Setup](livekit-setup.md)
- Required port: `8443` (OwnCord HTTPS/WebSocket)
- Additional ports for voice/video: `7880/TCP`, `7881/TCP`, `50000-60000/UDP`
- Additional port for ACME TLS: `80/TCP`

## Building from Source

**Windows:**

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.2.0-alpha.4" .
```

**Linux:**

```bash
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.2.0-alpha.4" .
```

- `-s -w` strips debug info (smaller binary)
- `-X main.version=...` embeds the version string
- `CGO_ENABLED=0` produces a fully static binary on Linux

Alternatively, download a pre-built binary from GitHub Releases:

| Platform      | Asset                           |
| ------------- | ------------------------------- |
| Windows x64   | `chatserver.exe`                |
| Windows ARM64 | `chatserver-windows-arm64.exe`  |
| Linux x64     | `chatserver-linux-amd64.tar.gz` |
| Linux ARM64   | `chatserver-linux-arm64.tar.gz` |

The Linux archives extract to a binary named `chatserver`. Download the asset
matching your machine's architecture: the server refuses an update built for a
different one rather than installing something it cannot execute, so a mismatch
leaves you stranded on the version you installed.

Every asset is built on its own architecture and, before release, run through a
full lifecycle check — it starts, migrates a fresh database, reports healthy,
shuts down cleanly on a stop signal, and restarts on the same data directory.

## Docker (Linux)

The easiest way to run OwnCord on Linux. Includes the chat server and LiveKit voice/video as separate containers on a shared internal network. The server image is built `FROM gcr.io/distroless/static-debian12` and runs as a non-root user (`65532`), so there is no shell inside the container.

`ghcr.io/j3vb/owncord-server` is published as a single multi-architecture tag
covering **`linux/amd64` and `linux/arm64`** — a Raspberry Pi 4/5, an Ampere or
Graviton VPS and an ordinary x86-64 box all pull the same tag and get the right
image. Both architectures are built and lifecycle-checked on their own hardware
before any tag is pushed: the image boots on an empty volume, migrates a fresh
database, reports healthy, shuts down cleanly on `docker stop`, and is then
replaced by a new container that finds the old data intact.

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- `linux/amd64` or `linux/arm64` host
- Ports available: `8443` (chat), `7880-7881` TCP, `50000-60000` UDP (LiveKit media)

### Health and privilege

The image declares its own `HEALTHCHECK`, so `docker ps` reports a health state
even without the compose file. The binary is its own probe (`chatserver
healthcheck`) because distroless ships no shell or `curl`. Docker only
_surfaces_ `unhealthy` — it does not restart on it; add an external watchdog if
you want that.

The shipped `docker-compose.yml` runs the server with no Linux capabilities at
all and with privilege escalation blocked:

```yaml
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
```

If you run the container by hand rather than through compose, pass the same
two: `--cap-drop=ALL --security-opt=no-new-privileges:true`. The server binds
`8443`, above the privileged-port range, so it needs no capability. A read-only
root filesystem is _not_ supported: the server writes its default
`config.yaml` into `/app` on first boot.

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
  livekit_url: "ws://livekit:7880" # Docker service DNS — do not change
  quality: "medium"

tls:
  mode: "self_signed" # or "acme" / "manual" for production
```

### Data Persistence

The `owncord-data` Docker volume maps to `/app/data` inside the container. This holds the SQLite database, TLS certs, uploads, and backups. It persists across container restarts and upgrades.

To back up, use the admin backup endpoint as normal — backups land in `/app/data/backups/` which is part of the named volume.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The named volume is preserved — no data loss. Take the pre-upgrade archive
first, and know what a rollback costs before you need one:
[Upgrade and Rollback](#upgrade-and-rollback) covers both, for Docker and for a
standalone install.

Pulling the image is the **only** upgrade path in Docker: the admin panel's
in-place "Apply Update & Restart" is refused in container deployments (503
`CONTAINER_DEPLOYMENT`), because the running binary is image content — a
replacement written next to it would die with the container. The shipped
image sets `OWNCORD_CONTAINER=1` to mark this; operators who bind-mount the
server binary into a container and genuinely want in-place self-update can
set `OWNCORD_CONTAINER=0` to opt back in.

The admin panel's backup **restore** (and a setup-wizard restart) does work
in containers: the server drains and exits cleanly, relying on the
container's restart policy to relaunch it. The shipped `docker-compose.yml`
sets `restart: unless-stopped`, which covers this; if you run the container
by hand, pass `--restart unless-stopped` or the restore leaves the container
stopped.

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
6. **Setup wizard** -- Navigate to `https://localhost:8443/admin` to run the first-time setup wizard

The setup wizard creates the Owner account and walks through the basics (server
name, port, TLS mode, upload limit, voice, registration and welcome
message). Choices are saved for you: live settings go to the database, and
startup settings are written into `config.yaml` — comments and any hand edits
in the file are preserved. The wizard also persists the generated LiveKit
credentials so voice keeps working across restarts. If the port or TLS mode
changed, the server restarts itself once and the wizard shows the new address.
"Skip" runs the legacy minimal flow: just the Owner account, everything else
on defaults.

Voice works out of the box: with `voice.auto_download_livekit` enabled (the
default in a freshly generated `config.yaml`, and a toggle in the wizard), the
server downloads a pinned `livekit-server` release from the official LiveKit
GitHub releases in the background — verified against the release checksum
file — into `data/livekit/` and manages the process itself. Operators who run
their own LiveKit can turn the toggle off or set `voice.livekit_binary`.

The server listens on `https://0.0.0.0:8443` by default. See [Server Configuration](server-configuration.md) for all options.

## Running as a Linux Service (systemd)

A crash — a panic under load, the OOM killer, a failed self-update — leaves a
bare-metal server down until someone notices, so run the binary under a
supervisor. A ready-made unit template ships in the repo at
[`deploy/owncord.service`](../deploy/owncord.service); installation steps are
in its header comments. The important choices it encodes:

- `Restart=always` — two deliberate exits rely on it: the server exits
  nonzero (rather than limping along) when its WebSocket dispatch loop dies,
  and it exits **cleanly** after an admin-panel self-update, backup restore,
  or setup-wizard restart, expecting systemd to relaunch it running the
  swapped binary (the server auto-detects systemd via `INVOCATION_ID` and
  hands off this way instead of spawning a child that the unit's cgroup
  cleanup would kill). `systemctl stop` still stops it — systemd never
  auto-restarts an explicitly stopped unit. **Update the unit file before
  applying server updates from the admin panel** — it also repairs the
  update handoff when updating from older OwnCord releases, whose spawned
  replacement gets reaped by the cgroup cleanup.
- `TimeoutStopSec=35` — the server drains gracefully on SIGTERM with a 30s
  budget; systemd waits it out before escalating.
- `ReadWritePaths=/opt/owncord` under `ProtectSystem=strict` — the install
  directory must stay writable or the admin panel's self-update (which
  renames the new binary into place) breaks.
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` — only needed for
  `tls.mode: acme`, which binds :80 for HTTP-01 challenges as a non-root
  user.

Pair it with the scheduled backups in the admin panel — or an external cron
line (see Backup Strategy below) if you prefer driving backups outside the
server.

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

# REQUIRED: tell the server NSSM supervises it. On a self-update/restore the
# server then exits cleanly and NSSM's default AppExit=Restart relaunches it
# with the new binary. (NSSM 2.24 is not auto-detectable, so without this the
# server spawns its own replacement, which races NSSM's relaunch.)
nssm set OwnCord AppEnvironmentExtra OWNCORD_SERVER_RESTART_MODE=supervised

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

Task Scheduler starts the process but does not supervise it, so leave
`server.restart_mode` on its default (`auto` resolves to `spawn` here): on a
self-update or restore the server starts its own replacement after draining.

## TLS Setup

What each mode means for the people connecting — desktop pinning, what a
browser will need, and what the operator can read regardless of TLS — is in
[trust-model.md](trust-model.md).

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

## Reverse Proxy Topology

OwnCord terminates its own TLS by default and does not require a reverse
proxy. If you front it with one anyway (shared host, existing nginx, central
cert management), three things matter:

1. **What the proxy can front.** Everything on port 8443 — the REST API, the
   WebSocket at `/api/v1/ws`, the admin panel, uploads, **and LiveKit
   signaling**, which the server already proxies at `/livekit/*`. You do NOT
   need to expose LiveKit's port 7880 through your proxy.
2. **What the proxy cannot front.** WebRTC media: UDP 50000–60000 (and the
   TCP 7881 fallback) must remain directly reachable on the host running
   LiveKit. An HTTP reverse proxy never carries this traffic.
3. **Tell OwnCord about the proxy.** Set `server.trusted_proxies` to the
   proxy's own address(es) (e.g. `["10.0.0.2/32"]`) so client IPs come from
   `X-Forwarded-For` for rate limiting and the admin IP allowlist. List only
   the proxy hops, never client networks.

Working nginx snippet:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass https://127.0.0.1:8443;   # or http:// with tls.mode: off
        proxy_http_version 1.1;              # required for WebSocket upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # Idle chat WebSockets outlive nginx's 60s default read timeout;
        # the client pings every 30s, so 300s has comfortable margin.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 100m;           # match upload.max_size_mb
    }
}
```

## Backup Strategy

The built-in backup covers the **database only**. Uploaded files live under
`upload.storage_dir` and are not in it — back that directory up on the same
schedule, or a restore comes back with every attachment missing.

### SQLite WAL Considerations

The database uses SQLite WAL mode. Do NOT copy the `.db` file directly while the server is running -- use the backup endpoint instead.

### Admin Backup Endpoint

| Endpoint                            | Method | Description                                                               |
| ----------------------------------- | ------ | ------------------------------------------------------------------------- |
| `/admin/api/backup`                 | POST   | Create a new backup (owner-only)                                          |
| `/admin/api/backups`                | GET    | List all backups (newest first)                                           |
| `/admin/api/backups/{name}`         | DELETE | Delete a backup (owner-only)                                              |
| `/admin/api/backups/{name}/restore` | POST   | Restore from backup (owner-only; creates pre-restore safety backup first) |

Backups are stored in the configured backup directory (default
`data/backups/`) with timestamps. Point it somewhere safer than the data
volume — another disk, or a mount that is shipped off-host (rsync, rclone,
a synced folder) — so backups don't share a single point of failure with the
live database and uploads:

```yaml
backup:
  dir: "/mnt/backup-disk/owncord"
```

Every backup is verified with SQLite's `integrity_check` right after it is
written (a failed backup is removed, never listed), and again before a
restore is allowed to overwrite the live database.

Note that a backup runs `VACUUM INTO` on the database's single write
connection: writes queue for the duration (reads keep serving). On a large
database, prefer scheduling backups at a low-traffic time of day.

### Scheduled Backups

The **Backup Schedule** (off / daily / weekly) and **Retention (days)**
settings in the admin panel are enforced by the server's maintenance loop
(checked every 15 minutes):

- A scheduled backup is taken when the newest backup on disk is older than
  the schedule interval — a manual backup resets the clock too.
- Retention deletes backups older than the configured number of days, but
  always keeps the newest one, so a stale schedule can never delete your
  last copy.

External scheduling still works if you prefer it — e.g. Linux cron:

```bash
# Nightly at 03:00 via an admin API token
0 3 * * * curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" https://localhost:8443/admin/api/backup
```

or Windows Task Scheduler with PowerShell:

```powershell
$headers = @{ "Cookie" = "session=<admin-session-token>" }
Invoke-RestMethod -Uri "https://localhost:8443/admin/api/backup" -Method POST -Headers $headers -SkipCertificateCheck
```

### Restore

Restoring replaces the live database file. A pre-restore safety backup is created automatically. A server restart is recommended after restore.

## Upgrade and Rollback

An upgrade swaps the binary (or the image) under an install directory that
nothing else touches. A **rollback is restore-then-downgrade**: put the
pre-upgrade copy back, then run the old version on it. Migrations are
forward-only. There is no down-migration and no supported way to run an older
binary against a database a newer one has already migrated — doing it anyway
is how you lose the database, not how you go back. The copy you take before
upgrading is therefore the only rollback that exists.

### Before upgrading: take the archive

Take it with the server **stopped**. The archive carries `data/chatserver.db`
as a file, and the database runs in WAL mode — a copy taken out from under a
running server is not a consistent snapshot (see
[SQLite WAL Considerations](#sqlite-wal-considerations)).

**Standalone:**

```bash
# 1. Backup while the server is still up. It is verified with integrity_check
#    as it is written and lands in data/backups/, inside the copy at step 3.
curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" \
  https://localhost:8443/admin/api/backup

# 2. Stop the server -- not "quiesce it", stop it.
sudo systemctl stop owncord          # or: nssm stop OwnCord

# 3. Copy the state off this disk, not into the directory being upgraded.
sudo cp -a /opt/owncord/data /opt/owncord/config.yaml \
  /mnt/backup-disk/owncord-pre-upgrade/
```

**Docker:** `data/` lives in the named volume and `config.yaml` does not —
the compose file bind-mounts it from the host, so a copy of the volume does
not contain it. Both have to be taken, separately:

```bash
# 1. Backup, then stop. `down` also releases the volume for step 3.
curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" \
  https://localhost:8443/admin/api/backup
docker compose down

# 2. The host-side config.yaml.
cp config.yaml /mnt/backup-disk/owncord-pre-upgrade/config.yaml

# 3. The volume, through a throwaway container -- the only way to read a named
#    volume from the host.
docker run --rm \
  -v server_owncord-data:/app/data:ro \
  -v /mnt/backup-disk/owncord-pre-upgrade:/archive \
  alpine cp -a /app/data /archive/data
```

`server_owncord-data` is the name Compose gives the `owncord-data` volume when
it runs in `Server/` (project name plus volume name); run `docker volume ls` to
confirm yours.

Copy `data/` **wholesale**, not a list of names. A version you have not
installed yet is allowed to add files to it, and a hand-written list is exactly
what silently misses one. If you copy selectively anyway, these are the pieces,
and what leaving each one out costs you:

- **The backup from `POST /admin/api/backup`** — without it your only copy of
  the database is the file-level one, and nothing verified it. The backup
  endpoint runs `integrity_check` when it writes the file and again before it
  is allowed to overwrite a live database, and the admin panel can put it back
  on its own. See [Admin Backup Endpoint](#admin-backup-endpoint).
- **`data/uploads/`** — every attachment 404s. The database rows survive, so
  messages still show their attachments; the bytes are gone and the download
  returns 404. The built-in backup covers the database only
  ([Backup Strategy](#backup-strategy)); this directory is never in it.
- **`data/totp.key`** — every enrolled authenticator stops working. Stored
  TOTP secrets are AES-256 ciphertext under this key; a server that cannot find
  the file generates a fresh one and boots, and every second factor on it is
  then undecryptable. Affected users get back in only by spending an emergency
  recovery code, and anyone without one is locked out.
- **`data/erasure.key`** — a restore cannot recognise erased accounts. A
  deletion marker names its subject as `HMAC-SHA256(key, user id)`, so without
  the key the markers name no one and a restore can resurrect what they guard.
- **`data/push_vapid.key`** — every push subscription is invalidated. Each
  `push_subscriptions` row records the key id it was created under; under a new
  key those rows are invisible and the maintenance sweep removes them. Every
  device has to subscribe again, and no push is delivered until it does.
- **`config.yaml`** — the server boots on compiled-in defaults instead: port
  8443, self-signed TLS, and freshly generated LiveKit credentials, which
  breaks every voice token and every certificate your clients have pinned.

None of these are in a database backup. Back them up on the same schedule as
the database, not only before an upgrade.

### Performing the upgrade

**Standalone** — replace the binary and start it again. Nothing else moves: no
directory is renamed, no configuration is rewritten, and the new version
migrates the database forward on its first boot.

```bash
sudo systemctl stop owncord
sudo install -m 0755 ./chatserver /opt/owncord/chatserver
sudo systemctl start owncord
```

The admin panel's in-place update performs the same swap for you, including the
supervisor handoff — see [Auto-Update](#auto-update). Take the archive first
either way; the panel does not take one for you.

**Docker** — `docker compose pull && docker compose up -d`, with the container
specifics under [Upgrading](#upgrading) in the Docker section.

**Upgrade the server before the clients.** Desktop clients fetch updates from
the server they connect to, and the server only offers releases whose protocol
epoch it can speak itself (`docs/protocol.md`, Compatibility). A release that
changes the wire protocol therefore reaches your users' clients only once the
server runs it; releases that do not change the protocol reach them regardless.
A client that is already too old for the server sees "update the client" on its
connect screen, with the usual Update Now button.

Upgrade rehearsals do not need a donated production database:
`Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` is a committed, anonymised,
alpha.4-schema dataset shaped like a month-old server (see the README beside
it), and `Server/db/alpha_snapshot_test.go` proves on every test run that the
current migrations still apply to it cleanly.

### Rolling back

**Everything written after the archive was taken is lost** — messages,
uploads, accounts, settings, every backup created since. That is the price of a
rollback, nothing about the procedure avoids it, and the only lever you have is
how recent the archive is.

**Standalone:**

```bash
sudo systemctl stop owncord
sudo rm -rf /opt/owncord/data
sudo cp -a /mnt/backup-disk/owncord-pre-upgrade/data /opt/owncord/data
sudo cp /mnt/backup-disk/owncord-pre-upgrade/config.yaml /opt/owncord/config.yaml
sudo install -m 0755 ./chatserver-previous /opt/owncord/chatserver
sudo systemctl start owncord
```

**Replace `data/`; never merge into it.** The newer version wrote files the
archive has never heard of — `data/erasure.key`, `data/push_vapid.key` and
`data/erasure/` all arrived after alpha.4 — and copying over the top leaves
them behind. The result is half one version and half the other, a state no
release has ever been tested in. Remove the directory first, then restore.

**Docker** — the same shape, except the volume has to be emptied rather than
copied into, because a copy into a volume can only add files:

```bash
docker compose down
docker volume rm server_owncord-data
docker volume create server_owncord-data

# Restore into the empty volume, owned by the image's uid.
docker run --rm \
  -v server_owncord-data:/app/data \
  -v /mnt/backup-disk/owncord-pre-upgrade:/archive:ro \
  alpine sh -c "cp -a /archive/data/. /app/data/ && chown -R 65532:65532 /app/data"

cp /mnt/backup-disk/owncord-pre-upgrade/config.yaml config.yaml
# Pin the previous tag in docker-compose.yml -- `:latest` pulls forward again --
# then bring the stack back up on the restored volume.
docker compose up -d
```

The admin panel's backup restore is not a rollback. It puts a database back
under **the version that is running**, which migrates it forward again on the
spot — see [Restore](#restore). Going back a version is the procedure above,
and only that.

### How this procedure is checked

Both halves are executed rather than asserted. `Server/cmd/smoke` drives the
newest published release through exactly this sequence — populate, stop,
archive, upgrade, verify, stop, restore, downgrade — in both shapes an owner
deploys: two binaries in one install directory, and two images on a named
volume. `.github/workflows/upgrade-rehearsal.yml` runs it nightly, on demand,
and from the release workflow before anything is signed or pushed, so a red
rehearsal stops the release.

What it asserts across the swap, by name: `config.yaml`, every credential key
file the pre-upgrade install had, and every file under `data/uploads/`
byte-identical; every pre-upgrade backup
still listed; the attachment uploaded before the upgrade still downloading
byte-identical through the API; the session token issued before the upgrade
still authenticating as the same owner; and the reported version actually
changing — then changing back across the rollback, with the old binary still
stopping cleanly on the restored install.

Two things it does not cover, stated because a rehearsal you misread is worse
than none:

- **ARM64 upgrades are not rehearsed.** `v1.2.0-alpha.4` published no ARM64
  server asset, so there is no published alpha to upgrade _from_. The ARM64
  assets are covered by the per-architecture lifecycle check described under
  [Building from Source](#building-from-source) and [Docker](#docker-linux) —
  boot, migrate, drain, restart — but not by an upgrade out of a previous
  release. That becomes rehearsable one release after the ARM64 assets ship.
- **In Docker, `config.yaml` is yours alone to manage.** The compose file
  mounts it read-only, so nothing inside the container can rewrite it: the
  admin panel and the setup wizard cannot persist a startup setting there, and
  an attempt comes back as a warning plus an `ERROR` line in the container log.
  Edit the host file and recreate the container instead. The rehearsal's
  "`config.yaml` is untouched" check is correspondingly weaker on that leg —
  it catches an in-place rewrite, but the kernel refuses the rename over a
  single-file bind mount that the server actually uses to save configuration.
  The standalone leg is the one that proves an upgrade leaves `config.yaml`
  alone.

## Monitoring

### Health Endpoint

`GET /health` -- public, no authentication required.

```json
{
  "status": "ok",
  "uptime": 86400,
  "online_users": 12
}
```

`status` is a real verdict, not a constant: the server probes its own
WebSocket dispatch loop, runs a bounded `SELECT 1` against the database, and
checks free disk space on the data volume. When any of those fail, the
endpoint returns HTTP 503 with `"status": "degraded"` and a `reason` field
naming the subsystem (`hub`, `database`, or `disk` — no further detail, since
the endpoint is unauthenticated). Checks are cached for a few seconds, so
polling it aggressively does not multiply database load. Point your uptime
monitor or container healthcheck at this endpoint and treat any 503 as
actionable.

The server version is deliberately not exposed on this unauthenticated
endpoint (anti-fingerprinting hardening).

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
  "broadcast_drops": 0,
  "livekit_healthy": true,
  "reconnect_tier_buffer": 120,
  "reconnect_tier_db": 4,
  "reconnect_tier_full": 1,
  "backpressure_queue_disconnects": 0,
  "backpressure_high_fallbacks": 0,
  "backpressure_low_drops": 17,
  "ws_conn_rejects": 0,
  "disk_free_mb": 51200.5,
  "disk_min_free_mb": 256,
  "disk_low": false,
  "upload_storage_used_mb": 3072.25,
  "db_writer_wait_count": 3,
  "db_writer_wait_seconds": 0.021,
  "perm_cache_hits": 5120,
  "perm_cache_misses": 84,
  "event_persister": { "persisted": 4021, "dropped": 0, "flushes": 311, "errors": 0 }
}
```

Signals worth watching as a community grows (see `docs/api.md` for full field
descriptions):

- `broadcast_drops` growing at all → the hub-wide broadcast queue overflowed
  and sequenced events were lost; alert on any growth.
- `db_writer_wait_seconds` climbing faster than uptime → requests are queueing
  on SQLite's single write connection; the write path is saturating.
- `reconnect_tier_full` becoming a noticeable share of reconnects → the replay
  budget is too small for real disconnect gaps.
- `backpressure_queue_disconnects` growing → clients are being force-cycled
  because they drain too slowly (slow links or an overloaded server).

### LiveKit Health

`GET /api/v1/livekit/health` -- checks LiveKit companion process reachability.

### Diagnostics

`GET /api/v1/diagnostics/connectivity` -- connectivity diagnostics for troubleshooting.

## Auto-Update

### Server

The server checks GitHub Releases for updates:

- Compares semver versions
- Results are cached for 1 hour
- Downloads the asset matching this machine's OS and architecture, with detached Ed25519/minisign signature verification on Windows
- Verifies a signed `server-update-manifest.json` that binds the binary hash to the release version
- Cross-checks the binary SHA256 against `checksums.sha256`

Applying an update runs in this order:

1. Download and verify the replacement beside the installed executable.
2. Give connected clients a "restarting in 5s" notice, then rotate the current
   binary to `.old` and put the verified download at the installation path.
3. Drain HTTP requests, stop the WebSocket hub and the managed `livekit-server`,
   flush queued event/audit writes, and close the database and its process lock.
   LiveKit's process must finish exiting before the handoff can continue. Unix
   companions receive SIGTERM with a five-second grace period before a forced
   kill; Windows companions are terminated and waited on until they exit.
4. Launch the replacement from the original installation path, or exit for
   systemd/NSSM to relaunch it (see `server.restart_mode` in
   [Server Configuration](server-configuration.md)). Normal teardown and the
   emergency restart backstop share one handoff, so only one replacement is
   launched. The backstop also waits for the managed LiveKit process to exit.
5. The new process removes `.old`, retrying briefly while Windows finishes
   releasing the predecessor's executable file.

Externally managed LiveKit is left running. Containers use image upgrades as
described above. Installing the first release with this handoff fix may require
a manual stop/replacement/start: the version already running performs that
first update's shutdown, so it cannot benefit from the fix until replaced.

Set `github.token` in config for higher API rate limits (5000/hr vs 60/hr unauthenticated).

### Client

The Tauri client uses NSIS installer updates:

- Server exposes client update assets from GitHub Releases
- Ed25519 signature verification before applying

## Firewall and Ports

| Port          | Protocol | Purpose                                           |
| ------------- | -------- | ------------------------------------------------- |
| `8443`        | TCP      | HTTPS server (configurable via `server.port`)     |
| `80`          | TCP      | ACME HTTP-01 challenge (only if `tls.mode: acme`) |
| `7880`        | TCP      | LiveKit server (WebSocket signaling)              |
| `7881`        | TCP      | LiveKit server (RTC/TURN over TCP)                |
| `50000-60000` | UDP      | LiveKit WebRTC media (ICE candidates)             |

For remote access, see the [Port Forwarding Guide](port-forwarding.md) or
[Tailscale Guide](tailscale.md). The port-forwarding guide also covers the
limits OwnCord cannot detect from inside your network — blocked ports, CGNAT,
hairpin NAT and a changing public IP — and how to check each one yourself.

**Not qualified in this build.** Certificate work is deferred to the release,
so there is no HTTPS on a bare public IP (`tls.mode: acme` requires a
hostname), no guided LAN or offline device-trust install, and no qualified
certificate lifecycle. Domain ACME is implemented but has not been exercised
against expiry, rotation and restart at release quality. See
[What this build does not do](port-forwarding.md#what-this-build-does-not-do).

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
