# Backups and restore

## The one rule

**Copy the whole `data/` folder plus `config.yaml`, regularly, to another
disk.** The admin panel's **Download full archive** button gives you exactly
that in one zip.

The automatic backup on its own covers the **database only**. It does not
include uploads or the key files, and some of those cannot be replaced (see
[Files you cannot lose](#files-you-cannot-lose)).

## Automatic backups

In the admin panel, open **Backups & restore**. Only the Owner sees it.

- **Automatic backups:** off, daily or weekly.
- **Keep backups for (days):** `0` keeps them forever, or 7 to 3650 days. The
  newest backup is always kept.

The server also takes a database backup **before every upgrade** that changes
the database, and before every restore. It keeps the newest three of each.

### Keep them off the server's disk

Backups land in `data/backups/` by default, on the same disk as everything
else. One broken disk would then take both. Point them somewhere else:

```yaml
backup:
  dir: "/mnt/backup-disk/owncord"
```

On a Linux service, also add that folder to `ReadWritePaths`
([how](../deployment.md#running-as-a-linux-service-systemd)), or every backup
fails.

## The full archive

**Download full archive** on the **Backups & restore** page gives one zip
with the database, the whole data folder (uploads and key files) and
`config.yaml`. Keep it off the server.

- It needs free space on the backup disk of about the data folder's size.
- Only the Owner can download it, because it holds password hashes and keys.
- The download link works once and only for a minute; the download itself
  must finish within 2 hours.

The database part is always consistent. Other files are copied while chat keeps
running, so for a perfect copy stop the server and copy the folder yourself, as
in [Upgrades](upgrades.md#before-you-upgrade-take-a-copy).

## Files you cannot lose

All of these live in `data/`, which is why copying `data/` whole covers them.

| File                            | Without it                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `totp.key`                      | **Every user with two-factor sign-in is locked out for good.** Nothing resets it. |
| `erasure.key`                   | The server refuses to start after a restore.                                      |
| `erasure/markers.sqlite`        | Deleted accounts can come back after a restore.                                   |
| `push_vapid.key`                | Push notifications stop; every device has to sign up again.                       |
| `uploads/`                      | Messages still show their files, but downloads fail.                              |
| `config-overrides.json`         | Settings you changed in the admin panel go back to `config.yaml`.                 |
| `config.yaml` (next to `data/`) | The server starts on defaults, with new voice keys, so voice breaks.              |

**Never copy the database file while the server runs.** Use a backup, or stop
the server first. A live copy can be broken.

## Backups from cron

You can start a backup from your own scheduler. First make an API token on the
server. It is shown once, so store it:

```bash
./chatserver token create --label backup
```

Then, nightly at 03:00 (Linux cron):

```bash
0 3 * * * curl -sk -X POST -H "Authorization: Bearer $OWNCORD_TOKEN" https://localhost:8443/admin/api/backup
```

On Windows (PowerShell, from Task Scheduler):

```powershell
$headers = @{ "Authorization" = "Bearer $env:OWNCORD_TOKEN" }
Invoke-RestMethod -Uri "https://localhost:8443/admin/api/backup" -Method POST -Headers $headers -SkipCertificateCheck
```

List or remove tokens with `./chatserver token list` and
`./chatserver token revoke <id or label>`.

## Restore

### From the admin panel

On **Backups & restore**, click **Restore** and type the backup's name. The
server checks the backup, takes a safety copy of the current database,
restarts, and swaps them. If the swap fails, it keeps the old database. The
Dashboard tells you how it went.

Good to know:

- Everything after the backup is gone: new messages, accounts and settings.
- Uploads are never in a backup, so they stay as they are.
- A restore is **not** going back a version. The running version opens the
  restored database. To go back a version, see
  [Upgrades](upgrades.md#going-back-a-version).
- The server needs something to start it again (a service, or Docker's restart
  policy). Otherwise the restore waits until you start it yourself.

### When the server will not start

Stop the server, then put a backup back from the command line:

```bash
./chatserver restore /path/to/chatserver_20260101_030000.db          # shows what it would do
./chatserver restore --force /path/to/chatserver_20260101_030000.db  # does it
```

In Docker:

```bash
docker compose down
docker compose run --rm --no-deps owncord restore --force data/backups/chatserver_20260101_030000.db
docker compose up -d
```

It takes a safety copy first and refuses a backup made by a newer version.

If uploads, keys or `config.yaml` changed too, restore your **archive**
instead: stop the server, **remove** the live `data/` folder (do not copy on
top of it), put the archive's `data/` and `config.yaml` back, and start the
server.

What happens step by step during a restore, and the edge cases, is in the
[reference](reference.md#how-a-restore-works).
