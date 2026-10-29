# Known limitations (beta)

This page lists what the beta does not do, so you know before you run into
it. It is for anyone running a server or using the desktop app. Each item
links to the guide that covers it.

OwnCord is a hobby project with no support promise. The
[README](../README.md) says so plainly. The [trust model](trust-model.md)
says exactly what the beta does and does not claim about who can read what.

## Certificates and TLS

- **The built-in certificate handling is not fully tested.** We accept this
  for the beta.
  - `self_signed` is the tested default.
  - `acme` (for a domain name) works, but it has not been tested through
    expiry, rotation and restart.
  - There is no HTTPS on a bare public IP address.
  - There is no guided way to install trust on devices for a LAN or offline
    server.

  For a public domain, we recommend a reverse proxy you trust to handle
  renewal. See [TLS Setup](deployment.md#tls-setup) and
  [What this build does not do](port-forwarding.md#what-this-build-does-not-do).

- **Most certificate changes look like an attack to the desktop app.** Every
  `tls.mode` pins the certificate the first time a client connects.
  - A routine renewal is re-pinned without a prompt, if the old and new
    certificates are both publicly valid for the server's domain. Examples are
    Let's Encrypt, or a reverse proxy using a public certificate authority.
  - Any other change shows every user the "Certificate Changed" prompt. That
    includes a new self-signed or private-CA certificate, and any certificate
    on a server reached by IP address.

  Ask your users to compare the new fingerprint, through another channel,
  before they accept. If they accept a mismatch, they cannot tell it apart
  from accepting an attack. See
  [Publishing the fingerprint after a renewal](deployment.md#publishing-the-fingerprint-after-a-renewal)
  and
  [Rotating the self-signed certificate](deployment.md#rotating-the-self-signed-certificate).

## First-run defaults we chose to keep (for beta)

- **The server listens on every network interface, on port `8443`.** There
  is no option to listen on this machine only. If that matters to you, put
  the server behind a firewall or a reverse proxy.
- **There is no limit on WebSocket connections by default.**
  `server.max_ws_connections` is `0`, which means unlimited.
- **Sessions last 30 days after last use**, and a year at most.
- **Uploads can be up to 100 MB** by default (`upload.max_size_mb`). The
  server blocks known dangerous file signatures, rather than allowing only a
  fixed list of types.
- **The web application firewall (WAF) is off by default.** Review
  [Capacity limits](deployment.md#capacity-limits) and
  [Server Configuration](server-configuration.md) for your community.
- **Account recovery signs you in without the second factor.** This is by
  design. A recovery kit, or a credential from the owner, is a complete login.
  The kit is shown once and changes each time it is used. See
  [security.md](security.md).

## Operating limits

- **An owner who is locked out cannot fix it themselves after setup.**
  - An owner cannot issue their own recovery.
  - `chatserver token create` cannot reset a password.
  - The setup wizard offers to make a recovery kit for the owner. You can
    also set one up at any time in the desktop app.
  - Without a kit, the only fix is to restore `data/` from your backup and run
    setup again. See [Backup Strategy](deployment.md#backup-strategy) and
    [Restore](deployment.md#restore).
- **Restoring needs a running server, or the command line.**
  - In the product, restore uses `POST /admin/api/backups/{name}/restore`. The
    server and admin panel must be running.
  - If the server will not start, `chatserver restore [--force] <file>` puts
    a database backup back while the server is stopped.
  - To roll back everything, a full archive is still the supported way. See
    [Restoring without a running server](deployment.md#restoring-without-a-running-server).
- **Health checks are poll-only.** `/health` answers, but the server never
  sends an alert. Docker only _shows_ `unhealthy`; it does not restart the
  container. Point your own uptime monitor at `/health`, and for voice at
  `/api/v1/livekit/health`. See
  [Monitor voice as well as liveness](deployment.md#monitor-voice-as-well-as-liveness).
- **ARM64 server upgrades are not rehearsed.** ARM64 builds are checked for
  boot, migrate, drain and restart. But there is no published ARM64 alpha to
  upgrade _from_ yet. See
  [How this procedure is checked](deployment.md#how-this-procedure-is-checked).
- **In Docker, `config.yaml` is read-only.** The compose file mounts it
  read-only. So the admin panel and setup wizard save start-up settings into
  `config-overrides.json` in the data volume, and the setup wizard cannot
  change the port. To change anything else from the file, edit it on the host
  and recreate the container. See
  [config.yaml for Docker](deployment.md#configyaml-for-docker).

## Client

- **The Windows installers are not code-signed.** SmartScreen warns on first
  install and on Update Now. This is expected for an unsigned app. See
  [Windows: "Windows protected your PC"](quick-start.md#windows-windows-protected-your-pc).
  We have decided not to code-sign during the beta.
- **There is no browser version yet.** The desktop app is the only supported
  client. A browser version is planned for after the beta.
- **A `.deb` install updates itself only where it can ask for a password.**
  The in-app update runs a root helper through `pkexec`, so it needs `pkexec`
  and a polkit agent. A bare window manager has none: the update then says
  OwnCord could not get permission, and you install the new `.deb` by hand. An
  RPM install always updates by hand.
- **On Linux, stock GNOME shows no tray icon.** GNOME has no tray of its
  own. OwnCord's tray icon shows only with the AppIndicator extension (or on
  KDE and other desktops with a tray). Without a tray host, **Close to Tray**
  does nothing: closing the window quits OwnCord. The tray's red dot for
  unread mentions needs the extension too. With the extension, left-click on
  the icon may not reach OwnCord on some desktops; use **Show/Hide** in the tray
  menu. Setup steps:
  [docs/linux-install.md](linux-install.md#recommended-extras).
- **On Linux with Wayland, global keys need a recent desktop.** Global push to
  talk, mute and deafen use the desktop's GlobalShortcuts portal. That
  exists on GNOME 48 and newer and on KDE Plasma. GNOME 47 and older, and
  wlroots desktops such as Sway, have no portal for it, so there are no global
  keys there; the tray menu's Mute and Deafen still work where there is a tray. On the portal,
  push to talk takes function keys (F1 to F24) only, and the desktop owns the
  keys while they are bound: the focused app no longer receives them. On X11 the
  app reads the keys itself and is not affected. See
  [Wayland notes](linux-install.md#wayland-notes).
- **On Linux, viewers hear screen-share audio in mono for now.** The app sends
  it in stereo, but the stereo signal is not passed on yet. This needs PulseAudio or
  pipewire-pulse to be running.
- **On Wayland, sharing one window shares every app's sound.** The desktop
  portal does not say which app owns the window, so the app sends all sound
  except OwnCord's own. On X11 a window share sends only that app's sound, as
  on Windows. An app running in a Flatpak or Snap sandbox may share no sound
  on X11, because its window reports a process id the sound server does not
  know.
- **On Linux, some media needs extra distro packages.**
  - Video attachments and YouTube embeds that use H264/AAC play only with
    `gstreamer1.0-libav` and `gstreamer1.0-plugins-bad`.
  - Emoji show in colour only with `fonts-noto-color-emoji`.
  - A camera that only works through PipeWire needs `gstreamer1.0-pipewire`.

  The `.deb` recommends all four, so apt installs them by default. It does
  not if you use `--no-install-recommends`. To add them by hand, see
  [Recommended extras](linux-install.md#recommended-extras).

  The AppImage only uses the host's fonts. It uses its own bundled GStreamer
  plugins, so installing GStreamer packages on the host does not help it.
  H264/AAC playback and PipeWire cameras do not work in the AppImage until the
  release build bundles them.

- **On Linux, updating and removing depend on how you installed.** The AppImage
  and the `.deb` update differently; see
  [Updating](linux-install.md#updating). Removing the app leaves your data
  behind; see [Uninstall](linux-install.md#uninstall).

## Voice and video

- **Voice needs an open UDP port.** By default that is the range
  `50000-60000`, or the single `voice.udp_port` if you set one (the Docker
  image and compose stack use `7882/UDP`). TCP `7881`
  must be open too. These ports are on the machine running LiveKit. An HTTP
  reverse proxy cannot carry this traffic. If people can join but hear
  nothing, the cause is almost always a missing port-forwarding rule or a
  wrong `voice.node_ip`. See [Port Forwarding](port-forwarding.md).
- **Old Linux desktop apps (v2.0.0-beta.1 and older) have two voice limits.**
  Both are fixed in v2.0.1-beta.1. Update to the latest release.
  - They cannot join voice on a `1.2.0-alpha.*` server. The Linux app sends
    its room credential as an HTTP header, and those servers drop it and
    refuse the join. Update the client or the server. See
    [Linux desktop voice](deployment.md#linux-desktop-voice).
  - They cannot join voice on a Docker Compose server of v2.0.0-beta.1 or
    older on the same machine, reached as `localhost`. Those servers give the
    app LiveKit's address inside the container network (`ws://livekit:7880`).
    That name does not work outside the containers. Update the server or the
    client. Or connect using the host's LAN address or hostname, so voice goes
    through the server's `/livekit` tunnel. See
    [Linux desktop voice](deployment.md#linux-desktop-voice).
- **On Linux with Wayland, screen shares go up to 60 fps.** The PipeWire
  capture runs at 60 fps. So the screen-share picker turns off 120 fps there,
  and a saved 120 fps setting falls back to 60.
- **On Linux, the mic test does not run during a call.** The call and the test
  would both need the microphone, and the Linux voice engine lets only one
  capture own it. **Settings › Voice & Video** says to leave the voice channel
  first. In a call the level bar already follows the call's own microphone, so
  you can still check your level and sensitivity there. On Windows the test
  also runs in a call.
- **On Linux, the connection test cannot check incoming media.** The Linux
  web view has no WebRTC, so the test has no receiver to inspect and reports
  that stage as not tested, even in a call. Hearing or seeing another
  participant in the call is the check. On Windows the test counts decoded
  audio and video for three seconds. The microphone check does open your
  microphone on both platforms.
- **On Linux with Wayland, the desktop picks what you share.** The share
  picker shows no thumbnails, because the desktop's own dialog does the
  choosing. After a reconnect the share cannot resume on its own: the desktop
  asks you to pick again.
- **On Linux with Wayland, the window opens where the desktop puts it.**
  Wayland does not let apps place their own windows, so the last window
  position is not restored. The window size is.

## FAQ

**I lost the owner password and have no recovery kit.**
There is no self-service reset for an owner. Restore `data/` and
`config.yaml` from your backup. Or recover with a recovery kit, if the owner
set one up. See [Operating limits](#operating-limits) above and
[Backup Strategy](deployment.md#backup-strategy).

**My app says the certificate changed.**
Either the certificate was replaced or renewed, or someone restored a
`config.yaml` with a different `tls.mode` from the one the app pinned. Publish
the new fingerprint through another channel. Ask each user to compare it
before they accept. See
[Clients see a certificate mismatch](deployment.md#clients-see-a-certificate-mismatch).

**People can join voice but nobody hears anything.**
Either the UDP media port is not forwarded, or `voice.node_ip` is set to an
address that is no longer your public address. Leave `voice.node_ip` empty so
LiveKit finds the address itself, and restart after your address changes. Both
checks are in the [Port Forwarding Guide](port-forwarding.md). The server
cannot see this problem, because the media never reaches it.

**I get a `403` on `/admin`.**
The admin panel, and the first-run wizard, only accept visitors from the
networks in `server.admin_allowed_cidrs`. By default that is this machine and
private networks. On a VPS, use an SSH tunnel or add your address to that
setting. See
[Reaching `/admin` on a headless server](quick-start.md#reaching-admin-on-a-headless-server-vps).

**Voice works on Windows but not on Linux.**
Check the Linux app's version. If it is v2.0.0-beta.1 or older, see
[Voice and video](#voice-and-video) above, and update it.

## See also

- [Deployment Guide](deployment.md): the full guide for running a server
- [trust-model.md](trust-model.md): what the beta does and does not claim
- [security.md](security.md): reporting a security problem, and known security
  limits
- [port-forwarding.md](port-forwarding.md): what the server cannot detect from
  inside your network
