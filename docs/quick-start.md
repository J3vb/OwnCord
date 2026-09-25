# Quick Start Guide

Get OwnCord running with the fewest possible steps.

## Choose Your Setup Path

| Goal                                 | Best path         |
| ------------------------------------ | ----------------- |
| Fastest local/LAN setup              | Prebuilt binaries |
| Linux server with easiest operations | Docker            |
| Custom dev build                     | Build from source |

## Platform Support (Current Releases)

| Component      | Windows x64 | Linux x64 | Linux ARM64       |
| -------------- | ----------- | --------- | ----------------- |
| Server binary  | Yes         | Yes       | Not published yet |
| Desktop client | Yes         | Yes       | Yes               |

## Prerequisites

- Go 1.26+ (only if building server from source)
- Node.js 26.x (see `Client/.nvmrc`) and Rust (only if building client from
  source)
- Docker + Compose v2 (Docker path only)
- LiveKit (optional, required for voice/video)

## Option A: Prebuilt binaries (recommended)

1. Download from [GitHub Releases](https://github.com/J3vb/OwnCord/releases).
2. Start the server:
   - Windows: `chatserver.exe` (x64) or `chatserver-windows-arm64.exe` (ARM64)
   - Linux: `./chatserver`, from the `amd64` or `arm64` archive
3. Open `https://localhost:8443/admin`.
4. Complete the setup wizard: it creates the Owner account and configures the
   basics (server name, port, security, uploads, voice). Your choices are
   written to `config.yaml` automatically — no manual editing needed.
5. Create invite codes and share them. A new server is **invite only** — the
   admin panel offers four choices under Settings: `closed` (nobody may
   register), `invite` (an invite code is required, the default), `approval`
   (anyone may apply, an admin approves each one) and `open` (anyone may
   register). Changing the mode is recorded in the audit log.

## Option B: Docker (Linux server)

The `docker-compose.yml`, `.env.example`, `livekit.yaml.example` and
`config.yaml.example` referenced below are **not release assets** — take them
from the source snapshot attached to each [GitHub release](https://github.com/J3vb/OwnCord/releases)
(or the repository's `Server/` directory) and run the commands there.

```bash
cd Server
cp .env.example .env
cp livekit.yaml.example livekit.yaml
cp config.yaml.example config.yaml
# Edit .env and livekit.yaml before start (set your public IP and matching
# LiveKit key/secret). In config.yaml, set voice.livekit_url to the compose
# service address `ws://livekit:7880` — the copied default is localhost.
docker compose up -d
```

Then open `https://localhost:8443/admin` and complete the setup wizard.

Full Docker details: [Deployment Guide](deployment.md#docker-linux).

### Reaching `/admin` on a headless server (VPS)

`/admin` (including the first-run setup wizard) is restricted by
`server.admin_allowed_cidrs`, which defaults to loopback and private networks
only. A VPS has no browser on it, so from your laptop the request arrives from a
public address and is refused with `403` naming that setting. Two fixes:

- **SSH tunnel (simplest).** Forward the port over SSH and browse to localhost:

  ```bash
  ssh -L 8443:localhost:8443 user@your-server
  # then open https://localhost:8443/admin locally
  ```

  The request arrives at the server from `127.0.0.1`, which the default
  allowlist already admits.

- **Add your address to the allowlist.** In `config.yaml`, list the CIDR you
  will connect from (see `server.admin_allowed_cidrs` in
  [Server Configuration](server-configuration.md)). Never widen it to
  `0.0.0.0/0`.

## Option C: Build from source

```bash
# Server (Windows)
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=1.2.0-alpha.4" .

# Server (Linux)
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=1.2.0-alpha.4" .

# Client
cd Client
npm install
npm run tauri build
```

## What Happens on First Server Start

- `config.yaml` is created with defaults.
- `data/` is created for DB, certs, uploads, and backups.
- A self-signed TLS certificate is generated.
- SQLite schema and migrations are applied.

## Windows Client: "Windows protected your PC"

The Windows installers are not code-signed, so SmartScreen warns the first time
you run one. This is expected for an unsigned open-source build, not a sign of a
problem. You will see it:

- **On first install**, when you run `OwnCord_<version>_x64-setup.exe` (or the
  `arm64` installer): click **More info**, check the app name and publisher line
  reads "Unknown publisher", then **Run anyway**.
- **On Update Now**, when the in-app updater launches the new installer. Every
  update is signature-verified against the release's updater public key before
  it is launched, so a warning here is the unsigned-installer prompt again —
  **More info → Run anyway** continues it.

If you would rather not click through, verify the download first: its checksum,
signature and provenance are published with each release — see
[Verifying a Download](deployment.md#verifying-a-download). Windows code
signing remains separate work ([Known Limitations](security.md#known-limitations)).

## Client Connection Notes

- The default server address is `https://<server-ip>:8443`.
- The desktop client uses TOFU certificate pinning:
  - First connection prompts for trust, showing the server certificate's
    SHA-256 fingerprint.
  - **Compare that fingerprint against the one the server prints in its
    start-up banner (also on the admin Dashboard and the setup wizard's finish
    step) before you accept.** Get it out of band — a channel on another
    platform, a call. A mismatch is the one warning that means an interception
    attempt; accepting a mismatch is indistinguishable from accepting one.
  - Future connections require the same cert fingerprint.
- Who can read what on a server you run or join — text is readable by the
  operator; voice and video are end-to-end encrypted, with the limits that
  document states — is in [trust-model.md](trust-model.md).
- Linux/Wayland: the client automatically sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  on Wayland sessions to work around WebKitGTK rendering crashes. Export the
  variable yourself (any value) before launching to override this.

## If Remote Users Cannot Connect

1. Use [Tailscale](tailscale.md) for the simplest remote setup.
2. Or configure [Port Forwarding](port-forwarding.md).

## Optional: enable the GIF picker

GIFs are **off by default** and each server supplies its own key — OwnCord does
not ship one, so nothing is shared between servers.

1. Request a key at [partner.klipy.com](https://partner.klipy.com).
2. Set it on the server, then restart:

```bash
# Preferred — keeps the credential out of config.yaml
OWNCORD_GIF_API_KEY=your_key_here
```

Or in `config.yaml`:

```yaml
gif:
  api_key: "your_key_here"
```

The key stays server-side; clients only ever call `/api/v1/gif/*` on their own
server. Until one is set, the client's GIF button is disabled with
"GIFs are not enabled on this server" — nothing else is affected.

## Next Steps

- [Server Configuration](server-configuration.md)
- [Deployment Guide](deployment.md)
- [LiveKit Setup](livekit-setup.md)
