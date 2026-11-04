# Known limitations (beta)

What OwnCord does not do yet, so you know before you run into it. Each item
links to the page that covers it.

OwnCord is a hobby project with no support promise. Who can read what is in
the [trust model](trust-model.md).

## Certificates

- **Built-in HTTPS has limits.** The default self-signed certificate is the
  tested one. Let's Encrypt works but is not tested through renewals. There is
  no HTTPS on a bare public IP address, and no guided way to make devices trust
  a server on your home network. For a public domain, a reverse proxy is the
  safest choice: [TLS and reverse proxies](hosting/tls-and-proxy.md).
- **A changed certificate shows every user a warning.** The app remembers the
  certificate the first time it connects. A normal renewal of a public
  certificate (Let's Encrypt, or a proxy with one) passes quietly. Any other
  change shows "Certificate Changed". Ask your users to compare the new
  fingerprint with you, through another channel, before they accept:
  [How the apps trust your server](hosting/tls-and-proxy.md#how-the-apps-trust-your-server).

## Server defaults

- **The server listens on every network, on port 8443.** There is no "this
  machine only" option. Use a firewall if that matters.
- **There is no connection limit by default,** and uploads can be up to 100 MB.
  You can change both: [Limits you can set](hosting/monitoring.md#limits-you-can-set).
- **The web application firewall is off by default.** See
  [Server configuration](server-configuration.md).
- **Account recovery skips two-factor sign-in.** That is on purpose: a recovery
  kit, or a code from the owner, is a complete sign-in. See
  [security.md](security.md#recovery-kit).

## Running a server

- **A locked-out owner cannot reset their own password.** Only a recovery kit
  gets you back in. Save yours at setup, or make one later in the app. Without
  one, the only way back is to restore your backup and run setup again:
  [Backups and restore](hosting/backups.md).
- **Restoring from the admin panel needs a running server.** If the server will
  not start, see
  [When the server will not start](hosting/backups.md#when-the-server-will-not-start).
- **Health checks do not send alerts.** Point your own uptime checker at the
  server: [Health checks](hosting/monitoring.md#health-checks). Docker shows
  "unhealthy" but does not restart the container.
- **Upgrades on ARM64 servers are less tested** than on x64.
- **In Docker, the admin panel cannot change `config.yaml`.** It saves its
  changes in the data folder instead. To change the file, edit it on the host
  and recreate the container:
  [Settings in a container](hosting/docker.md#settings-in-a-container).

## Desktop app

- **The Windows files are not code-signed,** so SmartScreen warns on install
  and on updates. See
  ["Windows protected your PC"](quick-start.md#windows-protected-your-pc).
- **The browser client is off by default.** The server owner turns it on in
  the admin panel. The desktop app is the main client.
- **A `.deb` install updates itself only if it can ask for your password.** On a
  bare window manager with no password prompt, install the new `.deb` by hand.

### Linux

- **Stock GNOME has no tray icon.** Install the AppIndicator extension. Without
  a tray, closing the window quits OwnCord. See
  [Recommended extras](linux-install.md#recommended-extras).
- **Global keys on Wayland need GNOME 48 or newer, or KDE Plasma.** Sway and
  older GNOME have no global push to talk, mute or deafen. On Wayland, push to
  talk only takes F1 to F24. X11 has no such limit. See
  [Wayland notes](linux-install.md#wayland-notes).
- **Some video, colour emoji and PipeWire cameras need extra packages.** The
  `.deb` installs them unless you skip recommended packages. See
  [Recommended extras](linux-install.md#recommended-extras).
- **Updating and removing depend on how you installed.** See
  [Updating](linux-install.md#updating) and
  [Uninstall](linux-install.md#uninstall).

## Voice and video

- **Voice needs open ports.** UDP for the media and TCP 7881 as a fallback. A
  web proxy cannot carry voice. If people join but hear nothing, a port is
  almost always missing: [Port forwarding](port-forwarding.md).
- **Old Linux apps (v2.0.0-beta.1 and older) can fail to join voice.** Update
  the app: [The Linux app cannot join voice](hosting/troubleshooting.md#the-linux-app-cannot-join-voice).

### On Linux

- Viewers hear a shared screen's sound in mono for now.
- On Wayland, sharing one window shares every app's sound. On X11 it shares
  only that app's sound, except for apps in a Flatpak or Snap.
- On Wayland, screen shares go up to 60 fps, and the desktop's own dialog
  picks what you share. After a reconnect you pick again.
- The mic test does not run during a call. The level bar in the call shows your
  microphone instead.
- The connection test cannot check incoming sound and video. Hearing the
  others in a call is the check.
- On Wayland, the window opens where the desktop puts it. Its size is
  remembered, its position is not.

## FAQ

**I lost the owner password and have no recovery kit.**
Restore your backup and run setup again. See
[Running a server](#running-a-server).

**My app says the certificate changed.**
The certificate was replaced or renewed. Share the new fingerprint with your
users through another channel, and ask them to compare it before they accept:
[Clients see a certificate warning](hosting/troubleshooting.md#clients-see-a-certificate-warning).

**People can join voice but nobody hears anything.**
A UDP port is not forwarded, or the server's public address changed. The fix
is in [Port forwarding](port-forwarding.md).

**I get a `403` on `/admin`.**
The admin panel only opens from the server itself and your home network by
default. See [First run](deployment.md#first-run).

**Voice works on Windows but not on Linux.**
Update the Linux app. Versions v2.0.0-beta.1 and older have voice bugs.

## See also

- [Run your server](deployment.md)
- [Trust model](trust-model.md): who can read what
- [Security for server owners](security.md)
- [Port forwarding](port-forwarding.md)
