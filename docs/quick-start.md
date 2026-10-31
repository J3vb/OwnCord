# Quick Start Guide

This page is for anyone who wants to run their own OwnCord server. It gets a
server running in as few steps as possible. For a longer-term setup, read the
[Deployment Guide](deployment.md) next.

## Choose how to install

| What you want                         | Use                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| The fastest setup on your own network | [Option A: download the server](#option-a-download-the-server-recommended) |
| A Linux server that is easy to run    | [Option B: Docker](#option-b-docker-linux-server)                          |
| Your own build, for development       | [Option C: build from source](#option-c-build-from-source)                 |

## Platform support

| Part          | Windows x64 | Windows ARM64 | Linux x64 | Linux ARM64                |
| ------------- | ----------- | ------------- | --------- | -------------------------- |
| Server        | Yes         | Yes           | Yes       | Yes (from `v2.0.0-beta.1`) |
| Desktop app   | Yes         | Yes           | Yes       | Yes                        |
| Docker server | No          | No            | Yes       | Yes                        |

Every server download comes in `amd64` and `arm64` versions. The Docker image
is one tag that covers both `linux/amd64` and `linux/arm64`. The file names are
in the table in [Deployment](deployment.md#download).

## What you need

- **Option A:** nothing extra.
- **Option B:** Docker with Compose v2.
- **Option C:** Go 1.27 or newer for the server. Node.js 26.x (see
  `Client/.nvmrc`) and Rust for the desktop app.
- **Voice and video (optional):** LiveKit. On Windows and bare-metal Linux the
  server can download and start LiveKit for you. See
  [LiveKit Setup](livekit-setup.md).

## Option A: download the server (recommended)

1. Download the server from
   [GitHub Releases](https://github.com/J3vb/OwnCord/releases).
2. Start it:
   - Windows x64: `chatserver.exe`
   - Windows ARM64: `chatserver-windows-arm64.exe`
   - Linux: `./chatserver`, from `chatserver-linux-amd64.tar.gz` or
     `chatserver-linux-arm64.tar.gz`
3. Open `https://localhost:8443/admin` in a browser. The server uses a
   certificate it made itself, so the browser shows a security warning once.
   Choose **Advanced**, then **Continue**, to reach the setup wizard.
4. Follow the setup wizard. It asks for the **setup token**. The server
   printed this token when it started. The wizard:
   - creates your Owner account
   - sets the basics: server name, port, security, uploads and voice
   - saves your choices to `config.yaml`, so you do not need to edit it by
     hand
5. Make invite codes and share them. Use the admin panel's **Invites** page,
   or **Invite people** in the desktop app.

### Who can register

A new server is **invite only**. You can change this in the admin panel under
**Settings**. There are four modes:

- `closed`: nobody can register.
- `invite`: people need an invite code. This is the default.
- `approval`: anyone can apply, and an admin approves each one.
- `open`: anyone can register.

Each change of mode is recorded in the audit log.

## Option B: Docker (Linux server)

You need four files: `docker-compose.yml`, `.env.example`,
`livekit.yaml.example` and `config.yaml.example`. They are **not separate
release downloads**. Get them from the source code attached to each
[GitHub release](https://github.com/J3vb/OwnCord/releases), or from the
repository's `Server/` folder. Run the commands below in that folder.

```bash
cd Server
cp .env.example .env
cp livekit.yaml.example livekit.yaml
cp config.yaml.example config.yaml
# Edit .env before you start. Set the LiveKit key and secret there, and only
# there. Never use a ' in either value; letters and digits (for example
# `openssl rand -hex 32`) are safest.
# livekit.yaml is required (compose mounts it); editing it is optional, and it
# holds no key or secret.
docker compose up -d
```

The compose file already points the server at the LiveKit container
(`ws://livekit:7880`) and turns off the server's own LiveKit download. So you
do not need to change any voice settings in `config.yaml`.

Then open `https://localhost:8443/admin` and follow the setup wizard. To find
the setup token, run:

```bash
docker compose logs owncord
```

You can also run chat and voice in one container, without compose. See
[LiveKit in Docker](hosting/docker.md#voice-in-docker). All Docker details are
in the [Deployment Guide](deployment.md#docker-linux).

### Reaching `/admin` on a headless server (VPS)

The admin panel and the setup wizard only accept visitors from certain
networks. The setting is `server.admin_allowed_cidrs`. By default it allows
only this machine (loopback) and private home or office networks.

A VPS has no browser. When you browse from your laptop, the request comes from
a public address. The server refuses it with `403` and names that setting.
There are two fixes.

**Fix 1: use an SSH tunnel (simplest).** Forward the port over SSH, then
browse to `localhost`:

```bash
ssh -L 8443:localhost:8443 user@your-server
# then open https://localhost:8443/admin on your laptop
```

The request now reaches the server from `127.0.0.1`, which the default
setting already allows.

**Fix 2: add your address to the setting.** In `config.yaml`, add the address
range you connect from to `server.admin_allowed_cidrs`. See
[Server Configuration](server-configuration.md). Never set it to `0.0.0.0/0`.

## Option C: build from source

```bash
# Server (Windows)
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .

# Server (Linux)
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=dev" .

# Desktop app
cd Client
npm install
npm run tauri build
```

A source build reports its version as `dev`. To change that, set
`-X main.version=` to the tag you built from. Release downloads already
contain their real version.

## What happens the first time the server starts

- It creates `config.yaml` with default settings.
- It creates a `data/` folder for the database, certificates, uploads and
  backups.
- It makes its own (self-signed) TLS certificate.
- It sets up the SQLite database.

## Windows: "Windows protected your PC"

The Windows installers are not code-signed. So Windows SmartScreen warns you
the first time you run one. This is normal for an unsigned open-source app. It
does not mean something is wrong.

You will see the warning:

- **When you first install.** You run `OwnCord_<version>_x64-setup.exe` (or
  the `arm64` installer). Click **More info**. Check that the publisher reads
  "Unknown publisher". Then click **Run anyway**.
- **When you click Update Now.** The app starts the new installer. The app
  checks every update's signature against the release's public key before it
  starts the installer. So the warning here is the same unsigned-installer
  message. Click **More info**, then **Run anyway**.

If you would rather not click through, check the download first. Each release
publishes a checksum, a signature and a provenance record. See
[Verifying a download](hosting/reference.md#verifying-a-download). Windows code
signing is separate work. See
[Known Limitations](security.md#known-limitations).

## Connecting with the desktop app

- The server address is `https://<server-ip>:8443` by default.
- The desktop app uses **trust on first use** (TOFU) to pin the server's
  certificate:
  1. The first time you connect, it shows the certificate's SHA-256
     fingerprint and asks if you trust it.
  2. **Before you accept, compare that fingerprint with the one the server
     shows.** The server prints it when it starts. It is also on the admin
     Dashboard and on the setup wizard's last step. Get it through another
     channel, such as a message on another platform or a call.
  3. After that, every connection must have the same fingerprint.

  A fingerprint that does not match is the one warning that can mean someone
  is intercepting your connection. If you accept a mismatch, you cannot tell
  it apart from accepting an attack.

- What the server operator can and cannot read is in
  [trust-model.md](trust-model.md). In short: the operator can read text.
  Voice and video are end-to-end encrypted, with the limits that page lists.
- **Linux with Wayland:** the app sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for
  you on Wayland. This avoids WebKitGTK rendering crashes. To override it, set
  the variable yourself (to any value) before you start the app.
- **Linux install:** for the `.deb`, the AppImage, the tray, the keyring and
  uninstalling, see [linux-install.md](linux-install.md).

## If friends outside your network cannot connect

1. The simplest fix is [Tailscale](tailscale.md).
2. Or set up [Port Forwarding](port-forwarding.md) on your router.

## Optional: turn on the GIF picker

GIFs are **off by default**. OwnCord does not ship a GIF key. Each server uses
its own, so nothing is shared between servers.

1. Ask for a key at [partner.klipy.com](https://partner.klipy.com).
2. Set it on the server, then restart the server.

The best way is an environment variable, which keeps the key out of
`config.yaml`:

```bash
OWNCORD_GIF_API_KEY=your_key_here
```

Or put it in `config.yaml`:

```yaml
gif:
  api_key: "your_key_here"
```

The key stays on the server. The desktop app only calls `/api/v1/gif/*` on its
own server. Until a key is set, the app's GIF button is turned off and says
"GIFs are not enabled on this server". Nothing else is affected.

## Next steps

- [Server Configuration](server-configuration.md)
- [Deployment Guide](deployment.md)
- [LiveKit Setup](livekit-setup.md)
- [Known Limitations](known-limitations.md)
