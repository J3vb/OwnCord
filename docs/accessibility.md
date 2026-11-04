# Accessibility

This page says what the OwnCord desktop app does for keyboard users, screen
reader users and people who need larger text, more contrast or less motion.
It also lists what does not work well yet. It covers the desktop app on
Windows and Linux.

Our target is WCAG 2.2 level AA. That is a goal we test against, not a
certification: no outside auditor has checked the app.

## Settings that help

Open **Settings** (Ctrl+,) and pick a tab.

**Accessibility**

- **Reduce Motion** turns off animations and transitions.
- **Sync with OS** (on by default) also reduces motion whenever your system
  asks for less motion. Either one is enough to reduce motion.
- **High Contrast** raises contrast across the app and puts back the tested
  accent and focus colours, even if you picked your own accent.
- **Large Font** makes text at least 18 px everywhere.
- **Always underline links** underlines links in messages, not only when you
  point at them.
- **Saturation** makes coloured names and main buttons more or less vivid.
  Images and video are not changed.
- **Role Colors** turns coloured usernames in chat on or off.

**Appearance**

- **Font Size** from 12 to 20 px.
- **Zoom Level** from 50 % to 200 %. Ctrl and `+`, `-` or `0` zoom in, out
  and back to 100 % from anywhere in the app.
- **Theme**: dark, midnight, light, neon glow, or **Sync with computer** to
  follow your system's light or dark setting.
- **Compact Mode** fits more messages on screen.
- **Time Format**: 12-hour or 24-hour clocks.

**Keybinds** lets you change many shortcuts, set push to talk, and set global
mute and deafen keys that work while another app has focus.

## Using the keyboard

Everything in the app can be reached with Tab and Shift+Tab, and used with
Enter (and Space for buttons). Nothing is only reachable by hovering with a
mouse. A visible ring shows where keyboard focus is.

- **Menus.** The Menu key or Shift+F10 opens the same menu a right-click does
  on a channel, a member, a message, an image or a video tile.
- **Dialogs.** Tab stays inside an open dialog. Escape closes it and puts
  focus back where you were.
- **Lists of options** (radio groups, grids, navigation lists) are one Tab
  stop. Use the arrow keys, Home and End to move, and Enter or Space to choose.
- **Messages.** When focus moves into a message, its action buttons appear.
- **Narrow windows.** When the window is narrow or zoomed in a lot, the
  sidebar folds away. The menu button at the top opens it as a panel; Escape
  closes it.

Shortcuts (Ctrl+/ shows the full list in the app):

| Keys                               | What it does                               |
| ---------------------------------- | ------------------------------------------ |
| Ctrl+K                             | Quick switcher: jump to any channel        |
| Ctrl+F                             | Search messages                            |
| Ctrl+,                             | Open settings                              |
| Ctrl+/                             | Show keyboard shortcuts                    |
| Alt+Up / Alt+Down                  | Previous / next channel                    |
| Alt+Shift+Up / Alt+Shift+Down      | Previous / next unread channel             |
| Escape                             | Close an overlay, or mark the channel read |
| Shift+Escape                       | Mark the whole server read                 |
| Page Up / Page Down                | Scroll the chat                            |
| Up arrow (in an empty message box) | Edit your last message                     |
| Ctrl+B / Ctrl+I / Ctrl+U           | Bold / italic / underline                  |
| Ctrl+E                             | Emoji picker                               |
| Ctrl+G                             | GIF picker                                 |
| Ctrl+Shift+U                       | Upload a file                              |
| Ctrl+Shift+V                       | Turn your camera on or off                 |

Search, the camera, upload and the emoji and GIF pickers can be rebound in
**Settings › Keybinds**. Toggle Screen Share and Disconnect from Voice have no
key until you set one.

## Screen readers

The app uses standard roles and names on its controls, so a screen reader can
read buttons, fields, menus, dialogs and lists. It announces:

- form errors, next to the field that has the problem;
- "saving", "saved" and other status messages;
- toasts (the short pop-up messages);
- who is typing;
- voice connection changes in the voice panel.

Every check above is automated: tests confirm that controls have names, that
focus is visible and that keyboard paths work. **Nobody has tested the app by
hand with NVDA, Narrator, JAWS or Orca yet**, so expect rough edges.

## Colour and contrast

Text is held to at least 4.5:1 contrast against its background in every
built-in theme and in High Contrast; focus rings and control edges to at
least 3:1. Colour is never the only signal: an error says it is an error in
words.

If you pick your own accent colour, it is used for fills. For text and focus
rings the app only uses it when it is readable enough; otherwise it falls back
to the theme's tested colour. Coloured role names are lightened or darkened
the same way, so a dark role colour on a dark theme stays readable.

## Known gaps

- **No hand testing with screen readers.** See above.
- **New messages are not read out on their own.** The chat history is not a
  live region, so a screen reader does not announce a message that arrives
  while you are reading. Move to the chat to read new messages.
- **Images have no written description.** An image is announced by its file
  name. There is no way to add alt text when you upload.
- **No captions or transcripts.** Voice calls, video and voice messages have
  no captions or text version.
- **Some small text is fainter.** A few decorative and disabled labels use a
  fainter colour that is not held to the 4.5:1 rule.
- **Custom themes are not checked.** A custom CSS theme
  (**Appearance › Custom Themes**) can lower contrast or hide the focus ring.
  Ctrl+Shift+Backspace turns a custom theme off.
- **Linux on Wayland limits global keys.** Global push to talk, mute and
  deafen need a desktop with the GlobalShortcuts portal, and push to talk
  then takes function keys only. See
  [known-limitations.md](known-limitations.md#desktop-app).

## Tell us about a problem

If something in the app is hard or impossible to use with your setup, please
[open an issue](https://github.com/J3vb/OwnCord/issues/new/choose). Say what
you tried, what assistive technology or setting you use, and your operating
system. Accessibility bugs are treated like any other bug.

For contributors, the shared rules every screen follows (colours, focus,
keyboard, announcements, motion) and the checks that test them are in
[architecture/ui-contract.md](architecture/ui-contract.md).
