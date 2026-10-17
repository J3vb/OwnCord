# Linux release checklist

Run this by hand before you tag a release. Do it on all three sessions:

1. **X11.** For example Ubuntu on Xorg.
2. **GNOME Wayland.** GNOME 48 or newer.
3. **KDE Plasma Wayland.**

A session passes only when every item passes. If one item fails, do not tag.
Write the failure down and fix it first. This is linked from the
[Release procedure](contributing.md#release-procedure).

## Before you start

- Use the release candidate build, not a dev build.
- Have a second person or a second device in a voice channel.
- Have a headset and a camera.
- Know your session type. Run `echo $XDG_SESSION_TYPE`. It prints `x11` or
  `wayland`.
- Do the items in order. Later ones need the earlier ones.

## Copy this table for each session

Session: ______________ Desktop version: ______________ Build: ______________

Tester: ______________ Date: ______________

| #   | Item                              | Pass | Fail | Notes |
| --- | --------------------------------- | ---- | ---- | ----- |
| 1   | Install .deb and first launch     |      |      |       |
| 2   | Install AppImage and first launch |      |      |       |
| 3   | Log in                            |      |      |       |
| 4   | Join voice, hear and be heard     |      |      |       |
| 5   | Mute and deafen in the app        |      |      |       |
| 6   | Global mute and deafen keys       |      |      |       |
| 7   | Push to talk                      |      |      |       |
| 8   | Camera on, off and switch         |      |      |       |
| 9   | Screen share with Share audio     |      |      |       |
| 10  | Pop-out window                    |      |      |       |
| 11  | Notifications and sounds          |      |      |       |
| 12  | Unread badge                      |      |      |       |
| 13  | Auto-idle goes Idle               |      |      |       |
| 14  | Close to tray with a tray         |      |      |       |
| 15  | Close with no tray                |      |      |       |
| 16  | In-app update (AppImage)          |      |      |       |
| 17  | In-app update (.deb)              |      |      |       |
| 18  | Push to talk on F13 to F24 (X11)  |      |      |       |
| 19  | Mic level bar outside a call      |      |      |       |
| 20  | Diagnostics microphone check      |      |      |       |
| 21  | Open Log Folder with no tray      |      |      |       |

## 1. Install the .deb and first launch

Do:

1. On a clean user, run `sudo apt install ./OwnCord_*.deb`.
2. Start OwnCord from the app menu.

You should see:

- apt installs it with no errors.
- OwnCord is in the app menu with its icon.
- The window opens and shows the connect screen.

## 2. Install the AppImage and first launch

Do:

1. Download the AppImage. Run `chmod +x` on it.
2. Start it.

You should see:

- The window opens and shows the connect screen.
- The icon is shown. It is not a blank square.

## 3. Log in

Do: enter the server address and log in.

You should see:

- You reach the chat.
- Close the app and open it again. You are still logged in.

## 4. Join voice, hear and be heard

Do: join a voice channel with the other person. Talk. Let them talk.

You should see:

- You hear them.
- They hear you.
- Your speaking ring lights up when you talk.
- In Settings, Voice & Video, the level bar moves with your voice.

## 5. Mute and deafen in the app

Do: click Mute. Talk. Click it again. Then click Deafen.

You should see:

- Muted: the other person does not hear you. The icon shows muted.
- Deafened: you do not hear them, and you are muted too.
- Undo both: audio is back both ways.

## 6. Global mute and deafen keys

Do: join voice. Put another app in front, so OwnCord has no focus. Press the
mute key, then the deafen key.

Default keys are Ctrl+Shift+M and Ctrl+Shift+D.

On X11:

- Mute and deafen toggle with the window unfocused.

On Wayland:

- The first time, the desktop shows a **Set up global shortcuts** dialog. Accept it.
- Mute and deafen toggle with the window unfocused.
- Close OwnCord and open it again. The keys still work. The dialog does not
  come back.

If the Settings, Keybinds page says the desktop does not support them, that is a
fail on GNOME 48 or newer and on KDE Plasma. It is the right answer on GNOME 47 or
older, and on Sway.

## 7. Push to talk

Do: Settings, Voice & Video, set Input Mode to Push to Talk. In Keybinds, set a
key. Join voice. Put another app in front.

On X11:

- Any supported key works. A mouse side button works too.
- Hold the key: the other person hears you.
- Let go: they stop hearing you.

On Wayland:

- Use a function key, such as F8. Other keys are not offered.
- Accept the **Set up global shortcuts** dialog.
- Hold the key with the window unfocused: the other person hears you.
- Let go: they stop hearing you.
- Close OwnCord and open it again. The key is remembered.

## 8. Camera on, off and switch

Do: turn the camera on. Turn it off. Turn it on again. Switch to a second
camera in Settings while in the call.

You should see:

- Your own tile shows your video.
- The other person sees you.
- After the switch, your tile stays and shows the new camera.
- Off: the video stops for them.

If you have only one camera, mark the switch as not tested.

## 9. Screen share with Share audio

Do: start a screen share. Keep **Share audio** on. Play a video with sound in
another app. Let the other person watch.

On X11:

- The picker shows thumbnails of screens and windows.

On Wayland:

- The desktop opens its own picker. There are no thumbnails in OwnCord. This is
  normal.

You should see:

- The other person sees your screen.
- They hear the sound from your other app.
- They do not hear their own voice back, and not OwnCord's sounds.
- The sound may be mono for now. That is known and is not a fail.
- Stop the share. The picture and the sound stop.

## 10. Pop-out window

Do: open a voice or stream view in its own window with the pop-out button.

You should see:

- A second window opens with the video.
- Move it and resize it. It keeps working.
- Close it. The video comes back to the main window. Nothing crashes.

## 11. Desktop notifications and sounds

Do: in Settings, Voice & Video, pick a speaker that is not the default. Ask the
other person to send you a message and mention you, while the window is in the
background. Then ask them to call you or join your channel.

You should see:

- A desktop notification appears.
- Click it. The OwnCord window comes to the front.
- The message sound, join sound and ring play on the speaker you picked.
- Use a different speaker and test again. The sound moves with it.

## 12. Unread badge

Do: leave OwnCord in the background. Ask the other person to mention you twice.

You should see:

- The tray icon shows a red dot. Its title shows the count.
- On KDE, the launcher icon shows the count.
- Open the channel. The dot and the count go away.

On stock GNOME the tray needs the AppIndicator extension. Install it for this
item.

## 13. Auto-idle goes Idle

Do: leave the keyboard and mouse alone for 10 minutes, with OwnCord in the
background. Then move the mouse.

You should see:

- Your status changes to Idle.
- It goes back to Online when you move the mouse or press a key.
- This works when you used another app, not only OwnCord.

## 14. Close to tray with a tray

Do: use a desktop that shows a tray. On GNOME, turn on the AppIndicator
extension. Make sure Settings, Advanced, **Close to Tray** is on. Close the
window.

You should see:

- The window hides. OwnCord keeps running.
- Voice stays connected if you were in a call.
- Open the tray menu. Click **Show/Hide**. The window comes back.
- Left-click on the tray icon may do nothing on some desktops. Use the menu.
- Tray menu, **Quit**: OwnCord exits.

## 15. Close with no tray

Do: use stock GNOME with no AppIndicator extension. Make sure **Close to Tray**
is on. Close the window.

You should see:

- OwnCord really quits. It does not hide.
- Nothing is left running. Check with `pgrep -ai owncord`.
- Start it again. It opens normally.

## 16. In-app update (AppImage)

Do: install an older AppImage build. Point it at a server that offers the
new release. Click Update Now.

You should see:

- The update downloads.
- OwnCord restarts on the new version.
- Settings shows the new version number.

## 17. In-app update (.deb)

Do: install an older .deb build. Point it at a server that offers the new release.
Click Update Now. Give your password when the system asks.

You should see:

- The update downloads.
- The system asks for your password once.
- OwnCord restarts on the new version.

On Ubuntu 24.04, also run it from one release to the next: install the
previous release's .deb, then update to this release candidate.

- Cancel the password prompt once. OwnCord stays on the old version and the
  banner says "Update cancelled." with Retry. It does not hang or crash.
- Give your password the second time. The update then finishes as above.

## 18. Push to talk on F13 to F24 (X11)

Run this on X11 only. Mark it **Not applicable** on the Wayland sessions.

Do: Settings, Voice & Video, set Input Mode to Push to Talk. In Keybinds, bind
F13. Join voice. Put another app in front. Repeat with F24 and one key between
them. If your keyboard has no such keys, use a remapping tool to send them.

You should see:

- The key is accepted in Keybinds and shown by name.
- Hold the key: the other person hears you.
- Let go: they stop hearing you.
- Close OwnCord and open it again. The key is remembered.

## 19. Mic level bar outside a call

Do: open Settings, Voice & Video. Do not be in a call. Talk. Then join a voice
channel, leave it, and look at the bar again.

You should see:

- The level bar moves with your voice with no call running.
- In the call, the bar still moves.
- After you leave the call, the bar moves again. It does not stay frozen.

## 20. Diagnostics microphone check

Do: open Settings, Diagnostics & logs. Run the connection diagnostics with
**Include a brief microphone permission check** on.

You should see:

- The Microphone row finishes with a result. It does not stay on a spinner.
- With a working microphone it passes.
- Unplug the microphone or block it in the system sound settings, and run it
  again. The row fails with a message that says why.

## 21. Open Log Folder with no tray

Do: use stock GNOME with no AppIndicator extension, so there is no tray. Open
Settings, Diagnostics & logs. In **Get help**, click **Open Log Folder**.

You should see:

- The file manager opens the OwnCord log folder. It contains
  `owncord-client.log`.
- Nothing else changes. No error shows under the button.
- On KDE and X11, the button does the same.
