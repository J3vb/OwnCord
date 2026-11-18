# The Android app

OwnCord has an Android app for your phone. It is the same app as on the
desktop, laid out for a small screen: a drawer with your servers, sheets for
message actions, a call bar and a full-screen call view.

The Android app is the newest part of OwnCord and less tested than the desktop
app. It is not in the Play Store; you install it from the release page.

## What you need

- A phone with **Android 9 or newer** and a 64-bit ARM processor (almost every
  phone from the last few years).
- The address of an OwnCord server and an invite code, as for the desktop app.

## Install

1. On your phone, open the
   [Releases](https://github.com/J3vb/OwnCord/releases/latest) page and
   download `OwnCord_<version>_arm64.apk`.
2. Open the file. Android asks once to allow installs from your browser or
   file manager. Allow it, then tap **Install**.
3. Open OwnCord, enter the server address and sign in or use your invite code.

The first time you connect, the app shows the server's fingerprint and asks if
you trust it, just like the desktop app. Compare it with the one the server
owner sent you.

## Updates

The app checks your server for a new version when it starts. When one is
there, it shows **Update available**. Tap **Update**: the app downloads the
new version, checks its signature and opens Android's installer.

The first time, Android asks you to allow "Install unknown apps" for OwnCord.
The app opens that settings page for you. Allow it, go back and tap **Update**
again. Your sign-in and data stay.

## Notifications when the app is closed

While the app is open, a direct message or a mention shows a normal Android
notification. To also get messages and calls while the app is closed, OwnCord
uses **UnifiedPush**. It does not use Google services.

1. The server owner turns push on (see [For server owners](#for-server-owners)).
2. Install a push app. [ntfy](https://ntfy.sh) is the easiest:
   **Settings > Notifications** in OwnCord has buttons for the Play Store and
   F-Droid.
3. Go back to OwnCord. It finds the push app and sets itself up. The row
   **Notifications when the app is closed** then says **On**.

What you get:

- **New messages:** one "New messages on <server>" notification per server.
  Opening the app clears it. A push never contains the message, the channel or
  who sent it.
- **Calls:** a direct message call rings like a phone call, with Accept and
  Decline, on the lock screen too. It stops when you answer on another device
  or the caller hangs up. A missed call leaves a notification.

If the row says something else:

| It says                        | What to do                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Needs a push app               | Install ntfy (or another UnifiedPush app) and come back.                              |
| Choose a push app              | You have more than one. Pick the one OwnCord should use.                              |
| Off on this server             | The server owner has not turned push on.                                              |
| Push server not public         | Your push app uses a server on a private network. Pick a public one, such as ntfy.sh. |
| Push server port not supported | Your push server uses a port other than 443. Pick one on the normal HTTPS port.       |
| Not working                    | Open your push app once, then come back to OwnCord.                                   |

Signing out of a server, or turning off its notifications, stops its pushes.

## Calls on a phone

- Calls keep running when you switch to another app or turn the screen off.
  The call notification has **Mute** and **Leave**.
- A normal phone call pauses your OwnCord call. Your mic and sound come back by
  themselves when the phone call ends.
- On Android 12 and newer, the sound route button picks Speaker, Earpiece or a
  headset.

## Share to OwnCord

From any app, use Android's share menu and pick OwnCord to send photos,
videos, files or a link to a channel or direct message.

## For server owners

Push is off on a new server. Turn it on in the admin panel under **Server
configuration > Integrations > Push notifications**, or set `push.enabled:
true` in `config.yaml`.

With push on, your server connects to the push server each phone chose (for
example ntfy.sh) to deliver the notice. The notice carries no message text and
no names. Your server only sends to push servers on a public address and the
standard HTTPS port, so a ntfy server on your own home network does not work.
Every setting is in
[Server configuration](server-configuration.md#web-push-push).

With push on, you as the owner also get one short notice on your phone when
the admin panel has a critical warning, such as a full disk or a failed
backup.
