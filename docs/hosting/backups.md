# Backups and restore

## The one rule

**Turn on Everything, and keep your backups on another disk.** Both are
settings on the **Backups & restore** page. Then the server saves the database
and a full archive for you, and one broken disk cannot take both the server and
its backups.

Without Everything, the automatic backup is the **database only**. It does not
include uploads or the key files, and some of those cannot be replaced (see
[Files you cannot lose](#files-you-cannot-lose)). You can still copy the whole
`data/` folder plus `config.yaml` yourself, or press **Download full archive**.

## Automatic backups

In the admin panel, open **Backups & restore**. Only the Owner sees it.

- **Automatic backups:** off, daily or weekly.
- **What to back up:** **Database only**, or **Everything** (database, uploads,
  keys and settings).
- **Keep backups for (days):** `0` keeps them forever, or 7 to 3650 days. The
  newest backup is always kept.

New servers start on **Everything**. A server that was already running before
this setting existed keeps taking the database only, and shows a hint until the
Owner picks one. Pick either choice and the hint goes away.

The server also takes a database backup **before every upgrade** that changes
the database, and before every restore. It keeps the newest three of each.

### What Everything does

Each time a backup is due, the server saves two files in the backup folder:

- `scheduled_<time>.db` is the database copy. **Restore** in the panel works
  with this one.
- `scheduled_<time>.zip` is the full archive. It is your copy if the whole disk
  is lost. It is not restored from the panel (see
  [Restore from a full archive](#restore-from-a-full-archive)).

Good to know:

- The archive is built in the background and kept as one file once it is
  complete. If the disk fills or the build fails, no half file is left, the
  last good archive stays, and the server tries again an hour later.
- It needs free space of about the data folder's size, plus
  `server.min_free_disk_mb`, plus 10 percent. A build that would not leave that
  much is refused.
- **At most 3 archives are kept**, newest first, even when **Keep backups for**
  is `0`. Uploads can be big. The days setting also applies: older archives go,
  but the newest always stays.
- The newest archive is never removed by the server, also after you turn
  automatic backups off or switch to **Database only**. It still holds the
  uploads it was made with, including those of members erased since. Delete it
  from the list when you no longer need it.
- If a manual **Download full archive** is running when the archive is due, the
  scheduled one waits for the next round.
- The Dashboard warns when the archive is out of date, and says why when it
  knows.
- **Create backup now** takes the database only. It is the quick one.
- The archive holds password hashes and keys. The file is private to the
  server's user. Only the Owner, or a member with **Restore Backups**, can
  download or delete one.

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

The Dashboard warns **"Your backups may be on the same disk as your server"**
when the backup folder looks to be on the same disk as the data folder, the
database folder or the uploads folder. This is a guess, not proof:

- It can miss a shared disk. A Docker overlay, a btrfs or ZFS share on one pool,
  or a network mount can look separate and still sit on the same disk.
- It can warn when the disks are different. Unraid's `/mnt/user` is one
  example. If you know the folder is on another disk, press **This is another
  disk** on the Backups page. The server remembers it for that folder. If you
  change `backup.dir`, it asks again.
- No warning does **not** mean your backups are safe. Check it yourself.

In Docker and Unraid, mount a second volume or share from another disk, and set
`backup.dir` to a path on it.

## The full archive

**Download full archive** on the **Backups & restore** page gives one zip
with the database, the whole data folder (uploads and key files) and
`config.yaml`. Keep it off the server.

- It needs free space on the backup disk of about the data folder's size.
- Only the Owner, or a member with **Restore Backups**, can download it,
  because it holds password hashes and keys.
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
- Uploads are never in a backup, so they stay as they are. The server's
  clean-up of files no message uses stands down for 7 days after a restore, so
  going back to the safety copy still finds the files it names. After that,
  files uploaded since the backup that the restored database does not name are
  removed.
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

`chatserver restore` only takes a database file. It refuses a `.zip`. If
uploads, keys or `config.yaml` changed too, restore your **archive** as below.

### Restore from a full archive

The panel and `chatserver restore` do not restore a `.zip`. Do it by hand:

1. Stop the server.
2. **Remove** the live `data/` folder (do not copy on top of it).
3. Unpack the archive. Put its `data/` folder and `config.yaml` where the old
   ones were.
4. Start the server.

Download the archive from the **Backups & restore** page, or take it from the
backup folder. Check that `data/chatserver.db`, `data/totp.key` and
`data/erasure.key` are in the unpacked `data/` folder before you start.

What happens step by step during a restore, and the edge cases, is in the
[reference](reference.md#how-a-restore-works).
