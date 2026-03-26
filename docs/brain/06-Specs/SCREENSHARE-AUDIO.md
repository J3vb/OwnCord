# Screenshare Audio + Per-Tile Volume Controls

## Goal

Enable system audio capture during screenshare and add per-tile
mute controls on the video grid so viewers can independently
control screenshare audio vs mic audio.

## Scope

This spec covers audio only — no layout changes to the video
grid. Focus mode and manual-activate are in a separate spec.

## 1. Screenshare Audio Capture (Sender)

Pass `{ audio: true }` as `ScreenShareCaptureOptions` to
`setScreenShareEnabled()`. This makes the browser show
the "Share audio" checkbox **pre-checked** by default in
the screen picker dialog.

- Chrome/Edge: full support for system audio capture
- Firefox: limited support (tab audio only, not window/screen)
- The browser handles the UX — no custom toggle needed

**File:** `Client/tauri-client/src/lib/livekitSession.ts`
- `enableScreenshare()`: change `setScreenShareEnabled(true)`
  to `setScreenShareEnabled(true, { audio: true })`

LiveKit automatically publishes a `ScreenShareAudio` track
(`Track.Source.ScreenShareAudio`) alongside the `ScreenShare`
video track when the user checks "Share audio".

## 2. Screenshare Audio Playback (Receiver)

Currently `handleTrackSubscribed` treats all audio tracks
identically — attaches to a hidden `<audio>` element and
applies per-user volume via `participant.setVolume()`.

The problem: `participant.setVolume()` controls ALL audio
from that participant (mic + screenshare audio). To enable
independent control, screenshare audio needs separate
volume management.

### Changes to handleTrackSubscribed

Check `publication.source` to distinguish audio track types:

- `Track.Source.Microphone` — existing behavior, use
  `participant.setVolume()` for per-user volume
- `Track.Source.ScreenShareAudio` — attach `<audio>` element
  but manage volume via `audioEl.volume` directly (0.0-1.0).
  Store reference in a `Map<number, HTMLAudioElement>` keyed
  by userId for the tile controls to access.

### New methods on LiveKitSession

```
setScreenshareAudioVolume(userId: number, volume: number): void
  — Set volume on the stored <audio> element (0.0-1.0)

muteScreenshareAudio(userId: number, muted: boolean): void
  — Set audioEl.muted = muted

getScreenshareAudioMuted(userId: number): boolean
  — Return current muted state (false if no element)
```

Export as bound methods like existing pattern.

### Cleanup

Remove `<audio>` element and map entry in
`handleTrackUnsubscribed` when a `ScreenShareAudio` track
is unsubscribed.

## 3. Video Grid Tile Controls (UI)

Each video tile in `VideoGrid.ts` gets a hover overlay:

### Overlay structure

```html
<div class="video-cell" data-user-id="42">
  <video .../>
  <div class="video-username">username</div>
  <div class="video-tile-overlay">     <!-- new -->
    <button class="tile-mute-btn" aria-label="Mute">
      <svg><!-- volume-2 or volume-x icon --></svg>
    </button>
  </div>
</div>
```

### Behavior

- **Hover** on tile → overlay fades in (CSS `opacity` transition)
- **Click mute button** → toggles mute for that tile's audio:
  - Screenshare tiles (userId + 1_000_000 offset): calls
    `muteScreenshareAudio(realUserId, muted)`
  - Camera tiles: calls `participant.setVolume(0)` to mute,
    restores saved volume to unmute
- **Icon swap**: `volume-2` when unmuted, `volume-x` when muted
- **Self-view tiles**: no overlay shown (you don't hear your
  own streams)

### CSS additions (in app.css)

```css
.video-tile-overlay {
  position: absolute;
  bottom: 0;
  right: 0;
  padding: 6px;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.video-cell:hover .video-tile-overlay {
  opacity: 1;
  pointer-events: auto;
}
.tile-mute-btn {
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 4px;
  color: var(--text-normal);
  padding: 4px;
  cursor: pointer;
}
.tile-mute-btn:hover {
  background: rgba(0, 0, 0, 0.8);
}
```

## 4. VideoGrid API Changes

`addStream` signature gains an optional config parameter:

```typescript
interface TileConfig {
  /** True if this is the local user's own tile (no audio controls) */
  readonly isSelf: boolean;
  /** The real userId for audio control (differs from tile ID for screenshare tiles) */
  readonly audioUserId: number;
  /** True if this tile represents a screenshare (vs camera) */
  readonly isScreenshare: boolean;
}

addStream(tileId: number, username: string, stream: MediaStream, config?: TileConfig): void
```

When `config` is provided and `isSelf` is false, the overlay
with the mute button is rendered. The `audioUserId` and
`isScreenshare` fields tell the button handler which audio
control method to call.

## 5. State Management

- **No new store fields.** Tile mute state is ephemeral
  (component-local). Not persisted.
- Screenshare audio elements tracked in a
  `Map<number, HTMLAudioElement>` inside `LiveKitSession`.
- Existing `userVolume_{userId}` localStorage pref continues
  to work for mic audio via the right-click sidebar slider.

## 6. Track Source Import

Add `Track.Source` usage (already partially imported) to
distinguish `ScreenShareAudio` from `Microphone` in
`handleTrackSubscribed`.

## Files Changed

| File | Change |
|------|--------|
| `lib/livekitSession.ts` | `audio: true` option, screenshare audio map, new methods |
| `components/VideoGrid.ts` | Hover overlay, mute button, TileConfig param |
| `pages/main-page/VideoModeController.ts` | Pass TileConfig to addStream calls |
| `pages/MainPage.ts` | Pass TileConfig for remote video callbacks |
| `styles/app.css` | Overlay + mute button styles |
| `tests/unit/video-grid.test.ts` | Overlay rendering, mute toggle |
| `tests/unit/livekit-session.test.ts` | Screenshare audio methods |

## Not In Scope

- Focus mode / large-tile layout (separate spec)
- Manual-activate video grid (separate spec)
- "LIVE" badge in sidebar (separate spec)
- Per-tile volume slider (right-click slider already exists
  for per-user volume; tile button is mute toggle only)
