# Voice & Video Comparison Matrix

Research compiled 2026-03-28 for the voice/video polish pass.
Sources: Discord support docs, TeamSpeak support/forums, Guilded support docs, LiveKit JS SDK docs.

## Connection & Join

| Behavior | Discord | TeamSpeak | Guilded | OwnCord (current) | Gap? | Priority |
|----------|---------|-----------|---------|-------------------|------|----------|
| Join animation | Green "Voice Connected" bar slides up in bottom-left panel | Channel tree highlights, user appears in list | Avatar appears in voice channel, green dot on channel | VoiceWidget appears with "Voice Connected" label | NO | -- |
| Join sound | Distinct "connected" chime | Configurable join sound | Subtle connection sound | None | YES | Should fix |
| Mic permission denied | Shows error in voice panel: "Could not access microphone" with settings link | Shows error dialog, falls back to listen-only | Shows error toast | Joins in listen-only mode silently -- no recovery UI | YES | Must fix |
| Selected device missing | Falls back to default device automatically | Shows error, user must manually select | Falls back to default | Silent failure -- mic doesn't work, no error | YES | Must fix |
| Connecting feedback | "Connecting..." text with spinner in voice panel | "Connecting to server..." status bar | Loading indicator in channel | "Voice Connected" appears after connect (no "connecting..." state) | YES | Should fix |
| Connection failed | "RTC Connecting" / "No Route" / "ICE Checking" error states with automatic retry, link to troubleshooting guide | Error dialog with retry option | Error toast | Error callback shows toast but no retry button | YES | Must fix |

## During Call

| Behavior | Discord | TeamSpeak | Guilded | OwnCord (current) | Gap? | Priority |
|----------|---------|-----------|---------|-------------------|------|----------|
| Speaker indicator | Green ring/glow around user avatar in voice channel list and video tiles. Animated with ~100ms transition. | Blue circle/highlight on speaking user's name in channel tree | Green dot on channel when active; avatar highlights | `.speaking` CSS class toggled on voice-user-item in ChannelSidebar and VoiceChannel. Already rendered. | PARTIAL | Should fix (verify animation/glow matches Discord polish) |
| Connection quality display | Green/yellow/red icon in voice panel footer. Hover shows tooltip with ping, packet loss. Click expands debug panel. | Server connection quality bar in status bar | Not prominently displayed | Signal bars icon + ping text. Click expands stats pane. Hidden by default. | PARTIAL | Should fix (add auto-expand on degradation + warning toast) |
| Device hot-swap (unplug mic) | Auto-detects device change, falls back to default device. Shows brief notification. | Manual -- user must go to settings to switch device | Auto-fallback to default | Silent failure -- mic stops working, no notification or fallback | YES | Must fix |
| VAD visible indicator | Green ring IS the VAD indicator -- it shows when voice activity is detected, so you can see your own ring animate when you talk | Audio meter in settings only; in-call indicator is the blue highlight | Not visible during call | No VAD indicator during call. Only visible in Settings > Voice Audio tab mic level meter | YES | Should fix |
| Own mute/deafen state | Mic/headphone icons with slash-through when muted/deafened. Red color for deafened. Icons in voice panel controls. | Icons change in channel tree next to username. Status text in panel. | Icons in voice controls bar | Icons swap between mic/mic-off, headphones/headphones-off. `active-ctrl` CSS class toggles. `aria-pressed` attribute. | NO | -- |
| Voice widget layout | Bottom-left panel: channel name, connected label, timer (optional), signal icon, 5 control buttons (mute, deafen, camera, screenshare, disconnect) | Separate panel with channel tree, user list, controls | Integrated into channel view | Bottom of sidebar: header (label, timer, channel, signal), expandable stats, 5 control buttons | NO | -- |
| Per-user volume | Right-click user > volume slider (0-200%) | Right-click user > volume slider | Right-click user > volume slider | Right-click in VoiceChannel (0-200%) + VideoGrid tile slider. Persisted per-user. Already implemented. | NO | -- |

## Video & Screenshare

| Behavior | Discord | TeamSpeak | Guilded | OwnCord (current) | Gap? | Priority |
|----------|---------|-----------|---------|-------------------|------|----------|
| Camera toggle feedback | Video tile appears/disappears with animation. No toast. | N/A (TS3/5 limited video) | Video tile appears | Video tile appears/disappears. No animation, no feedback. | YES | Should fix (add toast) |
| Screenshare per-tile controls | Right-click stream > Mute + Stream Volume slider. Pop-out window option. Fullscreen option. | Screen sharing added in TS6 beta -- limited controls | Right-click > volume + voice volume separate. PiP view. | Per-user volume slider (0-200%) in VideoGrid tiles + right-click in VoiceChannel. Already implemented. | NO | -- |
| Video quality adaptation | Automatic via WebRTC bandwidth estimation. Degrades gracefully. Nitro unlocks higher quality tiers. | Not applicable (limited video) | Automatic | No simulcast -- fixed quality. No adaptive degradation. | YES | Nice to have (deferred -- requires separate design doc) |
| Max simultaneous cameras | 25 in voice channel (Go Live limited) | Limited | Server configurable | Server-configured `MaxVideo` limit. Client doesn't know limit in advance. | PARTIAL | Nice to have |
| Screenshare audio | Included by default on supported platforms. Volume controllable via stream volume slider. | Added in TS6 | Separate volume control via right-click | Captured via getDisplayMedia. Volume control via per-user slider (0-200%) + HTMLAudioElement volume. Already implemented. | NO | -- |
| Screenshare stop feedback | Stream ends, tile disappears. Brief notification to viewers. | N/A | Notification | No feedback to the sharer. Tile just disappears for viewers. | YES | Should fix (add toast) |

## Settings & Configuration

| Behavior | Discord | TeamSpeak | Guilded | OwnCord (current) | Gap? | Priority |
|----------|---------|-----------|---------|-------------------|------|----------|
| Audio device selection | Dropdown for input, output, and camera. "Default" option at top. Device names shown. Test button. | Dropdown with test/playback. "Default" at top. | Dropdown in voice settings | Dropdown for input, output, camera. Device names shown. Preview for camera. | NO | -- |
| Input sensitivity / VAD | Toggle: "Automatically determine input sensitivity" (on by default). Manual slider when off. Visual feedback bar shows current level and threshold. | Three modes: Automatic (ML-based), Volume Gate (manual slider), Hybrid. | Basic sensitivity slider | VAD with adjustable threshold in VoiceAudioTab. Mic level meter shows green (above threshold) / yellow (below). | NO | -- |
| Stream quality options | Auto (default), 720p30, 1080p60 (Nitro), 4K60 (Nitro). Source quality option. | 384Kbps audio standard | Basic quality options | Low/Medium/High/Source presets with bitrate configs. | NO | -- |
| Noise suppression | Krisp AI-powered noise suppression. Toggle on/off. Three levels in newer versions. | ML-based background noise cancellation built-in | Basic noise suppression | RNNoise via AudioWorklet (rnnoise-worklet.js). Toggle in settings. | NO | -- |
| Echo cancellation | Toggle on/off. Automatic echo cancellation. | Built-in echo cancellation | Basic echo cancellation | Toggle in VoiceAudioTab. Applied via getUserMedia constraints. Already configurable. | NO | -- |

## Edge Cases

| Behavior | Discord | TeamSpeak | Guilded | OwnCord (current) | Gap? | Priority |
|----------|---------|-----------|---------|-------------------|------|----------|
| 4+ hour session | Stable. Token management handled transparently. | Stable (persistent TCP connection). | Stable | Token expires at 4h. Client pre-refreshes at 3.5h. But can't rotate on active connection -- long sessions fragile after network blip. | YES | Must fix (extend to 24h) |
| Network blip (Wi-Fi switch) | Auto-reconnects within seconds. Brief "Reconnecting..." indicator. | Auto-reconnects. Status shows "Connection lost". | Auto-reconnects | Auto-reconnect with 2 retries. Falls back to full leaveVoice if reconnect fails. No "Reconnecting..." UI indicator during retry. | PARTIAL | Should fix (add reconnecting indicator) |
| Multiple screenshares | One Go Live per user. Multiple users can Go Live simultaneously. | One per user in TS6 | One per user | One screenshare per user. Server tracks via voice_controls. | NO | -- |
| Ghost voice state | Handled by Discord's infrastructure -- presence system cleans up. | Server-side timeout + keepalive. | Infrastructure cleanup | DB row persists on LeaveVoiceChannel failure. No cleanup cron. Logged but not resolved. | YES | Must fix |

## Summary: Gaps by Priority

### Already Implemented (verified in codebase -- no work needed)
- ~~Speaker indicators~~ -- `.speaking` CSS class toggled in ChannelSidebar + VoiceChannel
- ~~Screenshare volume slider~~ -- 0-200% per-user slider in VideoGrid + VoiceChannel right-click
- ~~Screenshare audio volume~~ -- per-user volume control via HTMLAudioElement + setVolume()
- ~~Per-user volume controls~~ -- 0-200% slider with persistence, right-click context menu
- ~~Echo cancellation UI toggle~~ -- configurable in VoiceAudioTab

### Must Fix (user cannot complete action or behavior is visibly broken)
1. **Permission recovery UI** -- silently joins listen-only, no escape
2. **Device hot-swap detection** -- silent mic failure on unplug
3. **Retry/reconnect UI** -- no button to retry failed connections
4. **Ghost state cleanup** -- DB ghost states accumulate
5. **24h token TTL** -- fragile long sessions

### Should Fix (works but noticeably worse than competitors)
6. **Speaker indicator polish** -- CSS class exists but verify green glow animation matches Discord quality
7. **VAD indicator during call** -- can't verify your mic is working
8. **Connection quality auto-warning** -- degradation is silent
9. **Connecting state feedback** -- no "Connecting..." indicator
10. **Camera/screenshare stop toast** -- no confirmation when toggling off
11. **Bandwidth display** -- raw bytes, not human-readable Mbps
12. **Join sound** -- no audio feedback on connection
13. **Reconnecting indicator** -- no visual during auto-retry

### Nice to Have (competitors do it, not essential)
14. Video quality adaptation / simulcast (deferred -- separate design doc)
15. Max camera limit shown to user before toggle

## LiveKit SDK Capabilities (verified via Context7 docs)

Key SDK features available for implementation:
- `RoomEvent.ActiveSpeakersChanged` -- speaker detection (already used)
- `RoomEvent.ConnectionQualityChanged` -- quality per participant ('excellent' | 'good' | 'poor')
- `RoomEvent.MediaDevicesError` -- device failure detection
- `RoomEvent.AudioPlaybackStatusChanged` -- audio autoplay handling
- `room.switchActiveDevice(kind, deviceId)` -- device switching API
- `Room.getLocalDevices(kind)` -- device enumeration
- `adaptiveStream: true` -- automatic video quality management
- `dynacast: true` -- bandwidth optimization for published tracks
- `reconnectPolicy: { maxRetries, timeout }` -- configurable reconnect
- `TokenSourceConfigurable` -- automatic token refresh with custom fetch
- `RemoteAudioTrack.setVolume()` -- per-track volume control (for screenshare slider)

## OwnCord Target Behavior (for implementation)

When competitors differ, prefer the behavior that requires the least UI surface area and matches OwnCord's existing design language (dark theme, `tokens.css`, `vw-*` class naming).

- **Speaker indicator**: Already implemented with `.speaking` CSS class. Verify/polish green glow animation to match Discord quality (pulsing `box-shadow` with `--green`).
- **Quality display**: Keep existing signal bars + click-to-expand pattern, ADD auto-expand on degradation + debounced toast (Discord-style)
- **Device hot-swap**: Discord-style auto-fallback + toast notification via `navigator.mediaDevices.devicechange` event
- **Permission recovery**: "Grant Microphone" button in VoiceWidget (similar to Discord's settings link but more direct)
- **Screenshare/per-user volume**: Already implemented (0-200% sliders). No changes needed.
- **Token management**: Use LiveKit SDK's `TokenSourceConfigurable` for automatic refresh with 24h TTL
