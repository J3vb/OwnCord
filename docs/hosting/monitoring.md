# Monitoring

## Logs

The server prints its log to the screen (standard output). Where it ends up
depends on how you run it:

| How you run it | Read the log with                                   |
| -------------- | --------------------------------------------------- |
| Linux service  | `journalctl -u owncord -f`                          |
| Docker         | `docker compose logs -f owncord`                    |
| NSSM (Windows) | the file you set in `AppStdout` ([how](windows.md)) |

The admin panel's **Logs** page shows the same lines live, and its **History**
tab searches the last 7 days.

- Change how much is logged with `logging.level` (`debug`, `info`, `warn`,
  `error`). The **Logs** page can switch to `debug` for a while.
- Voice (LiveKit) lines appear in the same log when the server runs LiveKit
  itself. In the Docker compose stack, read them with
  `docker compose logs livekit`.
- Passwords, keys and tokens are never logged. Usernames and addresses are, so
  treat a copied log as personal data.

## Health checks

Point an uptime checker at **both** of these:

| Check  | Address                  | Healthy                    |
| ------ | ------------------------ | -------------------------- |
| Server | `/health`                | `200` with `"status":"ok"` |
| Voice  | `/api/v1/livekit/health` | `200` with `"status":"ok"` |

`/health` is public. When something is wrong it answers `503` and names the
part in `reason`: `hub`, `database` or `disk`. See
[Troubleshooting](troubleshooting.md#health-returns-503).

`/health` does **not** check voice, so a green `/health` does not mean calls
work. The voice check only answers your own network by default. To let an
outside monitor in, add its address to `server.livekit_webhook_allowed_cidrs`,
and keep your local networks in that list too, or voice clean-up gets slower.

The server does not restart itself when it hangs, and it does not send
alerts. Use your uptime checker, or a cron job, to restart the service after a
few failed checks.

## Metrics

`/api/v1/metrics` gives numbers about the running server, as JSON.
`/api/v1/metrics/prometheus` gives the same for Prometheus. Both answer only
the addresses in `server.metrics_allowed_cidrs` (or the admin list when that
is empty).

The few worth an alert:

- `broadcast_drops` or `topic_sheds_total` going up at all: messages were lost.
- `disk_low` is `true`: uploads are refused until you free space.
- `livekit_healthy` is `false`: voice is down.
- `ws_conn_rejects` going up: you hit your connection limit.

Every field, and a Prometheus scrape config, is in the
[reference](reference.md#metrics).

## Support bundle

When you ask for help, send a support bundle. It holds settings, versions and
counts, never messages, names, addresses or raw log lines. Nothing is
uploaded: it is a download you choose to share.

1. Admin panel, **Diagnostics**.
2. **Create support bundle preview**, and check the list.
3. **Confirm download**.

If the log shows the problem, you can add the last 200 lines yourself. Say
that you did: those lines contain usernames and addresses.

**Problems in the desktop app** have their own bundle: **Settings → Diagnostics
& logs → Export Support Bundle**. It copies the app's logs as they are, so look
through it before you share it. The app's log folder:

- Windows: `%LOCALAPPDATA%\com.owncord.client\logs`
- Linux: `~/.local/share/com.owncord.client/logs`

The tray icon's **Open Log Folder** opens it, even when the window never
appeared.

## Limits you can set

| Setting                               | Default  | When you hit it                                   |
| ------------------------------------- | -------- | ------------------------------------------------- |
| `server.max_ws_connections`           | no limit | New connections are refused until others leave.   |
| `upload.max_size_mb`                  | 100      | A bigger file is refused.                         |
| `upload.user_quota_mb`                | no limit | A user's upload is refused once they are over it. |
| `server.min_free_disk_mb`             | 256      | Uploads are refused. Chat keeps working.          |
| `security.auth_rate_limit_multiplier` | 1.0      | Sign-ins are refused for a while.                 |

Raise `security.auth_rate_limit_multiplier` when many members share one
internet connection, such as a school or office. The defaults expect about one
person per address.

**Open-file limit.** Each connected person uses one "open file". The shipped
service and compose files set 65,536, which is plenty. If you run the program
some other way, make sure `ulimit -n` is well above twice the number of people
you expect online. The server warns at start-up when it is too low.

How many people one server carries on which hardware: [Capacity](../capacity.md).
