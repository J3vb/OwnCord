# Quick Start

Get a server running and your friends connected, in a few minutes. When you
want it to start by itself and keep running, read
[Run your server](deployment.md) next.

## 1. Get the server

Download the file for your system from
[Releases](https://github.com/J3vb/OwnCord/releases):

| System        | File                            |
| ------------- | ------------------------------- |
| Windows x64   | `chatserver.exe`                |
| Windows ARM64 | `chatserver-windows-arm64.exe`  |
| Linux x64     | `chatserver-linux-amd64.tar.gz` |
| Linux ARM64   | `chatserver-linux-arm64.tar.gz` |

On Linux with Docker, use the [Docker steps](deployment.md#docker-linux)
instead and skip to step 3.

## 2. Start it

- **Windows:** double-click the file.
- **Linux:** unpack it and run `./chatserver`.

The first time, it creates its settings, a `data/` folder and its own
certificate, and prints a **setup token**. Keep that window open.

## 3. Run the setup wizard

1. Open `https://localhost:8443/admin` in a browser.
2. The browser warns about the certificate once, because the server made its
   own. Choose **Advanced**, then **Continue**.
3. Paste the setup token.
4. Create your **Owner** account and pick a server name. Voice works out of
   the box: the server downloads and runs it for you.
5. **Save your recovery kit.** It is shown only once.

Server on a VPS with no browser? See
[First run](deployment.md#first-run) for the SSH tunnel trick.

## 4. Invite your friends

Make an invite code on the admin panel's **Invites** page, or with **Invite
people** in the desktop app. Send them:

- the server address, `https://<server-ip>:8443`
- the invite code
- the certificate fingerprint, from the admin Dashboard

A new server is invite only. You can change who may join under **Settings**:
closed, invite, approval (an admin says yes to each person) or open.

## 5. Connect with the desktop app

Get the app from the same [Releases](https://github.com/J3vb/OwnCord/releases)
page. On Linux, see [Linux install](linux-install.md).

The first time you connect, the app shows the server's fingerprint and asks if
you trust it. **Compare it with the one the server owner sent you.** After
that, the app remembers it, and warns if it ever changes. An unexpected warning
can mean someone is listening in, so check with the owner before you accept.

What the server owner can and cannot read: [trust-model.md](trust-model.md).
In short, the owner can read text chat; calls are end-to-end encrypted.

### "Windows protected your PC"

The Windows installers are not code-signed yet, so SmartScreen warns the first
time, and again on each update. Click **More info**, check it says "Unknown
publisher", then **Run anyway**. The app checks each update's signature
itself. To check a download by hand, see
[Verifying a download](hosting/reference.md#verifying-a-download).

## Friends outside your home cannot connect?

- Easiest: [Tailscale](tailscale.md), no router changes.
- Or open the ports on your router: [Port forwarding](port-forwarding.md).

## Next steps

- [Run your server](deployment.md): start at boot, backups, upgrades.
- [Server configuration](server-configuration.md): every setting, including
  the optional [GIF picker](server-configuration.md#gif-picker-gif).
- [Known limitations](known-limitations.md): what the beta does not do yet.
- Building it yourself: [contributing.md](contributing.md).
