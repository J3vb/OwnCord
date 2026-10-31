# Run your server

This guide is for anyone who runs their own OwnCord server. It gets you from
a download to a server that starts by itself, and points to a short page for
each next step.

New to OwnCord? The [Quick Start](quick-start.md) is shorter. Come back here
when you want the server to keep running on its own.

## Pick how to run it

| You have                       | Use                                                      |
| ------------------------------ | -------------------------------------------------------- |
| A Linux machine with Docker    | [Docker](#docker-linux) (recommended on Linux)           |
| An Unraid server               | [Unraid](hosting/docker.md#unraid)                       |
| A Linux machine without Docker | [Linux service](#running-as-a-linux-service-systemd)     |
| A Windows PC                   | [Windows service](hosting/windows.md)                    |
| Just want to try it            | Download it and double-click it: [First run](#first-run) |

## What you need

- **A computer that stays on.** Windows 10 or later, or Linux, on x64 or ARM64.
  How many people one machine can carry is in [Capacity](capacity.md).
- **Nothing else for voice.** The server downloads and runs
  [LiveKit](livekit-setup.md), the voice and video part, for you.
- **These ports open** if people connect from outside your home network:

| Port              | What it is for                             |
| ----------------- | ------------------------------------------ |
| `8443/TCP`        | Chat, the API and the admin panel. Always. |
| `7881/TCP`        | Voice and video, fallback over TCP.        |
| `7882/UDP`        | Voice and video media, in Docker.          |
| `50000-60000/UDP` | Voice and video media, without Docker.     |
| `80/TCP`          | Only for built-in Let's Encrypt.           |

You never need `7880`. More on ports and routers:
[Port forwarding](port-forwarding.md), or skip the router with
[Tailscale](tailscale.md).

## Download

Each [release](https://github.com/J3vb/OwnCord/releases) has one server file
per system:

| System        | File                            |
| ------------- | ------------------------------- |
| Windows x64   | `chatserver.exe`                |
| Windows ARM64 | `chatserver-windows-arm64.exe`  |
| Linux x64     | `chatserver-linux-amd64.tar.gz` |
| Linux ARM64   | `chatserver-linux-arm64.tar.gz` |

Pick the one that matches your machine. The server will not update itself to a
file built for a different processor.

Want to check a download is genuine? See
[Verifying a download](hosting/reference.md#verifying-a-download). Building it
yourself is in [contributing.md](contributing.md).

## Docker (Linux)

Docker is the easiest way on Linux. The image is
`ghcr.io/j3vb/owncord-server` and works on both x64 and ARM64.

You need Docker Engine 24 or later with Compose v2. Get the files below from
the source code attached to a release, or from the `Server/` folder of this
repository. They are not separate downloads.

1. Go to the folder:

   ```bash
   cd Server
   ```

2. Make your three files from the examples:

   ```bash
   cp .env.example .env
   cp livekit.yaml.example livekit.yaml
   cp config.yaml.example config.yaml
   ```

   Do this **before** the first start. If `config.yaml` is missing, Docker
   makes an empty folder with that name and the server cannot start.

3. Open `.env` and set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Use only
   letters and digits (never a `'`), and make the secret at least 32
   characters. `openssl rand -hex 32` makes a good one. This is the only place
   you type them.

4. Change `config.yaml` if you want, for example the server name. Nothing is
   needed for voice.

5. Start it:

   ```bash
   docker compose up -d
   ```

6. Get the setup token with `docker compose logs owncord`, then open
   `https://<your-ip>:8443/admin` and follow the [First run](#first-run)
   steps.

**Upgrading** is `docker compose pull` then `docker compose up -d`. Your data
stays. Read [Upgrades](hosting/upgrades.md) first.

Single container, Unraid, file ownership and what the compose file sets for
you: [Docker in detail](hosting/docker.md).

## First run

1. Start the server. On first start it writes `config.yaml`, a `data/` folder,
   a certificate and the database, then prints a **setup token**.
2. Open `https://localhost:8443/admin` (or the server's address). Your browser
   warns about the certificate the first time. That is expected: the server
   made its own.
3. Paste the setup token. Where to find it:
   - in the terminal, if you started the server yourself
   - in `docker compose logs owncord`, in Docker
   - in `journalctl -u owncord`, for a Linux service
4. Follow the wizard. It creates your **Owner** account and asks for the
   server name, registration rules and voice. It saves your choices.
5. **Save your recovery kit.** The finish screen shows it once and never again.
6. Copy the server address and invite code from the finish screen and send
   them to your friends.

The token changes each time the server starts. Restart the server to get a new
one.

**On a cloud server (VPS) the admin panel may say 403.** By default it only
opens from the same machine or your local network. Either tunnel in with
`ssh -L 8443:localhost:8443 you@your-server` and open
`https://localhost:8443/admin`, or add your address to
`server.admin_allowed_cidrs` in `config.yaml`.

Every setting is in [Server configuration](server-configuration.md).

## Running as a Linux service (systemd)

Run the server as a service so it starts at boot and comes back after a crash
or an update. A ready-made unit file is in the repository at
`deploy/owncord.service`.

1. Make a user for the service:

   ```bash
   sudo useradd --system --home /var/lib/owncord --shell /usr/sbin/nologin owncord
   ```

2. Put the program in `/opt/owncord`:

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/owncord
   sudo install -o root -g root -m 0755 ./chatserver /opt/owncord/chatserver
   ```

3. Install and start the service:

   ```bash
   sudo cp deploy/owncord.service /etc/systemd/system/owncord.service
   sudo systemctl daemon-reload && sudo systemctl enable --now owncord
   ```

4. Watch the log with `journalctl -u owncord -f`.

The program lives in `/opt/owncord`. Everything the server writes (config,
database, uploads, backups) lives in `/var/lib/owncord`.

Things you may need to add to the unit (`sudo systemctl edit owncord`):

- **Backups or uploads on another disk.** The service can only write to
  `/var/lib/owncord`. Add each other folder, or every backup fails:

  ```ini
  [Service]
  ReadWritePaths=/mnt/backup-disk/owncord
  ```

- **Built-in Let's Encrypt.** Uncomment `AmbientCapabilities=CAP_NET_BIND_SERVICE`
  so the server may use port 80.
- **Updates from the admin panel.** Off by default. See
  [Opt in to admin-panel updates](#opt-in-to-admin-panel-updates).

Why each line in the unit is there: [reference](hosting/reference.md#the-systemd-unit).

### Migrating from the /opt/owncord data layout

Older unit files kept the data in `/opt/owncord` too. Do this once, **before**
you copy the new unit file over the old one.

1. Stop the service:

   ```bash
   sudo systemctl stop owncord
   ```

2. Move the data and config:

   ```bash
   sudo mkdir -p /var/lib/owncord
   sudo mv /opt/owncord/data /opt/owncord/config.yaml /var/lib/owncord/
   ```

3. Look for old paths in the config:

   ```bash
   sudo grep -n '/opt/owncord' /var/lib/owncord/config.yaml
   ```

   - Paths under `/opt/owncord/data` must now say `/var/lib/owncord/data`:

     ```bash
     sudo sed -i 's#/opt/owncord/data#/var/lib/owncord/data#g' /var/lib/owncord/config.yaml
     ```

   - Certificate files elsewhere in `/opt/owncord`: move them into
     `/var/lib/owncord`, then fix their paths.
   - `voice.livekit_binary` can stay where it is.
   - Folders outside both places (for example `/srv/owncord`): add them to
     `ReadWritePaths=` in step 5.

   If a move stops halfway, do not start the service. Delete the partial copy
   in `/var/lib/owncord` and move again.

4. Set the owners:

   ```bash
   sudo chown -R owncord:owncord /var/lib/owncord
   sudo chmod 0750 /var/lib/owncord
   sudo chown -R root:root /opt/owncord
   sudo usermod -d /var/lib/owncord owncord
   ```

5. If you use Let's Encrypt, or folders outside `/var/lib/owncord`, edit the
   new unit as described above.

6. Install the new unit and start:

   ```bash
   sudo cp deploy/owncord.service /etc/systemd/system/owncord.service
   sudo systemctl daemon-reload && sudo systemctl start owncord
   ```

**If something went wrong:**

- `Assertion failed ... /opt/owncord/data`: the data is still in the old place.
  Do step 2. (The unit refuses to start on an empty folder on purpose, so your
  data never looks lost.)
- Backups or uploads fail with `EROFS` (read-only file system): a path in
  `config.yaml` still points at the old place, or at a folder the service may
  not write. Do step 3.

### Opt in to admin-panel updates

By default the service may not change its own program, so the admin panel
cannot install updates. Its Updates page says so, and you update by hand as in
[Upgrades](hosting/upgrades.md).

To let the admin panel update the server:

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

To undo it: `sudo systemctl revert owncord` and `sudo chown root /opt/owncord`.

## Next steps

- [ ] **Backups.** Turn on automatic backups in the admin panel, and keep a
      copy off the machine. See [Backups and restore](hosting/backups.md).
- [ ] **Certificate.** The default works everywhere. For your own domain, see
      [TLS and reverse proxies](hosting/tls-and-proxy.md).
- [ ] **Monitoring.** Point an uptime checker at `/health`, and at voice too.
      See [Monitoring](hosting/monitoring.md).
- [ ] **Security.** Go through the [hardening checklist](security.md#security-hardening-checklist-for-operators).

## When it fails

Find your problem in [Troubleshooting](hosting/troubleshooting.md). The most
common ones:

- [Voice joins but nobody hears anything](hosting/troubleshooting.md#voice-joins-but-nobody-hears-anything)
- [The server refuses to start](hosting/troubleshooting.md#the-server-refuses-to-start)
- [Clients see a certificate warning](hosting/troubleshooting.md#clients-see-a-certificate-warning)
- [Every 2FA user is locked out after a restore](hosting/troubleshooting.md#every-2fa-user-is-locked-out-after-a-restore)

When you ask for help, attach a
[support bundle](hosting/monitoring.md#support-bundle).

## All server guides

| Page                                                | What it covers                                               |
| --------------------------------------------------- | ------------------------------------------------------------ |
| [Docker in detail](hosting/docker.md)               | Compose, one container, Unraid, settings in a container      |
| [Windows service](hosting/windows.md)               | NSSM, Task Scheduler, running from a window                  |
| [TLS and reverse proxies](hosting/tls-and-proxy.md) | Certificate modes, changing a certificate, nginx, Cloudflare |
| [Backups and restore](hosting/backups.md)           | What to back up, schedules, putting a backup back            |
| [Upgrades](hosting/upgrades.md)                     | Upgrading, going back a version, automatic updates           |
| [Monitoring](hosting/monitoring.md)                 | Logs, health checks, metrics, support bundles, limits        |
| [Troubleshooting](hosting/troubleshooting.md)       | Symptoms and fixes                                           |
| [Server reference](hosting/reference.md)            | The technical detail behind the pages above                  |
| [Server configuration](server-configuration.md)     | Every setting                                                |
| [LiveKit setup](livekit-setup.md)                   | Voice and video                                              |
