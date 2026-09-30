# Known limitations (beta)

What the beta does not do, stated before you discover it. This is a hobby
project with no support commitment — the repository-root
[README](../README.md) says that plainly, and the [trust model](trust-model.md)
says exactly what beta does and does not claim about who can read what.

Each item links to the guidance that owns it.

## Certificates and TLS

- **The built-in certificate lifecycle is not qualified (accepted limitation).**
  `self_signed` is the qualified default; domain `acme` works but has not been
  exercised against expiry, rotation and restart; there is no HTTPS on a bare
  public IP; and there is no guided LAN/offline device-trust install. For a
  public domain the recommended setup is a reverse proxy you trust to own
  renewal — see [TLS Setup](deployment.md#tls-setup) and
  [What this build does not do](port-forwarding.md#what-this-build-does-not-do).
- **A certificate change that is not a public-CA renewal looks like a
  man-in-the-middle to desktop clients.** Every `tls.mode` pins the certificate
  on first contact. A routine renewal where the old and the new certificate are
  both publicly valid for the server's domain (Let's Encrypt, or a reverse
  proxy using a public CA) is re-pinned without a prompt. Any other change — a
  rotated self-signed or private-CA certificate, or any certificate on an
  IP-address server — shows every user the "Certificate Changed" prompt. Have
  them compare the new fingerprint out of band before accepting; accepting a
  mismatch is indistinguishable from accepting an interception — see
  [Publishing the fingerprint after a renewal](deployment.md#publishing-the-fingerprint-after-a-renewal)
  and [Rotating the self-signed certificate](deployment.md#rotating-the-self-signed-certificate).

## First-run defaults we chose not to change (accepted for beta)

- **The server binds every interface on `:8443`.** There is no loopback-only
  option; put it behind a firewall or a reverse proxy if that matters to you.
- **`server.max_ws_connections` defaults to unlimited** (`0`), and sessions
  last 30 days after last use (a year at most).
- **Uploads allow up to 100 MB** with a magic-byte blocklist rather than an
  allowlist, and the WAF is off by default. Review
  [Capacity limits](deployment.md#capacity-limits) and
  [Server Configuration](server-configuration.md) for your community.
- **Account recovery signs in without the second factor, by design.** A
  recovery kit or an owner credential is a complete login; the kit is shown once
  and rotates on use — see [security.md](security.md).

## Operating limits

- **Owner lockout has no self-service fix after setup.** An owner cannot issue
  their own recovery, and `chatserver token create` cannot reset a password.
  The setup wizard offers to generate a recovery kit for the owner at first
  run, and one can be enrolled any time from the desktop client; without a kit,
  the answer is: restore `data/` from your archive and re-run setup — see
  [Backup Strategy](deployment.md#backup-strategy) and
  [Restore](deployment.md#restore).
- **Restore needs a running server or the CLI.** `POST /admin/api/backups/{name}/restore`
  is the in-product path and needs the server (and the admin panel) to be up.
  When the server will not boot, `chatserver restore [--force] <file>` puts a
  database backup back offline; a full archive is still the supported path for
  a whole-state rollback — [Restoring without a running server](deployment.md#restoring-without-a-running-server).
- **Health is poll-only.** `/health` answers, but the server never pushes an
  alert and Docker only _surfaces_ `unhealthy` rather than restarting on it.
  Point an uptime monitor at `/health` and, for voice,
  `/api/v1/livekit/health` yourself — see
  [Monitor voice as well as liveness](deployment.md#monitor-voice-as-well-as-liveness).
- **ARM64 server upgrades are not rehearsed.** ARM64 assets are
  lifecycle-checked (boot, migrate, drain, restart) but there is no published
  ARM64 alpha to upgrade _from_ yet — see
  [How this procedure is checked](deployment.md#how-this-procedure-is-checked).
- **In Docker, `config.yaml` is read-only.** The compose file bind-mounts it, so
  the admin panel and setup wizard cannot persist a startup setting there; edit
  the host file and recreate the container —
  [config.yaml for Docker](deployment.md#configyaml-for-docker).

## Client

- **Windows installers are not code-signed.** SmartScreen warns on first
  install and on Update Now; this is expected for an unsigned build —
  [Windows Client: "Windows protected your PC"](quick-start.md#windows-client-windows-protected-your-pc).
  Code signing stays declined for the beta.
- **The browser client does not exist yet.** The desktop client is the only
  supported client; the browser adapter is post-beta work.

## Voice and video

- Voice media needs a reachable UDP port — `50000-60000` by default, or the
  single `voice.udp_port` when set (and TCP `7881`) on the LiveKit
  host; an HTTP reverse proxy cannot carry it. "Joins but no audio" is almost
  always a missing forwarding rule or a wrong `voice.node_ip` — see
  [Port Forwarding](port-forwarding.md).
- **Linux voice needs a server on 2.0.0-beta.1 or later.** The Linux client's
  native voice engine sends its room credential as an HTTP header, and servers
  from the `1.2.0-alpha.*` series drop that header and refuse the join. Update
  the server — [Linux desktop voice](deployment.md#linux-desktop-voice).
- **On Linux, a 2.0.0-beta.1 or older client that reaches a 2.0.0-beta.1 or
  older Docker Compose server on the same machine as `localhost` cannot join
  voice.** Those servers hand the client LiveKit's container-internal address
  (`ws://livekit:7880`), which does not resolve outside the container network,
  and those clients use it as-is for a `localhost` server. Update the server or
  the client — the next release of either fixes it — or connect using the
  host's LAN address or hostname instead, so voice goes through the server's
  `/livekit` tunnel —
  [Linux desktop voice](deployment.md#linux-desktop-voice).

## FAQ

**I lost the owner password and have no recovery kit.**
There is no self-service reset for an owner. Restore `data/` and `config.yaml`
from your archive, or recover with a recovery kit an owner enrolled. See
[Operating limits](#operating-limits) above and
[Backup Strategy](deployment.md#backup-strategy).

**My client says the certificate changed.**
You rotated or renewed the certificate, or restored a `config.yaml` whose
`tls.mode` differs from what the client pinned. Publish the new fingerprint out
of band and have the user compare it before accepting —
[Clients see a certificate mismatch](deployment.md#clients-see-a-certificate-mismatch).

**Voice joins but nobody hears anything.**
The UDP media port is not forwarded, or a pinned `voice.node_ip` is not your
current public address (leave it empty so LiveKit detects it, and restart after
the address changes). Both checks are in the
[Port Forwarding Guide](port-forwarding.md); the server cannot see this
failure because the media never reaches it.

**I get a `403` on `/admin`.**
`/admin` (including the first-run wizard) is restricted by
`server.admin_allowed_cidrs`, which defaults to loopback and private networks.
On a VPS, use an SSH tunnel or add your address to that setting — see
[Reaching `/admin` on a headless server](quick-start.md#reaching-admin-on-a-headless-server-vps).

**Voice works on Windows and macOS, but not on Linux.**
Two known cases, both in [Voice and video](#voice-and-video): the server is an
older `1.2.0-alpha.*` release, or a 2.0.0-beta.1 or older Linux client reaches a
Docker Compose server on the same machine as `localhost`.

## See also

- [Deployment Guide](deployment.md) — the full operator guide
- [trust-model.md](trust-model.md) — what beta does and does not claim
- [security.md](security.md) — reporting a vulnerability, known security limitations
- [port-forwarding.md](port-forwarding.md) — what the server cannot detect from inside your network
