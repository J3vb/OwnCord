# Screenshare Audio + Per-Tile Volume Controls

## Complete Architecture Specification

*Updated: 2026-03-28 | Status: IMPLEMENTED | Related: [[VIDEO-FOCUS-MODE]], [[CLIENT-ARCHITECTURE]], [[DEC-009-livekit-migration]]*

---

## 1. Executive Summary

OwnCord's screen sharing system is built on the LiveKit client SDK.
The sender captures both a video and an audio track via the browser's
`getDisplayMedia` API (through LiveKit's `createLocalScreenTracks`
helper). The receiver subscribes to these tracks and renders them
in a VideoGrid tile with per-tile mute/volume controls. Audio for
screen shares is managed separately from microphone audio to allow
independent volume control.

---

## 2. Architecture Overview

```
                     SENDER                                    RECEIVER
  +-----------------------------------------+    +------------------------------------------+
  |         LiveKitSession.ts               |    |          LiveKitSession.ts                |
  |                                          |    |                                          |
  |  enableScreenshare()                     |    |  handleTrackSubscribed()                  |
  |   |                                      |    |   |                                      |
  |   +--> createLocalScreenTracks(opts)     |    |   +--> Track.Kind.Audio?                 |
  |   |     opts = SCREENSHARE_PRESETS[qual] |    |   |     |                                |
  |   |     { audio: true, resolution, ... } |    |   |     +--> Source.ScreenShareAudio?    |
  |   |                                      |    |   |     |     Yes: attach <audio>,       |
  |   +--> room.localParticipant             |    |   |     |     manage via audioEl.volume   |
  |   |     .publishTrack(videoTrack,        |    |   |     |     store in screenshareAudio-  |
  |   |       source: ScreenShare)           |    |   |     |     Elements map                |
  |   |     .publishTrack(audioTrack,        |    |   |     |                                |
  |   |       source: ScreenShareAudio)      |    |   |     +--> Source.Microphone?           |
  |   |                                      |    |   |           Yes: use participant        |
  |   +--> ws.send("voice_screenshare",      |    |   |           .setVolume() (GainNode)     |
  |         { enabled: true })               |    |   |                                      |
  |                                          |    |   +--> Track.Kind.Video?                 |
  |  disableScreenshare()                    |    |         Source.ScreenShare:               |
  |   |                                      |    |         wrap in MediaStream,              |
  |   +--> stopManualScreenTracks()          |    |         fire onRemoteVideoCallback        |
  |   |     unpublish + stop each track      |    |         with isScreenshare=true           |
  |   +--> ws.send("voice_screenshare",      |    |                                          |
  |         { enabled: false })              |    +------------------------------------------+
  +-----------------------------------------+
                     |                                              |
                     v                                              v
          +---------+----------+                        +-----------+-----------+
          | LiveKit SFU Server |  --- track forward --> | VideoGrid.ts          |
          |  (self-hosted)     |                        |  + per-tile overlay   |
          +--------------------+                        |  + volume slider      |
                                                        |  + mute button        |
                                                        +-----------------------+
```

---

## 3. Stream Quality Presets

Screen share quality is determined by the user's `streamQuality`
preference (persisted in localStorage as `owncord:pref:streamQuality`).

**File:** `Client/tauri-client/src/lib/livekitSession.ts` lines 57-69

| Quality  | Resolution                      | Content Hint | Max Bitrate | Max FPS |
|----------|---------------------------------|-------------|-------------|---------|
| `low`    | 1280x720, 5fps (h720fps5)     | (default)   | 1.5 Mbps    | 5       |
| `medium` | 1920x1080, 15fps (h1080fps15)  | `detail`    | 3.0 Mbps    | 15      |
| `high`   | 1920x1080, 30fps (h1080fps30)  | `detail`    | 6.0 Mbps    | 30      |
| `source` | Native source resolution       | `detail`    | 10.0 Mbps   | 30      |

**`contentHint: "detail"`** tells the browser encoder to optimize
for sharp text/UI rather than smooth motion (important for code
editors, documents, etc.).

**Simulcast is always disabled for screen shares** (`simulcast: false`
in `publishTrack` options). Unlike camera video where multiple
quality layers help with bandwidth adaptation, screen shares are
full-resolution or nothing.

---

## 4. Screenshare Audio Capture (Sender Side)

### 4.1 Enabling Screen Share

**File:** `Client/tauri-client/src/lib/livekitSession.ts`, `enableScreenshare()` (line 871)

```
enableScreenshare()
  1. Guard: room !== null && ws !== null
  2. Set voiceStore.localScreenshare = true (optimistic)
  3. Stop any existing manual screen tracks (idempotent cleanup)
  4. Call createLocalScreenTracks(SCREENSHARE_PRESETS[quality])
     - This invokes navigator.mediaDevices.getDisplayMedia()
     - The browser shows the native screen/window/tab picker
     - { audio: true } makes the "Share audio" checkbox visible
     - Returns [LocalVideoTrack, LocalAudioTrack?]
  5. For each track returned:
     a. If video: publishTrack(track, source: ScreenShare, videoEncoding: ...)
     b. If audio: publishTrack(track, source: ScreenShareAudio)
  6. Send WS: { type: "voice_screenshare", payload: { enabled: true } }
  7. Re-apply audio pipeline (renegotiation can disrupt mic GainNode)
```

### 4.2 Audio Capture Details

The `{ audio: true }` option in `SCREENSHARE_PRESETS` (all quality
levels) causes the browser to show a "Share audio" checkbox in
the system dialog:

- **Chrome/Edge (WebView2):** Full support. Captures system audio
  from the selected screen/window/tab. The checkbox is pre-checked.
- **Firefox:** Tab audio only, not window or screen-level audio.
- **Tauri WebView2 on Windows:** Uses Chromium backend, so full
  system audio capture works.

When the user checks "Share audio", `createLocalScreenTracks`
returns two tracks: a `LocalVideoTrack` and a `LocalAudioTrack`.
When unchecked, only the video track is returned. The code handles
both cases with the for-each loop.

### 4.3 Track Storage and Cleanup

Manually published tracks are stored in:

```typescript
private manualScreenTracks: LocalTrack[] = [];
```

On `disableScreenshare()` or `leaveVoice()`, each track is:
1. Unpublished from the room (`room.localParticipant.unpublishTrack`)
2. Stopped (`track.stop()` releases the browser capture)
3. Array cleared

### 4.4 Error Handling

| Error | Cause | User Feedback |
|-------|-------|--------------|
| `NotAllowedError` | User cancelled the screen picker | "Screen sharing permission denied" |
| Other DOMException | System/browser issue | "Failed to start screen sharing" |

On any error, `localScreenshare` is rolled back to `false`.

---

## 5. Screenshare Audio Playback (Receiver Side)

### 5.1 Track Subscription Handling

**File:** `Client/tauri-client/src/lib/livekitSession.ts`, `handleTrackSubscribed` (line 229)

When a remote participant publishes tracks, LiveKit automatically
notifies subscribers via the `RoomEvent.TrackSubscribed` event.
The handler distinguishes track types by `publication.source`:

```
handleTrackSubscribed(track, publication, participant)
  |
  +-- Track.Kind.Audio
  |    |
  |    +-- Source.ScreenShareAudio
  |    |    1. Detach any previous elements (prevent duplicates)
  |    |    2. track.attach() -> creates <audio> element
  |    |    3. Set audioEl.style.display = "none" (hidden playback)
  |    |    4. Append to document.body
  |    |    5. Set audioEl.volume = outputVolumeMultiplier (0-1.0)
  |    |    6. Set audioEl.muted = screenshareAudioMutedByUser[userId]
  |    |    7. Store in screenshareAudioElements Map<number, Set<HTMLAudioElement>>
  |    |    8. Apply saved audio output device via setSinkId()
  |    |
  |    +-- Source.Microphone
  |         1. Detach previous elements
  |         2. track.attach() -> <audio> element
  |         3. participant.setVolume(effectiveVolume)
  |         4. Apply saved output device
  |
  +-- Track.Kind.Video
       1. Wrap track.mediaStreamTrack in a MediaStream
       2. Determine isScreenshare from Source.ScreenShare
       3. Fire onRemoteVideoCallback(userId, stream, isScreenshare)
```

### 5.2 Separate Audio Pipeline

The critical design decision: **screenshare audio and microphone
audio use separate volume control mechanisms.**

| Audio Type | Volume Mechanism | Range | Control Granularity |
|-----------|-----------------|-------|-------------------|
| Microphone | `participant.setVolume()` (LiveKit GainNode) | 0-2.0 | Per-participant |
| Screen Share Audio | `audioEl.volume` (HTMLAudioElement) | 0-1.0 | Per-participant |

This separation exists because `participant.setVolume()` controls
ALL audio from a participant. Without separate management, adjusting
a user's screenshare audio volume would also change their mic volume.

### 5.3 Audio Element Storage

```typescript
// In LiveKitSession class
private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
private screenshareAudioMutedByUser = new Map<number, boolean>();
```

- **Key:** userId (parsed from LiveKit identity `user-{id}`)
- **Value:** Set of audio elements (a user could theoretically have
  multiple screenshare audio tracks during track renegotiation)
- **Mute persistence:** `screenshareAudioMutedByUser` persists the
  UI-level mute state across track replacements. When a new
  screenshare audio track is subscribed, it inherits the muted
  state the viewer had previously set.

### 5.4 Track Unsubscription

**File:** `handleTrackUnsubscribed` (line 289)

```
handleTrackUnsubscribed(track, publication, participant)
  |
  +-- Source.ScreenShareAudio
  |    1. track.detach() -> returns detached <audio> elements
  |    2. Remove each from DOM
  |    3. Remove from screenshareAudioElements[userId]
  |    4. If set is empty, delete the map entry
  |
  +-- Source.Microphone
  |    1. track.detach() -> remove elements
  |    2. Delete from remoteMicAudioElements map
  |
  +-- Track.Kind.Video
       1. track.detach()
       2. Fire onRemoteVideoRemovedCallback(userId, isScreenshare)
```

---

## 6. Per-Tile Volume Controls (VideoGrid UI)

### 6.1 Tile Configuration

**File:** `Client/tauri-client/src/components/VideoGrid.ts`

Each tile in the VideoGrid can receive a `TileConfig`:

```typescript
interface TileConfig {
  readonly isSelf: boolean;       // No audio controls on self-view
  readonly audioUserId: number;   // Maps to the real user for audio control
  readonly isScreenshare: boolean; // Determines which volume API to call
}
```

### 6.2 Tile ID Convention

- **Camera tiles:** `userId` (the user's actual ID)
- **Screenshare tiles:** `userId + 1_000_000` (offset constant
  `SCREENSHARE_TILE_ID_OFFSET` in VideoModeController)

This allows the grid to contain both a camera tile and a screenshare
tile for the same user simultaneously.

### 6.3 Overlay Structure (per remote tile)

```html
<div class="video-cell" data-user-id="42">
  <video autoplay playsinline muted />
  <div class="video-username">username</div>
  <div class="video-tile-overlay">
    <input type="range" class="tile-volume-slider"
           min="0" max="200" value="100" aria-label="Volume" />
    <button class="tile-mute-btn" aria-label="Mute">
      <svg><!-- volume-2 icon --></svg>
    </button>
  </div>
</div>
```

### 6.4 Volume Slider Behavior

| Action | Screenshare Tile | Camera Tile |
|--------|-----------------|-------------|
| Drag slider | `muteScreenshareAudio(userId, volume === 0)` — binary mute toggle only | `setUserVolume(userId, value)` — granular 0-200 |
| Slider range | 0-200 in HTML, but only 0 vs non-zero matters (mute/unmute) | 0-200 (allows boosting to 2x via GainNode) |
| Slider at 0 | Mutes screenshare audio + icon swap | Calls `setUserVolume(userId, 0)` |

**Note:** The VideoGrid slider for screenshare tiles does NOT call
`setScreenshareAudioVolume()` — it only calls `muteScreenshareAudio()`.
Granular screenshare volume control is available via the
`setScreenshareAudioVolume()` API but is not wired into the tile UI.
The slider effectively acts as a mute toggle for screenshare tiles.

### 6.5 Mute Button Behavior

- Click toggles between muted and unmuted
- On mute: saves current volume, sets to 0
- On unmute: restores saved volume (defaults to 100 if was 0)
- Icon swaps between `volume-2` and `volume-x` (lucide icons)
- The overlay class `.muted` is toggled for persistent visibility
  when muted (overlay stays visible even without hover)

### 6.6 Self-View Tiles

When `config.isSelf === true`, no overlay is rendered. Users do
not hear their own audio streams (video element has `muted = true`
on all tiles; audio playback is via separate `<audio>` elements
managed by LiveKitSession).

### 6.7 Click-to-Focus Interaction

Clicking a tile (but NOT the mute button) changes focus mode:

```typescript
cell.addEventListener("click", (e) => {
  if ((e.target as Element).closest(".tile-mute-btn")) return;
  if (focusedTileId !== null && focusedTileId !== userId) {
    focusedTileId = userId;
    rebuildFocusLayout();
  }
});
```

---

## 7. CSS Styling

**File:** `Client/tauri-client/src/styles/app.css` lines 2096-2188

```css
/* Overlay container — hidden by default, shown on hover or when muted */
.video-tile-overlay {
  position: absolute;
  bottom: 0; right: 0;
  padding: 6px;
  display: flex; align-items: center; gap: 4px;
  background: linear-gradient(transparent, rgba(0,0,0,0.6));
  opacity: 0;
  transition: opacity 0.15s;
}
.video-cell:hover .video-tile-overlay,
.video-tile-overlay.muted {
  opacity: 1;
}

/* Mute toggle button */
.tile-mute-btn {
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 4px;
  color: var(--text-normal);
  padding: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

/* Volume slider — slim range input */
.tile-volume-slider {
  width: 60px;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}
```

---

## 8. Server-Side Screenshare Handling

### 8.1 WebSocket Protocol

**File:** `Server/ws/voice_controls.go`, `handleVoiceScreenshare` (line 127)

```
Client ---> { type: "voice_screenshare", payload: { enabled: true } }
                            |
                            v
Server:
  1. Rate limit: 2/sec per user (voiceScreenshareRateLimit)
  2. Verify user is in a voice channel (voiceChID != 0)
  3. Check SHARE_SCREEN permission via requireChannelPerm()
  4. Parse { enabled: bool } from payload
  5. Update DB: UpdateVoiceScreenshare(userID, enabled)
  6. Broadcast voice_state to all users in the channel
```

The server does NOT relay screenshare media. Media flows directly
through the LiveKit SFU. The server only tracks the boolean
`screenshare` flag in the `voice_states` table for presence/UI
purposes.

### 8.2 Permission Check

Screen sharing requires the `SHARE_SCREEN` permission bit. This
is checked via `requireChannelPerm(c, voiceChID, permissions.ShareScreen, "SHARE_SCREEN")`.
If the user lacks this permission, an error message is sent back
and the broadcast is suppressed.

### 8.3 Voice State Broadcast

After a successful screenshare toggle, the server broadcasts a
`voice_state` message to all users in the voice channel:

```json
{
  "type": "voice_state",
  "payload": {
    "channel_id": 5,
    "user_id": 42,
    "username": "alice",
    "muted": false,
    "deafened": false,
    "speaking": false,
    "camera": false,
    "screenshare": true
  }
}
```

This is received by all clients and updates the voice store,
which drives sidebar icons and video grid tile management.

---

## 9. Data Flow: End-to-End Screenshare Session

```
  SENDER (Alice)                   SERVER              LiveKit SFU        RECEIVER (Bob)
       |                              |                     |                    |
  1. Click "Share Screen"             |                     |                    |
       |                              |                     |                    |
  2. Browser shows picker             |                     |                    |
     (screen/window/tab)              |                     |                    |
       |                              |                     |                    |
  3. User selects + "Share audio"     |                     |                    |
       |                              |                     |                    |
  4. createLocalScreenTracks()        |                     |                    |
     returns [videoTrack, audioTrack] |                     |                    |
       |                              |                     |                    |
  5. publishTrack(video, ScreenShare) |                     |                    |
       |--------- RTP video -------->|------forward------->|                    |
       |                              |                     |                    |
  6. publishTrack(audio, SSAudio)     |                     |                    |
       |--------- RTP audio -------->|------forward------->|                    |
       |                              |                     |                    |
  7. ws: voice_screenshare enabled    |                     |                    |
       |---->                         |                     |                    |
       |            8. DB update      |                     |                    |
       |            9. broadcast      |                     |                    |
       |            voice_state       |                     |                    |
       |                              |-------------------->|                    |
       |                              |                     |  10. TrackSubscribed
       |                              |                     |   (video + audio)  |
       |                              |                     |                    |
       |                              |                     |  11. Create tile   |
       |                              |                     |   in VideoGrid     |
       |                              |                     |  12. Attach audio  |
       |                              |                     |   to <audio> elem  |
```

---

## 10. LiveKitSession Public API for Screenshare Audio

### Exported Module-Level Functions

**File:** `Client/tauri-client/src/lib/livekitSession.ts` (bottom of file, module exports)

```typescript
// These are bound to the singleton LiveKitSession instance
export function muteScreenshareAudio(userId: number, muted: boolean): void
export function setScreenshareAudioVolume(userId: number, volume: number): void
export function getScreenshareAudioMuted(userId: number): boolean
export function setUserVolume(userId: number, volume: number): void
export function getLocalScreenshareStream(): MediaStream | null
export function getLocalCameraStream(): MediaStream | null
```

### Instance Methods

```typescript
class LiveKitSession {
  // Screenshare audio volume (HTMLAudioElement.volume, 0-1.0 range)
  setScreenshareAudioVolume(userId: number, volume: number): void
  // Mute/unmute screenshare audio (HTMLAudioElement.muted)
  muteScreenshareAudio(userId: number, muted: boolean): void
  // Query screenshare mute state (checks persisted map, then audio elements)
  getScreenshareAudioMuted(userId: number): boolean
  // Per-user mic volume (LiveKit GainNode, 0-200 range)
  setUserVolume(userId: number, volume: number): void
  getUserVolume(userId: number): number
}
```

---

## 11. Master Output Volume

The `outputVolumeMultiplier` (0-2.0 range, persisted as 0-200 in
localStorage as `owncord:pref:outputVolume`) affects both mic audio
and screenshare audio:

| Audio Type | Effective Volume |
|-----------|-----------------|
| Microphone | `(userVolume / 100) * outputVolumeMultiplier` via `participant.setVolume()` |
| Screenshare | `clamp(outputVolumeMultiplier, 0, 1)` via `audioEl.volume` |

The HTMLAudioElement.volume only supports 0-1.0, so screenshare
audio cannot be "boosted" beyond 100% even if the master output
is set above 100%.

---

## 12. Output Device Routing

When a saved audio output device exists (`owncord:pref:audioOutputDevice`),
both mic and screenshare audio elements are routed to it via
`audioEl.setSinkId(deviceId)`. This ensures screenshare audio
plays through the same speakers/headphones as voice chat.

---

## 13. Implementation Status

| Component | Status | File |
|-----------|--------|------|
| Screen share capture with audio | DONE | `livekitSession.ts` enableScreenshare() |
| Quality presets (4 levels) | DONE | `livekitSession.ts` SCREENSHARE_PRESETS |
| Screenshare audio playback (receiver) | DONE | `livekitSession.ts` handleTrackSubscribed |
| Separate audio element management | DONE | `livekitSession.ts` screenshareAudioElements Map |
| Mute state persistence across track replacement | DONE | `livekitSession.ts` screenshareAudioMutedByUser Map |
| Per-tile volume slider + mute button | DONE | `VideoGrid.ts` addStream overlay |
| Click-to-focus (don't trigger on mute click) | DONE | `VideoGrid.ts` click handler |
| Server-side screenshare state tracking | DONE | `voice_controls.go` handleVoiceScreenshare |
| SHARE_SCREEN permission check | DONE | `voice_controls.go` requireChannelPerm |
| Rate limiting (2/sec) | DONE | `voice_controls.go` voiceScreenshareRateLimit |
| Output device routing for screenshare audio | DONE | `livekitSession.ts` handleTrackSubscribed |
| Cleanup on disconnect | DONE | `livekitSession.ts` leaveVoice() |

---

## 14. Files Reference

| File | Role |
|------|------|
| `Client/tauri-client/src/lib/livekitSession.ts` | Core: capture, publish, subscribe, audio element management |
| `Client/tauri-client/src/components/VideoGrid.ts` | UI: tiles, overlay, volume slider, mute button |
| `Client/tauri-client/src/pages/main-page/VideoModeController.ts` | Orchestrator: tile lifecycle, screenshare tile IDs |
| `Client/tauri-client/src/stores/voice.store.ts` | State: `localScreenshare`, per-user `screenshare` flag |
| `Client/tauri-client/src/styles/app.css` | CSS: overlay, slider, focus mode |
| `Server/ws/voice_controls.go` | Server: permission check, DB update, broadcast |
| `Server/db/voice_queries.go` | DB: UpdateVoiceScreenshare |
| `Server/ws/messages.go` | Protocol: voice_state payload shape |

---

## 15. Known Limitations

1. **HTMLAudioElement volume cap:** Screenshare audio cannot be
   boosted above 100% (unlike mic audio which supports 0-200%).
2. **Browser audio selection:** On some systems, the user must
   manually check "Share audio" in the browser picker. There is
   no way to force system audio capture programmatically.
3. **Firefox:** Only tab audio capture is supported, not window
   or full-screen audio.
4. **Per-tile volume is ephemeral:** Tile volume/mute state is
   not persisted to localStorage (resets when the tile is removed).
   Only the per-user mic volume (`userVolume_{userId}`) is persisted
   via the right-click member list slider.
5. **No per-tile screenshare volume granularity:** The volume slider
   range for screenshare tiles is 0-200 in the UI but the actual
   HTMLAudioElement only accepts 0-1.0. Values above 100 have no
   additional effect.

---

## 16. Not In Scope

- Focus mode / large-tile layout (see [[VIDEO-FOCUS-MODE]])
- Manual-activate video grid (see [[VIDEO-FOCUS-MODE]])
- "LIVE" badge in sidebar (see [[VIDEO-FOCUS-MODE]])
- Per-tile volume slider in member list (existing right-click slider)
- Picture-in-picture / floating player (future enhancement)
