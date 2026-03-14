---
name: windows-native
description: Patterns for building the native Windows desktop chat client (chatclient.exe). Use this skill for any work on the client application — UI layout, Windows API integration, system tray, notifications, keyboard hooks, audio devices, credential storage, installer creation, or any code in the client/ directory. Also trigger when the user mentions push-to-talk, WASAPI, DXGI, toast notifications, systray, NSIS installer, or any Windows-specific client feature. Use this even for simple client tasks like "add a button" or "fix the settings page."
---

# Native Windows Client Patterns

Read this before writing any client code. The client is a native Windows desktop app — NOT Electron, NOT browser-based.

## Requirements Recap

The chosen language/framework must support all of these:
- Native Windows desktop UI (no embedded browser engine)
- ~20-40MB install size, ~50-100MB RAM idle
- WebSocket client for real-time chat
- WebRTC for voice/video
- WASAPI for low-latency audio
- Global keyboard hooks (push-to-talk in fullscreen games)
- System tray with badge overlay
- Windows toast notifications with action buttons
- DXGI Desktop Duplication for screen capture
- Windows Credential Manager (DPAPI) for token storage
- NSIS or WiX installer

## Window Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Server Name                              ─  □  ✕           │
├────┬──────────┬─────────────────────────────┬───────────────┤
│    │ CATEGORY │                             │ Online — 5    │
│ S1 │ # general│ [alex] Hello everyone!      │  ● alex       │
│    │ # gaming │ [jordan] Hey what's up      │  ● jordan     │
│ S2 │ # random │                             │  ● sam        │
│    │          │ [sam] Anyone want to play?   │ Offline — 2   │
│ S3 │ VOICE    │                             │  ○ pat        │
│    │ 🔊 Voice │                             │  ○ taylor     │
│    │  ● alex  │                             │               │
│    │  ● jordan│                             │               │
│    │          │                             │               │
│    │          ├─────────────────────────────┤               │
│    │          │ [message input          ] 📎│               │
├────┴──────────┴─────────────────────────────┴───────────────┤
│ 🎤 Mute  🎧 Deafen  ⚙ Settings    alex ● Online          │
└─────────────────────────────────────────────────────────────┘

Left edge: Server icons (S1, S2, S3) — click to switch servers
Second column: Channel list with categories, text (#) and voice (🔊) channels
Center: Message area (scrollable, loads history on scroll-up)
Right: Member list (collapsible)
Bottom bar: Voice controls, settings shortcut, current user status
```

## Core UI Components

### Connection Dialog (first screen)
- Server address + port fields
- Login / Register tabs
- "I have an invite code" option on Register tab
- "Remember me" checkbox
- Server profile dropdown (saved bookmarks)
- "Add Server" button to save new profiles

### Message Area
- Messages grouped by author when consecutive (show avatar + name once, then just messages)
- Timestamp shown on hover or at time gaps (>5 minutes)
- Markdown rendered: **bold**, *italic*, `code`, ```code blocks```, [links](url)
- Reply preview: small quote box above the replied-to content
- Reactions: row of emoji badges below message, click to toggle own reaction
- Edited indicator: "(edited)" text next to timestamp
- Deleted placeholder: "This message was deleted" in italic

### Settings Window (modal or separate window)
Tabs:
- **Account**: avatar upload, change password, 2FA setup
- **Appearance**: light/dark theme, font size, compact mode toggle
- **Notifications**: enable/disable, sounds on/off, per-channel overrides
- **Audio**: input device dropdown, output device dropdown, input volume slider with live meter, push-to-talk key selector, noise suppression toggle, voice activation sensitivity slider
- **Keybinds**: customizable shortcuts table

## Windows API Integration

### System Tray

```
Minimize to tray on window close (configurable in settings).
Tray icon: app icon with unread badge overlay.
Left-click: restore/focus window.
Right-click menu:
  - Show ChatServer
  - Mute All Notifications
  - Settings
  - ─────────────
  - Quit

Flash tray icon on new @mention.
Badge shows unread count (number overlay on icon).
```

### Windows Toast Notifications

```
Trigger: new message in channel or DM when window is unfocused or minimized.
Content: "[username] in #channel: message preview..."
Actions: "Reply" (opens input), "Mark Read" (clears unread).
Sound: configurable per event type (message, mention, voice join).
Respect per-channel mute settings — don't notify for muted channels.
Group notifications by channel to avoid spam.
```

### Global Keyboard Hooks (Push-to-Talk)

```
Use SetWindowsHookEx with WH_KEYBOARD_LL for low-level keyboard hook.
This captures key events system-wide, including in fullscreen games.
The hook runs in a separate thread.
When push-to-talk key is held: unmute mic, send audio.
When released: mute mic.
Visual indicator in the client UI: "Transmitting" badge or border glow.
Allow user to configure any key (including mouse buttons via WH_MOUSE_LL).
```

### WASAPI Audio

```
Enumerate audio devices: input (microphones) and output (speakers/headphones).
Let user select devices in Settings > Audio.
Use WASAPI in shared mode for low-latency capture and playback.
Feed captured audio into WebRTC audio track.
Play received audio from WebRTC to selected output device.
Noise suppression: process captured audio through RNNoise before sending.
Voice activity detection: analyze audio level, show "speaking" indicator.
```

### DXGI Desktop Duplication (Screen Sharing)

```
Use IDXGIOutputDuplication to capture the desktop.
Efficient — hardware-accelerated, low CPU overhead.
Encode captured frames and send as WebRTC video track.
Cap at 720p by default (configurable by server admin).
Show "You are sharing your screen" indicator in the UI.
Stop sharing button.
When someone else is sharing: show in a panel within the voice channel view.
Pop-out button to open screen share in a resizable window.
```

### Windows Credential Manager

```
Store auth tokens using Windows Credential Manager (DPAPI encryption).
Credential target name: "ChatServer:{server_address}"
On login success: store token.
On app launch: read stored token, attempt auto-login.
On logout: delete stored credential.
On session expired (server returns 401): delete credential, show login dialog.
Never store tokens in plaintext files or registry.
```

### Certificate Trust (TOFU)

```
When connecting to a server with a self-signed certificate:
1. First connection: show dialog "This server uses a self-signed certificate. 
   Fingerprint: SHA256:xxxx. Trust this certificate?"
2. If user accepts: save the cert fingerprint locally.
3. Future connections: verify fingerprint matches saved value.
4. If fingerprint changes: show warning "Certificate has changed! 
   This could indicate a security issue." Require explicit re-trust.
Store trusted fingerprints in local settings (per server profile).
```

## Connection & Reconnection

```
On startup:
1. Load last server profile
2. Read auth token from Credential Manager
3. Connect WebSocket to server
4. Send auth message with token
5. On auth_ok: receive ready payload, populate UI
6. On auth_error: show login dialog

On disconnect:
1. Show "Reconnecting..." indicator
2. Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
3. On reconnect: re-authenticate, request missed messages
4. If token expired: show login dialog

Connection indicator in bottom bar:
  ● Green = connected
  ● Yellow = reconnecting
  ● Red = disconnected
```

## Multi-Server Support

```
Left sidebar shows server icons (like Discord).
Each server is a separate WebSocket connection.
Server profiles stored locally:
{
    "servers": [
        {
            "name": "Friends Server",
            "address": "myserver.example.com",
            "port": 8443,
            "icon": "cached_icon.png"
        }
    ]
}
Only the active server's messages are shown.
Unread badges shown on all server icons.
Click a server icon to switch context.
"+" button at bottom to add new server.
Right-click server icon: Edit, Remove, Copy Invite Link.
```

## Installer (NSIS or WiX)

```
Install location: C:\Program Files\ChatServer\
Creates: Start Menu shortcut, optional Desktop shortcut.
Optional auto-start: adds to HKCU\...\Run registry key.
Registers protocol handler: chatserver:// 
  → opening chatserver://invite/abc123 launches client with invite dialog.
Uninstaller: removes files, registry entries, Start Menu items.
Size: ~20-40MB installed.
Include: client exe, runtime dependencies (if any), RNNoise DLL, default config.
```
