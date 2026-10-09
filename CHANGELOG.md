# Changelog

All notable changes to OwnCord are listed here. The repository's release
tooling (`npm run changelog`) auto-generates entries from commit messages
on each release; this file is the curated counterpart that calls out
behavioural changes operators must know about.

## How to write an entry

**Scannable lists, never walls of text.** A reader should be able to find what
affects them in about ten seconds, without reading a paragraph they do not care
about. Entries below `v1.2.0-alpha.3` do not follow this and are left as
shipped history; everything from the next release forward does.

The rules:

1. **Open with what is user-visible and what is not.** Most releases carry a
   mixture. Say which is which up front, so nobody reads twenty lines of
   repository plumbing looking for a fix.
2. **Group by the area a user recognises** — Login & connection, Voice,
   Mentions, Messages & files, Accounts & admin, Desktop UI. Not by subsystem,
   package, or which PR it came from.
3. **One line per fix.** If it needs two lines, it needs two entries or it does
   not belong here.
4. **Say what was broken, then what it does now.** "Banned users could still
   connect — ban is re-checked on connect." A reader must be able to tell
   whether it bit them, without opening the PR.
5. **Plain language.** Name the thing a user sees, not the function that owned
   the bug. `voiceJoinLeaveCurrent` means nothing to an operator; "moderator
   mute survives a channel move" does.
6. **No `OC-*` ids, no file paths, no PR-body prose.** The ledger and the pull
   request already carry those, and this file is the one place that does not
   need them. A PR number is fine where it genuinely helps someone dig.
7. **Counts belong in a summary line, not per item.** "62 fixes" once at the
   top beats a number attached to every bullet.
8. **Write the release section for end users, not contributors.** `release.yml`
   copies the tag's section verbatim onto the GitHub release page, so it opens
   with a one-paragraph intro and then **Highlights**, **Added**, **Changed**,
   **Fixed** and **Known issues** in plain language — what a user gets, not a
   wall of PR numbers. Internal, CI and test-only changes go in a short **Under
   the hood** list at the end.

Anything a user cannot observe — repository layout, CI gates, generated-code
ownership, dependency automation — gets **at most a short block at the end**,
and only when it changes something a contributor or fork holder must do
(a moved directory, a renamed module, a new required command).

## Unreleased

## v2.2.0-beta.2

**OwnCord 2.2 beta 2** is a fix-heavy follow-up to beta 1 for the self-hosted chat app with channels, direct messages, voice and video, and file sharing. It makes voice clearer and calls steadier, adds a Discord-style pop-out window for streams and cameras, and fixes a long list of Linux voice problems.

It is still a **beta and a hobby project** — don't use it for anything sensitive. Update the server and the desktop app together.

### Highlights

- **Clearer voice**: the robot-voice and chopped-quiet-mic problems are fixed, and the speaking ring lights up at normal speaking volume.
- **Pop-out window for streams and cameras**, like Discord's, with full screen.
- **Steadier DM calls**: rings arrive in order, cancel cleanly and no longer show a false "Missed call".
- **Screen share you can pick and trust**: a source picker on Windows, and a share that lowers quality on a weak link instead of freezing.
- **Linux voice** keeps working through odd audio devices, moderator mutes and quiet mics, and the Linux camera now captures at the resolution you picked.

### Added

**Voice and video**

- **Pop-out window**: Pop out opens a stream or camera in a window of its own that you can move, maximise or put in full screen (its own button, F or a double-click). Closing it, or Bring back on the tile, returns the stream to the grid. Linux gets Pop out for the first time.
- A screen and window picker when you share your screen on Windows.
- The camera defaults to 720p, and a 1080p camera also sends a 720p layer so viewers on slower links still get video.
- Screen-share audio is encoded for music instead of as a voice microphone.

### Changed

- The stream and camera hover preview in the voice sidebar is removed. The indicators and click-to-watch are unchanged.
- Per-user and output volume are capped at 100%, so joining a voice channel cannot fail on an out-of-range level.
- Linux: the camera is captured at the resolution of the preset you picked.
- The voice sidebar's channel categories reorder live when an admin moves them.
- Add Server creates your first saved profile on a fresh install.
- **For server owners:** `.html`, `.svg`, `.sh`, `.docm`, `.xlsm`, `.desktop` and `.command` uploads are refused by default (edit `upload.blocked_extensions` to allow them).
- **For server owners:** `plugins.directory` must be a folder that neither is nor holds your data, uploads or backups folder. In a container, `plugins.directory`, `tls.cert_file` and `tls.key_file` must all sit under the data folder, so move them before upgrading.
- **For server owners:** the generated LiveKit config (and `livekit.yaml.example`) detects speakers faster, which is what lights the speaking ring sooner. A hand-managed `livekit.yaml` needs the same change.
- Update checks fetch release files only from GitHub over https, redirects included.
- Adding a server whose address is already in your list is refused with a message; profiles you already have are left as they are.

### Fixed

**Voice**

- Robot-sounding or choppy voice: the input-sensitivity gate no longer chops quiet microphones.
- The "Secured" badge degrades on repeated decrypt failures even in short bursts; its grace window restarts only after a new key is installed.
- Rejoining voice no longer switches on the browser's voice isolation, which Settings never showed and could make a voice sound robotic; your saved microphone processing settings are applied every time.
- With the microphone set to Default, unplugging and replugging it moves the call back to the system default instead of staying on the device it fell back to.
- The speaking ring lights up at normal speaking volume.
- Screen share degrades instead of freezing on a weak link.
- A stalled voice connection that fails to resume now escalates to a full reconnect.
- Linux: audio devices open in any sample format at 48 kHz, the mic is republished after a moderator unmutes you, the server's voice-quality bitrate applies, and the sensitivity gate works on the native path.
- Voice sockets behind a reverse proxy are accepted when the origin names port `:443`.

**Direct-message calls**

- A call now rings the callee only after the caller's voice session is connected.
- A stale hang-up could cancel a new ring and show a false "Missed call"; call signals now arrive in order with voice events.
- A first-contact call tells the caller at once, and the callee is told if the caller hangs up early.
- A closed DM reopens on a ring, and a ring from someone who is not in the call is refused.
- Queued rings are dropped when you disconnect, and redialling has a little slack.
- In a group call where the caller leaves first, the ring now stops once the last person has left too, instead of ringing on into an empty call.
- Members who are offline no longer hold a ring open, so it ends once everyone who was online has declined.
- Camera and screen-share buttons now wait until the call has connected, instead of failing with "Join a voice channel first".
- Left alone in a 1:1 call after the other person leaves, you see `<name> left the call` with a Ring again button.

**Messages, servers and accounts**

- A reply's snippet refreshes when the original message is edited.
- The unread bar stays until you reach the real bottom, announces its count, and arrivals while scrolled away are counted.
- Typing a server address probes the server correctly, and a stale refusal error clears when you leave.
- Logout is time-limited, Cancel locks during recovery, and Settings stays open while a recovery key is requested.
- Opening a DM accepts a pending request; blocking someone revokes trust and unblocking clears old requests.
- A role with Manage Server but not Manage Channels now sees the channel list on the retention page and can add the first rule. Each member's own moderation history (warnings, timeouts, removals, bans) shows the newest 200 entries.
- Link and image previews have a fetch deadline and a length limit on image URLs.
- Uploads with padded or malformed trailing data now return 413 or 400 and leave no file behind.
- A failed avatar change now gives back its storage quota at once instead of holding it until the next cleanup.
- Replacing a timeout as someone who cannot moderate voice now releases the voice mute the old timeout held, instead of leaving it on.
- First-run setup waits its turn for password checks like sign-in does and says "try again later" when the server is busy, and the owner's setup login no longer shows as an unreviewed new login.
- Unblocking someone you had not blocked no longer clears an ignored Message Request, so their next message does not raise it again.
- Plugin HTTP responses are checked more strictly against their declared content type.
- Dragging files or images from your file manager onto OwnCord did nothing. They now attach to the message you are writing (desktop app and browser).
- Server hardening: stricter upload type checks, updater download hosts, TLS and plugin paths, push delivery, and failed-login counting.

**Support bundles**

- Support bundles keep the redacted detail of error events, and their wording and log writes are cleaner.
- Support bundles also hide names made only of punctuation and whole JSON lists or objects under identifying fields, and the preview no longer slows down on servers with thousands of similar names.

### Known issues

- **Not yet tested on a real machine:** the Windows screen-share picker, the pop-out window on Windows and Linux, and how Linux voice handles device changes.
- **Linux camera with screen share:** the crash seen in beta 1 when both are on has not been retested. If the app closes without warning, send the support bundle.
- **Linux voice sounds play on the system default speaker**, because the desktop webview cannot route them to the device you picked.
- **The Windows installers are not code-signed.** Windows shows "Windows protected your PC" on install and on Update Now; choose "More info", then "Run anyway".
- **A certificate change that is not a public-CA renewal prompts every member.** Compare the new fingerprint with the server owner out of band before accepting.
- **There is no browser client yet.** The desktop app is the only supported client.

### Under the hood

- Go toolchain 1.27.2 and `golang.org/x/net` 0.60.0; the auth and database coverage floors are restored.
- A large batch of new client tests: soak runs that hold media counters flat, stricter mocked end-to-end assertions, a console guard, and a tray menu mapping test.
- CI and repository guards are tighter: the npm audit gate, release gate, per-chunk size budgets, nightly mutation scores, and the Claude shell hook.
- Docs and plans are corrected, including data-lifecycle restore, operator guidance and Dependabot notes; no-mistakes review instructions were added.

## v2.2.0-beta.1

**OwnCord 2.2 beta 1** is the next public beta of OwnCord — a self-hosted chat app with channels, direct messages, voice and video, and file sharing, on a server you run yourself. It adds an unread bar that opens each channel where you left off, camera capture that keeps working while the window is hidden on Linux, voice sounds, and an admin page that edits almost every server setting. The Docker image now carries voice too, so one container is the whole server.

It is still a **beta and a hobby project** — try it if you are comfortable running a small server for a group of friends, and don't use it for anything sensitive. Update the server and the desktop app together.

### Highlights

- **Channels open at the NEW line**, with an unread bar and a counter on the jump-to-bottom button.
- **Linux camera that survives a hidden window**: captured natively, so screen sharing or minimizing no longer freezes it for everyone else.
- **Voice that sounds like a call**: ringback when you place a DM call, and short chimes for join, leave, mute and deafen.
- **Run the whole server from the admin panel**: every setting is explained, and almost all of them can be changed without editing `config.yaml`.
- **One Docker container for chat and voice**, plus a ready-made Unraid template.

### Added

**Messages and channels**

- An unread bar at the top of a channel says how many messages are new and since when; **Mark as read** clears it.
- The jump-to-bottom button counts new messages from other people while you are scrolled up.
- A reply to an old message shows a short snippet of the original, or "[message deleted]".
- `:` autocomplete uses the complete Discord emoji short-name table, so `:cry` is 😢 and `:sunglasses` is 😎.

**Voice and calls**

- A caller hears ringback while a DM call rings, and a toast reports "declined" or "No answer" if you are on another channel.
- Join, leave, mute and deafen play a short sound on the speaker you chose (Settings › Voice & Audio; on Linux they play on the system default speaker); turn them off under Settings › Notifications.
- Linux: the camera is captured in the app's native backend, and the camera list and self-view come from it.
- Linux: an empty camera list now names the missing GStreamer packages, and the `.deb` installs them for you.

**Desktop**

- Settings › Appearance has a **Time Format** choice, 12-hour or 24-hour.
- Trusting a new server certificate also asks in a native operating-system dialog showing the fingerprint.

**Admin and deployment**

- The owner-only **Server configuration** page edits almost every setting, applies it after a restart, and keeps secrets write-only. Risky changes ask for a typed confirmation.
- Each setting shows a plain-language name, a description, the recommended value and what changing it affects.
- The Docker image bundles LiveKit, so `docker run` serves chat and voice; voice uses UDP `7882` and TCP `7881`.
- An Unraid template is included (`deploy/unraid/owncord.xml`).

### Changed

- Voice media in the Docker image uses the single UDP port `7882` instead of the `50000-60000` range, so publish `-p 7882:7882/udp -p 7881:7881`. A compose file with a separate LiveKit must clear `OWNCORD_VOICE_LIVEKIT_BINARY` and set `OWNCORD_VOICE_UDP_PORT` to `0` for range mode (as the shipped `Server/docker-compose.yml` does) or to the same single port configured in LiveKit.
- Messages that arrive while the window is unfocused now count as unread for the channel you are viewing.
- Jumping to a message centres it, and a reply always shows who it quotes.
- Linux: a native crash now ends the client log with a line naming the signal and thread.
- The server spends less CPU delivering live events.

### Fixed

- Leaving a channel and returning keeps the history you had loaded, unless more new messages arrived than five pages of 100 can cover, in which case the oldest loaded rows are still dropped.
- A mention in another channel updates the taskbar and tray badge at once, and the badge no longer undercounts when a mention and a delete land together.
- A deleted mentioning message no longer updates the badge of someone who lost access to the channel.
- A certificate the client cannot verify now says so, instead of "Bad Gateway" or a dropped connection.
- A server counts as signed in only after it confirms the login, and saved credentials are read only for servers used this run.
- Desktop updates check the signed artifact's name against your system before installing.
- The `server.max_ws_connections` limit holds when many connections arrive at once.
- Closing Settings releases the last tab's memory.

### Known issues

- **Linux desktop:** the native camera is new and has not yet been checked on a real machine. Check it on your own setup, including with screen share on; the app can close without warning when both are on, and the new crash line is there to pin that down.
- **Linux voice sounds play on the system default speaker**, because the desktop webview cannot route them to the device you picked.
- **The Windows installers are not code-signed.** Windows shows "Windows protected your PC" on install and on Update Now; choose "More info", then "Run anyway".
- **A channel that opens at the NEW line with a backlog taller than the screen can miss unread counts.** Messages that arrive below the visible area may not be counted as unread if you leave before scrolling to the bottom.
- **A certificate change that is not a public-CA renewal prompts every member.** Compare the new fingerprint with the server owner out of band before accepting.
- **There is no browser client yet.** The desktop app is the only supported client.

### Under the hood

- Cached reply snippets, per-connection write timers and ordered mention-badge frames keep live delivery cheap and consistent.
- Certificate-trust dialogs load lazily to keep app startup within budget.
- Configuration copy for every setting ships with the server, and a test fails if a key lacks it.

## v2.1.0-beta.2

`v2.1.0-beta.1` was tagged but never published, so these notes ship as `v2.1.0-beta.2`.

**OwnCord 2.1 beta 2** is the third public beta of OwnCord — a self-hosted chat app with channels, direct messages, voice and video, and file sharing, on a server you run yourself. It is the largest release since the beta began: the full Unicode emoji set with remembered skin tones, whole-server search that pages through older results, an unread count on the taskbar and tray, notifications for incoming calls, a message list that updates in place instead of redrawing, and a server that carries a thousand or more people through a restart. Existing `2.0.1-beta.1` servers and clients upgrade in place.

It is still a **beta and a hobby project** — try it if you are comfortable running a small server for a group of friends, and don't use it for anything sensitive.

### Highlights

- **The full Unicode emoji set**, with skin tones you pick and the app remembers, loaded only when you open the picker.
- **Search the whole server**, page through older results, and keep the panel open while you jump between hits.
- **Your unread count on the taskbar and tray**, so a mention or direct message is visible even when the window is not.
- **Incoming calls are noticed when the app is hidden**, and an unanswered ring reports a missed call.
- **A faster, steadier message list**: sending, reacting, editing, deleting, reconnecting or scrolling no longer redraws the whole channel.
- **A server built for a crowd**: 1,000–2,000 people online reconnect after a restart without thrashing the database.
- **Hardened by default**: the desktop can no longer read its own credential and pin files from the web page, and login bursts queue instead of failing.

### Added

**Messages and search**

- Search covers the whole server by default and keeps its panel open when you jump to a hit, with **Load more** for older results and an "in #channel" chip to narrow it.
- Search finds a half-typed last word of three or more characters; the search API can sort newest-first and page past the first 100 results.
- The search and Ctrl+K result lists keep the highlighted row on screen.
- The `@`-mention list ranks recent channel speakers first and matches display names as well as usernames.
- Large images are served as a cached 800-pixel preview; the full file loads only when you open it.
- A file upload shows a determinate progress bar instead of an indefinite spinner.

**Emoji**

- The picker and `:` autocomplete carry the full Unicode 15.1 set (about 1,900 emoji), including Travel, Activities and Flags groups.
- A skin-tone selector is remembered and applies to `:` autocomplete and reactions; Discord-style names such as `:thumbsup` work.
- The emoji list loads lazily the first time you use it, so it does not slow down starting the app.
- The picker is keyboard-friendly: Enter inserts the first match, the arrow keys move through the grid, and a category bar jumps to a group.

**Notifications and calls**

- The taskbar and tray show your unread count (mentions plus unread direct messages); KDE and Ubuntu use the launcher count.
- An incoming DM call raises a notification, flashes the taskbar and rings; after 30 seconds it reports **Missed call from …**, with a new **Incoming Call Sound** switch.
- Desktop notifications strip markdown and hide spoilered text, and clicking one opens that message — including from a Windows Action Center toast.
- Notifications for other channels are suppressed while the window is focused, and an attachment-only message reads "sent an attachment".

**Voice and calls**

- DM calls have their own call panel, with who is in the call, the call controls, and "Calling…", declined and unanswered states; a DM call's camera or screen share can be watched from the DM.
- Watching a stream is more like Discord: click a tile to watch it large, with a speaker ring, a per-stream volume slider and right-click options, and a tile can go full screen or pop out.
- The voice connection and transport-stats panels were redesigned to read at a glance, with upload/download tiles and loss- and jitter-aware quality.
- Voice can run on a single UDP port (`voice.udp_port`) instead of the 10,000-port range, for a restrictive firewall.
- Push-to-talk keeps sending briefly after you release the key (a configurable 0–2000 ms delay) so the end of a word is not clipped.
- On Linux, sharing your screen asks what to share first, with Screens and Applications tabs, thumbnails, a quality choice and a **Go Live** button.
- Settings › Voice & Audio is grouped into microphone, speakers, camera & screen share, and voice processing cards.

**Accounts, privacy and admin**

- The server owner chooses which file types may be uploaded (`upload.blocked_extensions` / `upload.allowed_extensions`); executables are always refused by content.
- The admin panel can issue a temporary ban (1 hour to 30 days) and pages through the whole pending-registration queue.
- Backups can be downloaded from the admin panel, owner-only, through a single-use link.
- The Dashboard has a **Connectivity check** card that runs the voice and connection report and shows the result.
- "Sign out everywhere", account recovery, a password change, a two-factor change and removing a session now revoke the account's API tokens and disconnect the affected device at once.
- A refused sign-up now says why in the server log (at WARN, tied to the request id); the public response is unchanged.

**Desktop app**

- Auto-idle follows keyboard and mouse input anywhere on the computer on Windows, GNOME (X11 and Wayland) and KDE on X11.
- Alt+↑/↓ steps between channels and Alt+Shift+↑/↓ between unread channels.
- Incoming DM calls notify and report missed calls (see Notifications), and Settings shows your uploaded avatar and fetches its data only when you open it.

**Server and platform**

- The server raises its open-file limit at boot and warns when it is too low for the configured online count.
- IPv6 clients share per-address limits across their /64.
- The read-only database connection pool defaults to `max(8, 2× CPU)`.

### Changed

- The app hands off to the server about 0.8 s sooner after signing in; the fixed "Connected!" hold is gone.
- Repeat REST calls and server image fetches reuse one idle connection, and requests leave immediately instead of waiting for the OS to batch them.
- Server refusals read as plain sentences ("Incorrect username or password.") instead of raw lower-case codes.
- A registration held for approval is a neutral notice, not a red error, and an unreachable server shows plain copy instead of a raw transport string.
- "Reconnecting…" clears as soon as the network or the screen comes back, rather than waiting out the retry timer.
- A crowd signing in together now queues for up to 10 seconds (answering `AUTH_BUSY` with `Retry-After`) instead of most being refused; the login form retries by itself.
- The Invite Manager names each invite's creator and hides expired or revoked codes.
- Duplicate channel names are refused with a clear message.
- Message times roll over to "Yesterday at" at midnight, and system notices use the same 12-hour clock.
- Slow mode no longer locks the composer; you can keep typing and only Send is held back.
- Unread badges read "99+" from 100 upward, and the server counts large unread channels faster.
- Status dots use the design tokens, so the offline grey is the same everywhere.
- The DM list is in recency order and shows each conversation's last message and time; leaving a group DM asks first.
- Messages in other channels no longer pop up while the window is focused; the chime still plays and unread badges are unchanged.
- Settings › Logs is now **Diagnostics & logs**, opening with one summary line and the checks as a row of steps.
- The connection-quality readout counts packet loss and jitter, and the detailed stats pane opens only when you ask.

### Fixed

**Connection and session**

- **A server update, backup restore or restart no longer signs everyone out**: the client counts down, reconnects and returns to the channel it was in, and a voice call comes back within ten minutes.
- **A dead connection no longer stays open for up to two minutes** leaving the user showing online; the server pings every 25 seconds and closes a silent peer within about 50 seconds.
- **A half-open connection no longer stays "connected" forever**: the client treats a minute without any server frame as a dead link and redials.
- **Waking a sleeping laptop now probes at once and redials within about 15 seconds**, instead of showing Connected while nothing arrives.
- **A short network blip no longer ends a voice call** — the server holds your place for 15 seconds — and waking a laptop no longer silently takes over another computer's call.
- **An auto-login to a server that is down no longer sits on "Auto-connecting…" forever**; the first connection has a 20-second deadline, then returns to login with a "Waiting for <server>… Cancel" option and keeps checking.
- **A rejected two-factor code now shows the error inside the code card**, where the opaque overlay no longer hides it.
- **Saved servers, logins and trusted certificates survive a crash mid-save**, with atomic writes and a `.corrupt-<time>` copy that fails closed for pins.
- **A locked-out username can still be signed in from an address that recently signed in**, so a flood from elsewhere cannot lock you out of your own account.

**Messages and files**

- **A reconnect after a server restart no longer drops messages** posted in the channel you were reading, and it keeps your loaded history and scroll position.
- **The app opens on the channel you were last reading** and no longer clears another channel's unread badge on launch.
- **Fast scrolling never leaves the message list blank**, and older history loads about two screens before the top without moving your position.
- **Returning to a channel is instant and quiet**, and only the changed rows are redrawn for a reaction, edit, delete, sent message, timeout or role change.
- **A pin or unpin now reaches everyone**, and the pinned list is newest-pinned first; a pin, profile delete or invite action no longer leaves stale data behind.
- **An edit no longer discards a draft or reply**, a failed attachment or download now says so, and removing an attachment cancels its upload.
- **Link previews no longer make a message jump**, and a failed preview names the host once.
- **Clearing or shortening a search no longer repopulates old results**, and **Enter no longer sends a half-finished word** in Japanese, Chinese or Korean input.
- **Deleting a message asks first** (Shift-click deletes at once), and Pin is offered only where it will work.
- **Editing or deleting a message no longer claims success while offline**; success is confirmed by the server's echo.
- Error toasts stay until dismissed and coalesce duplicates, and Message Requests show the right time for everyone.
- **A "X is typing…" indicator clears the moment their message arrives**, and the typing strip no longer shifts the chat.
- **Attachments follow the server's real upload limit**, and a failed upload shows one error.
- Pin/profile/invite stale data (above), and a DM mention badge no longer disappears when the client reloads its DM list over REST.

**Voice and calls**

- **A long voice drop resumes** instead of ejecting you; the client keeps retrying for up to five minutes, and a quick service restart rejoins the call.
- **A voice call survives a LiveKit restart**, and the once-a-minute voice check now covers every room the media server has open.
- **Your microphone never goes out unprocessed**: sensitivity, volume and noise suppression live inside the mic track, so a reconnect or device change cannot leak raw audio, and mouse clicks no longer come through after a reconnect.
- **Push-to-talk no longer reopens the microphone on every press**, and on Linux it stays open; the mic button now reflects your own mute rather than the PTT gate.
- **Changing echo cancellation, noise suppression or gain no longer moves you to the default microphone**, and an unplugged device is remembered and switched back to on replug.
- **On Linux, a call recovers from a suspend or a sound-server restart**, and a screen share that never produces a frame gives up with an error instead of hanging.
- **Enhanced Noise Suppression now actually runs** the modern audio-worklet path, uses the current model against clicks and keyboard noise, and no longer drops you to listen-only when it fails to start.
- The sensitivity meter runs the call's own processing, the gate no longer eats the first syllable, and undeafening a member restores their audio.
- **A voice join is refused instead of minting a dead token when the media server is unreachable**, and joining a non-DM voice channel now also requires Read Messages.
- **The "Secured" badge recovers** after a brief key-delivery stall, and a changed participant key is accepted automatically with a dismissible notice.
- **The "Call" action in a member's profile now works**, an unanswered DM call no longer shows the absent callee's tile, and watching a stream is no longer a dead end.
- **The mic button, deafen and screen-share states read correctly**: a deafened member shows one icon, a cancelled screen-share picker is silent, and the Linux connection readout no longer shows a false "excellent".
- Linux desktop voice works again against a server on the same Docker host and against servers older than v2.0.0-beta.1.
- Camera-heavy calls use less bandwidth while the grid is closed or a tile is a thumbnail.

**Accounts and admin**

- **An invite code is accepted however it is pasted** — trimmed, lower-cased, or pulled out of an `owncord://invite/…` link.
- **Settings refuse values the setup wizard would refuse**, and duplicate channel names are refused with a clear message.
- **Overturning an appeal now needs the authority the reversal itself needs**, and a moderator's timeout request can no longer be silently shortened.
- **A timeout now also covers new DMs, group DMs, call rings, DM pins and custom status.**
- **Setting a custom status while timed out no longer leaves you showing a status nobody else sees.** The app applied and saved the new text straight away, but a timeout refuses it and the server broadcasts nothing, so only you saw it until a reconnect. The previous status and text are now restored in the app, and the usual timeout notice appears.
- **The admin panel no longer discards unsaved edits silently**; dialogs, the Settings form and the channel-access drawer ask first, and the update and restore dialogs stay open while their work runs.
- **The admin Dashboard no longer slows as the audit log grows**, and its nav badges refresh when you return to the tab.
- **Two manual backups in the same second no longer collide**, taking a backup no longer freezes the server's writes, and the full archive streams through a short-lived link.
- The audit log's Export CSV and Copy page no longer hand a spreadsheet a formula.
- Behind a reverse proxy, the log and audit trail now name the real client, and proxies that append their own `X-Forwarded-For` line are read correctly.
- The server warns whenever `trusted_proxies` is empty and the admin allowlist is on, and several server responses now tell the truth (negative invite limits refused, a truncated pin list reported, "already deleted" matching over WebSocket and REST).
- The admin panel's ban, pending, backup and settings paths were completed (see Added), and LiveKit's health and logs are now reported (below).

**Desktop and install**

- **The desktop webview can no longer read the app's credential and pin files**; its file access is limited to the log folder, and credential and identity commands refuse a host other than the active session's.
- **An avatar can no longer point at an arbitrary path on the server**, closing a token-leak vector.
- **A Windows server started from a console now restarts in that same window**, and the desktop client installs only an update built for the running system and signed for the offered version.
- The tray's status menu and the app now use the same word for "Invisible".
- Every channel is visible on a first login to a server with a long member list, and the member list section can be collapsed and the member picker driven from the keyboard.

### Known issues

- **Mentions in channels you are not viewing do not update the taskbar or tray badge live yet.** The count catches up when you open the channel or the app receives a fresh unread update.
- **Incoming-call notification clicks on Windows, and Linux voice device selection, still await a real-machine check.** Both are covered by automated tests but want a hands-on pass before they are called settled.
- **The Windows installers are not code-signed.** Windows shows "Windows protected your PC" on install and on Update Now; choose "More info", then "Run anyway". Code signing stays declined for the beta.
- **A certificate change that is not a public-CA renewal still prompts every member.** A rotated self-signed or private-CA certificate, or any certificate on an IP-address server, shows "Certificate Changed"; compare the new fingerprint with the server owner out of band before accepting.
- **There is no browser client yet.** The desktop app is the only supported client; the browser adapter is post-beta work.
- **ARM64 server upgrades are not rehearsed.** ARM64 assets are lifecycle-checked, but there is no published ARM64 beta to upgrade _from_ yet.
- **An owner locked out without a recovery kit still has no self-service fix.** The setup wizard offers to generate one at first run, and one can be enrolled any time from the desktop client; without one, restore `data/` from your archive and re-run setup.

### Under the hood

- **A restart with thousands online no longer thrashes the server.** Presence is coalesced into one update per 0.3 s, session keep-alives and connect/disconnect stamps are batched, reconnects are spread over up to 30 s, and concurrent clients share one member-list read, so a reconnect herd no longer overflows queues or blocks message sends. `GET /api/v1/metrics` gains `backpressure_presence_drops`.
- **A burst of mentions no longer spawns a goroutine and a write per message.** One bounded worker collects a short window and writes them per channel in one transaction.
- **The hourly replay-event cleanup now deletes in 5,000-row chunks**, the read pool defaults to `max(8, 2× CPU)`, and a 1,000–2,000 online scale load profile was added to the capacity harness.
- **WebSocket upgrades are limited per address before sign-in**, and pre-auth frames are capped at 8 KiB.
- **The desktop REST tunnel reuses connections and sets `TCP_NODELAY`**, and a voice session no longer waits behind the previous call's teardown or holds a closed Settings copy in memory.
- The desktop writes its JSON stores atomically and keeps two previous log files; the app's own log and OS/webview info ride in the support bundle.
- Release notes are written for users; `release.yml` copies this section verbatim onto the GitHub release page.

## v2.0.1-beta.1

**OwnCord 2.0.1 beta 1** is the second public beta of OwnCord — a self-hosted chat app with channels, direct messages, voice and video, and file sharing, on a server you run yourself. It hardens the rough edges of the first beta: a server update, backup restore or restart no longer signs everyone out, voice survives a network blip or a media-server restart, a laptop waking no longer takes over your desktop call, routine certificate renewals stop prompting, and the admin panel now answers before you dig. Existing `2.0.0-beta.1` servers and clients upgrade in place. It is still a beta and a hobby project — try it if you are comfortable running a small server for a group of friends, and don't use it for anything sensitive.

### Highlights

- **Updates, restores, restarts and dropped links no longer sign you out.** The desktop client counts down, reconnects on its own, returns to the channel it was in and rejoins voice once the server is back — including after an update, a backup restore or first-run setup.
- **Voice recovers instead of dropping.** A Wi-Fi roam, a sleeping laptop or a restart of the media server keeps you in the call, media can run over a single UDP port, and a user whose media path died no longer holds a seat.
- **Your keyboard and your notifications are yours.** Global Mute/Deafen work while OwnCord is in the background and are now rebindable; the notification level (All / Mentions only / Nothing) is set per server, a burst folds into one popup, and clicking a popup opens the message.
- **Calls look and feel better.** DM calls get their own panel with ringing and join states, a stream can be watched large, full screen or popped out, and a changed participant security key no longer blocks you.
- **The admin panel answers first.** It gained an Invites page with redemption history, a Running configuration view, a 15-minute debug log level, a pre-migration safety backup, an offline restore command and a one-zip full archive download.
- **Certificate renewals from a public CA no longer prompt.** Any other certificate change still does, now with clearer words on how to check it.

### Added

- **A refused sign-up now says why in the server log.** An unknown, revoked, used-up or expired invite, an empty invite while the server requires one, and a taken username all answer with the same "invalid invite or credentials" so the response reveals nothing — which left an operator unable to tell a dead invite from a real fault. The server now logs the specific cause at WARN, tied to the request id; the invite code and password are never logged. The public response is unchanged.
- **Half-written messages are no longer lost when you switch channels.** Each channel keeps its own draft — the text, the reply you had selected and any files you had staged — and restores it when you come back. And when the connection drops or slow mode gates the composer, the textarea is locked rather than disabled, so your caret stays exactly where you left it, and pressing Send says why it is blocked. An unfinished edit is not kept, and a file staged more than about 50 minutes ago must be attached again.
- **`@`-mentions and search results now show display names.** Typing `@Ali` used to find only usernames, so it missed a member displayed as Alice; the mention list now matches display names too and shows each member's display name with their `@username` beside it, and search results show the author the same way.
- **A file upload now shows its progress instead of an indefinite spinner.** The chip on each attachment fills as the bytes move, so a large file on a slow connection no longer looks stuck. Until the transfer reports its first byte the bar is indeterminate, as before.
- **The global Mute and Deafen shortcuts are now rebindable.** They shipped fixed as Ctrl+Shift+M / Ctrl+Shift+D, so anyone whose game or another app already owned that combination could not use them. Settings → Keybinds now has a Global Shortcuts section that captures Ctrl+Shift plus a letter, digit, function key, Space or navigation key (Escape cancels the capture, Tab moves on), rejects a combination already used by the other action or by the in-app Toggle Camera (Ctrl+Shift+V), and applies the change immediately — the running poller picks up the new keys without a restart. The choice is remembered per device. The section is hidden where global keys cannot fire (macOS and Wayland), where the tray items and the in-app shortcuts still work; on Linux/X11 the global keys still use the key positions of a US layout.
- **Voice can now run on a single UDP port.** By default LiveKit sends media across the 10,000-port UDP range `50000-60000`, which is awkward on a restrictive firewall or a router with a small port-forwarding table. Setting `voice.udp_port` (for example `7882`) makes OwnCord write LiveKit's single-port `udp_port` into the generated `livekit.yaml` instead, so you forward one UDP port. `0` (the default) keeps the range, so nothing changes on an existing install; the reachability report and the "joins but no audio" guidance name whichever form you chose. On the Docker stack, edit `livekit.yaml` and `docker-compose.yml` directly (the example shows how).
- **Mute and Deafen now work while OwnCord is in the background.** Ctrl+M and Ctrl+D fire only with the window focused, so anyone in a call with a game or another app in front had to switch windows to mute. Ctrl+Shift+M and Ctrl+Shift+D now mute and deafen whether or not OwnCord is focused, on Windows and on Linux/X11 (exactly those keys — with Alt or Win/Super also held they are left to the other app; on Linux/X11 they use the key positions of a US layout), and the tray menu gains Mute / Unmute and Deafen / Undeafen items that work everywhere. On a Wayland desktop the global keys are not available yet, even with XWayland (the desktop portal API is not wired); Settings says so, and the tray items still work.
- **DM calls have their own call panel.** A call used to show only as the small voice bar above your name. The DM now shows who is in the call, who is speaking and the call controls, with the chat still usable below; the caller sees "Calling…", is told when the call is declined or not answered and can ring again; a ringing DM you have open is answered right there; and a call you are not in shows a Join button. The DM list marks a DM with a live call, and the voice bar's call name opens the DM.
- **A screen share or camera in a DM call can now be seen from the DM.** It used to be reachable only for your own camera, which then covered the whole chat. The call panel now shows every stream, with a tile for each person without a camera, and the chat stays usable below; your own camera or screen share shows there while the call is still ringing too. Collapsed, the panel stays collapsed until you expand it.
- **Watching a stream is more like Discord.** Click a tile (or press Enter) to watch it large, with the rest in a strip and Back to grid to return. Screen shares show a LIVE badge, the person speaking gets a ring, and each stream's volume slider says whose it is and shows its level. Right-click a tile (or press Shift+F10) for separate stream and voice volumes, Mute stream and Stop watching; your own screen share shows what is going out, with Stop sharing and Hide preview. In a DM call, watching a stream stays inside the call panel with the chat still below it.
- **Streams can go full screen or pop out.** A tile has Full screen (also F, or a double-click), which fills the monitor and keeps mute, deafen and leave at hand, and Pop out, which opens it in a picture-in-picture window where the system supports it. The stream you are watching shows its resolution and frame rate; click it for bitrate, codec and packet loss.
- **The admin panel now shows whether LiveKit is healthy.** Nothing in Attention, Diagnostics or health reported it, so "voice doesn't work" meant reading the server's stdout by hand. A supervised LiveKit that is down now warns, one whose crashes stopped its restarts is critical, and an external LiveKit is health-probed; the restart count is in the support bundle too.
- **LiveKit's own output now goes to the server log.** Its ICE, port and key errors were written straight to the process's stdout, so the admin live log and the support bundle never saw them; each line is now logged with a `livekit` source.
- **A voice join that fails now records where it failed.** The voice diagnostics in Settings > Diagnostics & logs (and the exported support bundle) used to show only that there was no room; they now carry a timeline per join attempt — the stage it reached, whether the LiveKit address was used directly or tunnelled, how many connect tries it made, and how long each phase took — plus the connection self-test's result and a count of receive-side decrypt failures. "Voice won't connect" reports can be read instead of guessed at.
- **On Linux, sharing your screen now asks what to share first.** Picking the monitor or app window used to open a bare list of cards; it is now a proper "Share your screen" dialog with Screens and Applications tabs, a thumbnail of each source, a per-share quality choice and a Go Live button. Nothing is captured until you press Go Live. On Wayland, where the desktop portal owns the source choice, the dialog covers only the quality setting before the portal opens. A Linux screen share still carries no audio; the dialog says so.
- **The admin Settings page shows the running configuration, and the log level is adjustable for a while.** Settings now carries a **Running configuration** card with the effective values an owner otherwise reads out of `config.yaml` — port, TLS mode and domain, upload and per-user quotas, voice quality and URL, max connections, disk headroom, backup directory, log level, retention windows, and whether the GIF key and GitHub token are set. Secrets are shown only as "configured", never their value, and the backup directory, TLS domain and voice URL are shown only to an administrator. On the Logs page an administrator can switch the server to **debug** logging for 15 minutes; the switch shows the level the server is actually running, and it reverts to the configured level on its own, so a forgotten boost cannot quietly grow the logs. Turning it on or off is recorded in the audit log.
- **A server update can no longer move the database schema without a safety copy.** A routine upgrade — including a Docker `docker compose pull` — used to apply new migrations with nothing to roll back to. The server now takes a verified database backup before it applies any pending migration, named `pre_migrate_<first-migration>.db` in the backup directory (suffixed `_2`, `_3`, … rather than overwriting an earlier copy), and refuses to start if it cannot. It is kept out of retention pruning like the pre-restore copies.
- **The Dashboard shows the certificate fingerprint in every TLS mode.** In `acme` mode it appears after the first HTTPS connection and follows each renewal; with `tls.mode: "off"` behind a reverse proxy, the card gives the `openssl` command that reads the fingerprint members see. Before, both modes showed nothing.
- **The attention panel warns before the TLS certificate expires.** A new **TLS certificate** check warns three weeks before a self-signed or manual certificate expires and turns critical in the last week. A Let's Encrypt certificate warns only once its renewal is overdue (20 days before expiry for today's 90-day certificates, closer to expiry for shorter lifetimes), so a failing renewal or a two-year self-signed certificate running out no longer arrives as a surprise, and a healthy renewal never raises one.
- **Denying a registration asks first.** Approve and Deny sat next to each other and Deny was one click, permanent and silent; the applicant's row is anonymised and cannot be approved afterwards. Deny now opens a confirmation naming the applicant and saying the decision is final.
- **The setup wizard now hands the owner a recovery kit.** A lockout with no kit was the one failure an owner could not fix from inside the server, and the wizard offered no way to prepare for it. The first-run wizard now generates a recovery kit for the owner account and shows it once on the finish step; only its verifier is stored. It is on by default and can be turned off.
- **A server that will not boot can have its database restored without the admin panel.** The only in-product restore needed a running server, so a failed migration or a corrupt database locked an operator out of the very command that would fix it. `chatserver restore --force <file>` now verifies a backup, takes a `pre_restore_*` safety copy and puts it back offline; it refuses unless given `--force` and stops if the server is still running.
- **The owner can now download one archive that is everything a restore needs.** A database backup alone misses uploads, the key files and `config.yaml`, so a restore from one was never complete. **Download full archive** on the Backups & restore page returns a single zip with all of it: the database as a consistent snapshot, the whole data directory, and `config.yaml`. Owner-only.
- **`GET /api/v1/metrics` now reports broadcast latency, per-phase voice join time, dispatch-queue depth, the worst seqMu hold and per-channel message sheds** — figures that previously existed only in an OpenTelemetry build nobody ships, so an operator could not tell a slow server from a slow network. All are in every build, and all but the voice join phases are also in the support bundle's `health.json`.
- A channel frame dropped by the per-channel rate limiter is now counted (`topic_sheds_total`) and raised in the admin Attention panel, so a busy channel's lost frames are visible instead of silent. When the dropped frame carried message content, every client at or behind it reloads on its next reconnect, so the message is recovered from the database instead of being silently missed. The same recovery applies when a full hub-wide broadcast queue drops a message.
- **The admin panel now has an Invites page, and every redemption is recorded.** The setup finish screen said "create more invites later in the admin panel", but the panel had no invite page — invites existed only in the desktop client, and the server never recorded who redeemed a code, so a leaked invite could not be traced. The panel's new **Invites** page creates codes with an optional use limit and expiry, copies them, revokes them, and shows a **Redeemed by** history per code naming each account and when it redeemed. A code's history survives that account being erased (the row keeps the time, the name is gone). The setup invite's own 5-use / 24-hour limit is now stated where it is handed out.
- **The deployment docs now say how to monitor voice.** `/health` checks the hub, database and disk but not LiveKit, so a monitor watching only `/health` stayed green while voice was down. The guide now tells an operator to poll `GET /api/v1/livekit/health` alongside it, names the allowlist that gates it, and notes there is no built-in watchdog (the binary does not implement `sd_notify`).
- **A server that was killed or crashed now says so on the next start.** The Dashboard's attention panel gains a "Last server exit" signal: it warns when the previous run did not shut down cleanly and names when that run started and the last panic it recovered, so an unexplained restart is visible instead of silent. A normal restart or update clears it. On Windows specifically, a nil-pointer or invalid-address crash during a request or WebSocket message now exits for the supervisor to restart rather than running on possibly damaged memory (a Go runtime limitation); every other panic is still recovered as before.
- **The admin panel's address bar now names the page you are on.** Moving between sections used to leave the URL at `/admin`, so a reload or a copied link always returned to the dashboard and the back button left the panel entirely. Each section now sets its `#id` (`/admin#audit`), the back and forward buttons move between the sections you visited, and a link still opens the section it names. Leaving a page — by a click or the back button — while the Settings form or a dialog holds unsaved edits asks first, and declining keeps you where you were.
- **A support bundle keeps the warnings that matter.** Its log timeline held the last 200 records at any level, so an ordinary run of info messages could push a failure out of the bundle before you exported it. Warnings and errors are now kept in preference to lower levels.
- **Failures in a support bundle now name themselves.** Almost every warning or error in the bundle's log summary was reported as a generic `log_event`, so a reader could see that something failed but not what. Every warn/error message the server's own code logs now maps to a fixed event code, and a test fails the build when a new server failure log is added without one; messages from third-party libraries still appear as `log_event`. No message text or request value is exported — the code comes from the fixed message only. The supervised LiveKit's own output is now logged as `livekit companion output` entries with the original text in a `line` attribute (`component=livekit`), no longer as `livekit: ` lines — search for those instead.
- **The desktop client's own log now survives long enough to explain a problem.** It used to delete itself each time it reached ten megabytes; the two previous files are now kept beside it. A crash is written to the log with a backtrace, a window that never finishes loading leaves a `frontend not ready` line after 30 seconds, and the tray icon gains **Open Log Folder** so the log is reachable even when the window is blank.
- **The exported support bundle now carries the desktop app's own log too.** It held only the webview's log, so an update or a Linux voice problem arrived without the file that explains it. The bundle also records your OS and webview; it still makes no server call.
- **You choose how much a server may interrupt you.** Settings › Notifications gains a Notification level — All, Mentions only or Nothing — and, while you are connected, a per-server override beside it. New installs start at Mentions only, so a busy channel no longer pings you for every message; an install that already has OwnCord settings or saved state from before this release keeps its current All behaviour. Nothing silences the popup, the chime and the taskbar flash together, including for a mention, which a channel mute never did.
- **A burst of messages is now one popup, not twenty.** Messages arriving in the same channel within a few seconds fold into the single alert already shown, so a fast conversation — in a channel or a direct message — no longer stacks notifications. A message that mentions you always gets its own alert.
- **On Windows, the update banner now warns before Update Now that SmartScreen will show "Windows protected your PC".** The installer is not code-signed, so the prompt came as a surprise; the banner now says it is expected and to choose **More info**, then **Run anyway**.

### Changed

- **Server refusals now read as plain sentences.** A wrong password, a missing permission or a full storage quota used to surface the server's raw lower-case text ("invalid credentials", "missing CONNECT_VOICE permission"). The client now shows fixed, capitalised copy for the common refusal codes — "Incorrect username or password.", "You don't have permission to do that.", "Your storage is full — delete files or ask a server admin." — and capitalises the server's own message for any code without one.
- **The connect-page latency badge is now labelled "response time".** It times one REST call through the desktop's TLS tunnel, which opens a fresh connection and handshake per request — about three times the network round-trip — so calling it a "ping" set the wrong expectation. The number and its colours are unchanged.
- **Routine Let's Encrypt and reverse-proxy renewals no longer prompt.** When the certificate you accepted was publicly valid for the server's domain and its renewal is too, the desktop client now re-pins it silently instead of showing "Certificate Changed" every couple of months. Self-signed certificates, IP-address servers and any certificate that is not publicly valid still prompt on every change. On a server you already trust, the first connection after updating records this, so the next renewal is the first one that is silent.
- **The "Certificate Changed" prompt now says how to check it.** It used to say only that the change "could indicate a security issue". It now explains that routine renewals from public certificate authorities no longer prompt, so a change deserves extra care, and tells you to get the current fingerprint from the server owner through another channel and accept only if it matches.
- **A dynamic public IP no longer needs a config edit to recover voice.** The docs said to pin `voice.node_ip` to the public address; when the address later changed, calls connected and then carried no audio because the ICE candidate named an address no longer yours. The port-forwarding guide, the server's start-up warning and reachability report now say to leave `node_ip` empty so LiveKit auto-detects the address when it starts (a restart after an IP change picks up the new one), the Docker `livekit.yaml.example` now uses `use_external_ip: true` instead of a pinned `node_ip`, and the Tailscale guide explains the one case where `node_ip` **is** needed (a tailnet-only host, set to the `100.x` address).
- **The admin dashboard now opens with the answer.** It used to show a 19-row table of every health signal, most reading Healthy or Unknown; it now leads with one line — "Everything is running normally" or "1 problem needs your attention" — then a card per active warning with what to do. Every check sits under **All health checks**, open only when something needs attention (a check that can't be measured shows as a grey "not measured" count), with the maintenance jobs folded into one row. The stat cards are smaller and the certificate fingerprint is behind a disclosure.
- **Message retention says the policy in words.** The page opened on a `0` in a number box with the rule in fine print and a table of identical rows; it now reads "Messages are kept forever" or "Messages are deleted after 90 days", with how many channels follow it. The number sits behind **Change…**, together with what the next sweep deletes, and **Channel exceptions** lists only channels with their own rule, the full list (where a channel gets its own rule) behind **Show all N channels**. Every change still previews what it would delete before you confirm.
- **The admin Channels list looks like the channel list members see.** Channels are grouped under their category, the type is an icon beside the name instead of a column, the always-green "Archived: No" column is gone (an archived channel gets an Archived badge), and the lock button is named "Who can see".
- **Server logs are easier to scan.** Each line printed its raw JSON attributes, wrapping every request over two lines; a request now reads `GET /admin/api/channels · 200 · 3 ms` (the status coloured by class, the number always shown), other lines show `key=value` chips, and everything the line logged is one click away under **details**. Search, Copy and the level filters still work on the raw text. The connection state moves to the start of the toolbar, and a level switched off is struck through.
- **Admin pages answer first and stop showing empty tables.** Backups & restore opens with when the last backup was taken and whether automatic backups run; Updates is one line ("You are on the latest version" or "v2.0.0 is available", with **Update now…**) and writes a dev build as `dev`, not `vdev`; API tokens, Plugins and Emoji show a short explanation or one line instead of an empty table. In Settings, **Who can join** is four cards (Closed, Invite-only, Approval, Open) that each say what they mean, and Approval links to Members › Pending.
- **The audit log reads in plain words.** Rows showed raw codes such as `user_register user #4`; each now reads as a sentence ("dave joined the server", "alice created channel #7") under Today / Yesterday headings, with the code kept in the row's tooltip, the action filter, Copy page and Export CSV. Sign-in and connection events, which buried everything else on a quiet server, are hidden until you turn on the new **Sign-ins** filter. The dashboard's Recent activity uses the same sentences.
- The sidebar's Invite, Audit Log and Moderation buttons wrapped unevenly onto two rows under the server name — they are now one quiet row of icon buttons beside it, each with a tooltip.
- Settings no longer paints every action in the accent colour: routine actions (clear a cache, reset consent, clear a push-to-talk key) are now quieter secondary buttons, and **Clear All Cache & Restart** is marked as destructive in red. The empty **Debug** heading under Advanced no longer shows in release builds.
- **Settings › Logs is now Diagnostics & logs, and it answers first.** The connection test opens with one line ("Everything tested is working" or "2 problems found") and shows the checks left to right as one row of steps with status icons; the failing (or picked) step's detail sits below the row. The support bundle has its own Get help card, and the raw client logs and voice engine state sit behind collapsible sections whose headers show the entry, warning and error counts.
- **Settings › Account leads with a Security card.** Two-factor, recovery kit, password and signed-in devices each get one row with a status icon and words ("Disabled — anyone with your password can sign in"), and the card counts the recommended steps left. The change-password form and the device list open on demand, sign-out and other destructive buttons stay quiet until you confirm them, Status is one "Show me as" select, and account deletion sits in a closed "Delete account" section at the bottom. Avatar, display name, about and username now open together from one **Edit profile** button on the profile card.
- Settings › Accessibility groups its switches under Motion, Readability and Chat: Sync with OS sits under Reduce Motion and says whether your system is asking for less motion right now, and a Text size line shows the size Large Font gives you. Settings › Notifications shows the system permission as one word (Allowed, Blocked, Unknown or Unavailable) with a fix only when one is needed, and while notifications are blocked the Desktop Notifications switch is dimmed with the reason.
- Settings › Safety opens with your standing ("Your account is in good standing" or "1 active restriction"), keeps every section heading at one level (My reports no longer looks like a separate page), folds the appeal rules into "How appeals work", and shows an empty history as one line.
- Settings › Voice & Audio is four cards: Microphone (with a Hearing you / No input pill and the sensitivity value in numbers), Speakers, Camera & screen share (the preview says Camera off instead of showing an empty box), and Voice processing, with Enhanced Noise Suppression nested under Noise Suppression.
- The quick-start and deployment docs no longer tell Docker owners to set `voice.livekit_url` and `voice.auto_download_livekit` by hand, and the build-from-source examples show `dev` instead of the stale `1.2.0-alpha.4`. The quick start now warns about the one-time browser certificate prompt on `/admin` before the wizard.

### Fixed

- **An invite code is accepted however it is pasted.** Codes are lower-case hex and the server matches them exactly, so a code pasted in capitals or a pasted `owncord://invite/<code>` link used to be refused with the same opaque error. The register form now trims and lower-cases the code and pulls the code out of a pasted OwnCord invite link.
- **A server update, backup restore or restart no longer signs everyone out.** The desktop client counts down, reconnects on its own and returns to the channel it was in. A voice call now comes back too after an update, backup restore or setup: whoever was in a voice channel or a DM call is rejoined automatically once the server is up within ten minutes, unless they were kicked, moved, banned or had left.
- **A dead connection no longer stays open on the server for up to two minutes, leaving the user showing online.** The server now pings each connection every 25 seconds and closes one that stops answering within about 50 seconds.
- **A half-open connection no longer stays "connected" forever.** When the network path drops silently — a firewall change, a lost Wi-Fi hop — the client used to keep showing Connected while sends vanished. It now treats a minute without any server frame as a dead link, shows Reconnecting and dials again.
- **Waking a sleeping laptop no longer leaves the app looking Connected for up to a minute.** After a brief freeze the client only noticed a dead socket on its next heartbeat or the 60-second silence deadline, so it could show Connected while nothing was arriving. It now probes the moment it notices the wake (a heartbeat that fired long overdue), the screen comes back or the network returns, and redials within about 15 seconds when the server does not answer.
- **A short network blip no longer ends your voice call.** A Wi-Fi roam, a VPN reconnect or a laptop waking from sleep used to drop you from the call the moment the chat socket closed, forcing a manual rejoin and a fresh key exchange for everyone. The server now holds your place for 15 seconds, so a reconnecting client stays in the call with its media and room key intact; a blip longer than that still cleans up.
- **Waking a laptop no longer silently takes over your other computer's call.** One connection per account means the machine that reconnects wins, so a laptop that slept while a desktop kept the call used to reclaim it on wake and drop the desktop. A reconnect the client makes on its own after a sleep is now marked a wake and the server arbitrates: with no other device it connects silently, and while another device holds the session it is refused and the client offers **Use here** instead — after any sleep longer than about 90 seconds, so the old 90–180 second hole is closed and a lone device no longer needs a tap after a long sleep.
- **Saved servers, logins and trusted certificates survive a crash mid-save.** The desktop client rewrote its settings files in place, so a crash or power cut at the wrong moment could leave one torn, and the next start silently treated it as empty. Saves now replace the file atomically. A file that still cannot be read is copied aside as `<name>.corrupt-<time>` and logged; for the trusted-certificate and voice identity pins the client then refuses to connect or verify instead of trusting whatever it sees, until the damaged file is removed from the app data folder and the client restarted. A file the client cannot read or copy aside is left untouched rather than overwritten.
- An admin with the Logs tab open no longer stalls a restart for 30 seconds and cuts the restart notice and the audit flush short — the log stream now ends as shutdown begins, and each shutdown step has its own budget: up to 30 seconds for the HTTP drain and 10 seconds for every other step.
- **A reconnect after a server restart no longer drops messages posted in the channel you were reading while you were reconnecting.** The full re-sync that follows a restart ignored the channel you had open, so frames broadcast during the resume handshake reached nobody; it now subscribes you to that channel immediately, the same as an ordinary reconnect.
- **The Docker stack now wires voice for you.** `docker compose up` used to need two hand edits in `config.yaml` — pointing `voice.livekit_url` at the LiveKit container and turning `voice.auto_download_livekit` off — or the server started a second LiveKit inside its own container on ports nothing published. The compose file now sets both, so the mounted config needs no voice edit.
- **The startup banner prints the LAN admin URL when the main one is not reachable from the admin allowlist.** On a dual-stack host it could print a public IPv6 that the default `admin_allowed_cidrs` refuses with `403`, even from the host itself; the banner now adds an `Admin (LAN)` line with the private address that does pass.
- **The app opens on the channel you were last reading, and no longer silently clears another channel's unread badge on launch.** Every launch or server switch used to jump to the first text channel and zero its unread count even if you never looked at it; it now restores the last channel per server, and a channel's badge clears only when you actually open it.
- **A message queued before a server restore now says why Retry was refused.** If the owner restores a backup, Retry on a draft saved just before it still sends it; when the restored server already has it the row reconciles, and otherwise the row now says the server was restored and asks you to check the conversation before sending it again, instead of a bare refusal. The text stays on the row.
- **Error toasts no longer vanish before you can read them.** Errors used to disappear after five seconds and could not be closed; they now stay until you dismiss them, with a close button. Any toast pauses its countdown while you hover or focus it, and repeated identical toasts show as one with a count instead of stacking.
- Message Requests showed the wrong time for anyone not on UTC — the request's time was read as the viewer's local time instead of the server's instant, so it was off by their UTC offset.
- **Editing or deleting a message no longer claims success while offline.** Both used to show a "Message deleted" / "Message edited" toast the moment they were sent, so a moderator acting during a blip could think a message was gone when the frame had been dropped. Success is now confirmed by the server's echo; a dropped frame reports one error, and an edit's text is put back in an empty composer so it can be sent again. The delete button is disabled, with the reason shown, while the connection is down.
- **Large attachments no longer fail on a slow connection.** Uploads and downloads used to be cut after 30 seconds no matter how steadily they were moving, so a 25 MB file on a 1 Mbit/s uplink was lost mid-transfer and a download stopped without an error. The server now keeps a transfer alive while it is making progress and gives up on one that has stalled; any single transfer is still closed after 10 minutes.
- **Removing an attachment that is still uploading now cancels it.** The × only hid the preview while the upload kept running, and Send stayed blocked until it finished or failed. The upload is now stopped, Send is available at once, and no error is shown for it.
- **A pinned `voice.node_ip` is now honoured.** The generated `livekit.yaml` always set `use_external_ip: true`, and LiveKit overwrites `node_ip` with its STUN result while that is on, so a pin (such as a tailnet `100.x` address) was silently replaced by the detected public address. The generated file now writes `use_external_ip: true` only when `voice.node_ip` is empty — or when `voice.advertise_internal_ip` is on, because LiveKit advertises LAN candidates only alongside discovery; in that case the pin is still ignored and the server warns at start-up. If you pinned a public IP without `advertise_internal_ip`, LiveKit now advertises exactly that address instead of re-detecting it — clear the pin on a dynamic IP.
- **The "Call" action in a member's profile now works.** Clicking a member opens their profile popup, which offered Message but no Call; the menu item was never wired, so it did not render. It now opens (or reuses) your 1:1 DM with them and starts the call there, the same path the DM header's call button uses.
- **A call no longer waits for you to click "Trust New Key" when someone's security key changed** (for example after they reinstalled or used a new device). You couldn't hear them until you clicked. The new key is now accepted automatically and a notice naming that person stays until you dismiss it; their roster badge shows the change for the rest of the call. Compare safety numbers with them if you didn't expect it.
- Linux desktop voice works against a server on the same Docker host again — the client tried LiveKit's Docker-internal hostname, which does not resolve outside the container network, and now uses the same rule as the other platforms: only a loopback `ws:`/`http:` address is used directly, anything else goes through the `/livekit` tunnel.
- Linux desktop voice joins remote servers older than v2.0.0-beta.1. Those servers dropped the voice sign-in the Linux client sent, so the join failed; the client now sends it the way Windows and macOS do.
- The server no longer hands clients LiveKit's internal address — it sends LiveKit's own address only when that address is loopback, so an older Linux client on the Docker host also gets voice through the `/livekit` tunnel.
- On Linux desktop, a call kept showing "Secured" when another participant's audio could not be decrypted — that participant was just silent. The indicator now drops after a few seconds, as it already did on Windows and macOS.
- Switching microphones while muted (or with push-to-talk released) no longer starts audio processing on the muted mic — it kept running until you unmuted. Enhanced Noise Suppression now also turns on at your first unmute after joining muted or with push-to-talk.
- Joining or reconnecting to voice with a chosen microphone no longer opens the system default first — for a moment you were transmitting from the wrong mic. The chosen one is now the only one opened.
- On Linux desktop, unmuting after a connection drop that happened while you were muted left your mic silent until you rejoined — peers heard nothing although you showed as unmuted. Unmuting now works after such a reconnect.
- **Enhanced Noise Suppression now actually runs.** Its audio-worklet path rejected the shipped RNNoise module over its minified export names and fell back to the deprecated ScriptProcessorNode on every call. The worklet now resolves the real function names, so the modern path loads.
- Dragging the voice sensitivity slider restarted voice detection at every step — about 200 times per drag. It now applies once, when you let go.
- **A voice call now survives a LiveKit restart.** The client gave up reconnecting after about six seconds, so killing or restarting the media server (as a managed restart does) dropped everyone from the call. It now keeps retrying with backoff for about half a minute and rejoins on its own, showing "Reconnecting voice…" while it does.
- **A Windows screen share no longer sends the call back into itself.** Sharing your screen offered system audio, which included OwnCord's own playback of the other callers, so viewers heard an echo of the call. Screen-share audio now excludes the local app's own sound where the browser supports it.
- **A user whose voice connection died but whose app stayed open no longer keeps a seat in the call.** When only the media path drops (a severed UDP flow, a firewall change), the server used to keep showing them in the channel, holding a slot and — if they were the room's key holder — stalling everyone else's key exchange. The server now asks LiveKit who is really in each room every minute and removes memberships whose participant is gone, after tolerating one missed check so a momentary blip does not kick a live user.
- **Lifting a member's ban through an appeal now restores them for everyone connected.** Overturning a ban appeal un-banned the account in the database but told no connected client, so anyone who had been online when the ban landed kept seeing the member missing from the list — and a member who never reconnected stayed missing indefinitely. It now announces the unban the same way the admin unban does. Either unban also keeps a member online when they had already reconnected after a temporary ban ran out, instead of showing them offline.
- **A moderator's timeout request can no longer be silently shortened.** The timeout endpoints bounded the duration only after converting it, so an out-of-range `duration_seconds` whose conversion wrapped could be accepted as a much shorter timeout instead of being refused. Both the direct timeout and the moderation-queue action now reject an out-of-range value.
- **The full archive now downloads as a real streamed file.** The panel used to hold the whole archive in the page before saving it, so a large install could exhaust the browser's memory. It now asks the server for a short-lived single-use link (bound to the owner, good for about a minute, never logged) and opens it as a plain download, so the archive streams straight to disk. The old few-GB ceiling is gone; the download must still finish within 2 hours of the request.
- An operator who sets `telemetry.enabled` on a build without the OpenTelemetry SDK (the shipped release and Docker builds) now gets a startup warning instead of a silently inert setting.
- The admin panel's nav badges (pending registrations, active warnings, an available update) loaded only at sign-in, so a warning raised later went unseen until a re-login — they now refresh whenever you come back to the tab.
- **Two manual backups asked for in the same second no longer collide.** They derive the same filename from the second-resolution timestamp; on Windows the second could fail with an "Access is denied" rename error instead of a clear "already exists", and on Linux it silently overwrote the first. Publishing is now serialized with a destination re-check, so exactly one lands and the other is told the name is taken.
- **Taking a backup no longer freezes the server's writes.** The daily scheduled backup copied the database on the single write connection, so for its whole duration (a second or more on a large database) every message, upload and setting change waited, once a day and at a drifting time. The copy now runs alongside them, and a backup that is killed part-way leaves no file the Backups page would offer to restore. The log records how long each backup took; new backups are readable only by the server account.
- The admin panel's update and restore dialogs could be dismissed (Escape, a click outside, Close) while the update or restore was already running, leaving no sign of the restart in progress — they now stay open until the server is back, or until the request fails.
- The admin audit log's Export CSV could hand a spreadsheet a formula — a cell such as a username starting with `=`, `+`, `-` or `@` now gets a leading `'` so it opens as text.
- The audit log's Copy page button could hand a spreadsheet a formula the same way — its tab-separated cells get the same leading `'` as Export CSV.
- **Behind a reverse proxy, the log and audit trail now name the real client instead of the proxy.** With `trusted_proxies` configured — the recommended deployment — the access log, the WebSocket connect log and the `ws_connect` audit row recorded the proxy's address. They now record the client's, the same address the rate limiter and lockouts already used.
- **The admin panel no longer discards unsaved edits silently.** Closing a dialog with Escape, a click outside or a Cancel/Close button used to drop whatever you had typed or toggled, and reloading the page dropped an edited Settings form. Both now ask first: a dialog with edits asks before closing, and the browser's own leave-site prompt appears while the Settings form or a dialog holds unsaved changes.
- **The channel-access drawer's Clear override and target switch no longer drop unsaved edits.** Clearing an override closed the drawer over any other pending changes without asking; it now asks first. Switching the role-or-member target used to repaint the permission matrix over unsaved override edits; it now asks, and declining keeps you on the target you were editing.
- **Desktop notifications no longer show raw markdown or spoilered text.** The popup body used to be the message verbatim, so `**bold**`, `> quotes`, code fences and — worse — hidden `||spoiler||` text appeared as-is, including on a lock screen. The body is now the message's visible words, with a spoiler shown as the word "Spoiler" until you open it.
- **Clicking a message notification now opens that message.** It used to just raise the window; the app now jumps to the channel, scrolls to the message and flashes it, the same as an `owncord://message/…` link. A mention notification opens its message too, and on Windows a click works whether the popup is still on screen or has already timed out into Action Center, where clicking it now opens the message rather than only bringing OwnCord forward. A notification from a server you have since switched away from only brings OwnCord forward, rather than opening an unrelated message on the server you are signed into now.
- The admin Dashboard got slower as the audit log grew, because listing the audit actions read every row (one per connection, never pruned) — an index now answers it without touching the log.

### Known issues

- **The Windows installers are not code-signed.** Windows shows "Windows protected your PC" on install and on Update Now; choose "More info", then "Run anyway". Code signing stays declined for the beta.
- **A certificate change that is not a public-CA renewal still prompts every member.** A rotated self-signed or private-CA certificate, or any certificate on an IP-address server, shows "Certificate Changed"; compare the new fingerprint with the server owner out of band before accepting.
- **There is no browser client yet.** The desktop app is the only supported client; the browser adapter is post-beta work.
- **ARM64 server upgrades are not rehearsed.** ARM64 assets are lifecycle-checked, but there is no published ARM64 beta to upgrade _from_ yet.
- **An owner locked out without a recovery kit still has no self-service fix.** The setup wizard now offers to generate a kit at first run, and one can be enrolled any time from the desktop client; without one, restore `data/` from your archive and re-run setup.

### Under the hood

- **CI now runs on every push to `dev`, not only on pull requests.** A squash merge combines two PRs into a tree no single PR head ever built, so a break that only appears in the combination — each PR green alone — used to land silently until something else went red. The `dev` push trigger runs the full suite (every capability, since the change selector only narrows a PR into `dev`), so a broken integration commit is now a red run on the commit itself. Cost: while a `dev` → `main` release PR is open, one push to `dev` runs the suite twice, because the push and the PR's synchronize event are separate runs.
- **The desktop no longer polls the signed-in-devices list on every window focus, and no longer logs a TOFU line per request.** A 12-minute test call made 46 `GET /users/me/sessions` calls — each a fresh REST call and TLS handshake through the tunnel — and wrote 63 "TOFU cert event" lines, so owners' access logs and every support bundle carried the churn. The session notice now lists at most once every 30 seconds after a successful listing (focus and visibility firing together collapse into one request), and the "trusted" certificate event is emitted and logged once per host until that host's status changes, instead of once per request. Trust decisions are unchanged: first-use and changed-certificate prompts are not throttled. No user-visible change.
- **The remote-server REST tunnel's per-request TLS cost is now measured and published.** `docs/plans/http-tofu-proxy.md` records that a cold open against a remote server makes 14 REST calls, each on its own tunnel connection (`Connection: close` per request), and that each new connection adds a TCP handshake plus a TLS 1.3 handshake: two network round trips plus ~3-5 ms per call (measured 22.6 ms at 10 ms RTT up to 202 ms at 100 ms RTT; ~5 ms with no added delay). An uncached image fetch pays the same overhead once. `Client/tests/e2e/scripts/measure-tunnel-tls.mjs` reproduces the numbers. Connection reuse is deferred to a separate security review, not rejected as not worth it: summed over a cold open at 100 ms RTT the handshakes cost ~2.8 s against ~1.4 s of request time (three round trips per call instead of one), but a pooled keep-alive tunnel would change the invariants the `Host` rewrite and per-request TOFU rest on. No behaviour change.
- **The capacity load baseline now runs weekly on its own.** The published 250-user / 100-connection / 25-voice profile had only ever been produced by manual dispatch on measurement branches, so a server or harness regression was invisible until someone re-ran it. `load-baseline.yml` now also carries a weekly `schedule:` that, once the workflow reaches `main`, measures the workflow's own commit and uploads the artifacts, and is never part of the blocking CI matrix. RE-05's `dev` re-measurement published current figures for the capacity and operational profiles and refuted the once-observed operational upload-phase acknowledgement tail; the latency budgets are unchanged.
- **The startup bundle budget no longer moves when a UI change only adds CSS.** Because the build merged every stylesheet into one file linked from the entry, the startup budget counted all feature CSS and was raised almost every UI PR. The startup number now measures the JavaScript chain only, and every emitted stylesheet has its own budget line, so feature CSS moves the CSS number instead of the startup one. No user-visible change.
- **The local check is closer to the CI mirror the docs promise.** `npm run check:hygiene` now prettier-checks the tracked files rather than walking the filesystem (so a git-excluded scratch file or the ~23 GB `Client/src-tauri/target/` no longer turns it red), `check:server` runs the race suite with CI's `-timeout 20m` instead of Go's 10-minute default, and the client coverage floor lives in one place — `Client/coverage-floor.json` — instead of two that disagreed (90 in vitest, 93 in CI). The README, contributing guide and `ci-check` skill now state what `npm run check` actually covers.
- **The Linux native voice SDK moves from livekit 0.9.1 to 0.9.3** (not the 0.9.2 that was proposed): 0.9.2 splits its protobuf stack across two incompatible `prost` versions and does not compile, while 0.9.3 puts the whole family on `prost` 0.14.
- **The server now builds with Go 1.27**, up from 1.26, in all five coupled places: the `golang:1.27-bookworm` build image, the `go`/`toolchain` lines in `Server/go.mod`, every `actions/setup-go` in CI, the `golangci-lint` pin, which had to move to v2.13.2 because the old v2.11.3 (built with Go 1.26) refuses to lint a module declaring Go 1.27, and the `govulncheck` pin, which moves from v1.1.4 to v1.8.0 because the old one panics while analysing a Go 1.27 build. Builders and contributors need Go 1.27+.
- **The admin panel now has a type check.** `Server/admin/static/js` is Server-owned, so no client `tsconfig` covered it. `npm run check:admin-types` compiles it with `checkJs` and a shrink-only baseline: a new error fails CI, and a fixed one must be cleared from `Client/scripts/admin-types-baseline.json` with `--update`.
- **The client now checks the frozen wire fixtures too.** The epoch-1 transcripts under `protocol/fixtures/epoch-1/` gated only the server; each server→client frame is now replayed through the real client dispatcher and its store effect asserted, so a wire rename or retype fails a client test instead of breaking the client silently. No user-visible change.
- **The client's lower layers no longer reach up into its UI layer.** The shared preferences/theme helpers, the message timestamp/formatting helpers and the DM-to-channel mutator lived under `components/` and `pages/`, so transport and voice modules imported the UI (which also pulled those files into the startup bundle). They now live in `lib/` and `stores/`, and the last two exceptions are gone: the avatar DOM/fetch helper moved beside the attachments helper and the reaction-list cache moved into `features/messaging/`, so `lib/avatar.ts` and `features/messaging/wsHandlers.ts` import below the UI. A check in the unit suite fails any `lib/`, `stores/`, `features/` or `platform/` module that statically imports a `components/` or `pages/` module, and now has an empty allowlist. No user-visible change.
- **The single-writer lint rule now covers the feature-local domain stores.** A WebSocket handler outside the dispatcher that wrote one of the safety, message-requests or moderation stores used to lint clean; the rule now recognizes every `features/*/store` module and those stores' mutator names. Every custom lint rule also gained a canary test that fails if the rule's scope stops covering the production module it guards, or if the rule stops firing on its shape.
- **The pinned LiveKit SFU moves from 1.13.5 to 1.13.7**, as one bump in all three places that named the old release: the compose image an operator runs (`Server/docker-compose.yml`), the release the server auto-downloads (`ws.DefaultLiveKitVersion`) and the e2e/load harness that mirrors it. Patch release — no configuration change.
- Release notes are now written for users. The tag's `CHANGELOG.md` section opens with a one-paragraph intro, then Highlights / Added / Changed / Fixed / Known issues, with internal changes in a short Under-the-hood list. The release workflow copies it to the GitHub release page as-is, so a release no longer first publishes a wall of internal text.
- Server log lines for voice gained triage detail: a `voice join` line now carries the joining frame's `req_id`, and every `voice leave` line carries the reason it ran (`client`, `switch`, `disconnect`, `handshake`, `moderator`, `dm_leave`, `blocked`, `token_refresh`, `revoked`), so a "voice won't connect" report can be traced to the path that tore the session down.
- **Turning on `server.pprof_enabled` now also profiles blocking and mutex contention.** It was a CPU/heap profiler only, so seeing contention on the single SQLite writer needed a scratch build with `runtime.SetBlockProfileRate` and `runtime.SetMutexProfileFraction` called by hand. Enabling pprof now switches both samplers on at sensible rates — 100 µs between block samples and one in five mutex events — and `/debug/pprof/block` and `/debug/pprof/mutex` return real data. Either rate is overridable in the config or through `OWNCORD_SERVER_PPROF_BLOCK_PROFILE_RATE` / `OWNCORD_SERVER_PPROF_MUTEX_PROFILE_FRACTION`, and `0` disables it. A disabled profiler still adds nothing: the samplers are only touched when it is enabled.

## v2.0.0-beta.1

User-visible: the first public beta. You can now recover your own account
without an email server, two-factor sign-in survives a server restart, the
operator chooses who may register, messages can be set to expire, deleting an
account really deletes it, first-time DMs arrive as Message Requests, reports
and appeals flow through a permission-gated Moderation Center, adult content
and external links wait for your consent, and a zoomed desktop window can still
reach navigation. Not user-visible: the protocol carries a version number, the
server's internals were reorganised behind service boundaries, and the desktop
text was moved behind English catalogs ready for translation.

### Login & connection

- **The server now shows its certificate fingerprint so you can compare it.**
  The start-up banner, the admin Dashboard and the setup wizard's finish step
  print the served certificate's SHA-256 in the same format the desktop client
  shows before its trust prompt. Publish it out of band and compare — a
  mismatch is the one warning that means an interception attempt. Previously
  the disclosure told users to compare a fingerprint nothing printed.
- The client and server now agree on a protocol version ("epoch") when
  connecting. This release is epoch 1; clients from v1.2.0-alpha.4 and earlier
  still connect.
- **A server now says what it is before you connect.** `GET /api/v1/server-info`
  returns the server name, the protocol epoch it speaks, and whether the owner
  has switched on browser-client hosting — so a client can tell it is too old
  for a server without opening a connection and being turned away. The hosting
  switch exists and is off by default; the browser client itself is post-beta.
  No version number is included, on this or any other endpoint that does not
  require logging in.
- A client too old for its server is told "update the client" on the connect
  screen, with the usual Update Now button — instead of failing in confusing
  ways. The saved login is kept, so the updated client signs back in by
  itself.
- **Upgrade the server before the clients.** The server only offers client
  releases that speak its own protocol epoch, so a protocol-changing release
  reaches clients once the server runs it. Releases that do not change the
  protocol are offered as before.
- Signing in from a new device is flagged, so the client can tell you about a
  session you did not start.
- **The startup banner stopped calling a LAN address reachable.** It printed
  whatever address it found first — your `192.168.x` address on a home server,
  or the Docker bridge address on a container host — under the heading of an
  address the server can be reached at. Share that URL and it works for you and
  nobody else. It now prefers a public address when the machine has one, and
  says in one line what kind of address it printed and what that means for
  anyone outside the machine.
- **A failed HTTPS certificate is no longer silent.** With `tls.mode: acme`, a
  server that could not get a certificate logged nothing at all: it reported a
  healthy start and then failed every connection. It now logs the failure once,
  naming the usual cause — inbound port 80 has to be reachable from the
  internet.
- The error for `tls.mode: acme` with an IP address said Let's Encrypt does not
  issue certificates for IP addresses. It has since January 2026; the limit is
  OwnCord's certificate client. The message now says so, and names the two
  options that do work on a raw IP.

### Voice

- **Voice that joins and then carries no sound is now warned about at start-up.**
  If `voice.node_ip` is not a public address, remote callers connect and hear
  nothing, because it is the address LiveKit gives them to send audio to. The
  server says so at boot instead of leaving it to be discovered on a call. It
  warns, never refuses — a LAN-only or Tailscale-only server has a good reason
  to use a private address there.
- **Linux desktop voice now connects to remote servers.** It failed to join on
  any server not on the same machine; it now joins like Windows and macOS.

### Desktop UI

- **Every right-click menu is usable without a mouse.** The member, channel, DM
  and voice-participant menus open with **Shift+F10** (or the Menu key) on a
  focused row, move with the arrow keys and Home/End, open the Change Role and
  Move-to submenus with the right arrow, close with Escape, and return focus to
  the row you opened them from. Moderators could previously only ban, kick,
  change a role, server-mute or move a user — and members only block or mute —
  by right-clicking.
- The channel menu gains **Move Up** and **Move Down** for channel managers, so
  reordering no longer needs a drag.

### Accounts & admin

- **The backup schedule and retention window are now owner-only.** Any other
  administrator, including one holding MANAGE_SERVER or ADMINISTRATOR, is
  refused when they try to change them, matching the owner-only backup and
  restore buttons they already could not use. The panel shows both fields
  read-only to a non-owner. Retention must be `0` (keep forever) or between 7
  and 3650 days, and the `pre_restore_*` safety copies are never pruned.
- The connectivity diagnostics now name the kind of address a client connected
  from (`address_class`), so a Tailscale peer is no longer reported as coming
  from the public internet. Addresses in `100.64.0.0/10` were previously counted
  as public.
- New optional `server.reachability_report_enabled` adds a `reachability`
  section to the admin connectivity diagnostics: this host's addresses, the
  ports that need forwarding, and an explicit list of what the server **cannot**
  determine about its own reachability. Off by default. It makes no network
  request of any kind — see below.
- **[docs/port-forwarding.md](docs/port-forwarding.md) now covers what actually
  goes wrong**: blocked ISP ports, CGNAT, hairpin NAT, changing public IPs, and
  the LiveKit UDP range that causes most "voice connects but nobody can hear me"
  reports. It states plainly which cases OwnCord cannot detect for you, and how
  to check each one yourself. A server cannot test whether the outside world can
  reach it without asking the outside world, and OwnCord does not ask anyone —
  so it tells you what it does not know instead of guessing.
- Under heavy load the server now refuses expensive sign-in work with a "busy,
  try again" instead of queueing it until everything slows down.

### Accounts & sign-in

- **Two-factor sign-in survives a restart.** Used one-time codes, half-finished
  logins and pending enrolments are stored, so a restart can no longer let a
  code be replayed or drop you mid-enrolment.
- If the server cannot read its two-factor key it now refuses to start rather
  than quietly generating a new one — which would have locked out every
  account that had two-factor enabled.
- **Ten one-time recovery codes** can be generated for a two-factor account, so
  losing your phone is no longer the end of the account.
- **Recovery kit.** You can create a recovery secret, held only by you; the
  server keeps a verifier it cannot reverse. Redeeming it resets your password
  and signs out every session, without a second factor and without any email
  server. The kit is single-use and must be replaced after it is redeemed.
- **Owner-assisted recovery.** The server owner can issue a 15-minute,
  single-use recovery credential for an account, after recording how they
  verified the person — in person, voice call, video call, or trusted contact.
  There is no free-text field, so nothing about the conversation can end up in
  the audit log.
- **Recovery from the desktop client.** Settings > Account creates or replaces
  the recovery kit and regenerates the recovery codes, each shown once; the
  connect page's "Recover your account" redeems a kit or an owner-issued
  credential and signs you in.
- The desktop 2FA box would only take six digits, so a recovery code could not
  be typed at sign-in — it now accepts either.
- **Sign out everywhere** revokes every session including the one you are
  using, and drops the live connections immediately rather than waiting for
  the next sweep.
- Changing your password or two-factor settings now tells you when part of the
  change did not apply, instead of reporting success.
- Repeated failed logins for one username are counted against one lockout,
  however the name was capitalised.
- An API token can no longer be created with a negative lifetime, and a token
  whose label is a number can be revoked again.

### Installing & updating

- **A failed start-up no longer discards your rollback binary.** A
  self-updated server used to delete `chatserver.old` before it had proved it
  could boot, so a migration (or any later start-up failure) left no local
  rollback. It is now removed only after every start-up stage succeeds.
- **An older server refuses to start on a database a newer one has migrated,**
  naming the migrations it does not recognise, instead of serving on a schema
  it has never seen. Restoring a backup written by a newer server is refused
  the same way before the live database is touched.
- **The shipped systemd unit's comment now says off-disk directories need
  `ReadWritePaths` too.** With `ProtectSystem=strict`, a documented off-disk
  `backup.dir` (or `upload.storage_dir`) is read-only unless the unit allows
  it, so following the deployment guide exactly previously produced failing
  backups. Add a `ReadWritePaths=` line for each such path.
- **The connectivity report no longer tells you to forward `7880/TCP`.**
  Clients tunnel LiveKit signalling through `:8443/livekit`, so voice needs
  only `7881/TCP` and `50000-60000/UDP`; forwarding 7880 just exposed
  LiveKit's API.
- **First-run setup asks for a setup token.** The server prints a one-time
  token in its start-up output while setup is open, and the setup wizard asks
  for it before creating the Owner account. Restarting the server prints a
  fresh token, which is how you get one after reopening setup.
- **The `.env.example` placeholder LiveKit credentials are refused** like the
  `devkey` defaults: voice stays off until real values are set.
- **A start-up warning** names an admin allowlist that will see a proxy's or
  container relay's address because `server.trusted_proxies` is empty. It stays
  silent once the allowlist no longer admits loopback or the container's bridge
  gateway, so narrowing `server.admin_allowed_cidrs` is a real fix.
- **ARM64 server builds.** Releases now carry four server assets instead of
  two: `chatserver.exe` and `chatserver-windows-arm64.exe` for Windows,
  `chatserver-linux-amd64.tar.gz` and `chatserver-linux-arm64.tar.gz` for
  Linux. The existing x64 names are unchanged.
- **Self-update works on ARM64.** An ARM64 server previously reported no update
  available, forever, because no asset matched its architecture. It now
  downloads and verifies the asset built for it. Each Windows binary carries
  its own signature, so an ARM64 machine no longer checks its download against
  the x64 one.
- Every published server asset is now built on its own architecture and run
  through a full lifecycle check before release — it starts, migrates a fresh
  database, reports healthy, shuts down cleanly on a stop signal, and restarts
  on the same data directory. Previously a release asset was only checked as
  far as "it starts".
- **ARM64 Docker image.** `ghcr.io/j3vb/owncord-server` is now one tag covering
  `linux/amd64` and `linux/arm64`, so a Raspberry Pi, an Ampere or Graviton
  VPS and an x86-64 box all pull the same tag. Both are built and checked on
  their own hardware before the tag is pushed.
- The container is checked through the same full lifecycle as the standalone
  assets: it boots on an empty volume, migrates, reports healthy, drains
  cleanly on `docker stop`, and is then replaced by a new container that finds
  the old data intact. Previously only "it starts" was checked.
- **The image reports its own health.** `docker ps` shows a health state even
  without the compose file, so `docker run`, Podman and Kubernetes all see it.
- **The shipped compose file drops every Linux capability** and blocks
  privilege escalation. If you run the container by hand, pass
  `--cap-drop=ALL --security-opt=no-new-privileges:true`.
- **Upgrading and rolling back are rehearsed before a release ships.**
  Nothing previously checked that a new server takes over an install that is
  already in use, rather than an empty one. Every release now upgrades the
  previously published version to the one being shipped and rolls back out of
  it again, as standalone binaries and as containers, and is blocked unless a
  signed-in session, an uploaded file, the configuration, the credential keys
  and the backups all survive both directions intact.
- **Windows ARM64 desktop client.** Releases now carry a native Windows ARM64
  installer (`OwnCord_<version>_arm64-setup.exe`), and the server offers it
  updates, as it already did for Windows x64 and Linux x64/ARM64.
- **Every desktop build is used before a release ships, not just built.** The
  Windows x64/ARM64 installers and Linux x64/ARM64 AppImages are each
  installed on their own architecture, connected to a server, taken into a
  voice channel and through an account recovery, then updated from the
  previous release and rolled back to it; each .deb is installed and booted.
  A failure blocks the release.
- **Plugins are described by `plugin.json` only — the `plugin.toml` manifest is
  gone.** A plugin directory carrying only a `plugin.toml` no longer loads;
  convert it to `plugin.json`. A directory carrying both could previously leave
  the server honouring a different manifest than the one approved at install.
- **The Docker quick-start no longer crash-loops.** It now ships a
  `config.yaml.example` and tells you to copy it before `docker compose up -d`;
  previously the compose file bind-mounted a config nothing created, so Docker
  made a _directory_ at that path and the server failed to read its
  configuration. The same pages now say which files come from the release's
  source snapshot rather than its assets, and that `voice.livekit_url` must be
  set to the LiveKit container (`ws://livekit:7880`) because compose injects
  only the key and secret, with `voice.auto_download_livekit` set to `false`.
- **`chatserver --version` and `--help` print and exit.** Asking a build what
  it was no longer starts a server or writes a `config.yaml` into the working
  directory.
- **The Windows installer's SmartScreen warning is now explained.** The
  quick-start tells you what "Windows protected your PC" means on first install
  and on Update Now, and how to continue, since the installers are not
  code-signed.
- **The desktop app no longer reappears on the old version after starting an
  update.** Once the installer is launching, a launch handed to the still-running
  old process (shortcut, `owncord://` link, autostart) is ignored instead of
  bringing the old window back for the whole install. The update log now records
  the version and PID at startup and the timing around the installer launch.
- **A silent Windows update no longer relaunches the old version.** The
  installer could overwrite the app while the old copy was still exiting, skip
  the locked file and start the old build again. It now waits for the old
  executable to close before copying the new one.

### Configuration

- **A quoted number or boolean in `config.yaml` is now rejected at startup**,
  naming the line it sits on. `port: 8443` is a number; `port: "8443"` is a
  string and is no longer accepted.
- **List-valued `OWNCORD_*` overrides are comma-separated.** `OWNCORD_FOO=a,b`
  sets two entries, not one. A configuration file is unaffected.
- **A section left empty keeps its defaults.** `voice:` with nothing beneath it
  no longer discards everything that section would otherwise have supplied.

### Privacy & data

- **Deleting an account now really deletes it.** Every class of data the
  account owned — messages, files, reactions, DMs, sessions, tokens, voice
  state — is removed, not just hidden. The file half is journaled, so an
  interrupted deletion resumes on the next start instead of stranding files.
  Administrators can do this for an account from the admin panel.
- **A backup restore can no longer resurrect a deleted account.** Deletions are
  recorded outside the database file and re-applied whenever the server opens
  it, including after a restore of a backup taken before the deletion.
- Audit history about a deleted account keeps its integrity — what happened and
  when — without keeping who.
- **An account deletion now finishes its own disk-level cleanup.** If a reader
  is holding the database open while the deletion runs, the final compaction is
  retried at the next start and by the background maintenance pass, instead of
  waiting for an unrelated later write to happen along.
- **A server whose deletion history has gone missing now says so.** If the
  deletion markers are absent but the key that names them is still there — the
  shape a restore from a database-only backup leaves — start-up logs an error
  naming the absent history. It still starts, deliberately: losing one small
  file should not be a total outage.
- **Message retention.** Off by default: messages are kept forever unless you
  say otherwise. An operator can set a server-wide window and override it per
  channel in either direction. Pinned messages are exempt and DMs are never in
  scope. The admin panel previews what a policy would remove before you apply
  it. The sweep is bounded, restart-safe, and swept messages disappear from
  reconnect history too.
- The server no longer contacts a public DNS server on startup to work out its
  own address; it reads the interface table instead. A default install makes no
  outbound connection you did not configure.
- Per-user volume settings and DM notes saved by an older client are now
  carried across to this version instead of being left behind.

### Message Requests

- **First-time DMs arrive as Message Requests.** A stranger's first direct
  message no longer lands in your inbox: it waits in a Message Requests list as
  a text-only preview until you accept, ignore, delete or block it. Accepting is
  what creates the contact — ignoring keeps the sender out of your normal DMs,
  and blocking also files the request away. Only text is shown before you
  accept, so an unsolicited attachment is never fetched.
- You can mark a sender as trusted so their later messages skip the request
  queue, and the same sender is recognised across your devices.

### Moderation

- **A permission-gated Moderation Center** brings reports, evidence and
  decisions into one place. Members with the moderator role see the queue and
  the authorized evidence; everyone else sees nothing, and the server enforces
  that, not the panel.
- **Report a message, user or attachment to your own server's moderators.**
  Reporting is local to the server — nothing is sent anywhere central — and the
  evidence snapshot is taken at report time so a later edit or delete cannot
  change what the moderator reviews.
- **Issue a warning, timeout, kick or ban from a report**, with the role
  hierarchy enforced: you cannot act on someone at or above your own rank, on
  yourself, or on the owner. Every action and status change is written to an
  immutable audit history.
- **Appeals.** A user who was warned or restricted can file an appeal from their
  Safety tab, withdraw it, and follow its status; a moderator reviews and decides
  it, and the decision is recorded.

### Safety & consent

- **NSFW channels wait for your acknowledgement.** An adult channel's content,
  previews and attachments are not fetched or rendered until you acknowledge
  them; acknowledging is per user, survives a restart, and can be revoked.
- **External content is gated on consent before anything is requested.**
  Link previews, GIF search and embedded media make no third-party request
  until you consent for that server, and the desktop client fetches through a
  local broker that confines the destination — so nothing is contacted, and no
  destination leaked, before you agree.

### Translation-ready text

- **The desktop app's text now lives behind English catalogs**, with a
  shrink-only scan that fails CI when a user-visible string is written outside
  them. This is not a second language: it is the seam and the inventory a later
  translation can build on, plus date, number and plural formatting helpers.

### Desktop UI

- **A zoomed window can reach the sidebar again.** At 200 % zoom (or any
  window at most 800 px wide) the sidebar collapsed to nothing and channels,
  DMs, Message Requests, the Moderation Center and Settings became
  unreachable. A menu button in the header now opens it as a drawer that
  closes on Escape, on an outside click, and after choosing a destination.

### Admin panel

- **The admin panel now matches the app's look and is readable for everyone.**
  It uses the same dark neon palette as the desktop client, and every text,
  status badge, input edge and danger button meets WCAG contrast targets.
- **Keyboard focus is visible again** on the admin panel: tabbing shows a cyan
  ring on links, buttons and fields instead of nothing.
- Dialogs take focus when they open, keep Tab inside, hand focus back when they
  close, and announce their title; form fields, search boxes and file pickers
  have proper labels; toggles report their on/off state; icon buttons have names.
- **Error notifications now stay until you dismiss them**, so a failure can be
  read and acted on, and the panel honours your system's reduced-motion
  setting.
- On a narrow window the admin panel's navigation stays reachable and wide
  tables scroll instead of being cut off.
- Audit log, dashboard activity and pending registration times now show in
  your local time; hover one to see the exact UTC time.
- **Audit log search now covers the whole log**, not just the 50 entries on
  screen; the action filter does too. Server log lines, the Dashboard's
  Attention times, API tokens, plugins and support-bundle expiry also show
  local time with the UTC time on hover.
- The Server logs toolbar shows real icons instead of symbols that some
  systems drew as empty boxes, and its level buttons say whether they are on.
  The Diagnostics redaction report is laid out as a readable list.
- The admin panel's security policy now refuses any script that is not one of
  the panel's own files, so injected markup can no longer run code. The panel
  looks and works exactly as before.
- **The admin panel's navigation is regrouped** into Overview, Community,
  Moderation, Server, Operations and Integrations, with count badges for
  pending registrations and active warnings and a dot when an update is
  available. Existing `/admin#section` links still open the same pages.
- A top bar now names the server and its version, shows the signed-in account
  and role, and holds Sign out in its account menu.
- Below 900 px wide the navigation is a drawer behind a menu button: it takes
  keyboard focus when it opens and closes on Escape, an outside click or a
  chosen page.
- **Creating a role now warns when it would outrank Admin or Moderator.** A new
  role still defaults to the highest free rank below yours, which for the owner
  is above every built-in role; the dialog now says so before you create it,
  offers a one-click "place just above" the default role, and refuses a rank
  that is already taken.
- The Roles page is a rank ladder, highest first, with a line at your own rank,
  and every permission's description is shown under it instead of in a
  mouse-only tooltip.
- Channel access opens as a side drawer with Access, Overrides and Explain tabs
  instead of one long dialog.
- Deleting a channel or a role now asks you to type its name first.
- **Members has All, Pending and Banned tabs, a username search and a role
  filter**, and they search the whole server, not just the page on screen. Each
  row has one Manage button and a ⋮ menu instead of a row of unlabelled icons.
- Your own row, and anyone at or above your rank, no longer offers Ban, Force
  logout or any other action the server would refuse; a You, Outranks you or
  Same rank badge says why.
- **The setup wizard's security step now says what each TLS mode means for
  the desktop app**: Let's Encrypt needs port 80 as well as the server port and
  every renewal makes members accept a new fingerprint, and "off" means the
  desktop app cannot connect without an HTTPS reverse proxy in front.
- The setup wizard names each step ("Step 3 of 6 · Server"), and its finish
  screen shows the address members connect to beside the invite code and the
  certificate fingerprint. Sign-in and setup share one card layout, and Enter
  submits them.
- **Who may register is now a choice**: closed, invite only, approval, or open.
  Fresh installs default to invite only. Existing servers keep the behaviour
  they had — a server that required an invite still requires one, and
  registration is never opened by the upgrade. Switching mode is audited.
- The desktop sign-up form follows the server's registration mode: it asks for
  an invite code only when one is needed, says up front when an admin must
  approve the account, and disables Register on a closed server. If the mode
  cannot be read, it still asks for a code.
- **Approval mode** adds a queue: applicants can be listed, approved or denied,
  and cannot sign in until approved.
- Retention can be read, set and cleared per channel, with a server-wide
  default and an effect preview.
- **Settings are grouped** into General, Access & registration and Security,
  with a save bar that stays in view while there are unsaved changes.
- The upload limit and voice quality now show the values the server is running
  with from config.yaml, instead of disabled fields that could disagree with it.
- The backup schedule moved to Backups & restore, beside the backups it makes.
- **Restoring a backup asks you to type its file name**, then waits for the
  server to restart and reloads. It used to be one click and only suggested a
  restart.
- **Updating the server backs up the database first** unless you untick it,
  links the release notes and warns that database migrations only run forward;
  a failed backup stops the update.
- Creating or revoking an invite, and installing or uninstalling a plugin, now
  show up in the audit log. Invite entries name the invite by id, never by
  code.
- The owner check no longer costs a second database lookup on every request.
- **A refused `/admin` request now names the setting behind it.** The `403`
  body points at `server.admin_allowed_cidrs` (private networks by default), so
  a VPS operator can tell a firewall from the allowlist; the metrics and LiveKit
  webhook routes name their own allowlists the same way. The quick-start and
  deployment pages describe the SSH tunnel (`ssh -L 8443:localhost:8443`) and
  the allowlist entry for headless installs.

### Accessibility

- **The desktop client's login page is keyboard-operable.** The Register toggle
  and the "recover your account" link are now real buttons reachable with Tab;
  they were links without a destination, so a keyboard-only user could not
  sign up or start recovery.
- **The Appearance theme and accent pickers are one Tab stop each**, moved with
  the arrow keys, instead of one stop per tile and swatch.
- Focus rings are restored on channel mentions and message-link chips, and on
  the status text field.
- Composer refusals (message too long, uploads pending, a failed upload) now
  stay on screen until you edit or send again, and use a text colour that meets
  the contrast bar rather than vanishing after four seconds at about 3:1.
- Destructive and status labels — Delete Channel, Log Out, "Offline", a slow
  server's latency — use the accessible danger text colour instead of the raw
  red fill colour.
- The in-app **Reduce Motion** toggle now also stops the connect-page background
  pulse and the primary-button shimmer.
- **Voice and media controls are keyboard-reachable and meet contrast targets.**
  Mute, deafen, camera, screen-share and disconnect are operable with Tab and
  Enter, announce their state, and use the accessible text colours.
- **Message reading, composing and the overlays are keyboard- and
  screen-reader-friendlier:** the message list and composer expose their roles
  and labels, and dialogs keep focus inside and hand it back when they close.
- **Settings > Logs no longer scrolls sideways at 200 % zoom.** Its filter and
  level controls and its Copy All, Clear Logs and Refresh buttons wrap onto
  more than one row, and a log line with a long unbroken URL, token or hash
  wraps too, instead of pushing the pane into a horizontal scroll.

### Documentation

- `docs/trust-model.md` answers "who can read my messages?": the server
  operator can read text and files; voice, video and screen share are
  end-to-end encrypted; what beta does not claim. Every claim cites the code
  or test behind it.
- `docs/architecture/plugins.md`: plugins are experimental, off by default,
  compiled out of release binaries, and carry no API promise.
- `docs/architecture/data-lifecycle.md` models what happens to your data when a
  destructive operation is interrupted, runs out of disk, crashes, races
  another writer, or is undone by a restore.
- `docs/architecture/diagnostics.md` lists every diagnostic surface the server
  has and where its data goes, and states the support-bundle contract.
- `docs/architecture/server-boundaries.md` records which parts of the server
  may talk to the database directly.
- `docs/deployment.md` now covers upgrading and rolling back: stop the server,
  archive the install, swap the binary or image, and — because migrations only
  ever run forward — restore that archive first if you need the old version
  back.
- **`docs/deployment.md` says what a backup has to contain to be restorable.**
  The backup endpoint's file is the database only; the uploads and the key and
  marker files beside `data/` are what a restore needs with it, and restoring
  without the markers brings deleted accounts back. The same page describes the
  three stages a server passes through as its disk fills, and what an operator
  sees at each.
- **`docs/architecture/data-lifecycle.md` carries the failure and recovery
  drill results.** Every destructive operation is now measured against the
  failure axes that matter — interrupted, out of disk, racing a reader,
  crashed, undone by a restore — with each row naming the test or the drill run
  that produced it, and the byte-level erasure evidence under an active reader
  tabulated file by file.
- **`docs/capacity.md` says how much one server carries, and on what.** 250
  registered accounts, 100 connections held for three minutes, and 25 people in
  voice — measured on a 2 vCPU / 4 GB machine, with the exact commands to
  re-run it yourself, and with the things the numbers do not mean written down
  next to them.
- **Docs (not user-visible):** the beta product requirement for deleted-account
  audit history, the requirement-traceability row, and the repository-health
  register now describe the retained audit-token design as it was actually
  built and approved at HP-4 — one stable per-subject token, not an erased
  key — instead of the earlier, superseded wording. Those pages, and the
  trust-model and security pages carrying the same claim, now also name the
  two residues the token does not cover — the `erasure_jobs` row's bare user
  id and the free text an erased moderator authored — rather than claiming a
  deidentification the shipped code does not deliver.
- **`docs/deployment.md` now answers day-2 operation from the page itself.**
  Where logs actually land under journald, Docker, Task Scheduler and NSSM
  (with the two `nssm set` lines a Windows service needs or it has no logs at
  all); the support bundle — what it holds, what it never holds, and how to
  download it from the admin panel; the configurable capacity ceilings and what
  each returns when reached; what grows on disk and what is pruned, and the
  thirteen steps the background maintenance pass takes in order.
- **`docs/deployment.md` moves the backup set to where recovery is read.**
  Backup Strategy carries the full list of what a restorable backup must
  contain and what each file costs you to lose; Upgrade and Rollback keeps a
  one-line pointer, and Restore now describes the real sequence the server
  runs, including what a restore cannot bring back.
- **`docs/deployment.md` documents the certificate per mode, honestly.**
  Self-signed: two years, no expiry check, no reload — and the rotation
  procedure with what every desktop client sees afterwards. ACME: what it
  needs (inbound port 80 included) and what renews trigger on pinned desktop
  clients. Manual and plaintext: the restart and the trade-off, respectively.
- **`docs/deployment.md` gained "When it fails"** — a symptom-first section
  for the failures an owner actually hits: the health endpoint, a server that
  refuses to start, voice with no audio, voice that will not join, the
  certificate-mismatch modal, a 2FA lockout after a restore, upload refusals,
  an update that did not come back — and what to send when asking for help.
- `docs/deployment.md`'s update-failure procedure names the audit rows the
  updater writes, the two self-recovery shapes read from its verification and
  rotation code, the pre-checks that prevent the failures, and the port-80
  row for ACME moved into the canonical firewall table.

### Repository

- `protocol/schema.json` declares `protocol_epoch`; `npm run generate` emits it
  as `ws.ProtocolEpoch` and `PROTOCOL_EPOCH`. Rules for bumping it:
  `docs/protocol.md`, Compatibility.
- The server's route table, database tables and configuration keys are now
  generated into the docs and checked for drift in CI.
- CI gained a coverage floor, a nightly Docker smoke test of `dev`, seeded
  simulation and fuzz targets, and four static invariant rules covering lock
  discipline, database-import boundaries, permission chokepoints and outbound
  network sites.
- The load baseline now runs the server inside a 2-CPU, 4 GB cgroup with the
  load generators pinned outside it, and a second, unconstrained leg kept only
  as a headroom check. A voice harness drives 25 publishers and 25 subscribers
  through LiveKit's own load tester and checks the result, rather than trusting
  its exit status.
- The load baseline gained three operational profiles beside the capacity run:
  `operational` (reconnect storm, per-phase database-wait deltas, voice
  join/leave churn, upload admission through the quota, and the same run with
  TLS off for a cost delta), `restart` (the server is stopped and started under
  100 connections, with drain time, exit code and lost drain-window sends
  checked) and `ceiling-search` (connections stepped up to 500 to find where a
  capacity budget first breaks). `GET /api/v1/metrics` now reports the SQLite
  reader pool's wait count and seconds beside the writer's.
- All four of those profiles have now been run on the 2-CPU cgroup and the
  numbers published in `docs/capacity.md` — including the two budgets they
  miss, the restart that drained in six seconds losing nothing, and why the
  connection search stops telling you about the hardware past 100 connections
  in one channel.
- `upgrade-rehearsal.yml` now also runs the failure and recovery drills, on the
  nightly and on dispatch: backup and restore through the real admin endpoints
  with clients connected, the deletion-marker restore, disk pressure both as a
  process and inside the container image, corrupt operator input, and the SFU
  drill against a checksum-verified LiveKit release. A drill that cannot run
  reports `skipped`; none of them can report a pass they did not measure.
- Releases now carry a signed provenance attestation for every asset, an SBOM
  for each server asset, and an attestation on the container image. None of it
  requires trusting the download page — [Verifying a
  Download](docs/deployment.md#verifying-a-download) has the commands.
- The database-boundary guard now rejects handle **use**, not only imports: a
  file that reaches the handle through a package field is measured even when it
  imports nothing, every boundary file pins the exact calls and hand-offs it
  makes, and an adapter file that makes one fails the gate. Four previously
  unclassified websocket reads now go through the seam that owns them, and the
  replay purge's two deletes stay exactly where they are, pinned. No behaviour
  change.

## v1.2.0-alpha.4

**62 bug fixes**, all user-visible, plus repository work that changes nothing an
operator can see. Fixes first; the repository half is the short block at the end.

### Login & connection

- Connecting with a failed role lookup silently made you a plain **member** — it
  now fails closed instead of guessing.
- **Banned users could still connect.** Ban status is re-checked on connect.
- Reconnecting left a **phantom voice E2EE key holder** and a stale voice-channel
  marker behind.
- Typing indicators in DMs could **disconnect you** under load.

### Voice

- Moderator mute and deafen are **preserved across a channel move** — they were
  silently dropped.
- Voice E2EE keys **re-sync on reconnect**, and a departed peer's key is always
  retired so a replayed announce cannot overwrite a fresh one.
- A kicked client no longer receives frames.
- A rolled-back join now reaches everyone present, including people without
  permission to read the channel.
- A **failed microphone unmute now shows as failed** instead of quietly
  reporting you as unmuted.
- Noise suppression rebuilds correctly after a microphone restart.

### Mentions

- **`@here` no longer behaves like `@everyone`** — the two are distinguished.
- Mention badges are reversed on delete, purge and account deletion, and can no
  longer be reversed twice.

### Messages & files

- Deleting a message now **actually deletes its attachment files**.
- A failed avatar upload no longer deletes a committed file's reference.

### Accounts & admin

- The `require_2fa` enrollment gate misfired after a temporary ban lapsed, and
  applied its precondition to unrelated settings.
- A DM partner with no live connection now shows **offline everywhere** — it was
  inconsistent between views.
- Plugin installation rolls back properly when it fails.
- The diagnostics endpoint honours trusted proxies.

### Desktop app

- Fixed event-listener leaks in the message list, member list, emoji picker,
  quick switcher, sidebar popovers and drag-reorder.
- Recent emoji, channel mutes and custom status are now **per-server** instead of
  bleeding between servers.
- The DM sidebar filter survives updates, the call button cannot redial, the
  incoming-call banner uses nicknames, and Ctrl+I unwraps correctly on bold text.

### Repository — no runtime effect

Phases B0 and B1 of the
[repository-health roadmap](docs/plans/repo-health-roadmap-2026-08-23.md).
Desktop behaviour, release asset names and the update contract are unchanged by
design. Three items affect anyone holding a working copy or a fork:

- **`Client/tauri-client/` is now `Client/`** (#1411). Rebase an in-flight
  branch rather than merging across the move.
- **The Go module is now `github.com/J3vb/OwnCord/Server`** (#1417), was
  `github.com/owncord/server`.
- **The protocol schema is now `protocol/schema.json`** (#1417), was
  `docs/protocol-schema.json`.

One command runs what CI gates on, Windows and Linux, no `make` needed:
`npm run bootstrap`, then `npm run check`. Go-only contributors still do not
need Node.

## v1.2.0-alpha.3

- **fix:** eight bug-hunt batches closed **199 verified defects** since
  `v1.2.0-alpha.2` — 30 in #1366/#1367, 110 in #1369–#1372, 34 in #1374 and
  25 in #1375 — each fixed test-first with the failing assertion watched red
  against the unpatched code. The behavioural consequences worth knowing
  about are listed below; the rest are one-line correctness fixes with no
  operator-visible change.
- **security(client): voice E2EE was never actually enabled** (#1370). The
  full ECDH/HKDF/AES-GCM key exchange completed, the room key was set, and
  the UI showed 🔒 Secured — but `createRoom` never called
  `room.setE2EEEnabled(true)`, so every audio and video frame reached the
  SFU in plaintext. It is enabled now, and a dead E2EE worker is no longer
  invisible to the Secured badge. Related voice-crypto fixes: a joining key
  holder sent its room-key offers _before_ its own announce, so existing
  participants dropped them as "unknown peer" (#1370, #1374); rotation
  offers exceeded the server rate limit in large channels and permanently
  starved the same peers; both rotation paths and the reconnect-to-Secured
  path now carry session-generation guards; a departing peer's ephemeral
  key is retired on leave so a replayed pre-leave announce cannot overwrite
  the fresh key they rejoined with (#1372, #1374). The client also refreshed
  its LiveKit token every 23 hours while the server mints it with a 5-minute
  TTL, so auto-reconnect failed for any voice session older than five
  minutes (#1370).
- **security(server):** access-control holes (#1369–#1372, #1374, #1375) —
  `voice_join` into a 1:1 DM had no block gate, so a blocked user could
  enter the blocker's DM voice room; the attachment-serve admin bypass let
  an ADMINISTRATOR download files from private DMs they were not in; the
  archived-channel read-only gate covered `SendMessage` only, so edit,
  reaction, pin, purge, delete and `channel_focus` still mutated or
  subscribed to archived channels (every write sink now routes through one
  `requireChannelWritable` gate); `EditMessage` and `handleReaction` DM
  detection failed _open_ on a `GetChannel` error, skipping the block gate;
  group-DM creation only block-checked the creator, letting a third party
  force two users who blocked each other into a shared room; an invisible
  user's real custom status leaked on both presence emitters; `PATCH
/users/{id}` with `banned` + `role_id` committed and broadcast the ban
  before authorizing the role change; admin API-token creation accepted a
  negative `expires_hours` and minted a token that never expires; upload
  rejections echoed raw storage errors (absolute server paths) to any
  authenticated user; the GIF proxy's log redaction missed the
  percent-encoded API key; `chat_command` was the only client message type
  without a rate limiter while each frame ran a WASM plugin invocation; and
  the login and typing rate limiters built their keys from _unvalidated_
  input, letting an unauthenticated caller pin unbounded heap for six hours.
- **fix(auth):** accounts whose username contains `'`, `"` or `&` were
  permanently unloggable — registration HTML-escaped the name but login did
  not — and a profile rename to such a name locked the user out (#1370). If
  you had users hit this, they can log in again with no action on your side.
  Also: message search returned 500 for any query containing a hyphen (the
  one FTS5 operator the sanitizer allowlisted); usernames with an uppercase
  non-ASCII letter could never be @mentioned; registration recorded the
  reverse-proxy address as the session IP.
- **server:** WS hub, reconnect and replay (#1369, #1371, #1372, #1374,
  #1375) — REST DM events never bumped the visibility watermark, while
  _every_ ordinary DM message re-emitted `dm_channel_open` and bumped the
  global watermark, forcing every other client's next reconnect into a full
  resync; the client's `lastSeq` was never reset by a full-ready resync and
  desynced permanently; cold-tier replay had no interior-gap detection, so
  events the persister dropped were skipped and presented as a complete
  resume; `buildReady` swallowed three DB errors and shipped an
  authoritative-looking empty snapshot (the client wiped its DM list, member
  list and unread badges) and dropped the user's own live voice room when
  not READ-visible; `channel_focus` could re-subscribe after a concurrent
  visibility revoke, and role demotion's live-subscription revocation was
  gated on a cosmetic role re-read; a failed reconnect handshake ran the
  full disconnect teardown twice; presence events from every source now
  share one ordered per-client FIFO.
- **server:** voice lifecycle (#1369, #1371, #1374) — a stale join's
  rollback deleted `voice_states` by user id alone, destroying a concurrent
  newer membership; deleting a voice channel raced a concurrent `voice_join`
  into a permanent hub/SFU ghost no sweep could heal; the stale-state sweep
  could delete a just-committed join's row, leaving the client in voice with
  no DB row; `handleVoiceJoin` handed out a live 5-minute LiveKit credential
  _after_ a concurrent kick/move/revocation had already torn the membership
  down (the token is now withheld); the `participant_left` webhook never
  told the leaver, and a transient DB read error on `participant_joined`
  ejected a legitimate participant mid-call; `voice_mod_move` lacked the
  archived-channel gate; `CleanupVoiceForChannel` resolved an empty
  `voice_leave` audience because both callers archive first. Camera and
  screenshare now draw from the same per-channel `voice_max_video` budget —
  screenshare had no cap check at all, and the camera gate did not count
  screensharing occupants.
- **server:** DM and message fan-out (#1369, #1371, #1372, #1375) — a DM
  send, edit, delete or reaction survived a transient participant lookup
  failure by silently dropping live fan-out to everyone including the
  sender; emoji create/delete and group-DM creation tied their broadcasts to
  the request context, so an aborted request committed the mutation and
  skipped the event; slow mode consumed its cooldown token before content
  validation, so a rejected send locked the composer for the full window; an
  attachment-metadata read failure broadcast the message with no
  attachments; `GET /channels/{id}/pins` had no LIMIT and failed permanently
  past ~32k pins; pinning a soft-deleted message returned 500;
  `LinkAttachmentsToMessage` no longer claims a user's live avatar as a
  message attachment; `PATCH /channels/{id}` now rejects a blank name.
- **server:** admin and plugins (#1369, #1370, #1372, #1375) — "Restore
  backup" wrote to a hardcoded `data/chatserver.db`, so it silently no-oped
  on any server with a configured `database.path`; the WAF inline engine
  rejected every request body ≥ 1 MiB, breaking plugin install and large
  avatar uploads when `waf_enabled` was on; self-account-deletion emitted no
  `member_ban`, so every other client kept the deleted user; the admin live
  log stream blanked every error attribute to `{}`; `CheckForUpdate` had no
  in-flight dedupe and stampeded GitHub on cache expiry; a failed self-update
  swap left every client counting down to a restart that never came (a
  corrective `update_aborted` is now broadcast, and deferred cleanup runs
  before the restart exits — on Windows that file-handle release is the
  reason the restart exists). Plugin enable/re-install left
  `plugins.enabled = 1` while the runtime instance was deactivated, and
  uninstall reported success while the on-disk directory survived and
  resurrected the plugin on the next start.
- **fix(client):** voice reliability (#1366, #1367, #1370–#1372, #1374,
  #1375) — a failed voice channel-switch left the user live in the call
  (mic hot, audio flowing) with the voice UI hidden and no way to leave;
  selecting the "Default" microphone (or losing the pinned one to a hot
  unplug) never changed the capture device; a camera or screenshare disable
  that completed while the enable's `publishTrack` was in flight left the
  server and every peer believing it was on (`leaveVoice` and reconnect
  teardown now bump the same generation guard); a `VIDEO_LIMIT` rollback
  assumed the camera and tore down a working camera while leaving refused
  screen tracks published — it now correlates by envelope id; auto-idle's
  return-to-online `presence_update` was always swallowed by the 1-per-10s
  limiter, so every user showed Idle to everyone else after their first idle
  period; connection-quality degradation was never reported; a group-DM
  decline silenced every other participant's ring and never reached the
  caller.
- **fix(client):** messaging and stores (#1366, #1367, #1369, #1372) —
  re-opening a channel visited earlier in the session rendered a permanently
  stale window (live broadcasts only cover the focused channel; the tail is
  now refetched); the virtual scroll window never followed the scroll
  position, so rows past the initial overscan rendered as blank space; a
  scroll-up page past the 500-row cap deleted the user's pending/failed
  rows, the only copy of their composed text; the scroll-to-bottom button
  and "Jump to Present" pill scrolled out of view exactly when they became
  visible; a user named exactly "System" had every message rendered as a
  server notice with no moderation controls; DM permalinks failed until the
  DM had been opened once; the reaction picker dropped the server's custom
  emoji; Ctrl+K was dead with CapsLock on; the composer's slow-mode cooldown
  was applied to whichever channel was mounted, not the one that sent.
- **fix(client):** settings, session and platform (#1367, #1370–#1372,
  #1375) — the built-in light theme overrode only 4 of ~45 tokens (composer
  and inputs near-invisible), the Font Size slider and High Contrast toggle
  were no-ops, and the tray Status menu bypassed the client's own status
  state so a tray-set Do Not Disturb silenced nothing; a failed TOTP verify
  tore down the overlay so the code could not be re-entered; channel
  create/edit/delete modals locked up permanently on an API failure; login
  to an IPv6-literal host was impossible; a host stored with an explicit
  `:443` lost its bearer token and cert-pinned proxy on attachment fetches;
  one malformed stored server profile discarded _all_ saved profiles; a
  banned/revoked token reconnected forever if the session ended before
  MainPage mounted; a previous server's block list, collapsed categories and
  DM notes bled into the next server; the Rust HTTP proxy tunnel's data
  phase had no deadline, so a remote that completed TLS then went silent
  parked the connection forever (bounded at 600s — loose on purpose, this
  path carries uploads); the autostart toggle raced its own write.
- **infra:** observability, backups, guardrails and deployment hardening
  (#1376). **`/health` now returns a real verdict** — hub dispatch-loop
  liveness, a bounded DB ping and a free-disk check, answering **503 with a
  subsystem reason** (`hub`, `database`, `disk`) when degraded; results are
  cached so the unauthenticated endpoint cannot amplify load. Point uptime
  monitors at it and treat any 503 as actionable. **The hub's panic breaker
  now exits the process** so a supervisor can restart it, instead of leaving
  broadcast delivery silently dead while clients still appear online — if
  you run the bare binary without a supervisor, use the new hardened
  `deploy/owncord.service` systemd unit (see "Running as a Linux Service").
  **Backups now actually run:** `backup_schedule` and `backup_retention`
  had existed in the admin panel since the initial schema but were never
  read by any code; the 15-minute maintenance loop now enforces them,
  verifies each backup with `PRAGMA integrity_check` (and again before a
  restore may overwrite the live DB), and prunes by age keeping the newest.
  Expect backup files to start appearing and pruning for the first time.
  `/api/v1/metrics` gains reconnect-tier, backpressure, DB-writer-wait,
  permission-cache, `ws_conn_rejects` and `disk_free_mb` signals, and the
  declared-but-never-recorded OTel instruments are wired. Upload storage
  failures return **507** instead of blaming the client with a 400. A
  single-process lock beside the SQLite file makes a second server process
  fail fast instead of silently fighting the first. **Unknown config keys
  now warn at startup** (a typo previously kept the default silently), and
  startup warns when `admin_allowed_cidrs` is customized while
  `trusted_proxies` is empty. Shutdown now joins the pruner and maintenance
  loop before the DB closes, drains HTTP handlers into a live hub, and skips
  the 5s client-notice window when nobody is connected. Write-path work:
  no-op read-state UPSERTs are skipped, boot-time `ANALYZE` runs only when a
  migration applied, role-scoped override changes evict only that role's
  members from the permission cache, and connect/disconnect presence passes
  through a 300ms latest-wins coalescer (wire format and seq ordering
  unchanged).
- **config:** new keys, all defaulting to current behaviour (#1376) —
  `server.max_ws_connections` (0 = unlimited; over the cap answers 503 +
  Retry-After), `server.metrics_allowed_cidrs` and
  `server.livekit_webhook_allowed_cidrs` (both fall back to
  `admin_allowed_cidrs`, so a central Prometheus scraper or an
  externally-hosted LiveKit no longer requires widening the admin
  perimeter), `database.max_readers` (0 = auto), `backup.dir`
  (`data/backups`), `security.auth_rate_limit_multiplier` (1.0; raise for
  shared-NAT communities), `event_persistence.replay_ring_size` (1000) and
  `event_persistence.replay_cold_limit` (5000 — watch `reconnect_tier_full`
  before raising). Three stored-but-inert admin settings (`server_icon`,
  `max_upload_bytes`, `voice_quality`) are now shown read-only with a
  pointer at the real `config.yaml` keys instead of pretending to apply.
  Documented in `docs/server-configuration.md`.
- **deploy:** new `chatserver healthcheck` subcommand probes `/health`
  pinning the server's own certificate from disk (WebPKI when none exists,
  i.e. ACME) and is now the docker-compose healthcheck — the distroless
  image has no shell; plain `docker compose` only _surfaces_ unhealthy, pair
  it with a watchdog for auto-restart. Compose gains json-file log rotation
  (`10m` × 3) on both services. `release.yml` now cold-boots the freshly
  built server binaries and Docker image and probes them healthy **before
  anything is signed or pushed** — the release feed drives signed
  self-updates, so a binary that compiled but died on boot would previously
  have shipped itself to every auto-updating instance. New "Reverse Proxy
  Topology" docs section (nginx snippet; only WebRTC media ports need to be
  directly reachable, `/livekit/*` is already proxied). Release binaries
  are built with Go 1.26.6 (stdlib CVE fixes flagged by govulncheck).
- **migrations:** **031** normalizes legacy `sessions.expires_at` values to
  RFC3339-UTC and adds `idx_sessions_expires_at`, so the 15-minute expired-
  session sweep is an index lookup instead of a full-table scan on the
  writer. Applies automatically on first start; no operator action needed.
- **protocol:** no wire changes — `docs/protocol-schema.json`,
  `message_types.go` and `protocolTypes.ts` are byte-identical to
  `v1.2.0-alpha.2`. Older clients and servers interoperate unchanged.
- **fix(ws):** the LiveKit health check shared the process-wide
  `http.DefaultTransport` pool with every other user in the server; it now
  owns a private transport (#1356).
- **chore:** bug-hunt tooling under `.claude/` (fix pipeline, findings
  ledger, circuit breaker, single-finder hunt with graph-fed targeting —
  #1361–#1365, #1373); dependency bumps (OTel 1.45.0, koanf, sqlite,
  eslint/oxlint/knip/typescript-eslint, tauri-plugin-updater, GitHub
  Actions; #1353–#1360). No runtime impact.

## v1.2.0-alpha.2

- **feat(client):** the login form has an **Auto connect** checkbox under
  Remember password. Ticking it makes that server connect automatically on
  launch — the same setting as the auto-login button on a server card, so
  the two stay in sync, and as before only one server can be auto-connect
  at a time.
  Ticking it also forces Remember password on and locks it: auto-connect
  replays the stored token, which is only written when the password is
  remembered, so the two cannot be set independently without producing a
  setting that silently does nothing.
- **fix(client):** Remember password works again. The password was saved to
  the OS keyring but never returned to the client over IPC, so the login
  form could not prefill it — the box appeared to work and did nothing.
- **fix:** three bug-hunt sweeps closed **233 verified defects** since
  `v1.2.0-alpha.1` — 26 in #1328, 107 in #1331, 100 in #1332 — each fixed
  test-first, with the failing assertion watched red against the unpatched
  code before the patch landed. The behavioural consequences worth knowing
  about are listed in the nine entries below.
- **server:** WS hub reconnect and replay hardening (#1328, #1331).
  Cold-tier replay used to truncate silently instead of forcing a full
  ready, and a retention-pruned event log was accepted outright as a
  complete resume — the highest-impact fix in #1331, since any client whose
  reconnect gap crossed the 24h retention default was permanently desynced.
  Resume also silently dropped the focused channel's topic subscription,
  stopping message delivery until the user manually switched channels; it
  is now restored during the handshake. `visibilityChangeSeq` can now only
  move forward across its three writers — it previously could regress and
  skip a required resync.
- **server:** voice/E2EE key-holder election and audience gating (#1328,
  #1331) — three key-holder desync bugs (no client demotion path, peer keys
  cleared on reconnect, missing re-election on the webhook and
  fresh-reconnect paths), plus re-election wired into the sweep and
  channel-cleanup paths. Voice events were READ-filtered while membership
  is CONNECT-only, so participants in that gap silently missed
  `voice_leave`, stalling key-holder election and forward-secrecy rotation.
  Deleting a channel now evicts its voice participants first — the cleanup
  function existed but had zero production callers, so the FK cascade used
  to strand them silently. Moderator mute/deafen now survives a
  voice-channel switch; joins to non-voice channels are rejected; archived
  channels are read-only and unjoinable.
- **security(server):** roles/permissions (#1328, #1331) — `UpdateRole`
  allowed position collisions that `CreateRole` already rejected, so tied
  positions could read as equal rank in every hierarchy comparison; it now
  matches `CreateRole`'s validation. `can_send` is now recomputed per client
  on every role/override change, so a permission change takes effect for
  connected clients immediately rather than waiting on a reconnect.
- **server:** attachments and admin data-safety (#1331) — migration **030**
  unlinks attachments on message delete instead of cascading, so a cascaded
  channel/DM delete no longer strands uploaded files on disk with no
  reclamation path. The 15-minute orphan-attachment sweep was deleting every
  avatar in the instance (avatars are, by design, attachments with no
  message link) on its first tick past the grace period, permanently 404ing
  every profile picture; a second bug in the same sweep collapsed the
  one-hour grace period to effectively zero, from a TEXT-comparison mismatch
  between an RFC3339 cutoff and SQLite's own timestamp format. A failed
  backup restore used to truncate the live database to zero bytes with no
  rollback, while the server kept answering requests against the now-closed
  DB and falsely claimed a restart was underway — it now restores the
  pre-restore safety copy on failure and requests the restart honestly.
  Also fixed: personal data is cleared on account deletion, banned users are
  excluded from owner lookup, the silent 1000-member roster cap is gone, and
  a sender's own read state now advances on send. Migration applies
  automatically on first start; no operator action needed.
- **protocol:** a new READ-gated `active_channel_id` auth field (#1331)
  restores the focused-channel subscription during the reconnect handshake
  itself, closing the window before the post-`auth_ok` `channel_focus` round
  trip lands. `protocol.md` also corrects the presence table, which had
  incorrectly documented all presence events as sequenced. Older
  clients/servers are unaffected — it is a new, ignorable field.
- **security(client):** identity/TOFU and transport (#1332) — an in-flight
  change to scope the identity keypair by host _and_ user id would have
  re-minted a fresh key on every existing install, firing the TOFU "verify
  out-of-band" re-pin warning at the entire alpha population simultaneously,
  exactly the pattern that teaches users to click through the one warning
  meant to matter. The legacy host-only key is now adopted into the scoped
  name instead, saving before deleting so a partial failure cannot strand a
  user with neither key. Switching hosts carried the previous server's
  bearer token forward into the next login request; `api.setConfig` now
  drops it when the host changes without a replacement. A hand-copied,
  un-lowercased host normalizer in `main.ts` meant an uppercase hostname's
  cert-mismatch _reject_ path skipped `disconnect()`/`clearAuth()`, leaving
  a user who refused a changed certificate still connected to that server —
  the single lowercased implementation in `ws.ts` is now shared everywhere.
- **fix(client):** voice mic/camera reliability (#1331, #1332) — six
  separate paths could republish the microphone without checking the user's
  mute state (the audio-device fallback, selecting "Default" input,
  un-deafening, `retryMicPermission`, a stale PTT ownership latch, and
  auto-reconnect's `restoreLocalVoiceState`), each producing a hot mic while
  every remote UI still showed the user muted; all now route through
  `isMicPolicyGated()`. Camera and screenshare kept publishing to the SFU
  after the user turned them off during the OS device picker. Enhanced Noise
  Suppression silently disabled the input-volume slider and VAD gate because
  `livekit-client`'s own `replaceTrack` call landed after ours. A key-holder
  promotion arriving mid voice-setup was clobbered, ejecting the joiner
  after a timeout only it could have resolved.
- **fix(client):** messaging and store reliability (#1328, #1331, #1332) —
  sequenced DMs could jump the FIFO ahead of `sendHigh`, permanently losing
  an event dropped before flush. A full-ready resync left every loaded
  channel with a permanent hole in its history, because that tier never
  replays `chat_message` frames; loaded windows are now invalidated and the
  active channel refetched. The WS error handler only bannered
  `RATE_LIMITED` and `FORBIDDEN`, so every other server error code — for
  example a rejected `chat_edit` — was dropped in silence while the
  optimistic "Message edited" toast still fired. A message whose
  `chat_send_ok` was lost to the same disconnect that forced a resync could
  render twice; the optimistic row's id-based dedup now shares the
  content-based match predicate `addMessage` already used. Replay detection
  compared the server's `created_at` against the client's own clock, so a
  self-hosted server without NTP made every live message after a reconnect
  look like a replay and silently killed its notification; both sides now
  use an estimated server-time skew.
- **fix(client):** UI defects (#1331, #1332) — the quick-switcher could
  mount a second overlay, orphaning a body-mounted backdrop that blocked all
  input until reload. The status-picker stylesheet targeted a root element
  the component never toggles; a same-branch repair then left the status dot
  itself 0×0 and unclickable, now fixed together with a test pinning the
  stylesheet to the classes the component actually emits. The attachment
  remove button and the failed-send Retry/Discard buttons did nothing;
  drag-reorder's phantom-drag latch and permission gate are fixed; keyboard
  Tab could escape every modal because hidden (`display: none`) controls
  were still counted as focusable.
- **fix(client):** the user profile popup is styled correctly again
  (`a308f81`).
- **fix(client):** Vite no longer watches `src-tauri/`, so a running dev
  server does not rebuild the frontend when Rust sources or build artifacts
  change (`cdcfc03`).
- **fix(release):** the stripped Linux AppImage is signed from the
  environment-provided key instead of a temporary key file (`9d75890`) —
  release-pipeline only, no operator action needed.
- **docs:** full documentation audit against `5630aa1` — reference docs,
  architecture pages, and UX specs corrected; plans and prior audits given
  verified statuses; see `docs/audit-2026-08-04-docs-and-coverage.md`.
- **security(server):** closed the three 2026-08-04 review findings — the
  channel role-override **DELETE** now enforces the same hierarchy guard as
  PUT (A-2026-08-01); the admin channel list/edit/delete surface no longer
  sees DM channels, answering 404 for their ids (A-2026-08-02); DM call
  rings respect blocks like every other DM interaction (A-2026-08-03).
  Behavioural note: deleting a channel override for a _nonexistent_ role now
  returns 404 (was 204), matching PUT.
- **server:** migration **029** drops the never-used `sounds` table (dead
  since the initial schema; A-2026-07-13). Applies automatically on first
  start; no operator action.
- **protocol:** the plugin command family (`chat_command`, `command_reply`,
  `plugin_broadcast`) is now part of `protocol-schema.json` and the
  generated constants (27 client→server / 39 server→client). Wire strings
  are unchanged — no client or plugin impact.
- **chore(client):** dead modules deleted (`ServerStrip`, `FileUpload`,
  `reconcile`, a stray worklet copy, orphan sounds API methods) and the
  unused tauri-typegen pipeline retired (`src/generated/**`, its CI steps,
  config block, and build-dependency).
- **ci:** knip is now blocking; Playwright specs are typechecked
  (`typecheck:e2e`); three orphaned native e2e specs run again;
  `claude.yml` actions are SHA-pinned; the PR template asks for docs
  updates per the architecture maintenance rule.
- **tests(client):** the TOFU certificate ceremony has e2e coverage
  (first-use + mismatch journeys), and `modalFactory` is fully covered.
- **security(client):** the voice-E2EE identity pin lookup fails **closed**
  on keyring errors (DC-08): a transient store failure used to read as
  "never pinned", silently sending a pinned peer down the first-sight path
  and re-pinning whatever key the server delivered. An unreadable pin store
  now rejects the peer's announce, writes nothing, and shows a distinct
  amber "could not check" badge until the store recovers.
- **feat(client):** accessibility pass over the modal/overlay stack
  (DC-13): every modal is a labelled `role="dialog"` with a focus trap and
  focus restore, Escape maps to each dialog's safe action, the settings
  sidebar is a keyboard-navigable tablist, the quick switcher and composer
  autocompletes are wired as combobox/listbox, the emoji/GIF pickers are
  keyboard-operable, and toasts/typing announce via polite live regions.
- **feat(client):** UX polish (DC-12): deleting the active channel now
  says so in a toast; reactions toggle optimistically with rollback on
  failure; the role-change menu can no longer double-fire; a document-level
  listener leak in channel drag-reorder is fixed.
- **feat(admin):** restoring a backup now writes a `backup_restore`
  audit-log row (DC-09). The row is written before the pre-restore safety
  copy, so it lives inside the `pre_restore_*.db` backup — the restored
  database itself cannot carry it (the restore replaces the file).
- **ci:** the `-tags wazero` / `-tags otel` Go tests now actually run in CI
  (DC-06) — previously those variants were only compiled, leaving ~600
  lines of plugin/telemetry tests permanently dark.
- **tests(client):** e2e journeys for voice-E2EE identity verification
  (badge states + mismatch modal, driven through the real crypto path) and
  the updater (banner → progress → auto-relaunch), plus an accessibility
  smoke; full web suite now 291 tests.

- **server/admin:** in-place self-update is refused in container
  deployments (503 `CONTAINER_DEPLOYMENT`; the shipped image sets
  `OWNCORD_CONTAINER=1`, bind-mount operators can set `0` to opt back in).
  Container upgrades are image pulls; `GET /admin/api/updates` now reports
  `can_apply` and the admin panel says so instead of offering the button.
- **ci:** the full client e2e suite now blocks merges (DC-07); a new
  non-blocking `admin-e2e` job drives the admin panel against a real server
  (first-run wizard, channel CRUD, audit log, re-login).
- **docs:** the dependency pinning/review policy is written down in
  `docs/contributing.md`, closing the last 2026-04 audit carryover that was
  still undecided.

## v1.2.0-alpha.1 — Discord feature parity

> **Project reset note:** OwnCord has re-entered alpha. The `v1.0.0` release is
> superseded; versioning continues forward from `v1.1.0-alpha.N` so deployed
> servers and clients keep receiving updates. This release bumps the minor to
> `v1.2.0-alpha.1` to mark a large feature drop. Releases are published to this
> repository's [Releases](https://github.com/J3vb/OwnCord/releases) page,
> including a full source snapshot with every release.

This release closes most of the feature gap against basic Discord (see
[docs/plans/discord-parity.md](docs/plans/discord-parity.md) for the full
gap analysis and per-item detail). The work landed as six phases plus a
pre-release security and performance review.

### Messaging & mentions

- **Real mentions.** `@username` is now resolved server-side against unique
  usernames (address-shaped text like `mail@example` is rejected), stored per
  message, and carried on the wire — so a mention notifies, highlights the
  message, and drives a red per-channel mention badge distinct from the plain
  unread count. `@everyone` / `@here` are gated on a new `MENTION_EVERYONE`
  permission (`@here` skips offline and invisible users). `#channel` names
  render as clickable navigation chips, and the composer gains an `@`
  autocomplete.
- **Markdown rendering.** Messages render Discord-flavoured markdown — bold,
  italic, underline, strikethrough, spoilers, block quotes, headings, lists,
  masked links (`http(s)` only), and fenced code blocks with a language tag
  and lightweight syntax highlighting. Rendering is a strict DOM builder with
  no `innerHTML`. `Ctrl+B/I/U` wrap the selection in the composer.
- **Custom emoji.** Server emoji can be uploaded and managed (admin panel,
  `MANAGE_SERVER`); `:shortcode:` renders inline in messages (jumbo when a
  message is emoji-only), appears in the picker and a `:`-autocomplete, and can
  be used as a reaction.
- **Message navigation.** Search results, pinned messages, reply previews, and
  message permalinks (`owncord://message/…`, copyable from the hover bar) all
  jump to the target — fetching a window around it when it is not loaded, with
  a "Jump to Present" affordance. Reactions show a who-reacted tooltip on
  hover, video and audio attachments get inline players, and a "NEW" divider
  plus explicit Mark as Read / Mark All as Read round out read state.
- **Bulk delete.** `POST /channels/{id}/messages/purge` soft-deletes the newest
  N messages (`MANAGE_MESSAGES`), broadcasting one `chat_bulk_deleted` event.

### Roles, permissions & moderation

- **Role management.** Roles are now first-class: create, edit, delete, reorder,
  and edit permission masks and colours from the admin panel, all gated on
  `MANAGE_ROLES` and bounded by the actor's own position (you cannot touch a
  role at or above your rank, nor grant a permission bit your own role lacks).
- **The permission bits are live.** The six previously-decorative bits
  (`MANAGE_CHANNELS`, `KICK_MEMBERS`, `MUTE_MEMBERS`, `MANAGE_ROLES`,
  `MANAGE_SERVER`, `VIEW_AUDIT_LOG`) are now enforced per admin route group, so
  a Moderator role can actually moderate without being a full Administrator.
- **Per-user channel overrides.** Channel permissions resolve in Discord's
  order — base role → role override → user override — with a tri-state override
  matrix editor (role or user) in the admin panel.
- **Voice moderation.** Holders of `MUTE_MEMBERS` can server-mute, server-deafen,
  move, or disconnect a lower-ranked user; a server mute is enforced at the SFU.
- **Channel management from the desktop client.** Topics render and are editable,
  plus slowmode, an NSFW flag (with a per-session age gate), and voice
  user/video limits. Categories are now free text (any type under any name).

### Social & profiles

- **Profiles.** Avatar uploads (replacing letter-initials everywhere), display
  names (with the `@username` handle preserved for mentions), an about/bio, and
  a custom status line.
- **Presence.** Invisible is now a real status that never leaks to other users
  and survives a reconnect (the previous flash-online-on-connect bug is fixed);
  a 10-minute auto-idle that never overrides a manual status.
- **Group DMs** (2–10 participants, name, leave), **DM calls** with ringing
  (Call button + incoming-call banner over the existing DM voice path), and
  **per-channel notification mutes** (mentions still notify; other noise is
  silenced).
- **Quick wins from phase 1.** Block/unblock from the member menu, temporary
  bans, server-driven role colours, a mounted profile popup, and archived
  channels that actually hide.

### Security & performance review (pre-release)

- Channel-override endpoints now enforce grantability: a `MANAGE_CHANNELS`
  holder cannot grant itself or a user a permission bit its own role lacks,
  closing a privilege-escalation path.
- DM voice events (`voice_state`/`voice_leave`) are delivered only to the DM's
  participants instead of every user with base `READ_MESSAGES`.
- Voice moderation cannot reach a private DM call the actor is not part of.
- Mention-count bookkeeping is batched (one writer exec per 500 readers instead
  of one per reader) and resolved against a set; the markdown parser's
  bracket matching is amortized-linear; video/audio attachment blobs are
  LRU-capped and revoked, and cleared on logout.

### Test hardening (pre-release)

The hostile-input surface is now covered by Go native fuzzers and
client-side property tests (mention/emoji parsing, FTS query sanitizing,
permission resolution, markdown tokenizing, filename/path sanitizing,
content sanitizing, credential validation, avatar URLs, LiveKit webhook
identities), which found and fixed two real bugs:

- **Zero-dimension images are rejected.** A GIF decoding to height 0, and a
  VP8 keyframe with an all-zero size field, both passed the image size guard
  as "small". `imageDimensions` now rejects non-positive dimensions centrally.
- **Upload filenames stay safe basenames.** `/` survived sanitizing verbatim
  (`filepath.Base("/")` is `"/"`), and over-length names were truncated
  mid-rune into invalid UTF-8. Both are fixed at the sanitizer.

Also added: a full migration-chain and pre-parity (019) upgrade round-trip
test, a protocol-schema/generated-constant drift test, a 200-client hub
load/soak test with `goleak` verification, and a blocking `@parity`
Playwright job covering the new parity features. Separately, a test-quality
audit rewired tests that asserted nothing (or a tautology) to assert their
claimed behaviour — no product code changed and no assertion weakened.

### Phase B — Acceleration

- **Event persistence layer (Step 7).** A new `events` table backs the
  WebSocket reconnect path. When a client's `last_seq` is too old for
  the in-memory ring buffer (~1000 events), the server now falls back to
  a SQLite query before forcing a full re-sync. The hub seeds its
  monotonic sequence counter from `MAX(events.seq)` at startup so row
  seqs and wrapped-payload seqs stay aligned across restarts. Configurable
  via the new `event_persistence` block; **enabled by default** (see
  "Behavioural changes" below).
- **Tiered reconnect telemetry.** `auth_ok` now includes a `replay_source`
  field (`"none" | "buffer" | "db"`) so clients can attribute reconnection
  behaviour. The same tier label is exported as the
  `ws_reconnect_tier_total{tier}` counter.
- **OpenTelemetry skeleton (Step 8).** Public API + no-op default
  provider in `Server/telemetry/`. Chi router middleware mounted
  unconditionally. Service-layer spans on `MessageService.SendMessage`,
  `PermissionService.HasChannelPerm`,
  `ChannelService.ListVisibleChannels`, `DMService.CreateDM`,
  `VoiceService.JoinChannel`, `InviteService.CreateInvite`,
  `ModerationService.BanUser`, `BlockService.BlockUser`,
  `UserService.UpdateProfile`. The real OTel SDK is gated behind
  `-tags otel` and is currently a placeholder; completing it is
  deferred until after the beta reset.
- **Solid.js proof of concept (Step 6).** Two leaf components migrated
  (`Badge`, `ChannelListItem`), Vite + JSX configured, store→signal
  adapter landed. The remaining vanilla components remain in place;
  migration is mechanical and tracked in the local TODO.

### Phase C — Differentiation

- **Plugin runtime skeleton (Step 9).** New `Server/plugin/` package
  with manifest parser, on-disk loader, registry, and host capability
  surfaces (`commands`, `events`, `storage`, `http`, `ui`). Manifest
  format is JSON (`plugin.json`); the design's TOML format is gated
  behind the `-tags wazero` build and tracked locally.
- **Plugin admin REST surface.** Lifecycle endpoints under
  `/api/v1/admin/plugins`: list, enable, disable, uninstall, and the
  new install path that accepts a multipart zip upload, validates it
  zip-slip safe with size + symlink rejection, and atomically installs
  it. Mounted under both `AdminIPRestrict` and the
  `admin.RequireAdminAuth` session/permission middleware.
- **Plugin admin client bridge.** `pluginBridge.ts` mounts plugin UI
  tabs in sandboxed iframes with origin-validated postMessage routing.

### Security

- **SSRF defense for `http` capability.** Plugin outbound HTTP requests
  are now validated through `net/url.Parse`, suffix-matched with a dot
  boundary (so `evil-api.example.com` does not match
  `api.example.com`), and rejected for empty allowlist entries. A custom
  `Transport.DialContext` re-resolves DNS on every dial and refuses any
  resolved address in loopback / RFC1918 / RFC4193 / RFC6598 (CGN) /
  link-local / multicast / unspecified ranges. Closes the DNS-rebinding
  TOCTOU window. Response body is capped at 5 MiB.
- **Plugin manifest hardening.** `Manifest.Name` must match
  `^[a-z0-9][a-z0-9_-]{0,63}$`. Entrypoint and UI tab asset paths are
  rejected if absolute, non-canonical, contain `..`, or contain NUL
  bytes / backslashes.
- **Plugin asset handler.** Defends against symlink escapes (rejected
  at install time via `filepath.Walk` + `Lstat`) and prefix-without-
  separator path traversal (via `filepath.Rel` check after join).
- **Plugin postMessage routing.** The host bridge looks up the trusted
  pluginId via `e.source -> contentWindow` instead of trusting the
  `pluginId` field in the message body. Spoofed messages from any
  non-iframe source are dropped.

### Behavioural changes operators must know about

- **Voice now works out of the box for clients that are not on the server
  machine.** The LiveKit proxy's origin gate rejected two legitimate
  client shapes with `/livekit/rtc/v1` 403s — chat worked, voice didn't:
  the desktop client's fixed webview origins
  (`http(s)://tauri.localhost`, `tauri://localhost`) and any UI served
  from the server's own origin, whose WebSocket handshakes always carry
  that origin even though same-origin fetches omit it. Both are now
  recognized: first-party webview origins are always allowed, and an
  `Origin` whose host equals the request's `Host` is treated as
  same-origin — mirroring the default policy the chat WebSocket already
  applied, with no change to the CSRF posture (a foreign origin still
  needs an explicit `allowed_origins` entry). Rejected origins are now
  logged (`livekit proxy: origin rejected`) so the next such failure is
  diagnosable from the server log.
- **API tokens can use the admin log stream.** `POST
/admin/api/logs/ticket` required a browser login session, so headless
  clients (the `mcp-introspect` dev tool, bots) could reach every other
  `/admin/api/*` route but not `server_logs`. Tickets are now bound to
  whichever credential authenticated the request; revoking a token cuts
  an in-flight stream, exactly as session revocation always has.
- **The desktop client now actually uses the OS credential store.** The
  `keyring` crate declares no `default` feature, so the previous
  `keyring = "3"` dependency compiled its in-memory _mock_ store on
  Windows, macOS and Linux alike: saves reported success and the next
  read in the same process returned nothing, and no credential was ever
  written to Credential Manager / Keychain / Secret Service. The visible
  symptom was the voice-E2EE identity keypair being regenerated, so the
  published identity key stopped matching the key that signed the voice
  announce and peers rejected it as a possible MITM. The platform
  backends are now enabled explicitly and every write is read back
  before it is reported as saved. See
  [docs/credential-storage.md](docs/credential-storage.md).
  - **Linux builds need a new system package, `libdbus-1-dev`**, for the
    Secret Service backend. CI and release workflows install it already.
  - Users on an affected machine are logged in again and re-verified by
    their peers once, then persist normally.
- **`event_persistence.enabled` defaults to `true`.** Every broadcast
  WebSocket event is written to the `events` table, retained for
  24 hours by default, and pruned by a background goroutine every hour.
  This is a new on-disk write path that did not exist before. Disable
  it by adding to `config.yaml`:
  ```yaml
  event_persistence:
    enabled: false
  ```
- **DM events are persisted under the same retention.** Operators with
  GDPR or compliance requirements should review the retention window
  and consider setting `event_persistence.enabled: false` until a
  per-channel-type opt-out lands.
- **Plugin admin endpoints require admin session auth in addition to
  the existing IP restriction.** A previous prerelease shipped with only
  the IP gate; that has been corrected.
- **The parity work adds nine database migrations (`020`–`028`) that apply
  automatically on first boot.** They add the `message_mentions`,
  `channel_user_overrides`, and emoji-supporting tables/columns, per-user
  profile fields (`display_name`, `about`, `custom_status`), channel flags
  (`nsfw`, `is_group`), and the `server_muted`/`server_deafened` voice-state
  columns; a migration also seeds the new `MENTION_EVERYONE` permission bit
  into the Owner/Admin/Moderator roles. No manual step is required, but take a
  backup before upgrading as usual. The release also introduces new WebSocket
  message types (`roles_update`, `emoji_update`, `chat_bulk_deleted`,
  `voice_mod_*`, `voice_moved`, `voice_disconnected`, `mark_read`,
  `call_ring`/`call_incoming`/`call_decline`); older clients ignore unknown
  types, and older servers omit the new fields (the client fails safe).

### Deferred work

The project is under a feature freeze until the beta reset completes.
Explicitly deferred (not abandoned unless noted): real OpenTelemetry SDK
wiring, the Postgres backend (scaffolding removed pending real demand),
and the slash-command dispatcher (`docs/plans/slash-commands.md`). The
Solid.js migration was abandoned and its experiment fully removed
(2026-07-19) in favor of the established vanilla component pattern.
