# Video Focus Mode + Manual-Activate

## Goal

Replace auto-activating video grid with Discord-style opt-in
viewing: chat stays default, users click to watch streams,
focused layout with one large tile + thumbnail strip.

## Prerequisites

Screenshare Audio spec (SCREENSHARE-AUDIO.md) should be
implemented first — this spec builds on the TileConfig API
and per-tile controls it introduces.

## 1. Remove Auto-Activate

`VideoModeController.checkVideoMode()` currently auto-switches
to video grid when any camera/screenshare is active. Remove
this auto-switch behavior. The video grid only shows when the
user explicitly clicks to watch.

`checkVideoMode()` still manages tile lifecycle (adding/removing
self-view tiles, removing stale remote tiles) but no longer
calls `showVideoGrid()` or `showChat()` automatically.

The MainPage voice store subscription that triggers
`checkVideoMode` on camera/screenshare state changes remains
(for tile management) but no longer causes view switches.

## 2. Sidebar Indicators

In `VoiceChannel.ts`, each user row already shows a camera
icon when `user.camera` is true. Add:

- **Screen icon** when `user.screenshare` is true (use
  `monitor` icon from lucide, 14px)
- **"LIVE" text badge** next to the screen icon — small red
  pill badge (CSS class `vu-live-badge`)

```css
.vu-live-badge {
  background: #ed4245;
  color: white;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 2px;
}
```

Icons are visual indicators only (not individually clickable).
The entire user row is the click target.

## 3. Click-to-Watch

When a user clicks a voice channel user row in the sidebar
(`VoiceChannel.ts`):

- If the clicked user has camera or screenshare active,
  open the video grid in **focus mode** with that user's
  stream as the large tile
- If the clicked user has NO active video/screenshare,
  do nothing (or show a toast: "No active stream")

### Callback flow

`VoiceChannel` needs a new callback:

```typescript
onWatchStream?(userId: number): void
```

This is wired from `MainPage` → `SidebarArea` → the channel
sidebar → individual `VoiceChannel` instances.

`MainPage` handles `onWatchStream` by:
1. Calling `videoModeCtrl.showVideoGrid()`
2. Calling `videoModeCtrl.setFocus(userId)` (new method)

## 4. Focus Mode Layout

Replace the current equal-size CSS grid with a focus layout:

### Structure

```html
<div class="video-grid focus-mode">
  <div class="video-focus-main">
    <!-- The focused tile (large) -->
    <div class="video-cell focused" data-user-id="42">...</div>
  </div>
  <div class="video-focus-strip">
    <!-- All other tiles (small thumbnails) -->
    <div class="video-cell thumb" data-user-id="7">...</div>
    <div class="video-cell thumb" data-user-id="99">...</div>
  </div>
</div>
```

### Behavior

- **One tile focused** — takes ~75% of the video grid height
- **Thumbnail strip** at bottom — horizontal scroll if many
  tiles, each ~120px wide
- **Click a thumbnail** → it becomes the focused tile; the
  previously focused tile moves to the strip
- **Single stream** — if only one stream is active, it fills
  the entire area (no strip shown)
- The focused tile ID is tracked in `VideoModeController`
  state (not in a store — ephemeral)

### CSS

```css
.video-grid.focus-mode {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.video-focus-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}
.video-focus-main .video-cell {
  width: 100%;
  height: 100%;
}
.video-focus-strip {
  display: flex;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  flex-shrink: 0;
  height: 90px;
  background: var(--bg-tertiary);
}
.video-focus-strip .video-cell {
  width: 120px;
  min-width: 120px;
  height: 100%;
  cursor: pointer;
  border: 2px solid transparent;
  border-radius: 4px;
}
.video-focus-strip .video-cell:hover {
  border-color: var(--accent);
}
```

## 5. Return to Chat

Clicking any **text channel** in the sidebar while video grid
is visible:

1. Calls `videoModeCtrl.showChat()` to hide the grid
2. Loads the text channel as usual
3. Voice connection stays active

This already partially works (channel switching hides video).
The change is ensuring `showChat()` is always called when a
text channel is selected, not just when cameras turn off.

## 6. VideoModeController API Changes

New methods:

```typescript
interface VideoModeController {
  checkVideoMode(): void;     // existing — tile lifecycle only
  showChat(): void;           // existing
  showVideoGrid(): void;      // existing
  isVideoMode(): boolean;     // existing
  setFocus(tileId: number): void;    // new — focus on tile
  getFocusedTileId(): number | null; // new — current focus
  destroy(): void;            // existing
}
```

## 7. Files Changed

| File | Change |
|------|--------|
| `pages/main-page/VideoModeController.ts` | Remove auto-switch, add focus mode, setFocus/getFocusedTileId |
| `components/VideoGrid.ts` | Focus layout rendering (main + strip), click-to-focus |
| `components/VoiceChannel.ts` | Screen icon, LIVE badge, onWatchStream callback |
| `pages/MainPage.ts` | Wire onWatchStream, ensure text channel click calls showChat |
| `pages/main-page/SidebarArea.ts` | Pass onWatchStream callback through |
| `pages/main-page/ChannelController.ts` | Ensure showChat on text channel select |
| `styles/app.css` | Focus mode CSS, LIVE badge, thumbnail strip |
| `tests/unit/video-mode-controller.test.ts` | Focus mode, no auto-activate |
| `tests/unit/voice-channel.test.ts` | LIVE badge, screen icon |
| `tests/unit/video-grid.test.ts` | Focus layout |

## Not In Scope

- Picture-in-picture / floating mini-player when switching
  to text channels (future enhancement)
- Stream preview thumbnail on hover (future enhancement)
- Pop-out video window (future enhancement)
- "Watch Stream" popup dialog (simplified — direct click)
