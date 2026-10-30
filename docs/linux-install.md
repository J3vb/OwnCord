# Install the OwnCord desktop app on Linux

This page shows you how to install the OwnCord desktop app on Linux. It is for
people who run their own server and want the app on a Linux desktop. To set up
the server itself, read [quick-start.md](quick-start.md).

Every release publishes two kinds of Linux app file:

- a `.deb` package, for Ubuntu, Debian and their relatives
- an `.AppImage`, a single file that runs on most distros

There is no `.rpm`, Flatpak or AUR package. On Fedora, Arch and other distros,
use the AppImage.

## Supported systems

| Item      | What you need                                                                       |
| --------- | ----------------------------------------------------------------------------------- |
| CPU       | x86-64 (`amd64`) or ARM64 (`arm64`, also called `aarch64`)                          |
| C library | glibc 2.35 or newer. This is the version in Ubuntu 22.04, which builds the release. |
| Web view  | WebKitGTK 4.1 (`libwebkit2gtk-4.1-0` on Debian and Ubuntu)                          |
| Desktop   | GNOME, KDE Plasma or another desktop, on X11 or Wayland                             |
| Sound     | PulseAudio or PipeWire. Sharing a screen with audio needs one of them.              |

The release files are named like this. `<version>` is the release number, for
example `2.3.0-beta.1`.

| Architecture | .deb                          | AppImage                             |
| ------------ | ----------------------------- | ------------------------------------ |
| x86-64       | `OwnCord_<version>_amd64.deb` | `OwnCord_<version>_amd64.AppImage`   |
| ARM64        | `OwnCord_<version>_arm64.deb` | `OwnCord_<version>_aarch64.AppImage` |

Each release also has `.sig` signature files and a checksum. See
[Verifying a Download](deployment.md#verifying-a-download) to check yours. The
Linux files are not OS-signed.

Not sure which CPU you have? Run `uname -m`. `x86_64` means x86-64. `aarch64`
means ARM64.

## Install the .deb (Ubuntu, Debian, Mint, Pop!_OS)

Use the `.deb` if your distro uses `apt`. It pulls in everything the app needs.

1. Download the file for your CPU from the
   [releases page](https://github.com/J3vb/OwnCord/releases).
2. Install it with `apt`, not `dpkg`, so apt fetches the dependencies:

   ```bash
   sudo apt install ./OwnCord_*_amd64.deb
   ```

   On an ARM64 machine, use `./OwnCord_*_arm64.deb` instead.

3. Start **OwnCord** from your application menu.

The package depends on WebKitGTK 4.1, GTK 3, the AppIndicator library, libsecret
and GStreamer. It also recommends colour emoji fonts and extra GStreamer
plugins. apt installs recommended packages by default. If you use
`--no-install-recommends`, some video files and PipeWire cameras will not work.
See [Known Limitations](known-limitations.md).

## Install the AppImage (any distro)

An AppImage is one file you can run without installing it. It works on Fedora,
Arch, openSUSE and others.

1. Download the AppImage for your CPU from the
   [releases page](https://github.com/J3vb/OwnCord/releases).
2. Make it runnable, then start it:

   ```bash
   chmod +x OwnCord_*_amd64.AppImage
   ./OwnCord_*_amd64.AppImage
   ```

   On an ARM64 machine, the file ends in `_aarch64.AppImage`.

### Ubuntu 24.04 needs libfuse2

AppImages need FUSE 2. Ubuntu 24.04 does not ship it by default. If the
AppImage says it cannot run because of FUSE, install the library:

```bash
sudo apt install libfuse2t64
```

On Ubuntu 22.04 and Debian the package is called `libfuse2`. On Fedora it is
`fuse-libs`.

### What the AppImage does not include

The AppImage uses your system's fonts and its own bundled GStreamer plugins,
which include H264/AAC video and PipeWire cameras. Installing GStreamer
packages on your system does not change what it can play. Hardware video
decoding and PipeWire cameras use your system's `libva`, `libvdpau` and
`libpipewire`; without them those parts are off and the rest still works. See
[Known Limitations](known-limitations.md).

## Recommended extras

The app runs without these. Each one turns on a feature.

### The tray icon (GNOME and Fedora)

OwnCord can keep running in the tray when you close its window. The icon needs
a tray host on your desktop. KDE Plasma, XFCE and most other desktops have one.
Stock GNOME does not.

The app checks for a tray host before it hides the window. With no host,
closing the window quits the app instead. That is safe, but the tray menu is
out of reach.

To get a tray on GNOME, install the AppIndicator extension. It is called
"AppIndicator and KStatusNotifierItem Support".

On Ubuntu and Debian:

```bash
sudo apt install gnome-shell-extension-appindicator
```

On Fedora:

```bash
sudo dnf install gnome-shell-extension-appindicator
```

Then log out and back in, and turn the extension on in the **Extensions** app.

### A keyring, to keep your logins

OwnCord saves your login and your voice encryption key in the system keyring.
This is the "Secret Service". GNOME Keyring provides it, and so does KWallet
on KDE (turn on its Secret Service option). Most full desktops already run one.

Without one, the app still works. It stores the secrets in an encrypted file
in its data folder instead. That file is weaker than a keyring. See
[Credential storage](credential-storage.md) for what it holds and its limits.

To install GNOME Keyring on Ubuntu or Debian:

```bash
sudo apt install gnome-keyring
```

Then log out and back in.

### A spell-check dictionary

The message box can underline typos. The app asks the system's spell checker
(enchant) for the words, in the language of your session. If no dictionary
is installed, nothing is underlined.

On Ubuntu and Debian, install the dictionary for your language. For US English:

```bash
sudo apt install hunspell-en-us
```

On Fedora:

```bash
sudo dnf install hunspell-en-US
```

Restart the app afterwards. For another language, install its `hunspell-*`
package.

### Screen sharing on Wayland

On Wayland, your desktop shows its own window to pick a screen or window to
share. This needs `xdg-desktop-portal` and a portal for your desktop. Most
desktops install both. If they are missing:

```bash
# GNOME
sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome
# KDE Plasma
sudo apt install xdg-desktop-portal xdg-desktop-portal-kde
```

You also need PipeWire for the capture itself.

## Wayland notes

- **Rendering.** On a Wayland session the app sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` for you. This avoids blank windows and
  crashes in WebKitGTK, mostly on NVIDIA cards. To use your own value, set the
  variable to anything before you start the app. The app then leaves it alone:

  ```bash
  WEBKIT_DISABLE_DMABUF_RENDERER=0 ./OwnCord_*_amd64.AppImage
  ```

- **Screen share.** Capture on Wayland runs up to 60 fps, so the 120 fps
  option is off. Your desktop's own picker chooses the source, so OwnCord
  shows no thumbnails there. On X11 it does.
- **Global keys.** Mute, deafen and push to talk can work while OwnCord is not
  focused. On X11 the app reads the keys itself, using US-layout key
  positions. On Wayland it asks the desktop through the
  xdg-desktop-portal GlobalShortcuts interface. Your desktop may show a
  dialog the first time. A desktop without that portal cannot offer global
  keys. The tray menu still has mute and deafen. To let the desktop identify
  OwnCord, the app writes a hidden `com.owncord.client.desktop` file to
  `~/.local/share/applications` when no such file exists. On Hyprland the
  portal registers the shortcuts but does not choose their keys, so you assign
  them yourself in `hyprland.conf`. Change the keys to suit you:

  ```
  bind = CTRL SHIFT, M, global, com.owncord.client:toggle-mute
  bind = CTRL SHIFT, D, global, com.owncord.client:toggle-deafen
  bind = , F8, global, com.owncord.client:push-to-talk
  ```

## Updating

- **AppImage.** The app updates itself. When your server has a newer client,
  the app offers it. It checks the signature, then replaces the AppImage file.
- **.deb.** The app updates itself too. Click Update Now, and the desktop asks
  once for your administrator password. OwnCord then installs the new package
  and restarts. This needs a polkit password agent, which every full desktop has. On a bare
  window manager without one, or if you prefer, install the new `.deb` by hand:

  ```bash
  sudo apt install ./OwnCord_<new-version>_amd64.deb
  ```

Your server passes the update files on from GitHub Releases. See
[Client updates in deployment.md](deployment.md#client).

## Logs and troubleshooting

The app's data folder is `~/.local/share/com.owncord.client/`. Logs are in its
`logs` folder:

```text
~/.local/share/com.owncord.client/logs/owncord-client.log
```

The log rolls over at 10 MB and keeps the two previous files. **Open Log
Folder** in Settings, Diagnostics & logs opens this folder, and so does the
same item in the tray menu if you have a tray. A crash or an
unexpected exit leaves a last line in the same folder, so attach it when you
report a problem.

Common problems:

| Problem                                    | What to try                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| AppImage will not start, mentions FUSE     | Install `libfuse2t64` (Ubuntu 24.04) or `libfuse2`.                                       |
| The window is blank or crashes on Wayland  | Read [Wayland notes](#wayland-notes). Check the log for errors.                           |
| No tray icon, and closing the window quits | Install the AppIndicator extension. See [The tray icon](#the-tray-icon-gnome-and-fedora). |
| No red underlines in the message box       | Install a hunspell dictionary. See [A spell-check dictionary](#a-spell-check-dictionary). |
| Voice joins but nobody hears you           | This is usually the server's network. See [Port Forwarding](port-forwarding.md).          |

## Uninstall

Remove the app first.

For the `.deb`, find the package name, then remove it:

```bash
dpkg -l | grep -i owncord
sudo apt remove <package-name>
```

For the AppImage, delete the file.

Removing the app does not remove your data. `apt remove` leaves it too. To
delete it for good, remove these by hand. The folders may not all exist.

```bash
rm -r ~/.local/share/com.owncord.client   # data, logs, saved servers and settings
rm -r ~/.config/com.owncord.client        # window position and size
rm -r ~/.cache/com.owncord.client         # web view cache
rm ~/.config/autostart/OwnCord.desktop    # only if "start with the system" was on
```

If you used the AppImage, a leftover `.desktop` file for the `owncord://` link
handler may also be in `~/.local/share/applications/`. Look for a file with
`owncord` in its name.

Saved logins live in your keyring. To remove them, open **Passwords and Keys**
(GNOME) or **KWallet Manager** (KDE) and delete the entries for
`com.owncord.client`.
