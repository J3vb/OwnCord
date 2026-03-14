# Claude Code Prompt Playbook

Feed these prompts to Claude Code in order. Each step builds on the previous one. Don't move to the next step until the current one compiles, runs, and works.

Test each step by actually running the exe and trying it yourself.

---

## Milestone 1: Two Exes That Connect (Week 1)

The goal: `chatserver.exe` runs, `chatclient.exe` connects to it, you see proof of connection on both sides.

### Prompt 1.1 — Server skeleton

```
@CLAUDE.md @SCHEMA.md

Create the server project in the server/ folder.

- Go module with the folder structure from the go-server skill
- SQLite database that creates itself on first run with the users, sessions, channels, and messages tables from SCHEMA.md
- config.yaml generated on first run with defaults (port 8443, server name "My Server")
- A single REST endpoint: GET /api/health that returns {"status":"ok","version":"0.1.0"}
- TLS using a self-signed certificate generated automatically on first run
- Compiles to chatserver.exe

I want to run chatserver.exe and hit https://localhost:8443/api/health in my browser and see the JSON response. That's the only goal for now.
```

### Prompt 1.2 — Registration and login

```
@CLAUDE.md @API.md @SCHEMA.md

Add auth to the server:

- POST /api/auth/register — takes username, password, invite_code. Hashes password with bcrypt. Returns a session token.
- POST /api/auth/login — validates credentials, returns session token.
- Auth middleware that validates the session token from a cookie or Authorization header.
- On first server run, auto-generate one invite code and print it to the console so I can use it to register the first account.
- Rate limiting on login: 5 attempts per minute per IP.

Don't build any other endpoints yet. I just want to be able to register and login using curl or Postman and get back a valid session token.
```

### Prompt 1.3 — WebSocket with auth

```
@CLAUDE.md @PROTOCOL.md

Add the WebSocket endpoint to the server:

- GET /ws — upgrades to WebSocket
- Client must send an "auth" message with their session token as the first message
- Server responds with "auth_ok" containing the user info, or "auth_error" and closes the connection
- After auth, server sends a "ready" message with the list of channels and online members
- Implement the Hub pattern: register/unregister clients, track who's connected
- Ping/pong heartbeat every 30 seconds
- On first run, create a #general text channel automatically

Test: I should be able to connect with a WebSocket client (like websocat or a browser console), send auth, and get back auth_ok + ready.
```

### Prompt 1.4 — Client app skeleton

```
@CLAUDE.md

Now create the client application in the client/ folder. Choose the best language and framework for a native Windows desktop app based on the requirements in CHATSERVER.md.

For now, build just:
- A connection dialog window: server address field, port field, username field, password field, a "Login" button and a "Register" button (with an invite code field that shows when Register is selected)
- On login/register success: store the session token securely (Windows Credential Manager)
- Connect to the server's WebSocket endpoint with the token
- On auth_ok: show a basic main window that just says "Connected to [server name]" and lists the online members from the ready payload
- On disconnect: show "Disconnected" with a reconnect button

This is the absolute minimum — just prove the client can connect and authenticate with the server. No chat UI yet. Compiles to chatclient.exe with a simple build command.
```

### Prompt 1.5 — Send and receive messages

```
@CLAUDE.md @PROTOCOL.md

Now wire up basic text chat between server and client.

Server:
- Handle "chat_send" WebSocket messages: validate permissions, sanitize with bluemonday, store in SQLite, broadcast "chat_message" to all clients in the channel
- Handle GET /api/channels/{id}/messages for paginated history (50 messages, before cursor)

Client:
- Replace the "Connected" placeholder with a real chat UI: channel name at top, scrollable message area in the center, text input at the bottom with a Send button
- Display incoming messages in real-time as they arrive over WebSocket
- Load message history from the REST endpoint when opening a channel
- Show username, message content, and timestamp for each message
- Basic markdown: **bold** and *italic* only for now

Test with two instances of the client connecting to the same server. Type a message in one, it should appear in the other instantly.
```

---

## Milestone 2: Usable Chat App (Week 2-3)

At this point you have two exes that connect and chat works. Now make it actually usable.

### Prompt 2.1 — Multiple channels

```
@CLAUDE.md @PROTOCOL.md @SCHEMA.md

Add multi-channel support:

Server:
- Handle channel subscriptions in the hub — only broadcast messages to clients viewing that channel
- Send channel_create/channel_update/channel_delete events
- On first run, create #general, #random, and #announcements channels

Client:
- Add a channel list sidebar on the left showing all channels
- Click a channel to switch to it and load its message history
- Show the active channel name at the top
- Unread indicator (bold channel name) when a channel has new messages you haven't seen
- Remember which channel was last open when switching back
```

### Prompt 2.2 — Invite system + roles

```
@CLAUDE.md @API.md @SCHEMA.md

Build the invite and role system:

Server:
- POST /api/invites to generate invite codes (admin only). Support max_uses and expires_in_hours.
- Invite codes required for registration — no open signup.
- Implement the role system from SCHEMA.md: Owner, Admin, Moderator, Member.
- First registered user becomes Owner automatically.
- Permission checks on all existing endpoints using the bitfield system.

Client:
- When registering, require an invite code.
- Show role names/colors next to usernames in the member list.
- The Owner should see a small admin indicator somewhere.

No admin panel yet — just the backend enforcement.
```

### Prompt 2.3 — Message features

```
@CLAUDE.md @PROTOCOL.md

Add message features:

Server:
- Handle chat_edit (own messages only), chat_delete (own or moderator+)
- Handle reaction_add, reaction_remove
- Handle replies (reply_to field)
- Typing indicator: typing_start broadcast to channel

Client:
- Right-click a message: Reply, Edit (own only), Delete (own or mod), Copy Text
- Edit mode: press up arrow to edit last message, or right-click > Edit. Shows original text in input.
- Reply: click Reply, show a small preview above the input, send with reply_to
- Reactions: hover a message to see a small emoji button, click to add reaction. Show reaction badges below messages.
- "X is typing..." indicator below the message input
```

### Prompt 2.4 — File uploads

```
@CLAUDE.md @API.md

Add file sharing:

Server:
- POST /api/uploads: multipart upload, validate magic bytes, reject executables (.exe, .bat, .ps1, .cmd, .scr, .msi), strip EXIF from images, store with UUID filename, configurable size limit from config (default 25MB)
- GET /api/files/{uuid}: serve file with auth check
- Link attachments to messages via the attachments table

Client:
- Drag and drop files onto the message area or input to upload
- Paste images from clipboard (Ctrl+V)
- Show upload progress bar
- Display uploaded images inline in the message (thumbnail, click to open full size)
- Non-image files show as a download link with filename and size
```

### Prompt 2.5 — Presence + system tray + notifications

```
@CLAUDE.md @PROTOCOL.md

Add presence, tray, and notifications:

Server:
- Track presence: online, idle, dnd, offline
- Auto-set idle after 10 minutes of no WebSocket activity
- Broadcast presence changes to all clients

Client:
- Member list shows online status icons (green dot, yellow, red, grey)
- Sort member list: online first, then idle, then offline
- System tray icon — minimize to tray on close, left-click to restore
- Unread badge count on the tray icon
- Windows toast notification when a message arrives and the window is unfocused
- Status selector in the bottom bar: online, idle, DnD, invisible
```

### Prompt 2.6 — Search + settings

```
@CLAUDE.md @API.md

Add search and user settings:

Server:
- GET /api/search with FTS5 query, scoped to channels the user can read
- PUT /api/users/me/password for password changes

Client:
- Search bar (Ctrl+K): type to search messages across all channels. Show results with channel name, author, snippet, timestamp. Click to jump to message.
- Settings window with tabs:
  - Account: change password, change avatar (upload)
  - Appearance: light/dark theme toggle, font size
  - Notifications: enable/disable, per-channel mute
```

---

## Milestone 3: Voice Chat (Week 4-6)

Text chat is solid. Now add voice.

### Prompt 3.1 — Voice channel UI + signaling

```
@CLAUDE.md @PROTOCOL.md

Add voice channel infrastructure — signaling only, no actual audio yet:

Server:
- Voice channel type in the database
- Handle voice_join, voice_leave WebSocket events
- Track voice states (who's in which channel)
- Broadcast voice_state updates to all clients
- Create one voice channel called "Voice Chat" on first run

Client:
- Show voice channels in the channel list with a speaker icon
- Click to join (sends voice_join), click again to leave
- Show connected users in the voice channel with their names
- Show a "Connected to Voice" bar at the bottom when in a voice channel with a disconnect button
- Mute and deafen buttons (just UI for now, send voice_mute/voice_deafen events)

No actual audio — just the UI and signaling to prove the voice state tracking works.
```

### Prompt 3.2 — WebRTC audio

```
@CLAUDE.md Read the webrtc-voice skill for architecture patterns.

Add actual voice audio:

Server:
- Integrate Pion as an SFU: one PeerConnection per client in a voice channel
- Forward audio tracks between clients (don't decode, just forward RTP)
- Built-in TURN relay with time-limited credentials (GET /api/voice/credentials)
- Handle voice_offer, voice_answer, voice_ice signaling messages

Client:
- On voice_join: request TURN credentials, create WebRTC PeerConnection
- Capture microphone audio, add as audio track
- Handle incoming audio tracks — play through speakers
- Audio device selection in settings (input/output dropdowns)
- Mute actually stops the audio track, deafen stops playback
- Speaking indicator: green highlight on users who are transmitting

Test: two clients in the same voice channel should hear each other talk.
```

### Prompt 3.3 — Push-to-talk + noise suppression

```
@CLAUDE.md

Add push-to-talk and noise suppression:

Client:
- Push-to-talk mode: configurable global hotkey (default: ` backtick key)
- Global keyboard hook that works even when the app is not focused (fullscreen games)
- Toggle between push-to-talk and voice activation in settings
- Voice activation mode: configurable sensitivity threshold with a live meter in settings
- Integrate RNNoise for noise suppression — toggle in audio settings
- Visual indicator when transmitting (PTT held or voice active)
```

### Prompt 3.4 — Screen sharing + video

```
@CLAUDE.md

Add screen sharing and video:

Server:
- Forward video tracks through the SFU same as audio

Client:
- "Share Screen" button in the voice channel bar
- Capture screen via DXGI Desktop Duplication, send as video track
- Cap at 720p
- When someone is sharing: show a video panel in the voice area
- Pop-out button to open in a resizable window
- "Stop Sharing" button
- Optional webcam video: toggle camera on/off, small preview
```

### Prompt 3.5 — Soundboard

```
@CLAUDE.md @SCHEMA.md

Add soundboard:

Server:
- sounds table from SCHEMA.md
- POST /api/sounds to upload (admin/mod only, <10s, <1MB)
- Handle soundboard_play WebSocket event: validate permissions, enforce 3-second cooldown
- Mix the sound into the voice channel

Client:
- Soundboard panel accessible from the voice channel bar
- Grid of sound buttons with names
- Click or hotkey to play
- Show cooldown indicator after playing
```

---

## Milestone 4: Admin Panel + Polish (Week 7-8)

### Prompt 4.1 — Admin panel

```
@CLAUDE.md @API.md

Build the web-based admin panel served at /admin:

- Simple HTML/CSS/JS (no framework), embedded in the server binary
- Login page using existing auth
- Dashboard: connected users count, total messages, disk usage, uptime
- User management: list all users, change roles, ban/unban, reset password, force logout
- Channel management: create, rename, reorder, delete
- Invite management: generate codes with expiry/max uses, view active, revoke
- Server settings: server name, MOTD, max upload size

Keep it functional and clean — this is a tool for the server admin, not a showcase.
```

### Prompt 4.2 — Moderation tools

```
@CLAUDE.md @SCHEMA.md

Add moderation:

Server:
- Kick (disconnect, can rejoin), ban (permanent, by account), temp ban (auto-expires), IP ban
- Slow mode per channel (seconds between messages per user)
- Server mute (prevent sending messages)
- Word filter: configurable blocklist with action (delete message / warn / mute)
- Audit log: every mod action logged with who, what, when, why

Client:
- Right-click user in member list: Kick, Ban, Mute (for mods+)
- Show "slow mode enabled" indicator in channels with slow mode
- Show "[message deleted by moderator]" for mod-deleted messages

Admin panel:
- Word filter configuration page
- Audit log viewer with filters
```

### Prompt 4.3 — Backups

```
@CLAUDE.md

Add backup system:

Server:
- POST /api/admin/backup to trigger manual backup
- Backup = SQLite VACUUM INTO + zip of uploads folder → data/backups/timestamp.zip
- Scheduled backups: configurable in config.yaml (default daily at 3 AM)
- Retention: keep N most recent (default 7)
- GET /api/admin/backups to list available backups
- POST /api/admin/backups/{id}/restore to restore
- CLI: chatserver.exe --restore backup.zip

Admin panel:
- Backup page: trigger manual backup button, list backups with dates and sizes, restore button
```

---

## Milestone 5: Customization + Quality of Life (Week 8-9)

### Prompt 5.1 — Custom emoji + reactions

```
@CLAUDE.md @SCHEMA.md

Add custom emoji:

Server:
- emoji table from SCHEMA.md
- POST /api/emoji — admin uploads image + shortcode
- GET /api/emoji — list all, included in the ready payload
- Serve emoji images from uploads/emoji/

Client:
- Emoji picker: show built-in unicode emoji + custom server emoji
- Type :shortcode: in a message to auto-replace with emoji
- Autocomplete dropdown when typing :
- Custom emoji show inline in messages
```

### Prompt 5.2 — Threads + pins + DMs

```
@CLAUDE.md @PROTOCOL.md

Add threads, pins, and direct messages:

Server:
- Threads: messages with reply_to form a thread, endpoint to get thread messages
- Pins: POST/DELETE /api/channels/{id}/pins/{msg_id}, max 50 per channel
- DMs: private channels between two users, created on first DM

Client:
- Click "View Thread" on a reply to open thread panel on the right
- Pin icon on pinned messages, "View Pins" button to see all pinned in a channel
- DM section in the channel list above server channels
- Click a user in the member list > "Send Message" to open/create DM
```

### Prompt 5.3 — Multi-server support

```
@CLAUDE.md

Add multi-server support to the client:

- Server list sidebar on the far left (vertical strip of server icons, like Discord/TeamSpeak)
- Each server is a separate WebSocket connection
- "+" button to add a new server (opens connection dialog)
- Right-click server icon: Edit, Remove, Copy Address
- Unread badge on server icons that have unread messages
- Switch between servers by clicking their icon — switches the channel list and message area
- Store server profiles locally in a config file next to the exe
```

---

## Milestone 6: Distribution (Week 9-10)

### Prompt 6.1 — Server systray + service mode

```
@CLAUDE.md

Add system tray and service mode to the server:

- System tray icon using getlantern/systray
- Right-click menu: Open Admin Panel (launches browser to /admin), View Logs, Restart, Quit
- Tray icon shows green when running, yellow when starting up
- chatserver.exe --service install: register as a Windows Service
- chatserver.exe --service uninstall: remove the service
- When running as a service, no tray icon (headless mode)
```

### Prompt 6.2 — Client installer

```
@CLAUDE.md

Create an NSIS installer for the client:

- Installs to C:\Program Files\ChatServer Client\
- Creates Start Menu shortcut
- Optional desktop shortcut
- Optional auto-start on boot (registry key)
- Registers chatserver:// protocol handler so invite links open the client
- Uninstaller that removes everything cleanly
- Installer size should be ~20-40MB
```

### Prompt 6.3 — Auto-update system

```
@CLAUDE.md

Add update checking to both server and client:

Server:
- GET /api/admin/update-check queries GitHub Releases API for newer version
- Admin panel shows "Update available: v1.1.0" with download button
- Download new exe, verify SHA256, replace, restart

Client:
- On launch, check GitHub Releases for new client version
- If available, show a non-blocking notification: "Update available. Download now?"
- Download installer, verify SHA256, launch installer, close current client
```

### Prompt 6.4 — First-run setup wizard

```
@CLAUDE.md

Add a first-run setup wizard to the server:

When chatserver.exe starts and no database exists:
- Open browser to https://localhost:8443/setup
- Step 1: Create admin account (username + password)
- Step 2: Name your server, upload an icon (optional)
- Step 3: Choose network mode: "Local network only" / "Port forwarding" / "Tailscale/VPN"
- Step 4: TLS — auto-configure based on network choice
- Step 5: Generate first invite link, show it with a copy button
- After completing setup, redirect to the admin panel

This replaces the "print invite code to console" from prompt 1.2.
```

---

## Tips

- **Test after every prompt.** Build, run, try it. Don't stack three prompts before testing.
- **If something breaks**, paste the error into Claude Code: "This error happens when I try to [action]. Fix it."
- **If you want to tweak something**, just tell Claude Code what you want changed. The spec files give it context.
- **The milestones are roughly weekly.** Don't rush — a working app at each milestone is better than a broken app that has "more features."
- **Milestone 1 is the most important.** Once two exes connect and chat, everything else is incremental.
