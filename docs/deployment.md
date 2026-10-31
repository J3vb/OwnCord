# Deployment Guide

This guide is for anyone who runs their own OwnCord server. It covers Windows,
Linux, Docker and Unraid. It explains how to install the server, keep it
running, back it up, upgrade it and fix it when something goes wrong.

New to OwnCord? Start with the [Quick Start](quick-start.md). Come back here
when you are ready to run a server for real.

## On this page

- [Prerequisites](#prerequisites)
- [Building from Source](#building-from-source) and release downloads
- [Docker (Linux)](#docker-linux), including [Unraid](#unraid)
- [First run](#first-run)
- Running as a service: [Linux (systemd)](#running-as-a-linux-service-systemd)
  or [Windows](#running-as-a-windows-service)
- [TLS Setup](#tls-setup) and [Reverse Proxy Topology](#reverse-proxy-topology)
- [Backup Strategy](#backup-strategy) and [Restore](#restore)
- [Storage growth](#storage-growth)
- [Upgrade and Rollback](#upgrade-and-rollback)
- [Capacity limits](#capacity-limits)
- [Monitoring](#monitoring) and [When it fails](#when-it-fails)
- [Auto-Update](#auto-update) and [Verifying a Download](#verifying-a-download)
- [Firewall and Ports](#firewall-and-ports)
- [Command-line reference](#command-line-reference)
- [Hardening Checklist](#hardening-checklist)
- [Background Maintenance](#background-maintenance) and
  [Graceful Shutdown](#graceful-shutdown)

## Prerequisites

You need:

- **A computer to run the server.** Windows 10 or later, or Linux. Both x64
  and ARM64 are supported. For how many people one server can carry on which
  hardware, see [Capacity](capacity.md).
- **Go 1.27 or later**, but only if you build from source.
- **LiveKit**, but only for voice and video. You usually do not need to
  install it yourself: the server can download and run it for you. See
  [LiveKit Setup](livekit-setup.md).

Ports the server uses:

- `8443/TCP` for chat, the API and the admin panel. Always needed.
- `7881/TCP` plus UDP media ports for voice and video. The media ports are
  `50000-60000/UDP` by default, or one UDP port if you set `voice.udp_port`.
  The Docker image and the compose stack use `7882/UDP`.
- `80/TCP` only if you use the built-in Let's Encrypt mode (`tls.mode: acme`).

You do **not** need to open `7880/TCP`. That is LiveKit's own API port.
Clients reach LiveKit through the server's `/livekit` path on port 8443
instead. The full list is under [Firewall and Ports](#firewall-and-ports).

## Building from Source

You can build the server yourself or download a ready-made binary.

**Build on Windows:**

```bash
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .
```

**Build on Linux:**

```bash
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=dev" .
```

What the flags do:

- `-s -w` removes debug information, so the binary is smaller.
- `-X main.version=...` sets the version the server reports. A source build
  reports `dev` unless you set it to the tag you built from.
- `CGO_ENABLED=0` makes a fully static binary on Linux.

**Or download a release.** Each GitHub Release has these server assets:

| Platform      | Asset                           |
| ------------- | ------------------------------- |
| Windows x64   | `chatserver.exe`                |
| Windows ARM64 | `chatserver-windows-arm64.exe`  |
| Linux x64     | `chatserver-linux-amd64.tar.gz` |
| Linux ARM64   | `chatserver-linux-arm64.tar.gz` |

The Linux archives contain one binary named `chatserver`.

Pick the asset that matches your machine's architecture. The server refuses
an update built for a different architecture, so a mismatch leaves you stuck
on the version you installed.

Every asset is built on its own architecture. Before release, each one goes
through a full lifecycle check. It must start, migrate a fresh database,
report healthy, shut down cleanly when asked to stop, and restart on the same
data.

To check that a download is genuine, see
[Verifying a Download](#verifying-a-download).

## Docker (Linux)

Docker is the easiest way to run OwnCord on Linux. You have two choices:

- **The compose stack** (`Server/docker-compose.yml`). It runs the chat server
  and LiveKit as two separate containers on a private network. Use it when you
  want to restart or upgrade LiveKit on its own.
- **One container.** The image also bundles LiveKit, so a single container can
  serve both chat and voice. See [LiveKit in Docker](#livekit-in-docker).

About the image `ghcr.io/j3vb/owncord-server`:

- One tag covers both `linux/amd64` and `linux/arm64`. A Raspberry Pi 4 or 5,
  an ARM cloud server and an ordinary x86-64 machine all pull the same tag and
  get the right image.
- It is built on `gcr.io/distroless/static-debian12`. This base image has no
  shell and no tools like `curl`, which keeps it small and hard to attack.
- It runs as a non-root user with user ID `65532`.
- Before any tag is published, both architectures are tested on their own
  hardware. The image must boot on an empty volume, migrate a fresh database,
  report healthy and stop cleanly. A new container must then find the old data
  intact.

### Prerequisites

- Docker Engine 24 or later, and Docker Compose v2.
- A `linux/amd64` or `linux/arm64` host.
- Free ports: `8443/TCP` for chat, `7881/TCP`, and the voice media UDP
  port. Both the single-container image and the compose stack use `7882/UDP`.
  See
  [LiveKit in Docker](#livekit-in-docker).

### Quick Start

These steps use the compose stack.

The files `docker-compose.yml`, `.env.example`, `livekit.yaml.example` and
`config.yaml.example` are **not** separate release downloads. Take them from
the source snapshot attached to each release, or from the repository's
`Server/` folder.

1. Go to the folder with the files:

   ```bash
   cd Server
   ```

2. Create your secrets file, then edit `.env`. Set `LIVEKIT_API_KEY` and
   `LIVEKIT_API_SECRET`. The secret must be at least 32 characters. Never use
   a `'` in either value: LiveKit reads the pair as YAML, and a `'` stops it
   from starting. Letters and digits, for example the output of
   `openssl rand -hex 32`, are safest. This is the only place you type them: compose passes the pair to
   both containers. `docker compose` refuses to run any command, even `down`
   or `logs`, while either value is missing from `.env`.

   ```bash
   cp .env.example .env
   ```

3. Create your LiveKit config. It has no key or secret in it: those come from
   `.env`. Leave `use_external_ip: true` as it is, so LiveKit finds your
   public address. Only on a host reached through Tailscale alone do you
   replace it with `node_ip`. Media uses the single UDP port `7882`, which
   compose sets itself, so do not add a port range.

   ```bash
   cp livekit.yaml.example livekit.yaml
   ```

4. Create your server config, then edit `config.yaml` for settings such as the
   server name and TLS. You do not need to change anything for voice. See
   [config.yaml for Docker](#configyaml-for-docker).

   ```bash
   cp config.yaml.example config.yaml
   ```

5. Start the stack:

   ```bash
   docker compose up -d
   ```

> **Create `config.yaml` before the first start.** Compose mounts
> `./config.yaml` into the container. If the file does not exist, Docker
> creates an empty _folder_ with that name instead, and the server cannot read
> its configuration.

On first start the server creates its database and default files in
`/app/data`. Then:

1. Read the setup token from the log: `docker compose logs owncord`.
2. Open `https://<your-ip>:8443/admin`.
3. Enter the token and create the Owner account.

**On a cloud server (VPS) the admin panel may refuse you.** The admin panel and
the setup wizard only accept connections from the addresses in
`server.admin_allowed_cidrs`. By default that is the local machine and private
networks. From your own computer you have two options:

- Tunnel to the server over SSH, then browse to
  `https://localhost:8443/admin`:

  ```bash
  ssh -L 8443:localhost:8443 user@your-server
  ```

- Or add your address to `server.admin_allowed_cidrs` in `config.yaml`.

When the server refuses you, its `403` reply names this setting.

### config.yaml for Docker

The compose file already sets some values for you, through environment
variables:

- `OWNCORD_VOICE_LIVEKIT_API_KEY` and `OWNCORD_VOICE_LIVEKIT_API_SECRET`, taken
  from your `.env`. LiveKit gets the same pair as `LIVEKIT_KEYS`.
- `OWNCORD_VOICE_UDP_PORT` set to `7882`, the one UDP media port compose
  publishes.
- `OWNCORD_VOICE_LIVEKIT_URL` set to `ws://livekit:7880`, the LiveKit
  container.
- `OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT` set to `false`, because LiveKit runs in
  its own container.

An environment variable always wins over `config.yaml`. So whatever the copied
example says about these keys does no harm.

In `config.yaml`:

- **Do not set** `voice.livekit_api_key` or `voice.livekit_api_secret`. Keeping
  secrets out of `config.yaml` is the point of `.env`.
- **Do not set** `voice.livekit_binary`.
- Set everything else as normal. For example:

```yaml
server:
  name: "My OwnCord"
  port: 8443

voice:
  quality: "medium"

tls:
  mode: "self_signed" # or "acme" / "manual" for production
```

**Compose mounts `config.yaml` read-only.** Nothing inside the container can
change it. In a container, the admin panel and the setup wizard save startup
settings into `config-overrides.json` in the data volume instead, so they
survive a recreate. `config.yaml` stays as you wrote it, and a saved setting
overrides it only for the keys you changed there. The panel's **Reset**
button returns a key to what `config.yaml` says. The wizard cannot change the
port in a container, because the published port mapping fixes it; change the
mapping in your compose file or `docker run` command. To change any other
startup setting from the file, edit it on the host and recreate the container.

If a setting saved from the admin panel keeps you out of the panel, stop the
server and run `docker compose run --rm --no-deps owncord config reset-overrides`
(see [If a panel change locks you out](server-configuration.md#if-a-panel-change-locks-you-out)).

### Health and privilege

**Health check.** The image has its own `HEALTHCHECK`, so `docker ps` shows a
health state even without the compose file. The binary checks itself with
`chatserver healthcheck`, because the image has no shell or `curl`.

Docker only _reports_ `unhealthy`. It does not restart the container. If you
want automatic restarts on a hang, add an external watchdog.

**Privilege.** The shipped `docker-compose.yml` removes every Linux capability
and blocks privilege escalation:

```yaml
cap_drop:
  - ALL
security_opt:
  - no-new-privileges:true
```

If you run the container by hand, pass the same two options:
`--cap-drop=ALL --security-opt=no-new-privileges:true`. The server listens on
port 8443, which needs no special capability.

A read-only root filesystem is **not** supported. On first boot the server
writes its default `config.yaml` into `/app`.

### Data Persistence

The Docker volume `owncord-data` is mounted at `/app/data` inside the
container. It holds the SQLite database, TLS certificates, uploads and
backups. It survives container restarts and upgrades.

Backups from the admin panel land in `/app/data/backups/`, which is inside the
volume. For safer places to keep them, see [Backup Strategy](#backup-strategy).

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The named volume is kept, so no data is lost. Before you upgrade, take an
archive and learn what a rollback costs. Both are in
[Upgrade and Rollback](#upgrade-and-rollback).

**Pulling a new image is the only way to upgrade in Docker.** The admin panel's
in-place update is refused in a container. It answers
`503 CONTAINER_DEPLOYMENT`. The running binary is part of the image, so a new
binary written beside it would vanish with the container.

The image sets `OWNCORD_CONTAINER=1` to mark this. If you mount the server
binary into a container yourself and really want in-place updates, set
`OWNCORD_CONTAINER=0`.

**Restarts rely on the restart policy.** These actions make the server stop
cleanly and expect Docker to start it again:

- a backup restore from the admin panel
- the **Restart server** and **Restart now** buttons
- a restart from the setup wizard

The shipped `docker-compose.yml` sets `restart: unless-stopped`, which covers
this. If you run the container by hand, pass `--restart unless-stopped`.
Without it, a restore or restart leaves the container stopped.

### LiveKit in Docker

**One container (bundled LiveKit).** The image includes a pinned,
checksum-checked `livekit-server`. It sets
`OWNCORD_VOICE_LIVEKIT_BINARY=/livekit-server`, so the server starts LiveKit
itself, just as on bare metal. One container then serves chat and voice:

```bash
docker run -d -v owncord-data:/app/data \
  -p 8443:8443 -p 7881:7881 -p 7882:7882/udp \
  ghcr.io/j3vb/owncord-server:latest
```

The image also sets `OWNCORD_VOICE_UDP_PORT=7882`. All voice media then uses
that one UDP port instead of the `50000-60000` range. Override either variable
to change this. LiveKit's credentials and its `livekit.yaml` are kept in
`/app/data`, the volume. Credentials the setup wizard generates are saved there
too (in `config-overrides.json`). The pair is saved only when neither half is
supplied by `config.yaml` or the environment, so they persist once the wizard
has run.

**Two containers (the compose stack).** The shipped `docker-compose.yml` runs
`livekit/livekit-server:v1.13.7` as its own container. For the server it
clears `OWNCORD_VOICE_LIVEKIT_BINARY`, so the bundled copy never starts, and
sets `OWNCORD_VOICE_UDP_PORT` to `7882`, so the admin connectivity report
names the right port. It publishes `8443/TCP`, `7881/TCP`
and `7882/UDP`, and takes the LiveKit key and secret from `.env` only. Choose
this when you want to size, restart or upgrade LiveKit separately. See
[LiveKit Setup — Docker](livekit-setup.md#docker).

### Unraid

[`deploy/unraid/owncord.xml`](../deploy/unraid/owncord.xml) is a template for
Unraid's Docker tab. It runs one container, with voice from the bundled
LiveKit.

To install it:

1. Add the template's raw URL under **Docker > Template repositories**. Or copy
   the file into `/boot/config/plugins/dockerMan/templates-user/`.
2. Choose **Add Container > OwnCord**.
3. Start the container.
4. Read the setup token from the container log.
5. Open `https://<unraid-ip>:8443/admin` and create the Owner account.

Ports it publishes:

- `8443/tcp` for chat and the admin panel.
- `7881/tcp` and `7882/udp` for voice. Forward these two from your router for
  voice outside your home network. See [port-forwarding.md](port-forwarding.md).

Things to know:

- **File ownership.** The image normally runs as user `65532`. Unraid creates
  appdata folders owned by `99:100` (`nobody:users`). So the template adds
  `--user 99:100`, and the container writes its files as that user. To move an
  install between the two, run `chown -R` on the appdata folder for the new
  owner.
- **`config.yaml`.** If you mount a single file that does not exist yet,
  Docker creates a folder in its place. So the template mounts the folder
  `/app` instead (default `/mnt/user/appdata/owncord`). The server writes its
  default `config.yaml` there on first start. Edit it, then restart the
  container.
- **Data.** `/app/data` is a second mount, for the database and uploads.
- **Other settings.** The template also sets a 60-second stop timeout, the
  open-file limit, `--restart=unless-stopped`, `--cap-drop=ALL` and
  `no-new-privileges`.

### Linux desktop voice

Two problems with the Linux desktop client's voice were fixed in
**v2.0.1-beta.1**. They only affect you if the Linux client or the server is
older than that. Updating fixes both.

- **An old Linux client could not join voice on an older server.** The
  2.0.0-beta.1 Linux client sent its voice sign-in in a way that servers older
  than 2.0.0-beta.1 dropped, so the join failed. From v2.0.1-beta.1 the Linux
  client sends it the same way as Windows and macOS. Fix: update the client.
- **On the Docker host itself, voice could fail.** This hit a Linux client
  connecting as `localhost`, `127.0.0.1` or `::1`, to a server on the same
  Docker host. Older servers sent LiveKit's internal address,
  `ws://livekit:7880`, and the old client tried to use it directly. That name
  only works inside the container network. Fix: update either side to
  v2.0.1-beta.1 or later.
  - The server now sends LiveKit's address only when that address is itself
    local.
  - The client now uses a LiveKit address directly only when it is a local
    `ws:` or `http:` address. Anything else goes through the server's
    `/livekit` tunnel.
  - Until you update, connect using the host's LAN address or hostname, or run
    the client on another machine.

---

## First run

When the server starts for the first time, it does this:

1. **Writes `config.yaml`** with default values, in the working directory.
2. **Creates the `data/` folder** for the database, certificates, uploads and
   backups.
3. **Creates a self-signed TLS certificate** at `data/cert.pem` and
   `data/key.pem`.
4. **Creates the SQLite database** and runs all migrations.
5. **Resets status.** Every user is set to `offline`, and old voice states are
   cleared.
6. **Prints a setup token** in its start-up output.

Then open `https://localhost:8443/admin` to run the setup wizard. It asks for
the setup token. You find the token in:

- the terminal, if you started the server by hand
- `docker compose logs owncord`, in Docker
- the service log, under systemd or NSSM

The token changes every time the server starts. It is only printed while setup
is still open. To get a fresh one, restart the server. This includes after you
re-open setup ([security.md](security.md#first-run-setup)).

**What the wizard does:**

- It creates the Owner account.
- It asks for the basics: server name, port, TLS mode, upload limit, voice,
  registration, welcome message, and the Owner's recovery kit.
- It saves your choices. Live settings go into the database. Startup settings
  go into `config.yaml`, with comments and your own edits kept. In a Docker
  container they go into `config-overrides.json` in the data volume instead,
  and only the ones you changed.
- It saves the generated LiveKit credentials, so voice keeps working across
  restarts.
- If you changed the port or TLS mode, the server restarts once. The wizard
  then shows the new address.

**The finish screen shows:**

- the address members type into the desktop app (with TLS off, it points them
  to your HTTPS reverse proxy instead)
- the invite code
- the certificate fingerprint, if the server already serves a certificate
- the Owner's recovery kit

The recovery kit is shown only once. The server stores only a check value for
it ([security.md](security.md#account-recovery)). While the kit is on screen,
the page does not follow a restart by itself. Save the kit first, then open
the link.

**Skip** runs a shorter setup. It creates only the Owner account and its
recovery kit. Everything else keeps its default.

**Voice works out of the box.** In a freshly written `config.yaml`,
`voice.auto_download_livekit` is on. It is also a switch in the wizard. With it
on, the server:

1. downloads a pinned `livekit-server` release from LiveKit's official GitHub
   releases, in the background
2. checks it against the release's checksum file
3. stores it in `data/livekit/`
4. starts and manages the LiveKit process itself

If you run your own LiveKit, turn the switch off or set `voice.livekit_binary`.

By default the server listens on `https://0.0.0.0:8443`, meaning every network
interface. For every option, see [Server Configuration](server-configuration.md).

## Running as a Linux Service (systemd)

If the server crashes, it stays down until someone notices. Causes include a
crash under load, the out-of-memory killer, or a failed self-update. So run it
under a supervisor such as systemd.

A ready-made unit file ships in the repository:
[`deploy/owncord.service`](../deploy/owncord.service).

**To install it:**

1. Create a service user. Its home is the state folder, which systemd creates
   and owns (`StateDirectory=owncord`, `/var/lib/owncord`):

   ```bash
   sudo useradd --system --home /var/lib/owncord --shell /usr/sbin/nologin owncord
   ```

2. Install the `chatserver` binary, owned by root, so the service can run it
   but not change it:

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/owncord
   sudo install -o root -g root -m 0755 ./chatserver /opt/owncord/chatserver
   ```

3. Copy the unit file and start the service:

   ```bash
   sudo cp deploy/owncord.service /etc/systemd/system/owncord.service
   sudo systemctl daemon-reload && sudo systemctl enable --now owncord
   ```

4. Read the log with `journalctl -u owncord -f`.

The program lives in `/opt/owncord`. Everything the server writes lives in
`/var/lib/owncord`: `config.yaml`, `data/` (the database, uploads,
certificates, backups) and the bundled LiveKit. The unit sets
`WorkingDirectory=/var/lib/owncord`, so the relative `data_dir` default
(`data`) lands there with no configuration.

**Upgrading from the old layout?** Earlier unit files kept both the program
and its state in `/opt/owncord`. Your installed copy keeps working until you
re-copy the unit. Before you do, follow
[Migrating from the /opt/owncord data layout](#migrating-from-the-optowncord-data-layout).

**What the unit file sets, and why:**

- **`Restart=always`.** The server exits on purpose in two cases and expects
  systemd to start it again:
  - It exits with an error code if its WebSocket dispatch loop dies, rather
    than keep running broken.
  - It exits cleanly after an admin-panel self-update, a backup restore, a
    **Restart server** click, or a setup-wizard restart. systemd then starts
    the new binary.

  The server spots systemd through the `INVOCATION_ID` variable. Under systemd
  it exits and lets systemd restart it, instead of starting its own copy that
  systemd would kill. `systemctl stop` still stops it: systemd never restarts
  a unit you stopped yourself.

  **Update the unit file before you apply a server update from the admin
  panel.** With older OwnCord releases, the new process was killed by systemd's
  cleanup. The current unit file fixes that.

- **`TimeoutStopSec=60`.** On `SIGTERM` the server shuts down gracefully. It
  allows up to 30 seconds to finish open HTTP requests and up to 10 seconds
  for each other step. The whole shutdown is capped at 50 seconds. A normal
  stop takes about 5 to 10 seconds. systemd only reaches its 60-second limit if
  shutdown is stuck, and then it kills the process. For other supervisors, the
  server has its own 90-second restart backstop.

- **`StateDirectory=owncord` with `ProtectSystem=strict`.**
  `ProtectSystem=strict` makes the filesystem read-only for the service,
  except the state folder `/var/lib/owncord`, which systemd creates (mode
  `0750`) and keeps writable. The program folder `/opt/owncord` stays
  read-only to the service. Do not add `NoExecPaths=` for the state folder:
  the bundled LiveKit runs from `data/livekit/`.

  **Add every other folder the server writes to.** The usual ones are an
  off-disk `backup.dir` or `upload.storage_dir`. Without that, writes fail with
  `EROFS`, and every backup fails: manual, scheduled and pre-restore. Example:

  ```ini
  ReadWritePaths=/mnt/backup-disk/owncord
  ```

- **`AssertPathExists=!/opt/owncord/data`.** The unit refuses to start while
  the old layout's data folder still exists. Without it, a re-copied unit would
  start the server in an empty `/var/lib/owncord` and it would look like your
  data was gone. A new install never has that folder, so this costs nothing.

- **`#AmbientCapabilities=CAP_NET_BIND_SERVICE` (commented out).** Only needed
  for `tls.mode: acme`, which listens on port 80 as a non-root user. If you use
  `acme`, uncomment the line. Without it the server logs
  `ACME HTTP server error`, with the bind error, and certificate challenges
  and renewal fail until you fix it and restart.

- **`LimitNOFILE=65536`.** The open-file limit. Each WebSocket connection uses
  one file descriptor, so this caps how many people can be online. 65,536 is
  far more than 2,000 people need (about 4,256). Raise it only past about
  30,000 connections. An old systemd default of 1,024 would stop you at a few
  hundred people. See [Open-file limit](#open-file-limit-file-descriptors).

### Migrating from the /opt/owncord data layout

Do this before you copy the new unit file over an old one. Follow every step;
the signs of a missed one are at the end.

1. Stop the service:

   ```bash
   sudo systemctl stop owncord
   ```

2. Create the state folder, or skip this and let systemd create it on the first
   start. Then move your state into it:

   ```bash
   sudo mkdir -p /var/lib/owncord
   sudo mv /opt/owncord/data /opt/owncord/config.yaml /var/lib/owncord/
   ```

3. Check the moved config for absolute `/opt/owncord` paths:

   ```bash
   sudo grep -n '/opt/owncord' /var/lib/owncord/config.yaml
   ```

   Read the list before you change anything. Relative paths (the default
   `data_dir: data`) need no change.
   - Paths into the data you just moved (`data_dir`, `backup.dir`,
     `upload.storage_dir` under `/opt/owncord/data`) now live under
     `/var/lib/owncord/data`. Edit those keys by hand, or rewrite only that
     tree:

     ```bash
     sudo sed -i 's#/opt/owncord/data#/var/lib/owncord/data#g' /var/lib/owncord/config.yaml
     ```

   - TLS certificate and key files kept elsewhere under `/opt/owncord`: move
     them into `/var/lib/owncord` first, then edit their paths.
   - `voice.livekit_binary` and anything else that stays beside the program
     keeps its `/opt/owncord` path. The program folder is read-only to the
     service, which is fine for files it only reads.
   - A `data_dir`, `backup.dir` or `upload.storage_dir` outside both folders
     (for example `/srv/owncord`) stays where it is, but add it to
     `ReadWritePaths=` in the unit (step 5), or writes there fail.

   If a move is interrupted, do not start the service: delete the partial copy
   under `/var/lib/owncord` and redo the move.

4. Hand the state to the service and the program to root, and point the
   service user's home at the state folder:

   ```bash
   sudo chown -R owncord:owncord /var/lib/owncord
   sudo chmod 0750 /var/lib/owncord
   sudo chown -R root:root /opt/owncord
   sudo usermod -d /var/lib/owncord owncord
   ```

5. Edit the new unit before you install it, if you need to:
   - `tls.mode: acme`: uncomment `AmbientCapabilities=CAP_NET_BIND_SERVICE`.
   - A data, backup or upload folder outside `/var/lib/owncord`: add it to
     `ReadWritePaths=`.
   - Admin-panel updates: follow
     [Opt in to admin-panel updates](#opt-in-to-admin-panel-updates) after the
     next step.

6. Copy the new unit and start the service:

   ```bash
   sudo cp deploy/owncord.service /etc/systemd/system/owncord.service
   sudo systemctl daemon-reload && sudo systemctl start owncord
   ```

**Signs of a missed step:**

- The unit fails with `Assertion failed ... /opt/owncord/data` and the service
  does not start: the data folder is still under `/opt/owncord`. Do step 2.
- Backups or uploads fail with `EROFS` (read-only file system): a path in
  `config.yaml` still points under `/opt/owncord`, or at a folder not listed in
  `ReadWritePaths`. Do step 3.

### Opt in to admin-panel updates

By default the service cannot write to `/opt/owncord`, so the admin panel
cannot replace the binary: the Updates page says the server cannot replace its
own program file, and the apply request answers `503 INSTALL_READ_ONLY` before
it downloads anything. You then install new releases by hand, as in
[Performing the upgrade](#performing-the-upgrade).

To let the admin panel update the server, give the service write access to the
program folder with a drop-in:

```bash
sudo systemctl edit owncord
```

```ini
[Service]
ReadWritePaths=/opt/owncord
```

```bash
sudo chown owncord /opt/owncord
sudo systemctl restart owncord
```

The service can then rewrite its own program file. Remove the drop-in
(`sudo systemctl revert owncord`) and `sudo chown root /opt/owncord` to go back
to the default.

Pair the service with scheduled backups from the admin panel. Or drive backups
from cron instead: see
[Scheduling backups from outside the server](#scheduling-backups-from-outside-the-server).

## Running as a Windows Service

### Option 1: NSSM

NSSM ("Non-Sucking Service Manager") runs any program as a Windows service.

```powershell
# Install NSSM (with Chocolatey, or download it from nssm.cc)
choco install nssm

# Create the service
nssm install OwnCord "C:\OwnCord\chatserver.exe"
nssm set OwnCord AppDirectory "C:\OwnCord"
nssm set OwnCord DisplayName "OwnCord Chat Server"
nssm set OwnCord Start SERVICE_AUTO_START

# REQUIRED: tell the server that NSSM supervises it.
nssm set OwnCord AppEnvironmentExtra OWNCORD_SERVER_RESTART_MODE=supervised

# Keep the log. Create C:\OwnCord\logs first.
nssm set OwnCord AppStdout "C:\OwnCord\logs\server.log"
nssm set OwnCord AppStderr "C:\OwnCord\logs\server.log"
nssm set OwnCord AppRotateFiles 1

# Manage the service
nssm start OwnCord
nssm stop OwnCord
nssm restart OwnCord
```

Why the two important lines matter:

- **`OWNCORD_SERVER_RESTART_MODE=supervised` is required.** After a
  self-update or restore, the server then exits cleanly and NSSM starts it
  again with the new binary. NSSM 2.24 cannot be detected automatically.
  Without this line, the server starts its own replacement, which races with
  NSSM's restart.
- **`AppStdout` and `AppStderr` keep the log.** The server writes its log only
  to standard output. Without these lines, the service throws every log line
  away.

### Option 2: Task Scheduler

1. Open Task Scheduler and create a new task.
2. Trigger: **At startup**.
3. Action: start `chatserver.exe`.
4. Set **Start in** to the folder that holds `config.yaml`.
5. Tick **Run whether user is logged on or not**.
6. Tick **Run with highest privileges**.

Task Scheduler starts the server but does not watch it. So leave
`server.restart_mode` on its default, `auto`. Here `auto` means `spawn`: after
a self-update or restore, the server starts its own replacement.

Task Scheduler also throws away the server's output. To keep the log, wrap the
action in a redirect:

```powershell
cmd /c chatserver.exe >> logs\server.log 2>&1
```

### Running from a console window

You can also start the server by double-clicking `chatserver.exe`, or from
cmd or PowerShell. Nothing supervises it then, so `auto` means `spawn`.

What happens on a self-restart (after a self-update, backup restore or setup
wizard restart):

- The replacement runs in the same console window, and its log keeps printing
  there.
- The old process stays behind, idle, until the replacement exits. Then it
  exits too, with the same exit code.
- This keeps Windows Terminal from closing the tab. It also stops a shell from
  printing its prompt over the log.
- Each self-restart leaves one more idle process, until the window closes or
  the server stops.

To stop the server:

- **`Ctrl+C`** stops the replacement, which shuts down as usual. The old
  process then exits with it.
- **Closing the window** stops everything, including LiveKit.

**One exception.** If a restart's shutdown gets stuck past the 90-second
restart backstop, the old process may still hold the port or the database
lock. So it exits instead of staying behind, and the replacement opens in a
new console window of its own.

A server started without a console, for example by a service wrapper, also
gets a new console window of its own when it restarts itself.

## TLS Setup

TLS is the encryption between clients and the server. The server supports four
modes in `tls.mode`. What each mode means for the people who connect is in
[trust-model.md](trust-model.md). That page covers certificate pinning in the
desktop app, what a browser would need, and what the operator can read no
matter which mode you use.

| Mode          | Use it when                                                        |
| ------------- | ------------------------------------------------------------------ |
| `self_signed` | The default. Works anywhere, including on a bare IP address.       |
| `acme`        | You have a domain and want the server to get Let's Encrypt itself. |
| `manual`      | You already have certificate files.                                |
| `off`         | Only behind a reverse proxy that handles HTTPS.                    |

**Limits of this build.** These decide your TLS mode today, so they are stated
up front:

- `self_signed` is fully tested and is the default.
- `acme` with a domain works, but it has not been tested at release quality
  against expiry, rotation and restart.
- There is no HTTPS on a bare public IP with a public certificate.
- There is no guided way to install trust for a LAN or offline device.
- Certificate lifecycle is not fully tested: renewal state across restart,
  hot reload, and rotation with margin.

Details are in
[What this build does not do](port-forwarding.md#what-this-build-does-not-do).

### Self-Signed (default)

```yaml
tls:
  mode: "self_signed"
```

The server creates the certificate on first run. It is valid for **two
years**.

How it behaves:

- The server loads the same certificate on every start.
- It never checks the expiry date, never renews it, and never reloads it while
  running. It keeps serving it until you replace the files.
- The desktop client remembers ("pins") the certificate's fingerprint on first
  connect. If the certificate changes, the client shows a mismatch warning.

**An expired self-signed certificate keeps working.** This is tested, not
assumed. The server still serves it after its end date. The desktop app keeps
connecting, because it trusts the fingerprint, not the dates. The dates only
matter for public certificates, which a self-signed one never is.

Still, **replace it before the two years are up.** The Dashboard's attention
panel warns you three weeks ahead.

#### Rotating the self-signed certificate

The server cannot push a new fingerprint to clients. Rotation is a stop, a
file move, a start, and a message to every user:

1. Stop the server.
2. Move `data/cert.pem` and `data/key.pem` somewhere else. Do not delete them
   yet.
3. Start the server. It creates a new pair, because both files are missing.
4. Read the new fingerprint. It is in the start-up banner, on the admin
   Dashboard, and on the setup wizard's finish step.
5. Tell every member. **Every desktop client shows the certificate-mismatch
   warning and must accept the new fingerprint.**
   - Publish the new fingerprint somewhere else they trust, such as a post on
     another platform or a call.
   - Ask each person to **compare it, character for character, with the one
     their client shows** before accepting.
   - A mismatch looks exactly like someone intercepting the connection
     ([trust-model.md](trust-model.md)).

### Let's Encrypt (ACME)

> **For a domain, a reverse proxy is the recommended setup.** See
> [Reverse Proxy Topology](#reverse-proxy-topology). Built-in ACME works and is
> staying. But this project has not tested renewal across expiry, restart and
> rotation, so renewal is your responsibility. Caddy, nginx and Traefik are
> built for that job and far more widely used. Choose built-in ACME only if you
> would rather not run a proxy, and read the note on pinning below first.

ACME gets and renews a Let's Encrypt certificate automatically.

```yaml
tls:
  mode: "acme"
  domain: "chat.example.com"
  acme_cache_dir: "data/acme_certs" # where certificates are stored
```

What you need:

- Port 80 reachable from the internet, for the HTTP-01 challenge.
- A domain that points at this server. An IP address is refused. There is no
  HTTPS on a bare public IP in this build
  ([What this build does not do](port-forwarding.md#what-this-build-does-not-do)).

Certificates are stored in `acme_cache_dir`.

**The desktop client pins this certificate too.** Members see the same
first-use prompt in every TLS mode, so they compare the fingerprint once.
After that, a normal Let's Encrypt renewal is accepted without a prompt,
because both old and new certificates are publicly valid for your domain
([trust-model.md](trust-model.md)).

The admin Dashboard shows the fingerprint after the first HTTPS connection.
It shows the new one after each renewal. See
[Publishing the fingerprint after a renewal](#publishing-the-fingerprint-after-a-renewal).

### Manual Certificate

Use your own certificate files:

```yaml
tls:
  mode: "manual"
  cert_file: "path/to/cert.pem"
  key_file: "path/to/key.pem"
```

- The desktop pins this certificate too, in the same way.
- The files are read once, at start-up. After you replace them, restart the
  server.
- Keep the key file private, with file mode `0600`.

### TLS Off

```yaml
tls:
  mode: "off"
```

Use this **only** behind a reverse proxy that handles HTTPS
([Reverse Proxy Topology](#reverse-proxy-topology)). The desktop app only
connects over `wss://` (secure WebSocket). Without a proxy, it cannot connect
at all.

With TLS off, every connection to the server is plain HTTP. Passwords, tokens
and messages can be read by anyone on the path.
[trust-model.md](trust-model.md) says this plainly.

### Publishing the fingerprint after a renewal

The desktop client pins the certificate it sees. Members need the fingerprint
the first time they connect, and again whenever the certificate changes in a
way that prompts them.

When members are **not** prompted:

- A renewal from a public certificate authority (Let's Encrypt, directly or
  through a reverse proxy). This only holds if the certificate they first
  accepted was publicly valid for your domain.

When members **are** prompted ("Certificate Changed"):

- A new self-signed or private-CA certificate.
- Any change on a server reached by IP address.

The prompt asks them to get the current fingerprint from you through another
channel. Where to find it:

- **`self_signed`, `manual` and `acme`:** copy it from the admin Dashboard's
  **Certificate fingerprint** card. In `acme` mode it appears after the first
  HTTPS connection, and updates after each renewal.
- **`off` behind a reverse proxy:** the proxy serves the certificate, so
  OwnCord cannot read it. Run this on any machine with OpenSSL. Use your
  domain, and your HTTPS port if it is not 443:

  ```sh
  openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr 'A-F' 'a-f'
  ```

  It prints the fingerprint in the same lower-case form the app shows. Run it
  from outside your network if you can, so it sees what members see.

Post the fingerprint somewhere members already trust, such as another chat
platform or a call. Do not post it inside OwnCord: they cannot reach it until
they have accepted.

## Reverse Proxy Topology

A reverse proxy is a web server, such as Caddy, nginx or Traefik, that sits in
front of OwnCord and handles HTTPS for it.

OwnCord handles its own TLS by default, so a proxy is optional. **For a public
domain, a proxy is the recommended setup.** The proxy then gets and renews
certificates, which is the part this project has not fully tested (see
[Let's Encrypt (ACME)](#lets-encrypt-acme)). Caddy does this with nothing more
than your hostname. nginx and Traefik do it with certbot or their own ACME
support.

When the proxy handles TLS, set `tls.mode: "off"` on OwnCord.

### Keep port 8443 private

The server listens on every network interface. There is no setting to bind it
to one address. So with `tls.mode: "off"` you must make port 8443 reachable
only from the proxy:

- **Docker:** publish the port on loopback only (`127.0.0.1:8443:8443`). Or put
  the proxy on the compose network and remove the `ports:` entry. The supplied
  `Server/docker-compose.yml` publishes `8443:8443` on all interfaces, so you
  must change it.
- **Bare metal or VM:** add a host firewall rule that allows 8443 only from the
  proxy (loopback, if the proxy is on the same host). Do not forward 8443 on
  your router.
- **Check it:** with TLS off, port 8443 speaks plain HTTP. From another machine
  run the command below. It must fail to connect. If you get a reply, the port
  is still exposed.

  ```bash
  curl --max-time 5 http://<host>:8443/api/v1/health
  ```

**Pinning with a proxy.** Desktop clients pin the _proxy's_ certificate. If the
proxy uses a public certificate authority, its renewals are accepted without a
prompt. A self-signed or private-CA proxy certificate prompts on every change
([trust-model.md](trust-model.md)).

### What the proxy carries, and what it cannot

1. **What the proxy can carry.** Everything on port 8443: the REST API, the
   WebSocket at `/api/v1/ws`, the admin panel, uploads, **and LiveKit
   signalling**, which the server already forwards at `/livekit/*`. You do
   **not** need to expose LiveKit's port 7880 through the proxy.
2. **What the proxy cannot carry.** Voice and video media. That is UDP
   `50000-60000` (or the single UDP port if you set one, as the compose stack
   does with `7882`) plus the `7881/TCP` fallback. These must stay directly reachable on the host that runs
   LiveKit. An HTTP proxy never carries this traffic.
3. **Tell OwnCord about the proxy.** Set `server.trusted_proxies` to the
   proxy's own address or addresses, for example `["10.0.0.2/32"]`. OwnCord
   then reads each client's real address from `X-Forwarded-For`. It uses that
   address for rate limits, the admin allowlist, the access and WebSocket logs,
   and the `ws_connect` audit entry.
   - List only the proxy hops. Never list client networks.
   - A proxy on the same host is `["127.0.0.1/32", "::1/128"]`.
   - Without this, every request seems to come from the proxy. The server warns
     about this at start-up, and again on the first forwarded request.

A working nginx example:

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

### A CDN in front of the proxy

With a CDN such as Cloudflare in front of your proxy, each request passes two
hops. `server.trusted_proxies` must list every hop.

OwnCord reads `X-Forwarded-For` from the right. It takes the first address that
is not a trusted proxy. If you list only your reverse proxy, that address is the
CDN server that connected to it. Many users share one CDN server. Per-address
rate limits and lockouts would then hit everyone coming through it.

Do one of these:

- **List the CDN's ranges in OwnCord.** Add Cloudflare's published IPv4 and
  IPv6 ranges ([cloudflare.com/ips](https://www.cloudflare.com/ips/)) next to
  your proxy. Update them when Cloudflare changes the list.

  ```yaml
  server:
    trusted_proxies:
      - 172.17.0.1/32 # the reverse proxy (here Docker's bridge gateway)
      - 173.245.48.0/20 # ...then one entry per Cloudflare range
  ```

- **Let the proxy restore the client address.** In nginx (in Nginx Proxy
  Manager, the proxy host's Advanced tab), take the address from Cloudflare's
  header, but only for connections from a Cloudflare range. Keep
  `trusted_proxies` at your proxy alone. `$proxy_add_x_forwarded_for` then adds
  the real client address:

  ```nginx
  real_ip_header CF-Connecting-IP;
  set_real_ip_from 173.245.48.0/20;   # one line per Cloudflare range
  ```

## Backup Strategy

**The built-in backup covers the database only.** A full restore needs the
whole `data/` folder plus your `config.yaml`. The admin panel's
[full archive](#the-full-archive) gives you all of it in one download.

The simple rule: **copy `data/` as a whole, plus `config.yaml`, on the same
schedule as your database backups.** Not only before an upgrade.

Restore and rollback are different things. Putting yesterday's database back
is a [Restore](#restore). Going back to an older version after an upgrade is
[Rolling back](#rolling-back). They cost different things and have separate
procedures.

### What each file is for

If you copy files one by one anyway, here is what each one does, and what you
lose without it:

- **The database backup** (from `POST /admin/api/backup`). Without it, your
  only copy of the database is a plain file copy that nothing has checked. The
  backup is checked with SQLite's `integrity_check` when it is written. It is
  checked again before it may replace a live database. The admin panel can put
  it back by itself. See [Admin Backup Endpoint](#admin-backup-endpoint).
- **`data/uploads/`** holds every attachment. Without it, messages still show
  their attachments, but downloading one returns 404. The database backup
  never includes this folder.
- **`data/totp.key`** unlocks every user's two-factor (2FA) secret. Without it,
  **every 2FA user is locked out**, and their recovery codes do not help.
  - The stored 2FA secrets are encrypted with this key.
  - A server that cannot find the file makes a new one and starts normally.
    The old secrets can then never be decrypted.
  - Login decrypts the secret _before_ it looks at the code you typed. So it
    fails before it ever reaches the recovery-code check.
  - No admin action or command clears a user's 2FA. Turning 2FA off needs a
    signed-in session, which is exactly what the user cannot get.
  - The only way back is to restore this file from your archive.
- **`data/erasure.key`** lets the server recognise accounts that were erased.
  Each deletion record names its account through this key. Without it, the
  records name no one, and a restore can bring erased accounts back.
- **`data/erasure/markers.sqlite`** is the deletion record file. Losing it is
  worse than losing the key:
  - It stores counters that stop an erased account's ID from being handed out
    again. Without them, a new user could get that ID and then be erased by the
    old record.
  - It keeps first-run setup closed when you restore a backup taken before the
    Owner account existed.
  - The server refuses to use a file that does not match. You then have to fix
    it by hand. Deleting files does not get you out.
- **`data/push_vapid.key`** signs push notifications. Without it, every push
  subscription stops working. The maintenance sweep removes them, and every
  device has to subscribe again before it gets pushes.
- **`config.yaml`.** Without it, the server starts on built-in defaults: port
  8443, self-signed TLS, and new random LiveKit credentials. New credentials
  break every voice token.
  - It does **not** change a self-signed certificate. That mode reuses the
    existing `data/cert.pem` and `data/key.pem`, and those are in the archive.
  - Clients lose their pinned certificate only if the lost config said
    `tls.mode: acme` or `manual`. The server then falls back to a different,
    self-signed certificate.
- **`data/config-overrides.json`** holds the settings saved from the admin
  panel's **Server configuration** page. Without it, those keys go back to
  `config.yaml` and `OWNCORD_*` values at the next start. A restore silently
  undoes them (see
  [Server Configuration](server-configuration.md#changing-settings-from-the-admin-panel)).

None of these files are in a database backup. All of them except `config.yaml`
live under `data/`, which is why copying `data/` whole covers them.

### SQLite WAL Considerations

The database runs in SQLite's WAL (write-ahead log) mode. **Do not copy the
`.db` file while the server is running.** The copy may be inconsistent. Use
the backup endpoint instead, or stop the server first.

The size of the write-ahead log file is `db_wal_mb` in `GET /api/v1/metrics`
(`owncord_db_wal_bytes` in the Prometheus output). It rises under heavy writes
and falls when SQLite checkpoints; a value that keeps climbing is worth a look.
On every start the server also logs one `db: migration applied` line per
migration it ran, with the time in milliseconds, then a `db: migrations
applied` summary, so a slow upgrade can be traced to the migration behind it.

### Admin Backup Endpoint

All of these are Owner-only.

| Endpoint                            | Method | What it does                                                    |
| ----------------------------------- | ------ | --------------------------------------------------------------- |
| `/admin/api/backup`                 | POST   | Create a new backup                                             |
| `/admin/api/backups`                | GET    | List all backups, newest first                                  |
| `/admin/api/backups/{name}`         | DELETE | Delete a backup                                                 |
| `/admin/api/backups/{name}/restore` | POST   | Restore a backup (takes a safety copy first)                    |
| `/admin/api/backups/{name}/link`    | POST   | Get a short-lived, single-use download link for one backup      |
| `/admin/api/archive`                | GET    | Download the full archive (database, `data/` and `config.yaml`) |
| `/admin/api/archive/link`           | POST   | Get a short-lived, single-use download link for the archive     |

**Where backups go.** Backups are saved with a timestamp in `backup.dir`
(default `data/backups/`). Point it somewhere safer than the data volume:
another disk, or a folder that is copied off the machine (rsync, rclone, a
synced folder). Then a single disk failure cannot take both your data and your
backups.

```yaml
backup:
  dir: "/mnt/backup-disk/owncord"
```

Under the shipped systemd unit, also add that folder to `ReadWritePaths`. See
[Running as a Linux Service](#running-as-a-linux-service-systemd). Without it,
backups to that folder fail.

**How a backup works:**

- It uses SQLite's `VACUUM INTO` on a read connection. Chat keeps working while
  it runs.
- The file only appears under its final name once it is complete. A backup
  that is killed half-way leaves a `.tmp` file. It is never offered for
  restore, and maintenance deletes it once it is a day old.
- Each backup is checked with `integrity_check` right after it is written. A
  failed backup is deleted, never listed.
- Backups are readable only by the server's user (mode `0600`). A job that
  copies them elsewhere must run as that user or change the permissions.
- The server logs `duration_ms` for each backup, so you can see if backups get
  slower over time.

### Scheduled Backups

The admin panel's **Backups & restore** page has two settings:

- **Automatic backups:** off, daily or weekly.
- **Keep backups for (days):** `0` keeps them forever. Otherwise 7 to 3650
  days.

Only the Owner can see that page and change them. The server's maintenance
loop applies them, checking every 15 minutes:

- A scheduled backup runs when the newest backup is older than the schedule.
  A manual backup resets the clock too.
- Old backups are deleted after the number of days you set. The newest backup
  is always kept, so a schedule that stopped can never delete your last copy.
- Safety copies (`pre_restore_*`, `pre_migrate_*`) are not affected by the days
  setting. The server keeps the newest 3 of each kind and deletes older ones
  after it writes a new one. It never deletes the copy it just wrote or the
  backup being restored. Copy one elsewhere if you need to keep it longer.

### The full archive

A database backup alone is not a complete restore. It does not include
uploads, the key files or `config.yaml`. **Download full archive** on the
**Backups & restore** page gives you one zip with all of it:

- the database, as a consistent `VACUUM INTO` snapshot
- the whole data folder: uploads, `totp.key`, `erasure.key`,
  `erasure/markers.sqlite`, `push_vapid.key` and TLS files
- `config.yaml`

Details:

- An `upload.storage_dir` outside the data folder is still included, as
  `data/uploads/`.
- Stored backups (`backup.dir`) are left out.
- The archive is built inside `backup.dir` before it is sent. That volume
  needs free space of about the data folder's size plus the database again. If
  building it would leave less than `server.min_free_disk_mb` free, the server
  refuses.
- Only the Owner can download it, because it contains password hashes and the
  key files.
- Only one archive is built at a time. A second request during a build is
  refused.

**How the download works.** The panel asks the server for a single-use link and
opens it as a normal download. The browser saves the archive straight to disk,
so its size is not limited by the page's memory.

- The link is random, single-use, tied to the Owner, and expires within a
  minute.
- The download must finish within 2 hours. For a very large server on a slow
  link, take the archive by hand instead (see
  [Before upgrading: take the archive](#before-upgrading-take-the-archive)). Or
  rely on a database backup, which `chatserver restore` can put back.
- The build starts when the browser opens the link. So if there is not enough
  free space, you see a failed download in the browser, not a panel message.

The database part is a consistent snapshot even while the server runs. But
other files are copied while chat is still writing. When you can, prefer the
stop-the-server procedure in
[Before upgrading: take the archive](#before-upgrading-take-the-archive).
Either way, keep the download off the server machine.

### Backups taken automatically before an upgrade

An upgrade leaves database migrations waiting to run. This includes a Docker
`docker compose pull`. When the server starts with migrations waiting, it
**first** takes a database backup. So a schema change is never made without a
backup.

- The copy is named `pre_migrate_<first-migration>.db`, in `backup.dir`. If
  that name is taken, it adds `_2`, `_3` and so on, so an earlier copy is never
  overwritten.
- It is checked with `integrity_check`.
- It is not removed by the days setting; the newest 3 `pre_migrate_*` copies are kept.
- If the server cannot write it, it refuses to start rather than migrate
  without it.
- If the database has not changed since the last copy for that migration (for
  example, a migration that fails on every start), the server reuses that copy.

This protects the database only, not your uploads or keys. For a complete
rollback, also take the full
[archive](#before-upgrading-take-the-archive).

### Scheduling backups from outside the server

You can also trigger backups from your own scheduler, such as cron. The admin
API accepts **Bearer tokens only**, not a browser login. So first create an API
token on the server:

```bash
# On the server host. --label is required. The token belongs to the Owner
# account and never expires, unless you add --user or --expires (e.g. 720h).
./chatserver token create --label backup
# Prints the raw token ONCE. Store it now: it can never be shown again.
```

Put the token in `OWNCORD_TOKEN` and schedule the call.

**Linux cron:**

```bash
# Nightly at 03:00 via the admin API token
0 3 * * * curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" https://localhost:8443/admin/api/backup
```

**Windows Task Scheduler with PowerShell** (the same Bearer header):

```powershell
$headers = @{ "Authorization" = "Bearer $env:OWNCORD_TOKEN" }
Invoke-RestMethod -Uri "https://localhost:8443/admin/api/backup" -Method POST -Headers $headers -SkipCertificateCheck
```

Manage tokens with `./chatserver token list` and
`./chatserver token revoke <id|label>`.

### Restore

In the admin panel, **Restore** asks you to type the backup's file name. It
then waits for the restart and reloads the page.

What happens, in order:

1. The server checks the backup with `integrity_check` and refuses a broken
   one.
2. It writes a `backup_restore` audit entry.
3. It takes a `pre_restore_<time>.db` safety copy. If that fails, it stops
   before changing anything.
4. It copies the backup next to the database as `<database>.restore-staged`,
   checks the copy, and writes `<database>.restore-pending.json` last. If the
   copy cannot be written (the volume is full, say) it stops and the server
   keeps running unchanged.
5. It restarts through the normal shutdown, which tells connected clients to
   reconnect. The running database is not written to.
6. On the next start, before the database opens, the server moves the old
   database aside, puts the staged copy in its place and checks it. If the
   check fails, it puts the old database back and carries on with it. Either
   way the Dashboard's attention panel shows the outcome and the audit log
   records it. A power
   cut or crash in the middle of the swap is finished at the next start.

If the restart never comes (the server is stopped by hand, or no supervisor
restarts it), the staged restore waits and is applied at the next start. To
cancel it before then, delete `<database>.restore-pending.json`.

While a staged restore is pending, command-line tools that open the database
(`chatserver token`, `chatserver restore`) refuse to run and tell you to start
the server so it can finish the restore.

The check at the swap covers the file's integrity only. If the restored database
then fails to migrate, the server does not start, and the way back is the
`pre_restore_<time>.db` safety copy in the backups folder, not the automatic
rollback.

How it restarts depends on `server.restart_mode`. With `supervised`, which
`auto` chooses under systemd, NSSM and containers, the server exits cleanly
and the supervisor starts it again. The shipped `docker-compose.yml` sets
`restart: unless-stopped` for this reason ([Upgrading](#upgrading)).

On the first start after a restore, the server replays every deletion recorded
since the backup was taken, before it serves anyone
([data-lifecycle.md](architecture/data-lifecycle.md)). This is why the marker
file and `erasure.key` must travel with the backup.

**A restorable install is a set of files, not one file.** The backup file is
the database only. Everything the database points at must travel with it: the
uploads, the three key files, and the marker file. The list is in
[What each file is for](#what-each-file-is-for).

What a restore cannot bring back:

- uploads, because they are never in the backup
- anything that happened after the backup: accounts, messages, settings and
  bans created since then are gone

Two things that were tested, because both are easy to get backwards:

- **Restore without `data/erasure/markers.sqlite`:** every account erased since
  that backup comes back, and nothing removes it again. The server still
  starts, but logs an `ERROR` about the missing erasure history. It only checks
  this when the key file exists, so a first start says nothing. If your key is
  in `OWNCORD_ERASURE_KEY` instead of a file, the check stays silent too.
- **Restore without `data/erasure.key`:** the server **refuses to start** and
  says why. This is on purpose. Without the key, the deletion records cannot
  name anyone, so the server cannot match the database to its own deletion
  history.

The rules for the marker file, and the two refusals it can cause at start-up,
are in [security.md](security.md#erasure-marker-key).

### Restoring without a running server

The admin panel's restore needs a running server. When the server will not
start, for example after a failed migration or with a corrupt database, you
have two offline options:

- `chatserver restore` puts a database backup back.
- Restoring the archive puts back the whole state from before the failure.

**Option 1: a database backup, with `chatserver restore`.** This does what the
admin panel does, without the panel.

1. Stop the server. The command refuses while the server is running, because
   the server holds a lock on the database.

   ```bash
   sudo systemctl stop owncord          # or: docker compose down
   ```

2. Run the restore. Without `--force` it changes nothing and explains what it
   would do. With `--force` it takes a `pre_restore_*` safety copy, then
   replaces the live database.

   ```bash
   ./chatserver restore --force /path/to/chatserver_20260101_030000.db
   ```

   In Docker, the image's entry point is the binary and its working folder is
   `/app`. So run it in a one-off container on the same volume. Name the backup
   by its path inside the volume:

   ```bash
   docker compose run --rm --no-deps owncord restore --force data/backups/chatserver_20260101_030000.db
   ```

3. Start the server again.

Before it touches the live database, the command checks that:

- the file is a readable database
- a newer server version did not write it
- its `-wal` file holds no unsaved changes, because only the main file is
  copied

It also keeps the message-retry cutoff and the event sequence floor
(`chatserver.db.ws-seq-floor`, a file beside the database: carry it along if you
move a data folder by hand, or restore another machine's backup to move a server), and uses the same `database.path` and
`backup.dir` from `config.yaml` as the server.

If the live database is too broken to copy, the command moves it aside with
its `-wal` and `-shm` files, as `chatserver.db.pre_restore_<time>`, and prints
where.

This restores the database only. If uploads, key files or `config.yaml` changed
too, use the archive instead.

**Option 2: the whole state, from an archive.** Put back everything from
before the failure, then run the same version that wrote it.

1. Stop the server if it is still running (`sudo systemctl stop owncord`, or
   `docker compose down`).
2. Find your pre-upgrade archive, from
   [Before upgrading: take the archive](#before-upgrading-take-the-archive). It
   holds `data/`, `config.yaml`, and the binary you are going back to. If the
   upgrade caused the failure, this archive is your rollback.
3. **Replace, do not merge.** Remove the live `data/` folder and copy the
   archive's one back. For Docker, empty the volume rather than copy into it.
   The archive carries `config.yaml`, `data/erasure.key`,
   `data/erasure/markers.sqlite` and the other key files, which a database
   backup does not.
4. Start the server and check that it works.

**If you only have a database backup file** and no archive, you can still put
it back by hand:

1. Stop the server.
2. Move the current `data/chatserver.db` aside as your own safety copy.
3. Copy the backup file in its place. This is safe, because a backup is a
   consistent snapshot, unlike a live copy under WAL.
4. Start the server.

Only do this with the matching `data/erasure/` files in place. Without the
marker file, the server can serve an account that was erased after the backup
was taken ([Restore](#restore)). The full archive is the supported path. A
database file alone is the fallback.

## Storage growth

Most of what the server writes lives under `data/` next to the binary. But
**`server.data_dir` is not the root of everything.** It holds the key files,
the erasure marker store and the managed LiveKit binary. The database, uploads,
backups and TLS files each have their own setting, with its own `data/...`
default. If you move one, the others do not follow.

This table lists what each path holds, what limits its size, and what deletes
old data:

| Path                                        | Written by                                                                | Size limited by                                                                                       | Cleaned up by                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `chatserver.db` + `chatserver.db-wal`       | every feature                                                             | messages: the server's or a channel's retention window (`0` = keep forever); stored events: 24 hours  | the retention sweep (up to 5,000 messages per run); the event pruner, every 60 minutes; the WAL after an erasure  |
| `uploads/`                                  | attachments, avatars, emoji, and a preview of large images (`thumbs/`)    | `upload.max_size_mb` per file (default 100); `upload.user_quota_mb` per user (default `0` = no limit) | the orphan sweep (files unlinked for over 1 hour), retention, erasure, and reconciliation (up to 500 files a run) |
| `backups/`                                  | manual and scheduled backups, and `pre_restore_*.db` / `pre_migrate_*.db` | **Keep backups for (days)** on the **Backups & restore** page                                         | retention; it always keeps the newest backup and keeps the newest 3 `pre_restore_*` and 3 `pre_migrate_*` copies  |
| `acme_certs/`                               | `tls.mode: acme` only                                                     | one certificate for your domain                                                                       | the ACME client handles renewal                                                                                   |
| `livekit/`                                  | `voice.auto_download_livekit`                                             | one pinned LiveKit release                                                                            | never; delete the file to force a fresh download                                                                  |
| `plugins/`                                  | plugins, in builds made with `-tags wazero`                               | whatever the plugins write                                                                            | never                                                                                                             |
| `cert.pem`, `key.pem`                       | first run, `tls.mode: self_signed`                                        | one TLS pair                                                                                          | never; replacing them is [rotation](#rotating-the-self-signed-certificate)                                        |
| `totp.key`, `erasure.key`, `push_vapid.key` | first run                                                                 | three small files                                                                                     | never, and they must never be: losing one is permanent (see [Backup Strategy](#backup-strategy))                  |
| `erasure/markers.sqlite`                    | every account erasure and every swept channel                             | one row per erased account or swept channel                                                           | never; it stays small                                                                                             |

Four things the table cannot show:

- **The audit log is never pruned.** No maintenance step touches it, because
  it is the tamper-evident record. On a busy server it grows slowly, for the
  whole life of the server.
- **Message retention is off by default.** `settings.retention_days` is `0` on
  new and upgraded servers. Messages grow without limit until the Owner sets a
  window in the admin panel. The **Message retention** section, backed by
  `GET /admin/api/retention/preview`, shows exactly which messages a window
  would delete before it runs. Pinned messages and direct messages are never
  swept.
- **Report content and moderation actions expire on their own.**
  `moderation.report_retention_days` is 180 days and
  `moderation.action_retention_days` is 90. The first covers a closed report's
  content. The second covers warning and timeout entries after they are
  acknowledged or expire. Ban, kick and removal entries are never touched.
- **The disk floor.** Everything above shares one volume with the database's
  WAL. Below `server.min_free_disk_mb` free, the server stops accepting uploads
  and `/health` reports `degraded` with reason `disk`. Messages keep flowing.
  What each stage of a filling disk looks like, and how to recover, is under
  [Health Endpoint](#health-endpoint).

## Upgrade and Rollback

An upgrade replaces the binary (or the Docker image). Nothing else in the
install folder changes.

A **rollback** means restore, then downgrade. You put the pre-upgrade copy
back, then run the old version on it.

**Migrations only go forward.** You cannot run an older binary on a database a
newer one has already migrated. The server refuses to start on such a database,
because doing it anyway is how you lose it. So **the copy you take before
upgrading is the only complete rollback that exists.** The server's own
[pre-migration copy](#backups-taken-automatically-before-an-upgrade) holds the
database alone.

There are hand-run reversal scripts in `Server/rollback/`. They exist to
rehearse undoing one specific migration, not as an upgrade path. See
[`Server/rollback/README.md`](../Server/rollback/README.md).

### Before upgrading: take the archive

Take it with the server **stopped**. The archive copies `data/chatserver.db`
as a plain file, and a plain copy of a running WAL database is not consistent
(see [SQLite WAL Considerations](#sqlite-wal-considerations)).

**Standalone install:**

```bash
# 1. Back up while the server is still running. The backup is checked with
#    integrity_check and lands in data/backups/, inside the copy at step 3.
curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" \
  https://localhost:8443/admin/api/backup

# 2. Stop the server. Really stop it.
sudo systemctl stop owncord          # or: nssm stop OwnCord

# 3. Copy the state to another disk, not into the folder you are upgrading.
#    The destination must exist: cp with two sources will not create it.
sudo mkdir -p /mnt/backup-disk/owncord-pre-upgrade
sudo cp -a /var/lib/owncord/data /var/lib/owncord/config.yaml \
  /mnt/backup-disk/owncord-pre-upgrade/

# 4. Keep the binary you are upgrading FROM. Without it, step 3 is only half a
#    rollback -- see "Rolling back" below.
sudo cp -a /opt/owncord/chatserver \
  /mnt/backup-disk/owncord-pre-upgrade/chatserver-previous
```

**Docker:** `data/` lives in the named volume, but `config.yaml` does not. The
compose file mounts it from the host. So you must copy both, separately:

```bash
# 1. Back up, then stop. `down` also frees the volume for step 3.
curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" \
  https://localhost:8443/admin/api/backup
docker compose down

# 2. The host's config.yaml. Also record the image you are upgrading FROM:
#    without it there is nothing to roll back to.
mkdir -p /mnt/backup-disk/owncord-pre-upgrade
cp config.yaml /mnt/backup-disk/owncord-pre-upgrade/config.yaml
docker image inspect ghcr.io/j3vb/owncord-server:latest \
  --format '{{index .RepoDigests 0}}' > /mnt/backup-disk/owncord-pre-upgrade/image

# 3. The volume, through a throwaway container -- the only way to read a named
#    volume from the host. alpine, because the OwnCord image has no shell and
#    no `cp`. The rm -rf stops a re-run from nesting the copy inside the old one.
rm -rf /mnt/backup-disk/owncord-pre-upgrade/data
docker run --rm \
  -v server_owncord-data:/app/data:ro \
  -v /mnt/backup-disk/owncord-pre-upgrade:/archive \
  alpine cp -a /app/data /archive/data
```

`server_owncord-data` is the name Compose gives the `owncord-data` volume when
it runs in `Server/`: the project name plus the volume name. Run
`docker volume ls` to check yours.

**Copy `data/` as a whole, not a list of file names.** A newer version may add
files to it, and a hand-written list silently misses them. What each file is
for is in [What each file is for](#what-each-file-is-for).

### Performing the upgrade

**Standalone:** replace the binary and start it again. Nothing else changes.
No folder is renamed and no configuration is rewritten. The new version
migrates the database on its first start.

```bash
sudo systemctl stop owncord
sudo install -o root -g root -m 0755 ./chatserver /opt/owncord/chatserver
sudo systemctl start owncord
```

The admin panel's in-place update does the same swap for you, including the
hand-off to your supervisor. See [Auto-Update](#auto-update). Its dialog backs
up the database first unless you untick that box. That copy is the database
only, so take the archive first either way.

**Docker:** `docker compose pull && docker compose up -d`. Container details
are under [Upgrading](#upgrading) in the Docker section.

**Upgrade the server before the clients.** Desktop clients get their updates
from the server they connect to. The server only offers client releases whose
protocol it can speak itself (`docs/protocol.md`, Compatibility).

- A release that changes the protocol reaches your users only after the server
  runs it.
- Releases that do not change the protocol reach them either way.
- A client that is already too old for the server shows "update the client"
  on its connect screen, with an **Update Now** button.

**Rehearsing an upgrade.** You do not need a copy of a real server's database.
`Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` is an anonymised test
database shaped like a month-old server (see the README beside it).
`Server/db/alpha_snapshot_test.go` checks on every test run that current
migrations still apply to it cleanly.

### Rolling back

**Everything written after the archive was taken is lost.** That includes
messages, uploads, accounts, settings, and every backup made since. Nothing in
the procedure avoids this. The only thing you control is how recent the
archive is.

You also need the version you are going back **to**. Keep the binary, or the
image tag, that you upgraded from. GitHub Releases usually still has it. But an
in-place self-update leaves nothing on disk: it renames the old binary to
`.old-*`, and the new one deletes that. A withdrawn release, or a machine with
no internet, leaves you with no rollback at all. Step 4 of the archive above is
that copy.

**Standalone:**

```bash
sudo systemctl stop owncord
sudo rm -rf /var/lib/owncord/data
sudo cp -a /mnt/backup-disk/owncord-pre-upgrade/data /var/lib/owncord/data
sudo cp /mnt/backup-disk/owncord-pre-upgrade/config.yaml /var/lib/owncord/config.yaml
sudo chown -R owncord:owncord /var/lib/owncord
sudo install -o root -g root -m 0755 /mnt/backup-disk/owncord-pre-upgrade/chatserver-previous \
  /opt/owncord/chatserver
sudo systemctl start owncord
```

**Replace `data/`. Never merge into it.** The newer version can write files the
archive does not know about. For example, upgrading out of alpha.4 adds
`data/erasure.key`, `data/push_vapid.key` and `data/erasure/`. Copying over the
top leaves them behind. The result is half one version and half the other, a
state no release was ever tested in. Remove the folder first, then restore.

**Docker:** the same steps, except you must empty the volume rather than copy
into it. Copying into a volume can only add files.

```bash
docker compose down
docker volume rm server_owncord-data
docker volume create server_owncord-data

# Restore into the empty volume, owned by the image's user ID -- alpine again,
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

**The admin panel's backup restore is not a rollback.** It puts a database back
under **the version that is running**, which migrates it forward again
straight away. See [Restore](#restore). Going back a version means the
procedure above, and only that.

### How this procedure is checked

Both the upgrade and the rollback are run automatically, not just described.

`Server/cmd/smoke` takes the newest published release through exactly this
sequence: fill with data, stop, archive, upgrade, check, stop, restore,
downgrade, check the rollback. It does this in both shapes owners use: two
binaries in one install folder, and two images on a named volume.

- The standalone run happens on **every pull request**, inside the server
  build job in `ci.yml`.
- `.github/workflows/upgrade-rehearsal.yml` runs both shapes nightly, on
  demand, and from the release workflow before anything is published. A failed
  rehearsal stops the release.

What it checks across the upgrade:

- `config.yaml`, every key file, and every file under `data/uploads/` are
  byte-for-byte unchanged
- every pre-upgrade backup is still listed
- an attachment uploaded before the upgrade still downloads unchanged
- a login session from before the upgrade still works as the same Owner
- the reported version changes, then changes back after the rollback
- the old binary still stops cleanly on the restored install

Two things it does **not** cover:

- **ARM64 upgrades are not rehearsed.** `v1.2.0-alpha.4` had no ARM64 server
  asset, so there is no older ARM64 release to upgrade from. ARM64 assets do
  get the per-architecture lifecycle check (see
  [Building from Source](#building-from-source) and
  [Docker](#docker-linux)): start, migrate, stop, restart. They do not get an
  upgrade from a previous release. That becomes possible one release after the
  ARM64 assets ship.
- **In Docker, the `config.yaml` check is weaker.** Compose mounts the file
  read-only, so nothing in the container can rewrite it (see
  [config.yaml for Docker](#configyaml-for-docker)). The check catches an
  in-place edit. But the way the server really saves its config, a rename over
  the file, is refused by the system on a single-file mount anyway. The
  standalone run is the one that proves an upgrade leaves `config.yaml` alone.

## Capacity limits

What one server can carry on which hardware is in
[Capacity](capacity.md#sizing-for-10002000-online). That page also has an
measured 1,000-online result (steady chat holds; a login burst and a
full reconnect herd miss some of their budgets) and an estimate, not measured,
for 2,000 people online.

The tested profile is **250 registered users, 100 connections at once and 25
voice sessions at once, on 2 vCPU and 4 GB RAM**. See
[The profile](capacity.md#the-profile) and
[Reference hardware](capacity.md#reference-hardware).

These are the limits you set. Each item shows the default, what users see when
you hit it, and the metric in `GET /api/v1/metrics` that warns you:

- **`server.max_ws_connections`** (default `0` = no limit). New WebSocket
  connections are refused with `503` until others close. Metric:
  `ws_conn_rejects` above zero means you hit it.
- **`database.max_readers`** (default `0` = automatic, which is
  `max(8, 2 × CPU count)`, kept between 1 and 64). Read queries queue up. Metric:
  `db_reader_wait_seconds` growing.
- **`upload.max_size_mb`** (default `100`). A larger file is refused with
  `400 BAD_REQUEST`, or `413 PAYLOAD_TOO_LARGE` when the whole request is over
  the limit.
- **`upload.user_quota_mb`** (default `0` = no limit). An upload past a user's
  quota is refused with `507 STORAGE_QUOTA_EXCEEDED`. Metric:
  `upload_storage_used_mb` shows the total.
- **`server.min_free_disk_mb`** (default `256`). Uploads are refused with
  `507 STORAGE_LOW_DISK`, and `/health` reports `degraded` with reason `disk`.
  Metric: `disk_low`.
- **`security.auth_rate_limit_multiplier`** (default `1.0`). Logins and
  WebSocket connections are refused with `429 RATE_LIMITED`. The defaults
  assume about one person per IP address. Raise it for a community that shares
  one internet connection, such as an office or school.

How to read these and the other growth signals is under
[Metrics Endpoint](#metrics-endpoint). That list is the one to alert on.

### Open-file limit (file descriptors)

Every WebSocket connection uses one file descriptor. So the number of people
online at once is capped by the process's open-file limit (`RLIMIT_NOFILE`).

There are two limits, soft and hard. At start-up the server raises its soft
limit up to the hard limit and logs the result under `open-file limit`. So the
**hard** limit is what matters. Your supervisor or shell sets it.

The risk is a low hard limit, such as a plain `ulimit -n 1024` or an old
default of 1,024. That is enough for a small community, but not for 1,000 to
2,000 people, who need about 2,100 descriptors.

How to set it:

- **systemd:** `LimitNOFILE=65536` in the unit (the shipped
  [`deploy/owncord.service`](../deploy/owncord.service) sets it), or
  `infinity`. `systemctl edit owncord` changes it without editing the file.
- **Docker Compose:** `ulimits.nofile` on the `owncord` service. The shipped
  `Server/docker-compose.yml` sets 65,536. Without it, the hard limit is
  whatever the Docker daemon passes down, which can be as low as 1,024.
- **Plain binary or another supervisor:** set the soft and hard limits with
  `ulimit -n` (or your supervisor's equivalent) before the server starts.

The server also warns at start-up when the limit is below
`2 × max_ws_connections + 256`. That is two descriptors per connection, for
headroom, plus a fixed allowance for the database, LiveKit, TLS and the rest.
With `server.max_ws_connections` unset (no limit), the server plans for 2,000
online: 4,256. So a server started under `ulimit -n 1024` either raises the
limit or warns you, naming this setting. It never fails silently at 1,000
connections.

## Monitoring

### Logs

The server writes its log to **standard output** (stdout), as `slog` text. It
also keeps the last 10,000 lines in memory for the admin panel's live log view.
There is no log file and no rotation inside the server. So where the log ends
up depends on your supervisor:

| Supervisor      | Where the log goes                             | How to read it                                                                         |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| systemd (Linux) | the journald journal                           | `journalctl -u owncord -f`. journald's settings decide how long it is kept             |
| Docker          | Docker's `json-file` log driver on the host    | `docker compose logs -f owncord`. The shipped compose file keeps 3 files of 10 MB each |
| NSSM (Windows)  | **nowhere**, unless you set `AppStdout/Stderr` | the file you set in `AppStdout`. See [Option 1: NSSM](#option-1-nssm)                  |

**Log level.** `logging.level` sets how much is logged: `debug`, `info`,
`warn` or `error`. The default is `info`. `OWNCORD_LOGGING_LEVEL` overrides it
without editing `config.yaml`. An administrator can also switch a running
server to `debug` for a while from the admin panel's **Logs** page
([server-configuration.md](server-configuration.md#logging-logging)).

**Saved logs.** The server also keeps the last 7 days (at most 200 MB) of its
log under `<data_dir>/logs`, searchable from the **History** tab of the
**Logs** page. `logging.history_days` and `logging.history_max_mb` change
that; `logging.history_days: 0` turns it off.

**LiveKit's log.**

- When OwnCord runs LiveKit itself, LiveKit's lines appear in the same log, as
  `livekit companion output` entries. They have `component=livekit`, and
  LiveKit's own text in the `line` attribute.
- An external LiveKit, including the Docker `livekit` container, logs only to
  its own output. Read it with `docker compose logs livekit`, or wherever its
  supervisor puts it. It is not in the admin live log or the support bundle.

**Log format.** A line looks like `time level msg key=value ...`. Every line
from a web request carries a `req_id`, so you can tie it back to that request.

**What is never in the log.** The LiveKit API key and secret, the GitHub token
and the GIF API key are always hidden, however they reach a log line.

**What is in the log.** At `info` level, usernames, IDs and client addresses
appear. So a copied log excerpt is personal data. Treat it that way when you
attach it to an issue. The support bundle leaves raw log lines out for this
reason.

The admin panel's live log view shows the same lines at the same level. See
[Diagnostics](#diagnostics) below.

### Health Endpoint

`GET /health` is public and needs no login. (`/api/v1/health` is the same.)

```json
{
  "status": "ok",
  "uptime": 86400,
  "online_users": 12
}
```

`status` is a real check, not a fixed value. The server checks three things:

- its own WebSocket dispatch loop is alive
- a quick `SELECT 1` against the database succeeds within 1 second
- there is enough free disk space on the data volume

If any check fails, the endpoint returns HTTP `503` with `"status":
"degraded"` and a `reason` field: `hub`, `database` or `disk`. It gives no more
detail, because anyone can call it.

Results are cached for 5 seconds, so frequent polling does not load the
database. Point your uptime monitor or container health check here, and treat
any `503` as a problem to act on.

This endpoint does **not** check voice. See
[Monitor voice as well as liveness](#monitor-voice-as-well-as-liveness).

The server version is deliberately left out of this public endpoint, so
outsiders cannot easily tell which version you run.

**Disk space, in three stages.** The check compares free space on the volumes
the server writes to with `server.min_free_disk_mb`. The default is 256 MiB.
`0` turns the check off (see
[server-configuration.md](server-configuration.md)). All three stages were
tested on a disk that was really filled:

| Free space                 | `/health`                                           | Everything else                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Above the floor            | `200` `ok`                                          | Normal.                                                                                                                                                                                                                                                              |
| Below the floor            | `503` `degraded`, `"reason": "disk"`                | Uploads and other writes that need space are refused with `507 STORAGE_LOW_DISK`. **Messages still flow.** A backup still runs. It is either refused or produces a file that passes `integrity_check`, never a partial one.                                          |
| Completely full (`ENOSPC`) | `503` `degraded`, `"reason": "disk"`, still answers | Database writes are refused, each with an error reply, and the log says `database or disk is full`. **The server does not exit.** Free some space (delete junk, grow the volume, move `backup.dir`). Chat, uploads and `/health` then recover **without a restart**. |

The floor is spare room kept for uploads. It does not limit messages. A server
below its floor still accepts chat, so a full disk does not become a silent
outage. If you set the floor lower than your database grows, you will end up in
the third stage as normal.

### Metrics Endpoint

`GET /api/v1/metrics` is limited by IP address. It accepts the addresses in
`server.metrics_allowed_cidrs`. If that is empty, it uses
`server.admin_allowed_cidrs`.

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
  "reconnect_ring_misses": 3,
  "backpressure_queue_disconnects": 0,
  "backpressure_high_fallbacks": 0,
  "backpressure_low_drops": 17,
  "backpressure_presence_drops": 0,
  "delivery_loss_marks": 0,
  "ws_conn_rejects": 0,
  "disk_free_mb": 51200.5,
  "disk_min_free_mb": 256,
  "disk_low": false,
  "upload_storage_used_mb": 3072.25,
  "db_wal_mb": 4.2,
  "db_writer_wait_count": 3,
  "db_writer_wait_seconds": 0.021,
  "db_reader_wait_count": 11,
  "db_reader_wait_seconds": 0.004,
  "perm_cache_hits": 5120,
  "perm_cache_misses": 84,
  "push_dispatched": 0,
  "push_failed": 0,
  "push_pruned": 0,
  "event_persister": { "persisted": 4021, "dropped": 0, "flushes": 311, "errors": 0 }
}
```

The response also carries a `windows` block with the latency, worst-hold and
counter figures for the last minute (`1m`) and fifteen minutes (`15m`), updated
every 10 seconds. It is described in `docs/api.md`. It is left out until the
server has taken two samples.

Signals worth watching as your community grows. Every field is described in
`docs/api.md`.

- **`broadcast_drops` growing at all.** The server-wide broadcast queue
  overflowed and events were lost. Alert on any growth.
- **`topic_sheds_total` growing.** A sender went over its per-channel limit
  and messages were dropped before delivery. They cannot be replayed, so alert
  on any growth too. A client that missed a message this way reloads it from
  the database on its next reconnect.
- **`windows.1m.ws_dispatch_lag_ms.p95` climbing.** The single delivery loop
  is falling behind. `hub_broadcast_queue_depth` getting close to 1024 is the
  same signal from the other side. The top-level `ws_dispatch_lag_ms` covers
  the whole time since boot, so on a long-running server it moves slowly; read
  the `windows` copy for what is happening now.
- **`windows.1m.hub_seqmu_max_hold_ms` above about 100 ms.** Something that
  blocks every broadcast is holding things up. A replay purge's full scan is
  the known cause. The top-level figure is the worst hold since boot and never
  falls.
- **`windows.1m.db_writer_wait_seconds` growing.** Requests are queuing for
  SQLite's single write connection, so writes are near their limit. Over a
  minute it is the time spent queuing in that minute; the top-level figure is a
  total since boot, so watch its growth, not its size.
- **`windows.1m.db_reader_wait_seconds` growing.** Read queries are waiting for a free
  read connection (`database.max_readers`). Raise it, or look for slow reads.
  For an in-memory database this pair just repeats the writer's numbers.
- **`reconnect_tier_full` becoming a large share of reconnects.** The replay
  buffer is too small for real disconnect gaps.
- **A high `reconnect_ring_misses` count with a low `reconnect_tier_db` share.**
  The replay ring, not the event log, is doing the work: the log rescues few of
  the resumes the ring cannot serve.
- **`backpressure_queue_disconnects` growing.** Clients are being disconnected
  because they read too slowly. Causes are slow links or an overloaded server.

#### Scraping with Prometheus

`GET /api/v1/metrics/prometheus` serves the same figures in Prometheus text
format, in every build and with no setting to turn on. It sits behind the same
`server.metrics_allowed_cidrs` limit, so a scraper that is not on loopback or a
private network needs that key set to its address (see the config reference).

```yaml
scrape_configs:
  - job_name: owncord
    metrics_path: /api/v1/metrics/prometheus
    scheme: https
    tls_config:
      insecure_skip_verify: true # a self-signed certificate; use ca_file if you can
    static_configs:
      - targets: ["owncord.example.net:8443"]
```

Prometheus computes its own windows, so alert on `rate()` and
`histogram_quantile()` over `owncord_ws_dispatch_lag_seconds`, and on
`owncord_latency_max_seconds{metric="hub_seqmu_hold",window="1m"}` for the worst single hold. Every
family is listed in `docs/api.md`.

### LiveKit Health

`GET /api/v1/livekit/health` checks that LiveKit answers.

Who may call it:

- It uses `server.livekit_webhook_allowed_cidrs`. That is empty by default, so
  it falls back to `server.admin_allowed_cidrs` (the local machine and private
  networks, unless you changed it).
- Setting the key **replaces** that fallback. It does not add to it.
- The same list also controls LiveKit's webhook
  (`POST /api/v1/livekit/webhook`).

To let an outside monitor in, list the ranges LiveKit posts from (the local
machine and private networks, or LiveKit's own address), **plus** the
monitor's own `/32`. Never use `0.0.0.0/0`. If you list only the monitor, you
block the webhook. Stale voice seats then wait for the slower once-a-minute
check to clear.

### Monitor voice as well as liveness

`/health` checks the hub, the database and the disk, but **not voice**. So a
green `/health` does not mean voice works:

- LiveKit can be down while `/health` says `ok`. Voice joins are then refused.
- A blocked media path, where a call connects and then carries no sound, is
  invisible to the server. It never tests it.

To catch a voice outage, poll both endpoints:

- **Server liveness:** `GET /health`. Public, no allowlist needed. Any `503`
  needs action. `reason` names the part that failed (`hub`, `database`,
  `disk`).
- **Voice reachability:** `GET /api/v1/livekit/health`. `{"status": "ok"}`
  means LiveKit answered. A `503` with `"livekit_reachable": false` means it
  did not. An outside monitor must be allowed in, as described under
  [LiveKit Health](#livekit-health).

**The server has no watchdog of its own.** The systemd unit and the compose
file leave "restart a hung process" to the supervisor. For Docker, use an
external watchdog. The binary does not support `sd_notify`, so systemd's
`WatchdogSec=` does not work with the plain `Type=simple` unit. The portable
recipe is a cron job or uptime service that polls the two endpoints above and
restarts the service after repeated failures.

### Diagnostics

`GET /api/v1/diagnostics/connectivity` gives a connectivity report for
troubleshooting. Only administrators can call it. In the admin panel it is the
**Connectivity check** card on the Dashboard. See
[port-forwarding.md](port-forwarding.md).

### Support bundle

When you need help, the admin panel can write a support bundle for you to
attach to a report.

To make one:

1. Open the admin panel and go to **Diagnostics**.
2. Click **Create support bundle preview**.
3. Review the list of items, with their sizes and SHA-256 hashes.
4. Click **Confirm download**.

Previewing, or closing the preview, downloads nothing.

The zip holds six fixed files:

- `build.json`: app and Go version, operating system and architecture.
- `configuration.json`: a fixed list of safe settings from the running
  configuration.
- `database.json`: applied migration names, table names and row counts.
- `health.json`: a snapshot of the database, memory and hub.
- `events.json`: up to 200 recent log events. Each is mapped to a fixed event
  code with a cleaned-up detail, such as an error's reason. Warnings and errors
  are kept ahead of lower levels, so a burst of routine messages cannot push a
  failure out.
- `manifest.json`: sizes, hashes and a list of what was left out.

What it deliberately leaves out:

- message content, attachments, avatars and backups
- raw log lines
- names, paths, addresses, URLs and credentials

The configuration file leaves all of those out by design. Log details keep only
error words; every other word, path, host and address becomes `[x]`. Table
counts are counts only, never rows.

**Nothing is uploaded.** The bundle is a local download, and sharing it is your
choice. Confirming a download writes a `support_bundle_create` audit entry
with the list of items, never their contents. Only an administrator signed in
to the admin panel can make one. API tokens are refused.

The full data contract, with what may appear and how each item is cleaned, is
in the
[support-bundle data contract](architecture/diagnostics.md#support-bundle-data-contract).

## When it fails

Find your symptom below. Each entry says how to tell, what it means and what
to do. The tests behind each answer are linked from
[data-lifecycle.md](architecture/data-lifecycle.md).

### `/health` returns 503

The `reason` field names the part that failed:

- **`hub`:** the WebSocket dispatch loop died. The server exits with an error
  by itself, and the supervisor starts it again. Just check that it came back.
- **`database`:** the 1-second database check failed. Causes are the disk, a
  lock, or a stuck write. Read the last `database` lines in the log.
- **`disk`:** free space is below `server.min_free_disk_mb`. Free some space,
  or move `backup.dir` elsewhere. Uploads are refused first, and messages keep
  flowing. The three stages are under [Health Endpoint](#health-endpoint).

### The server refuses to start

There are three named reasons, each with one fix:

- **A bad `config.yaml`.** The start-up message names the file and the value.
  Fix that value.
- **An erasure key that does not match the marker file.** The log prints both
  fingerprints. Put the right `erasure.key` back from your archive. The rule is
  in [security.md](security.md#erasure-marker-key).
- **An unsupported `database.type`.** SQLite is the only one. Correct the key
  ([server-configuration.md](server-configuration.md)).

### Voice joins but nobody hears anything

Usually one of these:

- The UDP media port(s) are not forwarded. With the compose stack or the Docker
  image that is `7882/UDP`. Otherwise it is the `50000-60000` range by
  default, or your single `voice.udp_port`.
- `voice.node_ip` is pinned to an old public address. Leave it empty so
  LiveKit finds the address itself, and restart after your address changes.

The server cannot see this failure, because the media never reaches it. The
step-by-step check is in the [Port Forwarding Guide](port-forwarding.md).

### Voice cannot join at all

**When OwnCord runs LiveKit itself**, the LiveKit process is down. You will see:

- `livekit_healthy: false` in `GET /api/v1/metrics`
- `degraded` with a reason from `GET /api/v1/livekit/health`
- the `voice` warning on the Dashboard's attention panel

LiveKit's own errors are the `livekit companion output` entries in the server
log (`component=livekit`, text in the `line` attribute). The server restarts
LiveKit with growing waits, from 3 seconds up to 60. It gives up after ten
quick failures in a row. The recovery steps are in
[LiveKit Setup](livekit-setup.md).

**When you run LiveKit yourself** (no `voice.livekit_binary`, auto-download
off), the server checks it at each join. If LiveKit does not answer at
`voice.livekit_url` within 3 seconds, the join is refused with "voice is
temporarily unavailable — LiveKit is not reachable". The server logs
`handleVoiceJoin: external LiveKit unreachable`.

### Clients see a certificate mismatch

You replaced or renewed the certificate, or restored a `config.yaml` with a
different `tls.mode` from the one they pinned. Members must accept the new
fingerprint, which you publish through another channel. See
[Rotating the self-signed certificate](#rotating-the-self-signed-certificate).

### Every 2FA user is locked out after a restore

`totp.key` was not restored. What it costs and the only way back are in
[What each file is for](#what-each-file-is-for).

### Uploads refused with 507

The error code tells you which limit:

- **`STORAGE_QUOTA_EXCEEDED`:** the user's quota, `upload.user_quota_mb` (see
  [Capacity limits](#capacity-limits)).
- **`STORAGE_LOW_DISK`:** the disk floor. Free some space (see
  [Health Endpoint](#health-endpoint)).

A single file that is too large is refused with `400` or `413`, not `507`.

### An update did not come back

See [If the update fails](#if-the-update-fails). It covers the audit entries,
the `.old-*` fallback, and the Docker refusal.

### What to send when asking for help

Send a [support bundle](#support-bundle). It is never uploaded and holds no
messages, usernames, addresses or raw log lines.

If the problem shows in the log, add the last 200 lines of your supervisor's
log by hand. Say what you are sending: that excerpt contains usernames and
client addresses, which is exactly why the bundle leaves raw lines out.

## Auto-Update

### Server

The server checks GitHub Releases for updates:

- It compares versions using semantic versioning.
- It caches the result for 1 hour.
- It downloads the asset for this machine's operating system and
  architecture.
- On Windows, it checks a detached Ed25519 (minisign) signature.
- It checks a signed `server-update-manifest.json`, which ties the binary's
  hash to the release version.
- It checks the binary's SHA256 against `checksums.sha256`.

The admin panel's update dialog links the release notes. It warns that
database migrations only go forward. It takes a database backup first unless
you untick that box. If that backup fails, nothing is updated.

**What applying an update does, in order:**

1. Downloads and checks the new binary, next to the installed one.
2. Tells connected clients "restarting in 5s". Then renames the current binary
   to a unique `.old-*` name next to it (for example
   `chatserver.exe.old-123456789`), and puts the new binary in its place.
3. Shuts down: finishes HTTP requests, stops the WebSocket hub and the managed
   `livekit-server`, saves queued event and audit writes, and closes the
   database and its lock. It waits for LiveKit to fully exit. On Linux and
   macOS, LiveKit gets `SIGTERM` and 5 seconds before it is killed. On Windows
   it is ended and waited for.
4. Starts the new binary from the original path, or exits for systemd or NSSM
   to restart it (see `server.restart_mode` in
   [Server Configuration](server-configuration.md)). Normal shutdown and the
   emergency restart backstop share one hand-off, so only one new process
   starts. The backstop also waits for LiveKit to exit.
5. The new process starts up: data folder, TLS, database, migrations and the
   rest. Once every stage is up, it deletes every `.old-*` file (and any
   `.old` from an older release).
   - Windows may still hold an `.old-*` file open, because that binary is still
     running. It is then left for a later start. For example, a server started
     from a console window stays behind until its replacement exits (see
     [Running from a console window](#running-from-a-console-window)).
   - If a start-up stage fails before then, `.old-*` stays in place.
6. That cleanup is the only recovery start-up does.
   - The new process does not put `.old-*` back if the new binary turns out to
     be broken after it started serving.
   - It does not delete a leftover `.new` file from an interrupted download.
     The next update attempt removes it before downloading.
   - If the server dies between step 2 and step 5, the previous binary is still
     next to the installed one as `.old-*` (the newest one, if there are
     several). Putting it back is a manual rename.

Setting `github.token` raises GitHub's API limit for update checks from 60 to
5,000 requests per hour.

Containers upgrade by pulling a new image, as described above. A LiveKit you
run yourself is left running during an update.

**First update to a release with this hand-off.** The version you are running
does the shutdown for that first update. So it cannot benefit from the fix
until it has been replaced. That first update may need a manual stop, replace
and start.

#### If the update fails

The audit log tells you which stage failed. Every update writes
`update_apply`, then either `update_applied` or `update_failed` (see
[security.md](security.md)). There are three cases:

- **The check refused the download.** The manifest signature, the manifest's
  version or asset, or the SHA256 checksum did not match. The installed binary
  is untouched, and the admin panel says why. Try again. If it keeps failing,
  compare your version with the release page.
- **The server died during or after the swap.** The previous binary is still
  next to the installed one as `.old-*`, until a new process passes its
  start-up stages. If the new one never starts, rename that file back over the
  broken binary and start it.
  - This rolls back the binary only. If the failure was a migration, the
    database has already moved forward. An older binary refuses to start on it
    rather than damage it. Restore the pre-upgrade database first.
- **Docker refuses the whole thing.** The panel answers
  `503 CONTAINER_DEPLOYMENT`, because the binary is part of the image. Upgrade
  with the image instead: `docker compose pull && docker compose up -d`.
- **The install folder is read-only to the service.** The panel answers
  `503 INSTALL_READ_ONLY` before it downloads anything, and the Updates page
  says the server cannot replace its own program file. Install the release by
  hand ([Upgrade and Rollback](#upgrade-and-rollback)), or give the service
  write access to the folder that holds the binary. Under the shipped systemd
  unit this is the default; see
  [Opt in to admin-panel updates](#opt-in-to-admin-panel-updates).

To make failures rare:

- Take the [archive](#before-upgrading-take-the-archive) before you update.
- On systemd, update the unit file first (see
  [Running as a Linux Service](#running-as-a-linux-service-systemd)).
- Under NSSM, install the service with
  `OWNCORD_SERVER_RESTART_MODE=supervised` (see
  [Running as a Windows Service](#running-as-a-windows-service)).

### Client

The desktop client also updates itself. The server passes on client update
files from GitHub Releases:

- **Windows:** NSIS installer updates.
- **Linux:** AppImage updates, and `.deb` updates. A `.deb` install asks for
  the administrator password once per update (a system dialog) and installs
  the signed package through apt. It needs `pkexec` (the `pkexec` package, or
  `policykit-1` on older releases; the `.deb` recommends it) and a running
  polkit agent, which every desktop session has. Without either, the client
  keeps the old banner and the new `.deb` is installed by hand. A release that
  adds a hard dependency makes the in-app update need the network. The first
  update onto a version that carries this feature is manual; an RPM install
  still updates by hand.

Each update is checked with an Ed25519 signature before it is applied.

#### Client support bundle and logs

When a _user_ has a problem, the desktop client can write its own support
bundle, without contacting the server: **Settings → Diagnostics & logs →
Export Support Bundle**.

- It is a local zip, saved where the user chooses. Nothing is uploaded.
- Unlike the server bundle, it copies client log lines as they are. The client
  log is not cleaned. So review it before sharing. The **Diagnostics & logs**
  tab says this too.
- It contains both client logs, plus diagnostic sections the client collects
  itself. Ask for this bundle first.

The client keeps **two** logs: the webview's own rotating log (JSON lines),
and the native log below.
[Desktop client support bundle](architecture/diagnostics.md#desktop-client-support-bundle)
lists every file in the bundle.

Where the native client log is:

- **Windows:** `%LOCALAPPDATA%\com.owncord.client\logs\owncord-client.log`
- **Linux:** the app log folder, which is
  `~/.local/share/com.owncord.client/logs/owncord-client.log` on a default
  setup.

The log rolls over at 10 MB. It keeps the two previous files next to it, as
`owncord-client_<date>.log`.

The tray icon's **Open Log Folder** opens that folder. Use it when the window
never appeared. In that case the log says `frontend not ready` 30 seconds
after start. A crash is logged as a `[panic]` line with a backtrace.

## Verifying a Download

Each release page has checksums, signatures, build provenance records and
SBOMs (lists of what is inside). None of these checks trust the file you are
checking.

You need the [GitHub CLI](https://cli.github.com/) (`gh`). The image steps
also need Docker. Releases from before these were added have only checksums
and minisign signatures.

```bash
# 1. Checksums. Download the assets and checksums.sha256 into ONE folder --
#    gh release download <tag> -R J3vb/OwnCord puts them all there. The file
#    lists bare file names, so check it from that folder.
#    --ignore-missing skips assets you chose not to download.
sha256sum --check --ignore-missing checksums.sha256

# 2. Provenance. This proves the file was built by this repository's release
#    workflow at the commit the tag points to -- not just uploaded by whoever
#    controls the release. Run it on the asset you downloaded, then again on
#    checksums.sha256 and on the source snapshot. Set TAG to your release,
#    e.g. TAG=v2.2.0-beta.1. The --signer-workflow and --source-ref flags
#    reject a build from any other workflow or ref, such as a dry run.
gh attestation verify chatserver-linux-amd64.tar.gz --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners
gh attestation verify checksums.sha256 --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners

# 3. The image. First find the digest you are actually running:
#    a tag can change, a digest cannot.
DIGEST=$(docker image inspect ghcr.io/j3vb/owncord-server:${TAG#v} \
  --format '{{index .RepoDigests 0}}')

# 4. Check the image's provenance record, then read its SBOM.
gh attestation verify "oci://$DIGEST" --repo J3vb/OwnCord \
  --signer-workflow J3vb/OwnCord/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG" --deny-self-hosted-runners
docker buildx imagetools inspect ghcr.io/j3vb/owncord-server:${TAG#v} \
  --format '{{json .SBOM}}'

# 5. Windows binaries also have a detached minisign signature. This is what the
#    updater itself checks. The public key is in the repository. Both the key
#    and the .sig file are base64.
curl -sSfL -o server_update_public_key.txt \
  https://raw.githubusercontent.com/J3vb/OwnCord/main/Server/updater/server_update_public_key.txt
base64 -d chatserver.exe.sig > chatserver.exe.minisig
base64 -d server_update_public_key.txt > server_update.pub
minisign -Vm chatserver.exe -x chatserver.exe.minisig -p server_update.pub
```

| Asset                                                  | Signature                                          | SBOM                        | Who checks it                               |
| ------------------------------------------------------ | -------------------------------------------------- | --------------------------- | ------------------------------------------- |
| `chatserver.exe`, `chatserver-windows-arm64.exe`       | detached minisign signature, plus signed manifest  | CycloneDX, one per binary   | the updater on every update; you, by step 5 |
| `chatserver-linux-*.tar.gz`                            | none detached; SHA256 in the signed manifest       | CycloneDX, one per archive  | the updater, through the manifest           |
| Desktop client bundles (Windows and Linux, x64, arm64) | updater signature                                  | none yet                    | the client's own updater                    |
| `ghcr.io/j3vb/owncord-server` image                    | Sigstore provenance record, stored in the registry | SPDX, attached to the image | you, by steps 3 and 4                       |

What this proves, and what it does not:

- The provenance records meet **SLSA Build Level 2**. The build ran on a
  hosted runner. The signature comes from the workflow's own identity. The
  record names the workflow and commit, all from the same run. It is not Level
  3, which needs a hardened, isolated build platform.
- Provenance ties a file to a build, not to a person. It says which commit and
  workflow made it, not whether that commit can be trusted. Read the commit.
- The desktop client bundles have a provenance record but **no SBOM** yet. The
  updater signature is the check that matters for them today.
- Windows code signing (Authenticode) is separate work (see
  [Known Limitations](security.md#known-limitations)). So Windows SmartScreen
  still warns about the binaries, even when every check above passes.

## Firewall and Ports

This is the main port table. Other guides that repeat parts of it
([Port Forwarding Guide](port-forwarding.md), [LiveKit Setup](livekit-setup.md))
point here.

| Port          | Protocol | Purpose                                             |
| ------------- | -------- | --------------------------------------------------- |
| `8443`        | TCP      | HTTPS server (change it with `server.port`)         |
| `80`          | TCP      | ACME HTTP-01 challenge (only with `tls.mode: acme`) |
| `7881`        | TCP      | LiveKit media over TCP (fallback)                   |
| `50000-60000` | UDP      | LiveKit voice and video media                       |

**Docker.** The compose stack publishes exactly `8443/TCP`, `7881/TCP` and
`7882/UDP`, so for it the last row is `7882` instead of the range. The single
image only exposes those ports: you publish them with `-p`, and ACME adds
`80/TCP`. On compose the UDP port is set in `docker-compose.yml` (the
`command`, the `ports:` entry and `OWNCORD_VOICE_UDP_PORT` together), and an
`rtc.udp_port` in `livekit.yaml` is overridden there. An old `livekit.yaml`
cannot bring the range back.

**Single UDP port.** If LiveKit uses one UDP port, the last row is that port
instead of the range. You set it with `voice.udp_port` when OwnCord runs
LiveKit, or with `rtc.udp_port` in your own `livekit.yaml`. The Docker image
with bundled LiveKit uses `7882/UDP`.

**Port 7880 is not needed.** `7880/TCP` is LiveKit's own API port. The server
passes signalling to clients through `:8443/livekit`, so only clients that
connect to LiveKit directly would need it.

For remote access, see the [Port Forwarding Guide](port-forwarding.md) or the
[Tailscale Guide](tailscale.md). The port-forwarding guide also covers what
OwnCord cannot detect from inside your network: blocked ports, CGNAT, hairpin
NAT and a changing public IP. It shows how to check each one yourself.

The limits of each TLS mode are under [TLS Setup](#tls-setup).

## Command-line reference

`chatserver` has a few subcommands. Run `chatserver --help` to see them.

| Command                                  | What it does                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `chatserver`                             | Starts the server. Reads `config.yaml` in the working folder, or creates it. |
| `chatserver --version`                   | Prints the version and exits.                                                |
| `chatserver --help`                      | Prints help and exits.                                                       |
| `chatserver healthcheck`                 | Checks the running server's `/health`. Exits 0 if healthy, 1 if not.         |
| `chatserver token create --label <name>` | Creates an API token. Options: `--user <username>`, `--expires <duration>`.  |
| `chatserver token list`                  | Lists API tokens. Never prints the raw token.                                |
| `chatserver token revoke <id\|label>`    | Revokes a token by ID or label.                                              |
| `chatserver restore [--force] <file>`    | Puts a database backup back while the server is stopped.                     |

See [Scheduling backups from outside the server](#scheduling-backups-from-outside-the-server)
and [Restoring without a running server](#restoring-without-a-running-server).

## Hardening Checklist

- [ ] **Choose a strong Owner password during setup.** There is no default
      password. The first-run wizard creates the Owner account.
- [ ] **Set `admin_allowed_cidrs`** to limit admin access to specific addresses,
      if needed.
- [ ] **Serve TLS end to end.** Keep the tested default (`self_signed`). Or, for
      a public domain, put a reverse proxy in front that renews certificates.
      Built-in `acme` works but is not fully tested ([TLS Setup](#tls-setup)).
      Never expose `tls.mode: off` directly. Publish 8443 on loopback only
      (`127.0.0.1:8443:8443`), or allow it only from the proxy.
- [ ] **Set `trusted_proxies`**, only if you use a reverse proxy. List the
      proxy's own addresses, so client addresses come from `X-Forwarded-For`.
- [ ] **Leave `allowed_origins` empty unless you know why.** Empty refuses
      WebSocket connections from other websites, which is right for desktop-only
      use. Set it only to allow browser clients from your own domain.
- [ ] **Set fixed voice credentials.** Set `livekit_api_key` and
      `livekit_api_secret`, so voice tokens keep working after a restart.
- [ ] **Check the voice media address.** Leave `voice.node_ip` empty so LiveKit
      finds your public address. In Docker, keep `use_external_ip: true` in
      `livekit.yaml`, and replace it with `node_ip` only when you pin one. Pin
      it only when detection cannot work, such as on a Tailscale-only host
      ([Port Forwarding](port-forwarding.md#dynamic-public-ip)).
- [ ] **Review upload limits.** Adjust `upload.max_size_mb` for your community.
- [ ] **Set a GitHub token** (optional) for reliable update checks.
- [ ] **Schedule backups.** Use the built-in schedule on the **Backups &
      restore** page, or call the endpoint from your own cron
      ([Scheduled Backups](#scheduled-backups)).
- [ ] **Monitor health.** Poll `/health` and `/api/v1/livekit/health` from an
      uptime monitor
      ([Monitor voice as well as liveness](#monitor-voice-as-well-as-liveness)).
      The server does not send alerts itself.

## Background Maintenance

A maintenance loop runs every 15 minutes. It runs thirteen steps in this
order. Later steps see what earlier ones left this run.

1. Delete expired login sessions.
2. Delete expired message delivery receipts.
3. Clean up expired two-factor state.
4. Remove stale push subscriptions.
5. Run backup maintenance: the schedule check and retention.
6. Delete orphaned attachments: uploaded but never linked, older than 1 hour.
7. Run the message retention sweep, if a window is set.
8. Remove closed reports' content older than
   `moderation.report_retention_days`.
9. Clean up orphaned voice mutes.
10. Remove retired moderation actions older than
    `moderation.action_retention_days`. An action that still owns a voice mute
    is never removed.
11. Resume pending account erasures.
12. Check stored files against the database (up to 500 files per run).
13. Recount storage use. This runs last on purpose, so it counts what the steps
    above freed.

If a step fails, it is logged and the rest of the run continues. After five
failed runs in a row, the loop skips one run and then tries again.

## Graceful Shutdown

The server handles `Ctrl+C` (`SIGINT`) and `SIGTERM`. It shuts down in this
order:

1. Stops the ACME listener and ends any open admin **Logs** stream. Then waits
   for open HTTP requests to finish. A file upload or download still running
   gets up to 20 seconds, then is cut, so this stays inside the 30-second
   budget.
2. Stops the hub, on its own time budget. It sends the restart notice, waits
   out the notice, closes every WebSocket connection, and only then stops
   LiveKit. So clients leave voice while LiveKit is still up.
3. Stops listening for signals, so a second `Ctrl+C` during steps 1 and 2 does
   not cut the shutdown short.
4. Stops the maintenance loop, saves the queued audit entries, and saves the
   queued events.
5. Stops the router's cleanup task, closes the plugin runtime, shuts down
   telemetry, and releases the deletion-marker file.
6. Closes the database.

Open HTTP requests finish **before** WebSockets close. This is on purpose:
requests send events on their way out, and those must reach a live hub, or
they are missing after the restart. The shutdown does not wait for WebSocket
connections, so connected clients do not slow it down. They get the restart
notice straight after. The order is the reverse of the start-up order in
`Server/internal/app/stages.go`.

**LiveKit never outlives the server**, even if the server dies without this
sequence. On Linux, the kernel stops LiveKit when its parent dies. On Windows,
LiveKit runs in a job object that is closed when the server exits. On Windows,
closing the server's console window stops both the server and LiveKit,
including after a self-restart (see
[Running from a console window](#running-from-a-console-window)).

## See Also

- [Server Configuration](server-configuration.md) — every config key
- [Capacity](capacity.md) — the tested 250/100/25 profile, its hardware and
  its commands
- [LiveKit Setup](livekit-setup.md) — voice and video setup
- [Quick Start](quick-start.md) — getting started
- [Port Forwarding](port-forwarding.md) — reaching your server from outside
- [Tailscale](tailscale.md) — remote access without port forwarding
- [Security](security.md) — security guidance

## Sources

For readers who want the evidence behind the claims above:

- Expired self-signed certificates keep working:
  `Server/auth/tls_expiry_test.go` (`TestExpiredSelfSignedCertIsServedAsIs`),
  and the fingerprint checks in `Client/src-tauri/src/tofu.rs`.
- 2FA secrets are decrypted before the code is checked:
  `Server/service/auth.go`.
- The disk-full and restore behaviour was measured by the failure drills in
  `Server/cmd/smoke` (`-drills`), described in
  [data-lifecycle.md](architecture/data-lifecycle.md).
- The upgrade and rollback rehearsal: `Server/cmd/smoke` and
  `.github/workflows/upgrade-rehearsal.yml`.
