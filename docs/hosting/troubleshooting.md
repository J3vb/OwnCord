# Troubleshooting

Find your problem below. When none fits, ask for help with a
[support bundle](monitoring.md#support-bundle).

## `/health` returns 503

The `reason` says which part failed:

- **`hub`:** the chat core stopped. The server exits and your service or
  Docker starts it again. Check that it came back.
- **`database`:** the database did not answer within a second. Look at the
  last `database` lines in the log. Common causes: a full or slow disk.
- **`disk`:** free space is below `server.min_free_disk_mb`. Free some space or
  move backups to another disk. Uploads are refused; chat keeps working.

## The disk is completely full

The server keeps running and answering, but it cannot save anything new. Free
some space (delete old files, grow the disk, move `backup.dir`). Everything
recovers **without a restart**.

## The server refuses to start

The start-up message says why:

- **A bad `config.yaml`.** It names the setting and the value. Fix it.
- **The erasure key does not match.** The wrong `data/erasure.key` is in place,
  usually after a partial restore. Put the right one back from your archive.
  More in [security.md](../security.md#erasure-marker-key).
- **The database is from a newer version.** You went back a version without
  restoring the copy from before the upgrade. See
  [Upgrades](upgrades.md#going-back-a-version).
- **An unsupported `database.type`.** SQLite is the only one.
- **`Assertion failed ... /opt/owncord/data`** (Linux service): see
  [Migrating from the /opt/owncord data layout](../deployment.md#migrating-from-the-optowncord-data-layout).

## Voice joins but nobody hears anything

Almost always the UDP media port:

- It is not forwarded on your router. In Docker that is `7882/UDP`; otherwise
  `50000-60000/UDP`, or your own `voice.udp_port`.
- `voice.node_ip` is set to an old public address. Leave it empty so LiveKit
  finds the address itself.

The server cannot see this from the inside. Step-by-step checks:
[Port forwarding](../port-forwarding.md).

## Voice cannot join at all

LiveKit, the voice part, is down or unreachable.

- The admin Dashboard shows a **voice** warning, and `/api/v1/livekit/health`
  answers `503`.
- When the server runs LiveKit itself, it restarts it with growing waits and
  gives up after ten quick failures. LiveKit's own errors are in the server log
  (search for `livekit`).
- When you run LiveKit yourself, check that `voice.livekit_url` is right and
  answers.

Fixes: [LiveKit setup](../livekit-setup.md).

## The Linux app cannot join voice

Only with versions older than v2.0.1-beta.1, of the app or the server. Update
both. Until then, connect with the server's network address or name, not
`localhost`.

## Clients see a certificate warning

The certificate changed: you replaced or renewed it, or a restore brought back
a different TLS mode. Members have to accept the new fingerprint. Send it to
them through another channel: [replacing a certificate](tls-and-proxy.md#replacing-the-self-signed-certificate).

## Every 2FA user is locked out after a restore

`data/totp.key` was not restored with the rest. Nothing else can unlock their
two-factor sign-in. Put that file back from your archive
([files you cannot lose](backups.md#files-you-cannot-lose)).

## Uploads are refused

- **"Storage quota exceeded":** the user is over `upload.user_quota_mb`.
- **"Low disk":** free space is below `server.min_free_disk_mb`.
- **"Too large":** the file is over `upload.max_size_mb`.
- **"Forbidden" with no OwnCord code:** usually a reverse proxy in front with
  its own size limit (`client_max_body_size` in nginx).

## An update did not come back

See [If an update from the admin panel fails](upgrades.md#if-an-update-from-the-admin-panel-fails).

## The admin panel says 403

It only opens from the same machine or your local network by default. See
[First run](../deployment.md#first-run).
