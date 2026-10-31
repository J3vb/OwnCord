# Server reference

The technical detail behind the server guides: exact behaviour, internal
order of steps, and every number. You do not need this page to run a server.
Start at [Run your server](../deployment.md).

## The systemd unit

The shipped unit is `deploy/owncord.service`. Why each part is there:

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

## How a self-restart works

`server.restart_mode` decides how the server restarts itself after an update, a restore or a setup-wizard change. `supervised` exits cleanly and lets systemd, NSSM or Docker start it again. `spawn` starts the new process itself. `auto`, the default, picks `supervised` under systemd and in containers, and `spawn` otherwise. NSSM 2.24 cannot be detected, which is why NSSM needs `OWNCORD_SERVER_RESTART_MODE=supervised` set by hand.

### From a console window

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
| `cert.pem`, `key.pem`                       | first run, `tls.mode: self_signed`                                        | one TLS pair                                                                                          | never; replacing them is [rotation](tls-and-proxy.md#replacing-the-self-signed-certificate)                       |
| `totp.key`, `erasure.key`, `push_vapid.key` | first run                                                                 | three small files                                                                                     | never, and they must never be: losing one is permanent (see [Backup Strategy](backups.md))                        |
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

## Backups

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
  [Server Configuration](../server-configuration.md#changing-settings-from-the-admin-panel)).

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
[Running as a Linux Service](../deployment.md#running-as-a-linux-service-systemd). Without it,
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
  [Before upgrading: take the archive](upgrades.md#before-you-upgrade-take-a-copy)). Or
  rely on a database backup, which `chatserver restore` can put back.
- The build starts when the browser opens the link. So if there is not enough
  free space, you see a failed download in the browser, not a panel message.

The database part is a consistent snapshot even while the server runs. But
other files are copied while chat is still writing. When you can, prefer the
stop-the-server procedure in
[Before upgrading: take the archive](upgrades.md#before-you-upgrade-take-a-copy).
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
[archive](upgrades.md#before-you-upgrade-take-a-copy).

## How a restore works

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
`restart: unless-stopped` for this reason ([Upgrading](docker.md#upgrading)).

On the first start after a restore, the server replays every deletion recorded
since the backup was taken, before it serves anyone
([data-lifecycle.md](../architecture/data-lifecycle.md)). This is why the marker
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
are in [security.md](../security.md#erasure-marker-key).

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
   [Before upgrading: take the archive](upgrades.md#before-you-upgrade-take-a-copy). It
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
was taken ([Restore](backups.md#restore)). The full archive is the supported path. A
database file alone is the fallback.

## Upgrades

There are hand-run reversal scripts in `Server/rollback/`. They exist to
rehearse undoing one specific migration, not as an upgrade path. See
[`Server/rollback/README.md`](../../Server/rollback/README.md).

**Rehearsing an upgrade.** You do not need a copy of a real server's database.
`Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` is an anonymised test
database shaped like a month-old server (see the README beside it).
`Server/db/alpha_snapshot_test.go` checks on every test run that current
migrations still apply to it cleanly.

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
  [Building from Source](../deployment.md#download) and
  [Docker](../deployment.md#docker-linux)): start, migrate, stop, restart. They do not get an
  upgrade from a previous release. That becomes possible one release after the
  ARM64 assets ship.
- **In Docker, the `config.yaml` check is weaker.** Compose mounts the file
  read-only, so nothing in the container can rewrite it (see
  [config.yaml for Docker](docker.md#settings-in-a-container)). The check catches an
  in-place edit. But the way the server really saves its config, a rename over
  the file, is refused by the system on a single-file mount anyway. The
  standalone run is the one that proves an upgrade leaves `config.yaml` alone.

## How a server update works

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
   [Server Configuration](../server-configuration.md)). Normal shutdown and the
   emergency restart backstop share one hand-off, so only one new process
   starts. The backstop also waits for LiveKit to exit.
5. The new process starts up: data folder, TLS, database, migrations and the
   rest. Once every stage is up, it deletes every `.old-*` file (and any
   `.old` from an older release).
   - Windows may still hold an `.old-*` file open, because that binary is still
     running. It is then left for a later start. For example, a server started
     from a console window stays behind until its replacement exits (see
     [Running from a console window](#from-a-console-window)).
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

Containers upgrade by pulling a new image ([Docker](docker.md#upgrading)). A LiveKit you
run yourself is left running during an update.

**First update to a release with this hand-off.** The version you are running
does the shutdown for that first update. So it cannot benefit from the fix
until it has been replaced. That first update may need a manual stop, replace
and start.

### If the update fails

The audit log tells you which stage failed. Every update writes
`update_apply`, then either `update_applied` or `update_failed` (see
[security.md](../security.md)). There are three cases:

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
  hand ([Upgrade and Rollback](upgrades.md)), or give the service
  write access to the folder that holds the binary. Under the shipped systemd
  unit this is the default; see
  [Opt in to admin-panel updates](../deployment.md#opt-in-to-admin-panel-updates).

To make failures rare:

- Take the [archive](upgrades.md#before-you-upgrade-take-a-copy) before you update.
- On systemd, update the unit file first (see
  [Running as a Linux Service](../deployment.md#running-as-a-linux-service-systemd)).
- Under NSSM, install the service with
  `OWNCORD_SERVER_RESTART_MODE=supervised` (see
  [Running as a Windows Service](windows.md)).

### Desktop app updates

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

### Client support bundle and logs

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
[Desktop client support bundle](../architecture/diagnostics.md#desktop-client-support-bundle)
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

## Limits and the metric that shows each

What one server can carry on which hardware is in
[Capacity](../capacity.md#sizing-for-10002000-online). That page also has an
measured 1,000-online result (steady chat holds; a login burst and a
full reconnect herd miss some of their budgets) and an estimate, not measured,
for 2,000 people online.

The tested profile is **250 registered users, 100 connections at once and 25
voice sessions at once, on 2 vCPU and 4 GB RAM**. See
[The profile](../capacity.md#the-profile) and
[Reference hardware](../capacity.md#reference-hardware).

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
[Metrics Endpoint](#metrics). That list is the one to alert on.

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
  [`deploy/owncord.service`](../../deploy/owncord.service) sets it), or
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

## Logs

The server writes its log to **standard output** (stdout), as `slog` text. It
also keeps the last 10,000 lines in memory for the admin panel's live log view.
There is no log file and no rotation inside the server. So where the log ends
up depends on your supervisor:

| Supervisor      | Where the log goes                             | How to read it                                                                         |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| systemd (Linux) | the journald journal                           | `journalctl -u owncord -f`. journald's settings decide how long it is kept             |
| Docker          | Docker's `json-file` log driver on the host    | `docker compose logs -f owncord`. The shipped compose file keeps 3 files of 10 MB each |
| NSSM (Windows)  | **nowhere**, unless you set `AppStdout/Stderr` | the file you set in `AppStdout`. See [Option 1: NSSM](windows.md#nssm-recommended)     |

**Log level.** `logging.level` sets how much is logged: `debug`, `info`,
`warn` or `error`. The default is `info`. `OWNCORD_LOGGING_LEVEL` overrides it
without editing `config.yaml`. An administrator can also switch a running
server to `debug` for a while from the admin panel's **Logs** page
([server-configuration.md](../server-configuration.md#logging-logging)).

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

## Health endpoint

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
[Monitor voice as well as liveness](monitoring.md#health-checks).

The server version is deliberately left out of this public endpoint, so
outsiders cannot easily tell which version you run.

**Disk space, in three stages.** The check compares free space on the volumes
the server writes to with `server.min_free_disk_mb`. The default is 256 MiB.
`0` turns the check off (see
[server-configuration.md](../server-configuration.md)). All three stages were
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

## Metrics

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

### Scraping with Prometheus

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

## LiveKit health

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

## Diagnostics

`GET /api/v1/diagnostics/connectivity` gives a connectivity report for
troubleshooting. Only administrators can call it. In the admin panel it is the
**Connectivity check** card on the Dashboard. See
[port-forwarding.md](../port-forwarding.md).

### Support bundle contents

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
[support-bundle data contract](../architecture/diagnostics.md#support-bundle-data-contract).

## Verifying a download

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
  [Known Limitations](../security.md#known-limitations)). So Windows SmartScreen
  still warns about the binaries, even when every check above passes.

## Ports in detail

Every port the server and LiveKit use.

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

For remote access, see the [Port Forwarding Guide](../port-forwarding.md) or the
[Tailscale Guide](../tailscale.md). The port-forwarding guide also covers what
OwnCord cannot detect from inside your network: blocked ports, CGNAT, hairpin
NAT and a changing public IP. It shows how to check each one yourself.

The limits of each TLS mode are under [TLS Setup](tls-and-proxy.md).

## Voice (LiveKit) internals

### How the server runs LiveKit

When `livekit_binary` is set, or auto-download provides the binary, OwnCord
manages LiveKit like this:

1. **It writes the config.** OwnCord generates `data/livekit.yaml` with:
   - the API key and secret
   - port 7880
   - the UDP range `50000-60000`, or your single `voice.udp_port`
   - an `audio:` block that tunes speaker detection, so the speaking ring
     lights up promptly (copy it from `livekit.yaml.example` into a file you
     manage yourself)
2. **It starts LiveKit:** `livekit-server --config data/livekit.yaml`.
3. **It restarts LiveKit after a crash.** Waits grow from 3 seconds to 6, 12,
   and so on, up to 60 seconds. It gives up after 10 quick failures in a row.
4. **It checks LiveKit's health** with an HTTP request to the address in
   `voice.livekit_url` (by default `http://localhost:7880/`).
5. **It stops LiveKit when OwnCord shuts down.** On Linux, LiveKit gets 5
   seconds to stop before it is killed.

**To manage `data/livekit.yaml` yourself** (custom `rtc` options, several
network interfaces, and so on), delete the header line that contains the
auto-generated marker. OwnCord then leaves the file alone on future starts.
Your `keys:` entry must still match `voice.livekit_api_key` and
`voice.livekit_api_secret`.

If `livekit_binary` is empty and `auto_download_livekit` is off, OwnCord
assumes you run LiveKit yourself, for example with Docker, systemd or by hand.

### How a client joins voice

How a client joins voice:

```
Client                     OwnCord Server              LiveKit Server
  |                             |                           |
  |-- voice_join (channel_id)-->|                           |
  |                             |-- check READ+CONNECT_VOICE|
  |                             |-- persist to voice_states |
  |                             |-- GenerateToken()         |
  |<-- voice_token ------------|                           |
  |    { token, url,           |                           |
  |      direct_url }          |                           |
  |                             |                           |
  |-- connect with JWT --------|-------------------------->|
  |<--- media streams ----------|--------------------------|
```

**Token details:**

- Room name: `"channel-{channelID}"`.
- Identity: `"user-{userID}:{joinToken}"`. The join token makes each rejoin a
  separate participant. Without a token it is `"user-{userID}"`.
- Lifetime: 5 minutes. The client asks for a fresh token with
  `voice_token_refresh` every 4 minutes. The server allows one refresh per 60
  seconds.
- What a user may send is set per source with `CanPublishSources`:
  - microphone needs `SPEAK_VOICE`
  - camera needs `USE_VIDEO`
  - screen share needs `SHARE_SCREEN`
- `canSubscribe` is always true.

**How clients connect:**

- **Proxy path (`/livekit`):** the client connects through OwnCord's HTTPS
  server. This avoids mixed-content problems. It is the normal path.
- **Direct URL (`ws://localhost:7880`):** sent only when `voice.livekit_url` is
  itself a local (loopback) address
  ([protocol.md](../protocol.md#voice_token-server---client-direct)). The client
  uses it only when it is on the same machine and the URL is a local `ws:` or
  `http:` address. Any other `direct_url` goes through the proxy path. That
  includes a compose-internal name such as `ws://livekit:7880`, which only
  works inside the container network. This rule is the same on every platform,
  including Linux native voice
  ([security.md](../security-model.md#tauri-capabilities-least-privilege)).
  - Linux clients up to 2.0.0-beta.1 used any `direct_url` as-is for a
    `localhost` server. See
    [Linux app cannot join voice](troubleshooting.md#the-linux-app-cannot-join-voice).

### Webhooks and clean-up

**By default, LiveKit sends no webhooks.** Neither shipped LiveKit config
(`Server/livekit.yaml.example`, or the one `Server/ws/livekit_process.go`
writes) turns them on. The server relies on its own LiveKit API calls and on
clients' `voice_leave` messages instead.

**Cleaning up dropped users.** Sometimes a user's LiveKit connection dies
without a `voice_leave`. To catch that, once a minute the server asks LiveKit
who is in each room that has a voice member
(`Server/ws/voice_reconcile.go`):

- A member missing from LiveKit for two checks in a row is removed.
- The same check lists every room LiveKit has open, and removes any
  participant with no matching voice state, even in a room nobody is in voice
  for.

**Optional: turn webhooks on.** If you run LiveKit yourself, it can post
webhooks to `POST /api/v1/livekit/webhook`. This needs LiveKit to reach
OwnCord at a URL whose TLS certificate it trusts. OwnCord's default
self-signed certificate fails LiveKit's check, so the managed LiveKit is never
set up this way.

Add this block to your `livekit.yaml`. A commented copy is in
`Server/livekit.yaml.example`. On compose the key comes from `.env`, and a
webhook that names another key stops LiveKit from starting.

```yaml
webhook:
  api_key: YOUR_API_KEY # your LIVEKIT_API_KEY from .env (compose), or your voice.livekit_api_key / keys: entry when you run LiveKit yourself
  urls:
    - https://chat.example.com/api/v1/livekit/webhook
```

The sender's address must be in `server.livekit_webhook_allowed_cidrs`. By
default that falls back to `server.admin_allowed_cidrs`.

What the endpoint does:

- It checks the webhook's signed token (JWT).
- On `participant_joined`, it removes a participant with no matching voice
  state as soon as it joins.
- On `participant_left`, it cleans up the leftover voice state straight away,
  instead of at the next check.

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

See [Scheduling backups from outside the server](backups.md#backups-from-cron)
and [Restoring without a running server](backups.md#when-the-server-will-not-start).

## Background maintenance

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

## Graceful shutdown

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
[Running from a console window](#from-a-console-window)).

## Sources

For readers who want the evidence behind the claims above:

- Expired self-signed certificates keep working:
  `Server/auth/tls_expiry_test.go` (`TestExpiredSelfSignedCertIsServedAsIs`),
  and the fingerprint checks in `Client/src-tauri/src/tofu.rs`.
- 2FA secrets are decrypted before the code is checked:
  `Server/service/auth.go`.
- The disk-full and restore behaviour was measured by the failure drills in
  `Server/cmd/smoke` (`-drills`), described in
  [data-lifecycle.md](../architecture/data-lifecycle.md).
- The upgrade and rollback rehearsal: `Server/cmd/smoke` and
  `.github/workflows/upgrade-rehearsal.yml`.
