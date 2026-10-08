# Deployment Guide

Production deployment guide for OwnCord server on Windows and Linux.

## Prerequisites

- **Windows 10+** (x64) or **Linux** (x64). For how much one server carries on
  which hardware, see [Capacity](capacity.md)
- **Go 1.27+** (only if building from source)
- **LiveKit Server** binary (only if enabling voice/video) -- see [LiveKit Setup](livekit-setup.md)
- Required port: `8443` (OwnCord HTTPS/WebSocket)
- Additional ports for voice/video: `7881/TCP`, `50000-60000/UDP` — or a single UDP port when `voice.udp_port` is set (`7880/TCP` is LiveKit's own API endpoint and is not needed — remote clients tunnel signalling through `/livekit`)
- Additional port for ACME TLS: `80/TCP`

## Building from Source

**Windows:**

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .
```

**Linux:**

```bash
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=dev" .
```

- `-s -w` strips debug info (smaller binary)
- `-X main.version=...` embeds the version string; a source build reports `dev`
  unless you set it to the tag you built from
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

The easiest way to run OwnCord on Linux. The compose stack runs the chat server and LiveKit voice/video as separate containers on a shared internal network; the image itself also bundles LiveKit (see [LiveKit in Docker](#livekit-in-docker)), so a single container can serve both. The server image is built `FROM gcr.io/distroless/static-debian12` and runs as a non-root user (`65532`), so there is no shell inside the container.

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
- Ports available: `8443` (chat), `7881` TCP, and the LiveKit media UDP port(s) — `7882` for the bundled image (its default), or `50000-60000` for the two-container compose stack (see [LiveKit in Docker](#livekit-in-docker))

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

The `docker-compose.yml`, `.env.example`, `livekit.yaml.example` and
`config.yaml.example` copied below are **not release assets**: take them from
the source snapshot attached to each release (or the repository's `Server/`
directory).

```bash
cd Server

# 1. Create your secrets file
cp .env.example .env
# Edit .env — set LIVEKIT_API_KEY and LIVEKIT_API_SECRET (secret must be 32+ chars)

# 2. Create your LiveKit config
cp livekit.yaml.example livekit.yaml
# Edit livekit.yaml — paste the same key/secret (use_external_ip detects the
# public IP; only on a tailnet-only host, replace it with node_ip)

# 3. Create config.yaml from the shipped example
cp config.yaml.example config.yaml
# Edit it for non-secret settings (server name, TLS, etc.). The compose file
# already points the server at the LiveKit service (voice.livekit_url =
# "ws://livekit:7880") and turns auto-download off, so no voice edit is needed
# here. Leave voice.livekit_api_key, voice.livekit_api_secret and
# voice.livekit_binary unset: compose injects the key and secret from .env, and
# LiveKit runs as its own container.

# 4. Start
docker compose up -d
```

`docker compose` bind-mounts `./config.yaml` into the container, so the file
must exist before the first start: without it Docker creates a _directory_ at
that path and the server fails to read its configuration.

On first start OwnCord creates its database and writes defaults into `/app/data`. Navigate to `https://<your-ip>:8443/admin` to create the Owner account, with the setup token from `docker compose logs owncord`.

The admin panel and the setup wizard are gated by `server.admin_allowed_cidrs`
(loopback and private networks by default), so on a VPS the wizard is
unreachable from your laptop until you either tunnel to it —
`ssh -L 8443:localhost:8443 user@your-server`, then browse to
`https://localhost:8443/admin` — or add your address to that setting in
`config.yaml`. A refusal names the setting in its `403` body.

### config.yaml for Docker

The shipped compose file injects the LiveKit key and secret from `.env`, and
it also sets `voice.livekit_url` to `ws://livekit:7880` and
`voice.auto_download_livekit` to `false` as environment variables, so those two
keys need not be set in `config.yaml`: the environment value wins over
anything the file says, so the copied example's values are harmless. Leave
`voice.livekit_binary` unset, and do not set `voice.livekit_api_key` /
`voice.livekit_api_secret` in the file either (compose injects them from `.env`,
and keeping secrets out of `config.yaml` is the point of `.env`). Set everything
else as normal:

```yaml
server:
  name: "My OwnCord"
  port: 8443

voice:
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
in-place update is refused in container deployments (503
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

The image bundles the pinned, checksum-verified `livekit-server` (the version in `ws.DefaultLiveKitVersion`) and sets `OWNCORD_VOICE_LIVEKIT_BINARY=/livekit-server`, so the server starts it as its companion process, exactly as on bare metal. One container serves chat and voice:

```bash
docker run -d -v owncord-data:/app/data \
  -p 8443:8443 -p 7881:7881 -p 7882:7882/udp \
  ghcr.io/j3vb/owncord-server:latest
```

The image also sets `OWNCORD_VOICE_UDP_PORT=7882`, so all media rides one UDP port rather than the `50000-60000` range. Override either variable to change that. LiveKit's credentials and `livekit.yaml` live in `/app/data` (the volume).

The shipped `docker-compose.yml` instead runs `livekit/livekit-server:v1.13.7` as its own container: it clears `OWNCORD_VOICE_LIVEKIT_BINARY` and sets `OWNCORD_VOICE_UDP_PORT` to `0` for the server, so the bundled copy never starts there. Use it when you want to size, restart or upgrade LiveKit independently. See [LiveKit Setup — Docker](livekit-setup.md#docker).

### Unraid

[`deploy/unraid/owncord.xml`](../deploy/unraid/owncord.xml) is a template for Unraid's Docker tab: one container, with voice from the bundled LiveKit. Add its raw URL under **Docker > Template repositories** (or paste the file into `/boot/config/plugins/dockerMan/templates-user/`), then **Add Container > OwnCord**.

It publishes `8443/tcp` (chat and the admin panel), `7881/tcp` and `7882/udp` (voice). Forward the last two from your router for voice outside your LAN ([port-forwarding.md](port-forwarding.md)).

- **Ownership.** The image runs as uid `65532`, but Unraid creates appdata as `99:100` (`nobody:users`), so the template adds `--user 99:100` and the container writes its files as that user. To move an install between the two, `chown -R` the appdata folder to the new owner.
- **`config.yaml`.** Mounting a single file that does not exist yet makes Docker create a directory in its place. The template mounts the folder `/app` (default `/mnt/user/appdata/owncord`) instead, so the server writes its default `config.yaml` there on first start; edit it and restart the container. `/app/data` is a second mount for the database and uploads.
- **First start.** Read the setup token from the container log, then open `https://<unraid-ip>:8443/admin`.

### Linux desktop voice

Two limits apply to Linux desktop clients:

- **The server must be 2.0.0-beta.1 or later.** The Linux client's native voice
  sends its room credential as an `Authorization` header; the server forwards it
  through `/livekit` from 2.0.0-beta.1 on, and a `1.2.0-alpha.*` server drops it
  and refuses the join. Update the server.
- **A 2.0.0-beta.1 or older client on the Docker host cannot join as
  `localhost` against a 2.0.0-beta.1 or older server.** Those servers hand the
  client LiveKit's own address, `ws://livekit:7880`, as its `direct_url`; a
  client that reaches the server as `localhost`, `127.0.0.1` or `::1` uses it
  as-is, and that name does not resolve outside the container network. Update
  the server: it now sends a `direct_url` only when it is loopback, so the
  client routes voice through the server's `/livekit` tunnel. Updating the
  client also fixes it, since the next client release tunnels any non-loopback
  `direct_url`. Until then, connect using the host's LAN address or hostname
  instead, or run the client on another machine.

---

## First Run Behavior

When `chatserver.exe` starts for the first time:

1. **Config creation** -- `config.yaml` is written to the working directory with defaults
2. **Data directory** -- `data/` is created (database, certs, uploads, backups)
3. **TLS certificate** -- A self-signed certificate is generated at `data/cert.pem` / `data/key.pem`
4. **Database migration** -- SQLite database is created and all migrations run
5. **Status reset** -- All user statuses are set to `offline`, stale voice states are cleared
6. **Setup wizard** -- Navigate to `https://localhost:8443/admin` to run the first-time setup wizard. It asks for the setup token printed in the start-up output (the terminal, `docker compose logs owncord`, or the service's log). The token is regenerated at every start and is printed only while setup is open; restart the server to get a fresh one — including after re-opening setup ([security.md](security.md#first-run-setup)).

The setup wizard creates the Owner account and walks through the basics (server
name, port, TLS mode, upload limit, voice, registration, welcome message and
the owner's recovery kit). Choices are saved for you: live settings go to the database, and
startup settings are written into `config.yaml` — comments and any hand edits
in the file are preserved. The wizard also persists the generated LiveKit
credentials so voice keeps working across restarts. If the port or TLS mode
changed, the server restarts itself once and the wizard shows the new address.
The finish screen shows the address members enter in the desktop app (with TLS
off, it points them to your HTTPS reverse proxy's address instead), the invite
code, for a certificate the server already serves, its fingerprint, and the
owner's recovery kit — shown once, only its verifier is stored
([security.md](security.md#account-recovery)). While the kit is on screen the
page does not follow a restart on its own; save the kit, then open the link.
"Skip" runs the legacy minimal flow: just the Owner account and its recovery
kit, everything else on defaults.

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
- `TimeoutStopSec=60` — the server drains gracefully on SIGTERM, each
  shutdown step on its own budget — up to 30s for the HTTP drain and 10s
  for each other step — so one step that overruns cannot starve the next,
  and the whole teardown is capped at 50s; a normal stop takes about 5–10s,
  so systemd's 60s is only reached by a wedged teardown, which it SIGKILLs;
  the server's own 90s restart backstop covers non-systemd supervisors.
- `ReadWritePaths=/opt/owncord` under `ProtectSystem=strict` — the install
  directory must stay writable or the admin panel's self-update (which
  renames the new binary into place) breaks. `ProtectSystem=strict` mounts
  the rest of the filesystem read-only, so **every directory the server
  writes to outside `/opt/owncord` must be added to `ReadWritePaths` as
  well** — most commonly the off-disk `backup.dir` or `upload.storage_dir`
  documented below. Without that line, `MkdirAll` and `VACUUM INTO` fail with
  `EROFS`, so manual, scheduled and pre-restore backups all fail under the
  shipped unit. Example: `ReadWritePaths=/mnt/backup-disk/owncord`.
- `AmbientCapabilities=CAP_NET_BIND_SERVICE` — only needed for
  `tls.mode: acme`, which binds :80 for HTTP-01 challenges as a non-root
  user.
- `LimitNOFILE=65536` — the open-file ceiling. Each WebSocket holds a
  descriptor. The Go runtime already lifts the soft limit to just under the
  hard one at init, and the server raises it the rest of the way, so this hard
  limit is the real cap on how many people can be online (see
  [Open-file limit](#open-file-limit-file-descriptors)). 65,536 is well above
  what 2,000 online need (the boot budget for 2,000 is 4,256) and only needs
  raising past roughly 30,000 connections; an old systemd default hard limit
  of 1,024 would stop at a few hundred online.

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

# Capture the log. The server writes to stdout only, so without AppStdout/
# AppStderr the service discards every log line. Create C:\OwnCord\logs first.
nssm set OwnCord AppStdout "C:\OwnCord\logs\server.log"
nssm set OwnCord AppStderr "C:\OwnCord\logs\server.log"
nssm set OwnCord AppRotateFiles 1

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

Task Scheduler discards the process's stdout: point the action at a redirect
(wrap it as `cmd /c chatserver.exe >> logs\server.log 2>&1`) or the log is
gone.

### Running from a console window

A server started by double-clicking `chatserver.exe`, or from cmd or
PowerShell, is not supervised, so `auto` resolves to `spawn`. After a
self-update, backup restore or setup-wizard restart, the replacement runs in the
same console window and its log keeps printing there. The old process stays
behind, idle, until the replacement exits, and then exits with the
replacement's exit code. That keeps the window open under Windows Terminal,
which closes a tab when the process it started exits, and a shell that started
the server keeps waiting instead of printing its prompt over the log.

`Ctrl+C` stops the replacement, which drains as usual, and then the old process
exits with it. Closing the window stops both, and LiveKit. Each self-restart
leaves one more idle process behind until the window closes or the server stops.

The one exception is a restart whose teardown wedges past the 90-second restart
backstop. The old process may still hold the port or the database lock, so it
exits instead of staying behind, and the replacement opens in a new console
window of its own.

A server started without a console (by a service wrapper, for example) gets a
new console window of its own on a self-restart.

## TLS Setup

What each mode means for the people connecting — desktop pinning, what a
browser will need, and what the operator can read regardless of TLS — is in
[trust-model.md](trust-model.md).

**What this build does not do.** Self-signed is qualified and is the default;
domain ACME is implemented but not exercised at release quality (it has not
been run against expiry, rotation and restart); there is no HTTPS on a bare
public IP, and no guided LAN/offline device-trust install. The certificate
lifecycle — renewal state across restart, hot reload, rotation with margin —
is not qualified. Stated plainly because it decides your TLS mode today, not
because anything is missing at runtime; the details are in
[What this build does not do](port-forwarding.md#what-this-build-does-not-do).

### Self-Signed (default)

Generated on first run and valid for **two years**. Loaded as-is on every
later start: the expiry date is never checked, the certificate is never
renewed and never reloaded while the server runs — it is served until you
replace the pair. The desktop client pins the leaf certificate's fingerprint
on first connect and shows a mismatch modal if it changes; a browser client
(B8) is out of scope of this guide.

```yaml
tls:
  mode: "self_signed"
```

An expired self-signed pair keeps working, measured rather than asserted
(`Server/auth/tls_expiry_test.go`, `TestExpiredSelfSignedCertIsServedAsIs`):
the server loads and serves a certificate whose `NotAfter` is in the past, and
the desktop keeps connecting past expiry because the pin is the fingerprint,
not the validity window — `Client/src-tauri/src/tofu.rs`'s verifiers decide
trust on the fingerprint alone; the validity dates feed only the public-CA
renewal check, which a self-signed certificate never passes. **Rotate before the
two years are up**; the Dashboard's attention panel warns three weeks ahead.

#### Rotating the self-signed certificate

There is no server-side push of a new pin — rotation is a stop, a file move,
a start, and a message to every user:

1. Stop the server.
2. Move `data/cert.pem` and `data/key.pem` aside (do not delete them yet).
3. Start the server: a fresh pair is generated because both files are absent.
4. Read the new certificate's fingerprint from the start-up banner (also shown
   on the admin Dashboard and the setup wizard's finish step).
5. **Every desktop client sees the certificate-mismatch modal and must accept
   the new fingerprint.** Publish the new fingerprint out of band — a channel
   post on another platform, a call — and have each person **compare it,
   character for character, against the prompt their client shows** before
   accepting. A mismatch is indistinguishable from an interception attempt
   ([trust-model.md](trust-model.md)).

### Let's Encrypt (ACME)

> **Not the recommended path for a domain (owner decision, 2026-09-20).** Put
> a reverse proxy in front instead — see
> [Reverse Proxy Topology](#reverse-proxy-topology). Built-in ACME works and
> is staying, but this project does not qualify it: renewal across expiry,
> restart and rotation has never been exercised here, so renewal is your
> responsibility. Caddy, nginx and Traefik are built for that job and are
> tested by far more operators than OwnCord has. Choose built-in ACME only if
> you would rather not run a proxy, and read the pinning note below first.

Automatic certificate issuance and renewal. Requires port 80 open and a public domain.

```yaml
tls:
  mode: "acme"
  domain: "chat.example.com"
  acme_cache_dir: "data/acme_certs" # where certificates are cached
```

The facts a stranger needs before choosing it: port 80 must be reachable from
the internet (the HTTP-01 challenge), the configured domain must resolve to
this server, and an IP address is rejected — there is no HTTPS on a bare
public IP in this build
([What this build does not do](port-forwarding.md#what-this-build-does-not-do)).
Certificates are cached under `acme_cache_dir`. And the sentence owners do not
expect: **the desktop client pins this certificate too** — the first-use
prompt is the same in every `tls.mode`, so members compare the fingerprint
once. A routine Let's Encrypt renewal is then re-pinned without a prompt,
because both the old and the new certificate are publicly valid for the
domain ([trust-model.md](trust-model.md)). The admin Dashboard shows the
fingerprint once the first HTTPS connection has been made, and the new one
after each renewal
([Publishing the fingerprint](#publishing-the-fingerprint-after-a-renewal)).

### Manual Certificate

Use your own certificate files:

```yaml
tls:
  mode: "manual"
  cert_file: "path/to/cert.pem"
  key_file: "path/to/key.pem"
```

The desktop pins this certificate too, the same way. The files are loaded
once at start-up, so replacing them takes a restart; keep the key at file
mode `0600`.

### TLS Off

Only behind a TLS-terminating reverse proxy
([Reverse Proxy Topology](#reverse-proxy-topology)). The desktop app connects
only over `wss://`, so without one it cannot connect at all:

```yaml
tls:
  mode: "off"
```

Every connection is plaintext HTTP — passwords, tokens and messages are
readable by anyone on the path;
[trust-model.md](trust-model.md) states that plainly.

### Publishing the fingerprint after a renewal

The desktop client pins the certificate it sees. A renewal from a public CA
(Let's Encrypt, directly or through a reverse proxy) is re-pinned without a
prompt, provided the certificate members first accepted was publicly valid for
your domain. Any other change — a new self-signed or private-CA certificate, or
any change on a server reached by IP address — gives every member a
"Certificate Changed" prompt that asks them to get the current fingerprint from
you through another channel. Members also need it the first time they connect.
Publish it whenever the certificate changes:

- **`self_signed`, `manual` and `acme`:** copy it from the admin Dashboard's
  **Certificate fingerprint** card (in `acme` mode it appears after the first
  HTTPS connection and updates after each renewal).
- **`off` behind a reverse proxy:** the proxy serves the certificate, so
  OwnCord cannot read it. Run this on any machine with OpenSSL, with your
  domain (and your HTTPS port, if it is not 443):

  ```sh
  openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr 'A-F' 'a-f'
  ```

  It prints the fingerprint in the lower-case colon-hex form the app shows.
  Run it from outside your network when you can, so it sees what members see.

Post it somewhere members already trust — another chat platform, a call — not
inside OwnCord, which they cannot reach until they have accepted.

## Reverse Proxy Topology

OwnCord terminates its own TLS by default and does not require a reverse
proxy. **For a public domain, fronting it with one is nonetheless the
recommended setup (owner decision, 2026-09-20):** the proxy owns certificate
issuance and renewal, which is the part this project does not qualify (see
[Let's Encrypt (ACME)](#lets-encrypt-acme)). Caddy obtains and renews
certificates with no configuration beyond the hostname; nginx and Traefik do
the same with certbot or their own ACME support. Set `tls.mode: "off"` on
OwnCord when the proxy terminates TLS.

The server listens on every interface and has no bind-address setting, so with
`tls.mode: "off"` you must make port 8443 reachable only from the proxy:

- **Docker:** publish the port on loopback only (`127.0.0.1:8443:8443`), or put
  the proxy on the compose network and drop the `ports:` entry. The supplied
  `Server/docker-compose.yml` publishes `8443:8443` on all interfaces and must
  be changed for this setup.
- **Bare metal or VM:** add a host firewall rule that admits 8443 only from the
  proxy (loopback for a same-host proxy), and do not port-forward 8443 on your
  router.
- **Check:** from another machine, `curl -k https://<host>:8443/api/v1/health`
  (or the plain-http equivalent) must fail to connect.

One consequence worth knowing before you choose: with a proxy terminating TLS,
desktop clients pin the _proxy's_ certificate. When the proxy uses a public CA,
its renewals are re-pinned without a prompt, as described under
[Let's Encrypt (ACME)](#lets-encrypt-acme); a self-signed or private-CA proxy
certificate prompts on every change ([trust-model.md](trust-model.md)).

Whatever your reason for fronting it (shared host, existing nginx, central
cert management), three things matter:

1. **What the proxy can front.** Everything on port 8443 — the REST API, the
   WebSocket at `/api/v1/ws`, the admin panel, uploads, **and LiveKit
   signaling**, which the server already proxies at `/livekit/*`. You do NOT
   need to expose LiveKit's port 7880 through your proxy.
2. **What the proxy cannot front.** WebRTC media: UDP 50000–60000 — or the
   single port when the LiveKit config sets `udp_port` — plus the TCP 7881
   fallback; these must remain directly reachable on the host running LiveKit.
   An HTTP reverse proxy never carries this traffic.
3. **Tell OwnCord about the proxy.** Set `server.trusted_proxies` to the
   proxy's own address(es) (e.g. `["10.0.0.2/32"]`) so client IPs come from
   `X-Forwarded-For` for rate limiting, the admin IP allowlist, the access
   and WebSocket logs, and the `ws_connect` audit row. List only
   the proxy hops, never client networks. A proxy on the same host is
   `["127.0.0.1/32", "::1/128"]`: without it the allowlist sees the proxy's
   loopback address on every request, and the server warns about this shape
   at start-up and again on the first forwarded request it admits.

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
        client_max_body_size 101m;           # upload.max_size_mb plus 1m of multipart framing
    }
}
```

## Backup Strategy

The built-in backup endpoint covers the **database only**. What a restore
needs is the whole of `data/` plus your `config.yaml` — [Restore](#restore)
states that rule once, with what was measured about it. The admin panel's
[full archive](#the-full-archive) is all of it in one download. Restore is not
rollback: putting yesterday's database back is not the same operation as
reverting an upgrade — the costs are different and
[Rolling back](#rolling-back) is a separate procedure.

If you copy selectively anyway, these are the pieces, and what leaving each
one out costs you:

- **The backup from `POST /admin/api/backup`** — without it your only copy of
  the database is the file-level one, and nothing verified it. The backup
  endpoint runs `integrity_check` when it writes the file and again before it
  is allowed to overwrite a live database, and the admin panel can put it back
  on its own. See [Admin Backup Endpoint](#admin-backup-endpoint).
- **`data/uploads/`** — every attachment 404s. The database rows survive, so
  messages still show their attachments; the bytes are gone and the download
  returns 404. The built-in backup covers the database only
  ([Backup Strategy](#backup-strategy)); this directory is never in it.
- **`data/totp.key`** — every 2FA user is locked out, and emergency recovery
  codes do not help. Stored TOTP secrets are AES-256 ciphertext under this key;
  a server that cannot find the file generates a fresh one and boots happily,
  and every second factor on it is then undecryptable. The verify path decrypts
  the stored secret _before_ it will look at the submitted code, so it fails
  first and never reaches the recovery-code branch
  (`Server/service/auth.go:673`). There is no admin endpoint and no CLI
  subcommand that clears a user's second factor — disabling 2FA needs an
  already-authenticated session, which is exactly what the user cannot get. The
  only way back is to put this file back from the archive.
- **`data/erasure.key`** — a restore cannot recognise erased accounts. A
  deletion marker names its subject as `HMAC-SHA256(key, user id)`, so without
  the key the markers name no one and a restore can resurrect what they guard.
- **`data/erasure/markers.sqlite`** — worse than losing the key, because the
  file carries two more things. It holds `sequence_floors`: without them an
  erased account's id is handed out again, and its innocent new holder is
  erased by the old marker. It also holds the account markers that keep the
  first-run setup gate closed against a restore of a pre-owner backup. The
  server refuses rather than adopting a mismatched file, so this is an outage
  you resolve by hand, not one you can delete your way out of.
- **`data/push_vapid.key`** — every push subscription is invalidated. Each
  `push_subscriptions` row records the key id it was created under; under a new
  key those rows are invisible and the maintenance sweep removes them. Every
  device has to subscribe again, and no push is delivered until it does.
- **`config.yaml`** — the server boots on compiled-in defaults instead: port
  8443, self-signed TLS, and freshly generated LiveKit credentials, which
  breaks every voice token. It does **not** rotate a self-signed certificate:
  `self_signed` loads an existing `data/cert.pem` / `data/key.pem` and
  generates only on confirmed absence, and those are in the archive. Clients
  lose their pinned certificate only if the lost config said
  `tls.mode: acme` or `manual`, because the fallback to self-signed then
  serves a different one.
- **`data/config-overrides.json`** — the settings saved from the admin panel's
  Server configuration page are lost. The keys it held fall back to
  `config.yaml` and `OWNCORD_*` at the next boot, so a restore silently reverts
  them (see [Server Configuration](server-configuration.md#changing-settings-from-the-admin-panel)).

None of these are in a database backup. `data/uploads/`, the three key files
and `data/erasure/` all live under the data directory, so copying `data/`
wholesale covers every one of them. Back them up on the same schedule as the
database, not only before an upgrade.

### SQLite WAL Considerations

The database uses SQLite WAL mode. Do NOT copy the `.db` file directly while the server is running -- use the backup endpoint instead.

### Admin Backup Endpoint

| Endpoint                            | Method | Description                                                                         |
| ----------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `/admin/api/backup`                 | POST   | Create a new backup (owner-only)                                                    |
| `/admin/api/backups`                | GET    | List all backups (newest first)                                                     |
| `/admin/api/backups/{name}`         | DELETE | Delete a backup (owner-only)                                                        |
| `/admin/api/backups/{name}/restore` | POST   | Restore from backup (owner-only; creates pre-restore safety backup first)           |
| `/admin/api/backups/{name}/link`    | POST   | Issue a short-lived single-use download link for one backup (owner-only)            |
| `/admin/api/archive`                | GET    | Download the full archive (owner-only; database snapshot + `data/` + `config.yaml`) |
| `/admin/api/archive/link`           | POST   | Issue a short-lived single-use archive download link (owner-only)                   |

Backups are stored in the configured backup directory (default
`data/backups/`) with timestamps. Point it somewhere safer than the data
volume — another disk, or a mount that is shipped off-host (rsync, rclone,
a synced folder) — so backups don't share a single point of failure with the
live database and uploads:

```yaml
backup:
  dir: "/mnt/backup-disk/owncord"
```

Under the shipped systemd unit, add that directory to the unit's
`ReadWritePaths` too (see
[Running as a Linux Service](#running-as-a-linux-service-systemd)): with
`ProtectSystem=strict` the rest of the filesystem is read-only for the
service, and a backup to a path the unit has not allowed fails.

Every backup is verified with SQLite's `integrity_check` right after it is
written (a failed backup is removed, never listed), and again before a
restore is allowed to overwrite the live database.

A backup runs `VACUUM INTO` on the database's **reader** connection and
publishes the result with an atomic rename only once the copy is complete:
writers keep serving for the whole duration, and a backup that is killed
part-way leaves a `.tmp` file no listing offers as restorable, which the
maintenance tick removes once it is a day old. Backups are created
owner-only (mode `0600`), so an off-host copy job must run as the server's
user or adjust the permissions itself. The server
logs `duration_ms` when the backup lands, so a shrinking window is visible
before it becomes a problem.

### Scheduled Backups

The **Automatic backups** schedule (off / daily / weekly) and **Keep backups
for (days)** on the admin panel's Backups & restore page are enforced by the
server's maintenance loop (checked every 15 minutes). Only the Owner can
change them, and that page is the Owner's alone:

- A scheduled backup is taken when the newest backup on disk is older than
  the schedule interval — a manual backup resets the clock too.
- Retention is `0` (keep forever) or between 7 and 3650 days. It deletes
  backups older than that, but always keeps the newest one, so a stale
  schedule can never delete your last copy, and it never removes the
  `pre_restore_*` or `pre_migrate_*` safety copies — delete those by hand.

### The full archive

A database backup is not a complete restore: it does not carry uploads, the
key files or `config.yaml` ([Backup Strategy](#backup-strategy) lists what
each omission costs). **Download full archive** on the Backups & restore page
returns one zip with all of it — the database as a `VACUUM INTO` snapshot, the
whole data directory (uploads, `totp.key`, `erasure.key`,
`erasure/markers.sqlite`, `push_vapid.key`, TLS material), and `config.yaml`.
An `upload.storage_dir` outside the data directory is archived as
`data/uploads/`. Stored backups (`backup.dir`) are left out. The archive is
built inside `backup.dir` before it is sent, so that volume needs room for
about the size of the data directory plus the database again; when building
it would leave less free than `server.min_free_disk_mb`, the server refuses
the download instead of filling the disk. It is Owner-only, because the
archive holds password hashes and the key files. Only one archive is built at
a time; a second request while one is being prepared is refused.

The panel asks the server for a short-lived single-use link and opens it as a
plain download, so the browser streams the archive straight to disk — there is
no size limit imposed by the page's memory. The download must still finish
within 2 hours of the request, so for a very large server on a slow link take
the archive by hand with the procedure in
[Before upgrading: take the archive](#before-upgrading-take-the-archive), or
rely on a database backup, which `chatserver restore` can put back. The
link token is random, single-use, Owner-bound and expires within a minute;
nothing else can use it. The build starts when the browser opens the link, so
a refusal from the free-space check arrives as a failed download in the
browser rather than as a panel message.

The database entry is a `VACUUM INTO` snapshot, so it is a consistent copy
even while the server runs. The archive is still taken with WAL-mode writes in
flight, so prefer the manual stop-the-server procedure in
[Before upgrading: take the archive](#before-upgrading-take-the-archive) when
you can, and keep the download off the host either way.

### Backups taken automatically before an upgrade

A server that starts with migrations pending — the state every upgrade leaves
behind, including a Docker `docker compose pull` — takes a database backup
**before** it applies them, so a schema move is never unbacked-up. The copy
lands in the configured backup directory as
`pre_migrate_<first-migration>.db` (with a `_2`, `_3`, … suffix when that name
is already taken, so an earlier copy is never overwritten), is verified with
`integrity_check`, and is
kept out of retention pruning like the `pre_restore_*` copies. A boot that
cannot write it refuses to start rather than migrate without it. If the
database has not changed since the newest copy for that migration — a
migration that fails on every boot, say — the boot reuses that copy instead of
writing another.

This protects the schema, not your uploads or keys: it is a database copy, so
pair it with the full [archive](#before-upgrading-take-the-archive) for a
complete rollback.

External scheduling still works if you prefer it, but the admin API accepts
**Bearer tokens only** — there is no cookie session for it — so the job needs an
API token first. Mint one on the server and keep the raw value, because it is
printed once and never recoverable:

```bash
# On the server host. Defaults to the owner account, no expiry; --expires 720h
# or --label for a managed one.
./chatserver token create --label backup
# prints the raw token ONCE — store it now, it is never recoverable
```

Put it in `OWNCORD_TOKEN` and schedule the call. Linux cron:

```bash
# Nightly at 03:00 via the admin API token
0 3 * * * curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" https://localhost:8443/admin/api/backup
```

Windows Task Scheduler with PowerShell — same Bearer header, not a cookie:

```powershell
$headers = @{ "Authorization" = "Bearer $env:OWNCORD_TOKEN" }
Invoke-RestMethod -Uri "https://localhost:8443/admin/api/backup" -Method POST -Headers $headers -SkipCertificateCheck
```

Manage tokens with `./chatserver token list` and
`./chatserver token revoke <id|label>`.

### Restore

In the admin panel, **Restore** asks for the backup's file name typed out,
then waits for the restart and reloads the page.

Restoring replaces the live database file, in this order: the server runs
`integrity_check` on the backup file and refuses a broken one; it writes the
`backup_restore` audit row; it takes the `pre_restore_<ts>.db` safety copy
and aborts before anything is touched if that copy cannot be written; it
broadcasts the restart so connected clients are told to reconnect; then it
replaces the database and the process restarts. With `server.restart_mode` on
`supervised` — which `auto` picks for systemd, NSSM and containers — it drains
and exits cleanly and the supervisor relaunches it instead; the shipped
`docker-compose.yml` sets `restart: unless-stopped` for exactly this
([Upgrading](#upgrading)). On the first boot after a restore, every deletion
marker recorded since the backup was taken is replayed before anything serves
([data-lifecycle.md](architecture/data-lifecycle.md)) — which is why the
marker file and `erasure.key` have to travel with the backup.

**A restorable install is a set, not one file.** The backup endpoint's file is
the database only. What has to travel with it is everything the database
_points at_ — the uploads, and the three key files plus the marker file that
live beside `data/`. **Back up `data/` wholesale on the same schedule as the
database**, not only before an upgrade: the list of what each file costs you if
it is missing is [Backup Strategy](#backup-strategy)'s list, and it is the
same list here. What a restore cannot bring back: the uploads (they are never
in the backup), and everything that happened after the backup was taken —
accounts, messages, settings and bans created since are gone. And the two
refusals the marker file can produce at boot are described in
[security.md](security.md#erasure-marker-key), which carries the matching rule
in full.

Measured, because both halves are easy to assume the wrong way round
(`cmd/smoke -drills` phase R, and the B6-11 block in
[data-lifecycle.md](architecture/data-lifecycle.md)):

- Restore a backup **without** `data/erasure/markers.sqlite` and every account
  erased since that backup comes back, and nothing removes it again — the
  markers were the only record that they were erased, and the restored database
  does not carry one. The server boots and logs an `ERROR` naming the absent
  erasure history — an error in the log, not a refusal to start. It is gated on
  the key file existing, so a first boot says nothing: an install that never had
  erasure history has none to lose. An install holding its key in
  `OWNCORD_ERASURE_KEY` has no key file either way, so this check stays silent
  for it — the loud case is the key on disk.
- Restore a backup **without** `data/erasure.key` and the server **refuses to
  start**, naming the reason. That is deliberate: without the key the markers
  cannot name anybody, so a server that booted would be serving a database it
  cannot reconcile with its own deletion history.

### Restoring without a running server

The restore endpoint above needs a running server. When the server will not
boot — a failed migration, a corrupt database — the admin API is unreachable.
Two offline paths cover it: `chatserver restore` puts a database backup back,
and the archive rollback restores the whole pre-failure state.

**A database backup, with `chatserver restore`.** The CLI does what the admin
endpoint does, without the panel:

```bash
# Stop the server first — it holds the database's process lock, and the
# command refuses while it is running.
sudo systemctl stop owncord          # or: docker compose down

# Without --force it changes nothing and explains itself; with it, the live
# database is replaced after a pre_restore_* safety copy is taken.
./chatserver restore --force /path/to/chatserver_20260101_030000.db

# Docker: the image's entrypoint is the binary and its working dir is /app,
# so run it in a one-off container against the same volume, naming the
# backup by its path inside that volume.
docker compose run --rm --no-deps owncord restore --force data/backups/chatserver_20260101_030000.db
```

It verifies the file is a readable database that a newer server version did
not write — and refuses one whose `-wal` still holds transactions, since only
the main file is copied — before touching the live one, takes a
`pre_restore_*` safety copy, preserves the message-retry cutoff, and uses the
same `database.path` and `backup.dir` from `config.yaml` the server does. When the live database is too
broken to copy, it is moved aside with its `-wal` and `-shm` files as
`chatserver.db.pre_restore_<time>` instead, and the command prints where. This
restores the database alone — a full archive below is still the supported path
when uploads, the key files or `config.yaml` changed too.

**The whole state, from an archive.** Put the whole pre-failure state back,
then start the same version that wrote it.

1. Stop the server if it is still running (`sudo systemctl stop owncord`, or
   `docker compose down`).
2. Take the pre-upgrade archive described under
   [Before upgrading: take the archive](#before-upgrading-take-the-archive) —
   `data/` wholesale plus `config.yaml`, and the binary you are restoring to.
   If the failure _is_ the upgrade, that archive is your rollback.
3. Replace, do not merge: remove the live `data/` directory and copy the
   archive's back (the Docker volume has to be emptied rather than copied
   into). The archive carries `config.yaml`,
   `data/erasure.key`, `data/erasure/markers.sqlite` and the other key files,
   which a database-only backup does not — see [Restore](#restore).
4. Start the server and confirm it serves.

If you have only a database backup file (`POST /admin/api/backup`'s output),
not a full archive, you can still put it back by hand — stop the server, keep
the current `data/chatserver.db` aside as your own safety copy, replace it with
the backup file (the backup is a consistent `VACUUM INTO` snapshot, so it is
safe to drop in directly, unlike a live file copy under WAL), and start again.
Do this only with the matching `data/erasure/` files in place: a restore
without the marker file can serve an account that was erased since the backup
was taken ([Restore](#restore)). A full archive is the supported path; a
database file alone is the fallback.

## Storage growth

Most of what the server writes lives beside the binary under `data/` by
default, but **`server.data_dir` is not the root of all of it** (REL-04): it
holds the key files (`totp.key`, `erasure.key`, `push_vapid.key`), the erasure
marker store and the managed LiveKit binary, while `database.path`,
`upload.storage_dir`, `backup.dir` and the TLS `cert_file`/`key_file` each have
their own independent `data/...` default. What each path holds, what bounds it
and what — if anything — ever deletes it:

| Path                                        | Written by                                                                                    | Bounded by                                                                                                         | Pruned by                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatserver.db` + `chatserver.db-wal`       | every feature                                                                                 | messages: the server window or a per-channel retention policy (`0` = keep forever); the persisted event tier: 24 h | retention sweep, at most 5 000 messages per tick; the event pruner, every 60 minutes; the WAL is truncated after an erasure completes          |
| `uploads/`                                  | attachments, avatars, emoji, and a kept preview of a large image (`thumbs/`)                  | `upload.max_size_mb` (default 100) per file, `upload.user_quota_mb` (default `0` = unlimited) per user             | the orphan sweep (unlinked for more than 1 hour), the retention sweep, erasure, and the reconciliation pass, at most 500 files per tick        |
| `backups/`                                  | manual and scheduled backups, and the `pre_restore_*.db` and `pre_migrate_*.db` safety copies | `Keep backups for (days)` on the admin panel's Backups & restore page                                              | retention always keeps the newest backup and never removes the `pre_restore_*` or `pre_migrate_*` safety copies, which must be deleted by hand |
| `acme_certs/`                               | `tls.mode: acme` only                                                                         | one certificate for the configured domain                                                                          | the ACME client manages renewal itself                                                                                                         |
| `livekit/`                                  | `voice.auto_download_livekit`                                                                 | one pinned release of the LiveKit server binary                                                                    | never — delete the file by hand to force a fresh download                                                                                      |
| `plugins/`                                  | plugins loaded by `-tags wazero` builds                                                       | what the plugins themselves write                                                                                  | never                                                                                                                                          |
| `cert.pem`, `key.pem`                       | first run, `tls.mode: self_signed`                                                            | one TLS pair                                                                                                       | never — replacing them is the rotation procedure under [TLS Setup](#tls-setup)                                                                 |
| `totp.key`, `erasure.key`, `push_vapid.key` | first run                                                                                     | three small files                                                                                                  | never — and must never be: each loss is permanent (see [Before upgrading](#before-upgrading-take-the-archive))                                 |
| `erasure/markers.sqlite`                    | every account erasure and every swept channel                                                 | one row per erased account or swept channel                                                                        | never; small by construction                                                                                                                   |

Four facts the table cannot carry:

- **The audit log is never pruned.** No maintenance step touches it — it is
  the tamper-evident trail, and the doc says so rather than leaving it to be
  assumed: on a busy server `audit_log` is the slowest-growing large table,
  and it grows for the life of the server.
- **Message retention is off by default.** `settings.retention_days` is `0`
  on a fresh and on an upgraded server, so message growth is unbounded until
  an owner sets a window in the admin panel. `GET /admin/api/retention/preview`
  (admin panel, Message retention) shows exactly which messages a window would delete
  before it runs. Pinned messages and DMs are never swept.
- **Report content and moderation actions age out on their own:**
  `moderation.report_retention_days` 180, `moderation.action_retention_days`
  90 (a closed report's content, and a warning/timeout action row after
  acknowledgement or expiry — ban, kick and removal rows are never touched).
- **The disk floor.** Everything in the table shares one volume with the WAL.
  The server stops accepting uploads at `server.min_free_disk_mb` and reports
  `degraded`/`disk` on `/health`; messages keep flowing. What each stage of a
  filling disk looks like and how to recover is under
  [Health Endpoint](#health-endpoint); that table is not repeated here.

## Upgrade and Rollback

An upgrade swaps the binary (or the image) under an install directory that
nothing else touches. A **rollback is restore-then-downgrade**: put the
pre-upgrade copy back, then run the old version on it. Migrations are
forward-only. A full down-migration is not a supported upgrade path — the
`Server/rollback/*.down.sql` reversals exist only for rehearsing a rollback of
a specific migration and are run by hand (see `Server/rollback/README.md`).
There is no supported way to run an older binary against a database a newer
one has already migrated; the server refuses to start on such a schema rather
than risk it, because doing it anyway is how you lose the database, not how you
go back. The copy you take before upgrading is therefore the only complete
rollback that exists; the server's own
[pre-migration copy](#backups-taken-automatically-before-an-upgrade) holds the
database alone.

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
#    The destination must exist: `cp` with two sources refuses to create it.
sudo mkdir -p /mnt/backup-disk/owncord-pre-upgrade
sudo cp -a /opt/owncord/data /opt/owncord/config.yaml \
  /mnt/backup-disk/owncord-pre-upgrade/

# 4. Keep the binary you are upgrading FROM. Step 3 is only half a rollback
#    without it -- see "Rolling back" below.
sudo cp -a /opt/owncord/chatserver \
  /mnt/backup-disk/owncord-pre-upgrade/chatserver-previous
```

**Docker:** `data/` lives in the named volume and `config.yaml` does not —
the compose file bind-mounts it from the host, so a copy of the volume does
not contain it. Both have to be taken, separately:

```bash
# 1. Backup, then stop. `down` also releases the volume for step 3.
curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" \
  https://localhost:8443/admin/api/backup
docker compose down

# 2. The host-side config.yaml. Note the tag you are upgrading FROM: without
#    it there is nothing to pin the rollback to.
mkdir -p /mnt/backup-disk/owncord-pre-upgrade
cp config.yaml /mnt/backup-disk/owncord-pre-upgrade/config.yaml
docker image inspect ghcr.io/j3vb/owncord-server:latest \
  --format '{{index .RepoDigests 0}}' > /mnt/backup-disk/owncord-pre-upgrade/image

# 3. The volume, through a throwaway container -- the only way to read a named
#    volume from the host. alpine because the OwnCord image is distroless and
#    ships no shell and no `cp`. The rm -rf keeps a re-run from nesting the
#    copy inside the previous one.
rm -rf /mnt/backup-disk/owncord-pre-upgrade/data
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
what silently misses one. What each file costs you if it is missing — the
backup file, `data/uploads/`, `data/totp.key`, `data/erasure.key`,
`data/erasure/markers.sqlite`, `data/push_vapid.key` and `config.yaml` — is
[Backup Strategy](#backup-strategy)'s list, and it is the same list here.

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
supervisor handoff — see [Auto-Update](#auto-update). Its update dialog backs
up the database first unless you untick that, but the copy is the database
alone, so take the archive first either way.

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

You also need the version you are rolling back **to**. Keep the binary, or the
image tag, you upgraded from: GitHub Releases usually still has it, but an
in-place self-update leaves nothing local (it rotates the old binary to
`.old-*` and the replacement deletes that), and a yanked or air-gapped release
leaves you no rollback at all. Step 4 of the archive above is that copy.

**Standalone:**

```bash
sudo systemctl stop owncord
sudo rm -rf /opt/owncord/data
sudo cp -a /mnt/backup-disk/owncord-pre-upgrade/data /opt/owncord/data
sudo cp /mnt/backup-disk/owncord-pre-upgrade/config.yaml /opt/owncord/config.yaml
sudo install -m 0755 /mnt/backup-disk/owncord-pre-upgrade/chatserver-previous \
  /opt/owncord/chatserver
sudo systemctl start owncord
```

**Replace `data/`; never merge into it.** The newer version can write files the
archive has never heard of — upgrading out of alpha.4, `data/erasure.key`,
`data/push_vapid.key` and `data/erasure/` all arrive that way — and copying
over the top leaves them behind. The result is half one version and half the other, a state no
release has ever been tested in. Remove the directory first, then restore.

**Docker** — the same shape, except the volume has to be emptied rather than
copied into, because a copy into a volume can only add files:

```bash
docker compose down
docker volume rm server_owncord-data
docker volume create server_owncord-data

# Restore into the empty volume, owned by the image's uid -- alpine again
# because the OwnCord image has no shell to run this in.
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

Both halves are executed on every run, not merely described.
`Server/cmd/smoke` drives the newest published release through exactly this
sequence — populate, stop, archive, upgrade, verify, stop, restore,
downgrade, verify the rollback — in both shapes an owner deploys: two binaries in one install
directory, and two images on a named volume. It runs on **every pull request**
(the standalone leg, inside `ci.yml`'s server build job), and
`.github/workflows/upgrade-rehearsal.yml` runs both legs nightly, on demand,
and from the release workflow before anything is pushed or published, so a red
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

## Capacity limits

What one server carries on which hardware, and the size to buy for a
community of 1,000–2,000 online, is in [Capacity](capacity.md#sizing-for-10002000-online).
The qualified profile is **250 registered users, 100 simultaneous connections
and 25 concurrent voice sessions on 2 vCPU / 4 GB RAM** — see
[The profile](capacity.md#the-profile) and
[Reference hardware](capacity.md#reference-hardware) in
[Capacity](capacity.md), where it is reproduced rather than owned. The keys
below are the ceilings an owner configures; each carries its default, what an
outgrowing community sees, and the metric in `GET /api/v1/metrics` that says
which one is near:

- `server.max_ws_connections` (default `0` = unlimited) → further WebSocket
  upgrades are refused with 503 before the upgrade completes, until
  connections free up → `ws_conn_rejects` (nonzero means you hit it).
- `database.max_readers` (default `0` = automatic, `max(8, 2× CPU count)`,
  clamped to 1–64) → read queries queue behind the pool →
  `db_reader_wait_seconds` growing.
- `upload.max_size_mb` (default `100`) → a larger file is refused with
  `400 BAD_REQUEST`. `upload.user_quota_mb` (default `0` = unlimited) → an
  upload past it is refused with `507 STORAGE_QUOTA_EXCEEDED` →
  `upload_storage_used_mb` for where the number is.
- `server.min_free_disk_mb` (default `256`) → uploads are refused with
  `507 STORAGE_LOW_DISK` and `/health` reports `degraded`/`disk` → `disk_low`
  on metrics.
- `security.auth_rate_limit_multiplier` (default `1.0`) → auth requests
  and WebSocket upgrades refused with `429 RATE_LIMITED`; raise it for a community behind one shared
  NAT (office, school) — the defaults assume roughly one person per IP.

The reading of these and the other growth signals is covered once, under
[Metrics Endpoint](#metrics-endpoint); that list is the one to alert on.

### Open-file limit (file descriptors)

Every WebSocket holds a file descriptor, so the number of people who can be
online at once is bounded by the process's `RLIMIT_NOFILE`. The Go runtime
already lifts the soft limit to just under the hard one at init, and the server
**raises its soft limit to the hard limit at start-up** and logs the result
under `open-file limit`; the number that matters is therefore the **hard**
limit, which the supervisor or shell sets. The risk is a low hard limit — a
plain `ulimit -n 1024`, or an old daemon or unit default of 1,024 — enough for
a small community but not for 1,000–2,000, which need about 2,100 descriptors:

- **systemd:** `LimitNOFILE=65536` in the unit (the shipped
  [`deploy/owncord.service`](../deploy/owncord.service) sets it), or
  `infinity`. `systemctl edit owncord` overrides it without touching the file.
- **Docker Compose:** `ulimits.nofile` on the `owncord` service (the shipped
  `Server/docker-compose.yml` sets 65,536). Without it the hard limit is
  whatever the host daemon passes down, which an old or tuned-down daemon can
  set to 1,024.
- **Bare binary or another supervisor:** set the soft and hard limit with
  `ulimit -n` (or `LimitNOFILE`-equivalent) before the server starts.

The server also warns at boot when the resulting limit is below
`2 × max_ws_connections + 256` — the descriptors that many connections need,
doubled for headroom, plus a fixed allowance for the database, LiveKit, TLS
and the rest of the process. With `server.max_ws_connections` unset
(unlimited), the budget is the 2,000-online target: 4,256. A server started
under `ulimit -n 1024` reports a raised limit or a warning naming this setting,
never a silent fall-over at 1,000 connections.

## Monitoring

### Logs

The server logs to **stdout** as `slog` text and keeps the most recent 2 000
lines in memory for the admin panel's live view. There is no log file and no
rotation inside the server: every record is teed to stdout and to the ring
buffer by the logging setup in `Server/main.go`. Where the log lives is
therefore where your supervisor puts stdout, not a server setting:

| Supervisor      | Where stdout goes                                  | How to read it                                                                                        |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| systemd (Linux) | the journald journal                               | `journalctl -u owncord -f`; retention follows journald's configuration, not the server's              |
| Docker          | the `json-file` log driver on the host             | `docker compose logs -f owncord`; the shipped compose file caps the driver at 10 MB per file, 3 files |
| NSSM (Windows)  | **nowhere** unless `AppStdout`/`AppStderr` are set | the file you point `AppStdout` at — see the Windows service install above                             |

One key controls verbosity: `logging.level` (`debug`/`info`/`warn`/`error`,
default `info`). `OWNCORD_LOGGING_LEVEL` overrides it without editing
`config.yaml`, and an administrator can switch a running server to debug for
a while from the admin panel's Logs page
([server-configuration.md](server-configuration.md#logging-logging)).

A LiveKit that OwnCord supervises logs through the same pipeline, as
`livekit companion output` entries with `component=livekit` and LiveKit's own
line in the `line` attribute. An external LiveKit, including
the Docker `livekit` service, logs only to its own stdout: read it with
`docker compose logs livekit` (or wherever that process's supervisor puts
stdout). Its output is not in the admin live log or the support bundle.

A log line is `time level msg key=value ...`, and every request-scoped
record carries a `req_id` so a line can be tied back to the HTTP request
that produced it.

What is **never** in a log line, by construction rather than by call-site
discipline: the LiveKit API key and secret, the GitHub token and the GIF API
key are redacted at the logging boundary no matter how the value reaches a
record. What **is** in it at `info`: usernames, ids and client addresses —
so a pasted log excerpt is personal data. Treat it as such when attaching
one to an issue; the support bundle deliberately omits raw log lines for
this reason.

The admin panel's live log view is the same stream at the same level,
delivered over a single-use SSE ticket — see the Diagnostics section below.

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
actionable. It does not cover voice — see
[Monitor voice as well as liveness](#monitor-voice-as-well-as-liveness).

The server version is deliberately not exposed on this unauthenticated
endpoint (anti-fingerprinting hardening).

**Disk, in the three stages an operator can be in.** The check is free space on
the volumes the server writes to against `server.min_free_disk_mb` (default
256 MiB; `0` disables the floor — see
[server-configuration.md](server-configuration.md)). All three stages were
measured against a filesystem that was actually filled (`cmd/smoke -drills`
phase D):

| Free space                 | `/health`                                                 | Everything else                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Above the floor            | `200` `ok`                                                | Normal.                                                                                                                                                                                                                                                                                                                      |
| Below the floor            | `503` `degraded`, `"reason": "disk"`                      | Uploads and other writes that need headroom are refused with `507 STORAGE_LOW_DISK`. **Messages still flow**, and a backup still runs — and a backup taken here is still either refused or a file `integrity_check` accepts, never a partial one.                                                                            |
| Completely full (`ENOSPC`) | `503` `degraded`, `"reason": "disk"` — it keeps answering | Writes that touch the database are refused, each with an error frame rather than silence, and the log carries `database or disk is full`. **The server does not exit.** Give the space back — delete the junk, grow the volume, move `backup.dir` elsewhere — and chat, uploads and `/health` recover **without a restart**. |

The floor is a reserved headroom for the upload path, not a message-path limit:
a server below its floor still accepts chat, which is what keeps a filled disk
from becoming a silent outage. Set it below what your database grows by and you
have chosen the third stage as your normal state.

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
  "topic_sheds_total": 0,
  "ws_broadcast_ms": { "count": 1204, "p50": 1, "p95": 5, "p99": 20, "max": 210 },
  "ws_dispatch_lag_ms": { "count": 1204, "p50": 0.5, "p95": 2, "p99": 10, "max": 90 },
  "chat_send_ack_ms": { "count": 340, "p50": 2, "p95": 10, "p99": 50, "max": 60 },
  "voice_join_ms": {
    "precheck": { "count": 12, "p50": 1, "p95": 1.4, "p99": 1.4, "max": 1.4 },
    "leave": { "count": 12, "p50": 0.5, "p95": 3.1, "p99": 3.1, "max": 3.1 },
    "persist": { "count": 12, "p50": 2, "p95": 4.2, "p99": 4.2, "max": 4.2 },
    "token": { "count": 12, "p50": 0.5, "p95": 0.8, "p99": 0.8, "max": 0.8 },
    "complete": { "count": 12, "p50": 2, "p95": 4.9, "p99": 4.9, "max": 4.9 },
    "total": { "count": 12, "p50": 5, "p95": 12.6, "p99": 12.6, "max": 12.6 }
  },
  "hub_broadcast_queue_depth": 0,
  "hub_seqmu_max_hold_ms": 12,
  "livekit_healthy": true,
  "reconnect_tier_buffer": 120,
  "reconnect_tier_db": 4,
  "reconnect_tier_full": 1,
  "backpressure_queue_disconnects": 0,
  "backpressure_high_fallbacks": 0,
  "backpressure_low_drops": 17,
  "backpressure_presence_drops": 0,
  "ws_conn_rejects": 0,
  "disk_free_mb": 51200.5,
  "disk_min_free_mb": 256,
  "disk_low": false,
  "upload_storage_used_mb": 3072.25,
  "db_writer_wait_count": 3,
  "db_writer_wait_seconds": 0.021,
  "db_reader_wait_count": 11,
  "db_reader_wait_seconds": 0.004,
  "perm_cache_hits": 5120,
  "perm_cache_misses": 84,
  "event_persister": { "persisted": 4021, "dropped": 0, "flushes": 311, "errors": 0 }
}
```

Signals worth watching as a community grows (see `docs/api.md` for full field
descriptions):

- `broadcast_drops` growing at all → the hub-wide broadcast queue overflowed
  and sequenced events were lost; alert on any growth. `topic_sheds_total`
  growing → a sender exceeded its per-channel topic limit and frames
  were shed before sequencing; replay cannot recover them, so alert on any
  growth too. A content frame lost to either counter also forces the next
  reconnect of a client at or behind the loss onto the full-ready path, so
  that client recovers the message from the database.
- `ws_dispatch_lag_ms.p95` climbing → the single hub dispatch goroutine is
  falling behind its queue; `hub_broadcast_queue_depth` approaching 1024 is the
  same signal from the other side.
- `hub_seqmu_max_hold_ms` above ~100 ms → a critical section that serializes
  every broadcast (a replay purge's full scan is the known one) is stalling
  delivery.
- `db_writer_wait_seconds` climbing faster than uptime → requests are queueing
  on SQLite's single write connection; the write path is saturating.
- `db_reader_wait_seconds` growing → read queries are queueing behind all
  reader-pool connections (`database.max_readers`); raise it or check for slow
  reads. (On in-memory databases this pair duplicates the writer's.)
- `reconnect_tier_full` becoming a noticeable share of reconnects → the replay
  budget is too small for real disconnect gaps.
- `backpressure_queue_disconnects` growing → clients are being force-cycled
  because they drain too slowly (slow links or an overloaded server).

### LiveKit Health

`GET /api/v1/livekit/health` -- checks LiveKit companion process reachability.
It is gated by `server.livekit_webhook_allowed_cidrs`, which is empty by
default and so falls back to `server.admin_allowed_cidrs` (loopback and private
networks unless you changed it). Setting the key **replaces** that fallback
rather than adding to it, and the same list gates LiveKit's webhook
(`POST /api/v1/livekit/webhook`). To admit an off-host monitor, list the ranges
LiveKit posts from (loopback and private networks, or the SFU's address) plus
the monitor's own `/32` — never `0.0.0.0/0`. Listing only the monitor blocks
the webhook, and stale voice seats then wait for the slower reconcile to clear.

### Monitor voice as well as liveness

`/health` checks the hub, database and disk, but **not voice**. A green
`/health` therefore does not mean voice works: LiveKit can be down while
`/health` says `ok` (joins are then refused), and a blocked media path — a call
that connects and then carries no audio — is invisible from the server, which
never probes it. To catch a voice outage, poll both endpoints:

- **Server liveness:** `GET /health` (public, no allowlist entry). Any `503`
  is actionable; `reason` names the subsystem (`hub`, `database`, `disk`).
- **Voice reachability:** `GET /api/v1/livekit/health` — `{"status": "ok"}`
  means LiveKit answered, a `503` with `"livekit_reachable": false` means it did
  not. It is behind the LiveKit allowlist, so an external monitor must be
  admitted as described under [LiveKit Health](#livekit-health).

There is no watchdog in the server itself. The systemd unit and the compose
file both leave "restart a hung process" to the supervisor, and for Docker to
an external watchdog (see the compose file's `healthcheck` note). The binary
does not implement `sd_notify`, so `WatchdogSec=` will not work with a plain
`Type=simple` unit — a cron job or uptime service that probes the two endpoints
above and restarts the service after repeated failures is the portable recipe.

### Diagnostics

`GET /api/v1/diagnostics/connectivity` -- connectivity diagnostics for troubleshooting.

### Support bundle

When you need help, the admin panel writes a support bundle you can attach to
a report. The flow, in the operator's words: admin panel → **Diagnostics** →
**Create support bundle preview** → review the item list, byte sizes and
SHA-256 hashes → **Confirm download**. Previewing or discarding downloads
nothing.

The ZIP holds six fixed files: `build.json` (application/Go version, OS and
architecture), `configuration.json` (an explicit scalar allowlist from the
running startup configuration), `database.json` (applied migration names,
table names and row counts), `health.json` (a database, memory and hub
snapshot), `events.json` (up to 200 recent log records, each mapped to a fixed
event code; Warn/Error records are kept in preference to lower levels, so a
routine INFO burst cannot push a failure out of the bundle) and
`manifest.json` (sizes, hashes and the omission report).
What it deliberately does not hold: no message content, no attachments or
avatars, no backups, no raw log lines, and no names, paths, addresses, URLs
or credentials — the configuration item structurally omits every one of
those, and table counts are counts, never rows.

Nothing uploads: the bundle is a local download, and sharing that file
remains your decision. Confirming a download writes a `support_bundle_create`
audit row carrying the item list, never contents. Only a logged-in
`ADMINISTRATOR` session can make one — API tokens are refused. The data
contract (what may appear, and the redaction each item receives) is in the
[support-bundle data contract](architecture/diagnostics.md#support-bundle-data-contract);
this guide does not copy it.

## When it fails

Symptom first; each entry says how to tell, what it means, and what to do.
The failure drills that measured each answer are linked from
[data-lifecycle.md](architecture/data-lifecycle.md).

### `/health` returns 503

The `reason` field names the failing subsystem:

- `hub` — the WebSocket dispatch loop died. The server exits nonzero on its
  own and the supervisor relaunches it; nothing to do but confirm it came
  back.
- `database` — the 1-second ping failed: the disk, a lock, or a wedged
  writer. Read the log's last `database` lines.
- `disk` — free space is below `server.min_free_disk_mb`. Free space or move
  `backup.dir` elsewhere; uploads refuse first, messages keep flowing, and
  the three stages are in
  [Health Endpoint](#health-endpoint).

### The server refuses to start

Three named refusals, each with the one thing to do:

- A bad `config.yaml` — the start-up message names the file; fix the value it
  names.
- An erasure-key fingerprint that does not match the marker file — the log
  prints both fingerprints; the matching rule is in
  [security.md](security.md#erasure-marker-key). Put the right `erasure.key`
  back from your archive.
- An unsupported `database.type` — SQLite is the only one; correct the key
  ([server-configuration.md](server-configuration.md)).

### Voice joins but nobody hears anything

The UDP media port(s) — the `50000-60000` range by default, or the single
`voice.udp_port` when set — are not forwarded, or a pinned
`voice.node_ip` is not your current public address (leave it empty so LiveKit
detects it, and restart after the address changes). This is the one
failure the server cannot see, because the media never reaches it. The
check-by-check walkthrough is in [Port Forwarding Guide](port-forwarding.md).

### Voice cannot join at all

The supervised LiveKit process is down. `livekit_healthy: false` on
`GET /api/v1/metrics`, `GET /api/v1/livekit/health` answers
`degraded` with the reason, and the Dashboard's attention panel raises its
`voice` signal. LiveKit's own errors are the `livekit companion output` entries
(`component=livekit`, text in the `line` attribute) in the server log. The companion process restarts it with
exponential backoff (3 s up to 60 s) and gives up after ten consecutive rapid
failures; the recovery steps are in
[LiveKit Setup](livekit-setup.md).

An externally managed LiveKit (no `voice.livekit_binary`, auto-download off)
is probed at each join instead: when it does not answer at
`voice.livekit_url` within 3 s, the join is refused with "voice is temporarily
unavailable — LiveKit is not reachable" and the server logs
`handleVoiceJoin: external LiveKit unreachable`.

### Clients see a certificate mismatch

You rotated or renewed the certificate, or restored a `config.yaml` whose
`tls.mode` differs from what they pinned. They must accept the new
fingerprint you publish out of band —
[Rotating the self-signed certificate](#rotating-the-self-signed-certificate).

### Every 2FA user is locked out after a restore

`totp.key` was not in the restore set — its loss cost and the only way back
are in [Backup Strategy](#backup-strategy).

### Uploads refused with 507

The error code tells you which ceiling: `STORAGE_QUOTA_EXCEEDED` is the
per-file or per-user limit ([Capacity limits](#capacity-limits));
`STORAGE_LOW_DISK` is the disk floor — free space (see
[Health Endpoint](#health-endpoint)).

### An update did not come back

[If the update fails](#if-the-update-fails) — audit rows, the `.old-*`
fallback and the Docker refusal are there.

### What to send when asking for help

A [support bundle](#support-bundle) — it never uploads and holds no
messages, usernames, addresses or raw log lines. Add the last 200 lines of
your supervisor's log by hand if the problem is in it, and say what you are
sending: that excerpt carries usernames and client addresses, which is
exactly why the bundle itself omits raw lines.

## Auto-Update

### Server

The server checks GitHub Releases for updates:

- Compares semver versions
- Results are cached for 1 hour
- Downloads the asset matching this machine's OS and architecture, with detached Ed25519/minisign signature verification on Windows
- Verifies a signed `server-update-manifest.json` that binds the binary hash to the release version
- Cross-checks the binary SHA256 against `checksums.sha256`

The admin panel's update dialog links the release notes, warns that database
migrations only run forward, and takes a database backup first unless you
untick it; if that backup fails, nothing is updated.

Applying an update runs in this order:

1. Download and verify the replacement beside the installed executable.
2. Give connected clients a "restarting in 5s" notice, then rotate the current
   binary to a uniquely named `.old-*` beside it (for example
   `chatserver.exe.old-123456789`) and put the verified download at the
   installation path.
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
5. Once every start-up stage has come up — data dir, TLS, database, migrations,
   and the rest — the new process removes every `.old-*` (and a `.old` left by
   an older release). One that Windows still holds open, because that binary
   is still running, is left for a later start: a server started from a
   console window stays behind until its replacement exits (see
   [Running from a console window](#running-from-a-console-window)). A
   start-up stage that fails before then leaves `.old-*` in place.
6. That removal is the only recovery start-up performs. A new process does not
   put `.old-*` back if the installed binary turns out to be broken after it has
   started serving, and it does not delete a stale `.new` left by an interrupted
   download — staging refuses to write through an existing `.new`, and the next
   update attempt removes it before downloading. If the server dies between
   step 2 and step 5, the previous binary is still beside the installation path
   as a `.old-*` (the most recently modified one, if there are several);
   restoring it is a manual rename.

#### If the update fails

The audit log tells you which stage failed: every apply writes `update_apply`,
then `update_applied` or `update_failed` (see
[security.md](security.md)). Three shapes:

- **The verification refused the download** — the manifest signature, the
  manifest's version or asset binding, or the SHA256 checksum did not match.
  The installed binary is untouched and the admin panel says why; retry, and
  if it persists compare your version against the release page.
- **The rotation succeeded and the server died before or during the handoff**
  — the previous binary is still beside the installation path as a `.old-*`
  until a successor passes its start-up stages. If the new one never boots,
  put that file back by hand (rename it over the broken binary) and start.
  This is a rollback of the binary only: if the failed start was a migration, the
  database has already moved forward, and an older binary refuses to start on
  it rather than corrupting it (restore the pre-upgrade database first).
- **Docker refuses the whole flow** — the panel answers `503
CONTAINER_DEPLOYMENT` because the running binary is image content; the way
  back is the image tag (`docker compose pull && docker compose up -d`).

And the pre-checks that make the failure cases rare: take the
[archive](#before-upgrading-take-the-archive) before the update; on systemd,
update the unit file before applying server updates (see
[Running as a Linux Service](#running-as-a-linux-service-systemd)); under
NSSM, the service must be installed with `OWNCORD_SERVER_RESTART_MODE=supervised`
(see [Running as a Windows Service](#running-as-a-windows-service)).

Externally managed LiveKit is left running. Containers use image upgrades as
described above. Installing the first release with this handoff fix may require
a manual stop/replacement/start: the version already running performs that
first update's shutdown, so it cannot benefit from the fix until replaced.

Set `github.token` in config for higher API rate limits (5000/hr vs 60/hr unauthenticated).

### Client

The Tauri client uses NSIS installer updates:

- Server exposes client update assets from GitHub Releases
- Ed25519 signature verification before applying

#### Client support bundle and logs

When a _user_ has a problem, the desktop client can write its own support bundle
without contacting the server: **Settings → Diagnostics & logs → Export Support Bundle**. It is a local zip
you choose where to save; like the server bundle it uploads nothing, but unlike
it the client log lines are copied verbatim (the client logger does not redact),
so review it before sharing — the Diagnostics & logs tab says so too.

The raw client log lives per user:

- **Windows:** `%LOCALAPPDATA%\com.owncord.client\logs\owncord-client.log`
- **Linux:** the app log directory, `~/.local/share/com.owncord.client/logs/owncord-client.log`
  on a default setup.

It rolls over at ten megabytes and keeps the two previous files beside it as
`owncord-client_<date>.log`. The tray icon's **Open Log Folder** opens that
directory, which is the route in when the window never came up: the log then
says `frontend not ready` 30 seconds after start, and a crash is logged as a
`[panic]` line with a backtrace.

The desktop client keeps **two** logs, the webview's own rotating JSONL log and
the native log above, and the exported bundle carries both;
[Desktop client support bundle](architecture/diagnostics.md#desktop-client-support-bundle)
lists every file it holds.

Ask for the exported bundle first; it carries both logs plus the diagnostic
sections the client can collect on its own.

## Verifying a Download

Checksums, signatures, provenance attestations and SBOMs are all on the release
page, and none of them require trusting the copy of the file you are checking.
Verification needs the [GitHub CLI](https://cli.github.com/) (`gh`); the image
steps also need Docker. Releases published before these were added carry
checksums and minisign signatures only.

```bash
# 1. Checksums. Download the assets and checksums.sha256 into ONE directory --
#    gh release download <tag> -R J3vb/OwnCord puts them all there. The file
#    lists bare filenames, so it has to be checked from that directory, and
#    --ignore-missing skips the assets you chose not to download.
sha256sum --check --ignore-missing checksums.sha256

# 2. Provenance. This proves the file was built by this repository's release
#    workflow at the commit the tag points to, not merely uploaded by whoever
#    holds the release. Run it on the asset you downloaded, and again on
#    checksums.sha256 and on the source snapshot. Set TAG to the release you
#    downloaded, e.g. TAG=v2.2.0-beta.1; the signer-workflow and source-ref
#    flags reject a build from any other workflow or ref, such as a dry run.
gh attestation verify chatserver-linux-amd64.tar.gz --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners
gh attestation verify checksums.sha256 --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners

# 3. The image. Resolve the tag to the digest you are actually running first:
#    a tag is mutable and a digest is not.
DIGEST=$(docker image inspect ghcr.io/j3vb/owncord-server:${TAG#v} \
  --format '{{index .RepoDigests 0}}')

# 4. Verify the attestation the release run pushed beside that digest, then
#    read the inventory BuildKit attached to the image.
gh attestation verify "oci://$DIGEST" --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners
docker buildx imagetools inspect ghcr.io/j3vb/owncord-server:${TAG#v} \
  --format '{{json .SBOM}}'

# 5. Windows binaries additionally carry a detached minisign signature, which is
#    what the updater itself checks before applying an update. The public key
#    lives in the repository; both the key and the .sig are base64.
curl -sSfL -o server_update_public_key.txt \
  https://raw.githubusercontent.com/J3vb/OwnCord/main/Server/updater/server_update_public_key.txt
base64 -d chatserver.exe.sig > chatserver.exe.minisig
base64 -d server_update_public_key.txt > server_update.pub
minisign -Vm chatserver.exe -x chatserver.exe.minisig -p server_update.pub
```

| Asset class                                             | Signature                                                    | SBOM                        | Who verifies it                                  |
| ------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- | ------------------------------------------------ |
| `chatserver.exe`, `chatserver-windows-arm64.exe`        | detached minisign signature, plus the signed update manifest | CycloneDX, one per binary   | the updater on every update; by hand with step 5 |
| `chatserver-linux-*.tar.gz`                             | none detached — the SHA256 in the signed update manifest     | CycloneDX, one per archive  | the updater, through the manifest                |
| Tauri client bundles (Windows and Linux, x64 and arm64) | updater signature                                            | none yet                    | the client's own updater                         |
| `ghcr.io/j3vb/owncord-server` image                     | Sigstore provenance attestation, stored in the registry      | SPDX, attached to the index | an operator, with steps 3 and 4                  |

What this does and does not prove:

- Attestations here are **SLSA Build L2**: a hosted runner, a signature minted
  from the workflow's own OIDC identity, and provenance naming the workflow and
  commit, all from the same run. It is not L3, which needs a hardened and
  isolated build platform.
- Provenance binds a file to a build, not to a person: it says which commit and
  which workflow produced it, and nothing about whether that commit is
  trustworthy. Read the commit.
- The Tauri client bundles carry a provenance attestation but **no SBOM**; that
  arrives with the client-bundle work in B8. The updater signature on them is
  the check that matters today.
- Windows Authenticode/SmartScreen code signing is still separate work (see
  [Known Limitations](security.md#known-limitations)), so SmartScreen keeps
  warning on the binaries even when every check above passes.

## Firewall and Ports

This is the canonical port table — the guides that repeat any of it
([Port Forwarding Guide](port-forwarding.md),
[LiveKit Setup](livekit-setup.md)) point here, and their own tables carry
only the rows their instructions need.

| Port          | Protocol | Purpose                                           |
| ------------- | -------- | ------------------------------------------------- |
| `8443`        | TCP      | HTTPS server (configurable via `server.port`)     |
| `80`          | TCP      | ACME HTTP-01 challenge (only if `tls.mode: acme`) |
| `7881`        | TCP      | LiveKit server (RTC/TURN over TCP)                |
| `50000-60000` | UDP      | LiveKit WebRTC media (ICE candidates)             |

With LiveKit in single-port mode (`rtc.udp_port` in its `livekit.yaml`, or
`voice.udp_port` when OwnCord runs it), the last row is that one UDP port
instead of the range.

`7880/TCP` (LiveKit's own WebSocket/REST API) is **not** in the required set:
the server proxies signalling to clients at `:8443/livekit`, so only clients
that reach LiveKit directly need it.

For remote access, see the [Port Forwarding Guide](port-forwarding.md) or
[Tailscale Guide](tailscale.md). The port-forwarding guide also covers the
limits OwnCord cannot detect from inside your network — blocked ports, CGNAT,
hairpin NAT and a changing public IP — and how to check each one yourself.

The TLS limits this build's certificate modes carry are stated where you
choose one: [TLS Setup](#tls-setup).

## Hardening Checklist

- [ ] **Set a strong Owner password at setup** -- there is no default password to change; the first-run wizard creates the Owner account
- [ ] **Set `admin_allowed_cidrs`** -- restrict admin access to specific IPs if needed
- [ ] **Serve TLS end to end** -- keep the qualified default (`self_signed`) or, for a public domain, front the server with a reverse proxy that owns certificate renewal; built-in `acme` works but is not qualified ([TLS Setup](#tls-setup)). Never expose `tls.mode: off` directly: publish 8443 on loopback (`127.0.0.1:8443:8443`) or firewall it to the proxy only
- [ ] **Set `trusted_proxies`** -- only if behind a reverse proxy, list the proxy's own addresses so client IPs come from `X-Forwarded-For`
- [ ] **Leave `allowed_origins` empty unless you know why** -- empty denies cross-origin WebSocket connections, which is what a desktop-only deployment wants; set it only to admit browser clients from your own domain
- [ ] **Set stable voice credentials** -- set `livekit_api_key` and `livekit_api_secret` to avoid token breakage on restart
- [ ] **Check the voice media address** -- leave `voice.node_ip` empty so LiveKit detects the public address (Docker: `use_external_ip: true` in `livekit.yaml`, replaced by `node_ip` when pinned); pin it only when detection cannot work, such as a tailnet-only host ([Port Forwarding](port-forwarding.md#dynamic-public-ip))
- [ ] **Review upload limits** -- adjust `upload.max_size_mb` for your use case
- [ ] **Configure GitHub token** -- optional, for reliable update checks
- [ ] **Schedule backups** -- use the built-in schedule on the admin panel's Backups & restore page, or the endpoint from your own cron ([Scheduled Backups](#scheduled-backups))
- [ ] **Monitor health** -- poll `/health` and `/api/v1/livekit/health` for uptime monitoring ([Monitor voice as well as liveness](#monitor-voice-as-well-as-liveness)); both are poll-only, the server does not push alerts

## Background Maintenance

A maintenance loop runs every 15 minutes, thirteen steps in this order
(later steps only see what earlier ones stranded this tick). A failing step
is logged and the rest of the pass still runs; five consecutive failed passes
open a circuit breaker that skips one tick and then retries:

1. Expired user sessions are purged
2. Expired message delivery receipts are deleted
3. Expired second-factor state is cleaned up
4. Stale push subscriptions are swept
5. Backup maintenance runs (schedule check, retention pruning)
6. Orphaned attachments are deleted (uploaded but never linked, older than 1 hour)
7. The retention sweep runs (messages past the configured window, if any)
8. Closed reports' content past `moderation.report_retention_days` is pruned
9. Orphaned voice mutes are reconciled
10. Retired moderation actions past `moderation.action_retention_days` are removed (never one that still owns a voice mute)
11. Pending erasure jobs resume
12. Storage files are reconciled against the database (at most 500 files per tick)
13. A storage recount runs — last on purpose, so it measures what the sweeps above freed

## Graceful Shutdown

The server handles `Ctrl+C` (SIGINT) and `SIGTERM`:

1. Shuts down the ACME listener, ends any open admin Logs stream, then
   drains in-flight HTTP handlers; a file upload or download still in
   progress gets up to 20 seconds to finish and is then cut, so the drain
   stays inside the 30-second budget
2. Stops the hub on a budget of its own: sends the restart notice, waits
   out the notice window, closes every WebSocket connection and only then
   stops the LiveKit process, so clients leave voice while it is still up
3. Unregisters the signal handler, so a second `Ctrl+C` during steps 1–2 does
   not cut the drain short
4. Joins the maintenance loop, flushes the audit queue and drains event
   persistence
5. Stops the router's cleanup goroutine, closes the plugin runtime, shuts
   telemetry down and releases the deletion-marker file
6. Closes the database

The drain comes **before** the WebSocket close, not after: in-flight handlers
broadcast on their way out, and those frames have to reach a live hub and event
persister or they vanish from the replay store across the restart. Shutdown
does not wait on hijacked WebSocket connections, so connected clients do not
delay the drain — they get the restart notice immediately afterwards. The order
is the reverse of the start sequence in `Server/internal/app/stages.go`, not
a hand-written teardown.

A managed livekit-server never outlives the server, even when the server dies
without running this sequence: on Linux the kernel kills it with its parent
(`Pdeathsig`), and on Windows it runs in a job object that is killed when the
server exits. On Windows, closing the server's console window stops the server
and LiveKit together, including after a self-restart (see
[Running from a console window](#running-from-a-console-window)).

## See Also

- [Server Configuration](server-configuration.md) -- full config key reference
- [Capacity](capacity.md) -- the measured 250/100/25 profile, its hardware and its commands
- [LiveKit Setup](livekit-setup.md) -- voice/video setup
- [Quick Start](quick-start.md) -- getting started
- [Port Forwarding](port-forwarding.md) -- port forwarding for remote access
- [Tailscale](tailscale.md) -- zero-config networking
- [Security](security.md) -- security guidelines
