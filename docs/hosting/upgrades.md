# Upgrades

## In short

1. Take a copy of your data (below).
2. Upgrade the **server** first, then the apps.
3. Keep the old version until you are sure the new one works.

**Upgrades only go forward.** A new version updates the database, and an older
version cannot open it again. So the copy you take before upgrading is your
only way back.

## Before you upgrade: take a copy

Stop the server, then copy the data, the config and the program you are
upgrading **from**.

**Linux service:**

```bash
sudo systemctl stop owncord
sudo mkdir -p /mnt/backup-disk/owncord-pre-upgrade
sudo cp -a /var/lib/owncord/data /var/lib/owncord/config.yaml \
  /mnt/backup-disk/owncord-pre-upgrade/
sudo cp -a /opt/owncord/chatserver /mnt/backup-disk/owncord-pre-upgrade/chatserver-previous
```

**Docker:**

```bash
docker compose down
mkdir -p /mnt/backup-disk/owncord-pre-upgrade
cp config.yaml /mnt/backup-disk/owncord-pre-upgrade/config.yaml
docker image inspect ghcr.io/j3vb/owncord-server:latest \
  --format '{{index .RepoDigests 0}}' > /mnt/backup-disk/owncord-pre-upgrade/image
rm -rf /mnt/backup-disk/owncord-pre-upgrade/data
docker run --rm \
  -v server_owncord-data:/app/data:ro \
  -v /mnt/backup-disk/owncord-pre-upgrade:/archive \
  alpine cp -a /app/data /archive/data
```

`server_owncord-data` is the volume name Compose uses when you run it in
`Server/`. Check yours with `docker volume ls`.

Copy `data/` as a whole, not file by file: new versions add files to it.

## Upgrade

- **Linux service:**

  ```bash
  sudo systemctl stop owncord
  sudo install -o root -g root -m 0755 ./chatserver /opt/owncord/chatserver
  sudo systemctl start owncord
  ```

- **Docker:** `docker compose pull && docker compose up -d`.
- **Admin panel:** the **Updates** page downloads, checks and installs the new
  version, and restarts. It backs up the database first unless you untick that
  box. On a Linux service you must
  [opt in](../deployment.md#opt-in-to-admin-panel-updates) first. Docker cannot
  use it.

The new version updates the database on its first start. Nothing else in the
folder changes.

**Why the server goes first:** the desktop apps get their updates through your
server, and it only offers app versions it can talk to. An app that is too old
shows **Update Now** on its connect screen.

## Going back a version

**Everything written after your copy is lost**: messages, uploads, accounts and
backups. You also need the old program or image. GitHub Releases usually still
has it, but an update from the admin panel does not keep it.

**Linux service:**

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

**Docker:**

```bash
docker compose down
docker volume rm server_owncord-data
docker volume create server_owncord-data
docker run --rm \
  -v server_owncord-data:/app/data \
  -v /mnt/backup-disk/owncord-pre-upgrade:/archive:ro \
  alpine sh -c "cp -a /archive/data/. /app/data/ && chown -R 65532:65532 /app/data"
cp /mnt/backup-disk/owncord-pre-upgrade/config.yaml config.yaml
# Set the old image tag in docker-compose.yml first: :latest pulls the new one again.
docker compose up -d
```

**Replace `data/`, never copy on top of it.** A newer version may have added
files that the old one does not expect.

## If an update from the admin panel fails

The audit log shows `update_failed` and the reason.

- **The download did not pass the checks.** Nothing changed. Try again later.
- **The new version never started.** The old program is still next to it, named
  `chatserver.old-<number>` (or `chatserver.exe.old-<number>`). Stop the
  server, rename it back, and start it. If the database was already updated,
  also restore the copy you took first.
- **"Container deployment".** Docker: upgrade with `docker compose pull`
  instead.
- **"Install read-only".** The Linux service may not change its program. Opt in
  as described in [Run your server](../deployment.md#opt-in-to-admin-panel-updates),
  or upgrade by hand.

Under NSSM, make sure the service has `OWNCORD_SERVER_RESTART_MODE=supervised`
([Windows service](windows.md)). Setting `github.token` makes update checks
more reliable.

## Desktop app updates

The desktop app updates itself and checks each update's signature first.

- **Windows:** the installer updates in place.
- **Linux AppImage:** updates in place.
- **Linux .deb:** asks for your password once per update. It needs `pkexec`,
  which most desktops have. Without it, install the new `.deb` by hand. RPM
  installs always update by hand.

What the server checks before it installs an update, and the exact steps, are
in the [reference](reference.md#how-a-server-update-works).
