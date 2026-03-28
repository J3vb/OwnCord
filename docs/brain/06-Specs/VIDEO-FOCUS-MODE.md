# Video Focus Mode + Grid Layout System

## Complete Architecture Specification

*Updated: 2026-03-28 | Status: IMPLEMENTED | Related: [[SCREENSHARE-AUDIO]], [[CLIENT-ARCHITECTURE]], [[DEC-009-livekit-migration]]*

---

## 1. Executive Summary

OwnCord's video system renders camera and screen share streams in a
responsive CSS grid (VideoGrid component). It supports two layout
modes: a standard equal-size grid and a focus mode with one large
tile plus a thumbnail strip. The VideoModeController orchestrates
tile lifecycle, mode switching between chat and video, and focus
state. Camera and screenshare are managed via LiveKit tracks,
with the server tracking boolean state for presence display.

---

## 2. Component Architecture

```
  +-----------------------------------------------------------------+
  |                        MainPage.ts                                |
  |                                                                   |
  |  Wires:                                                           |
  |   - onRemoteVideo(userId, stream, isScreenshare)                  |
  |   - onRemoteVideoRemoved(userId, isScreenshare)                   |
  |   - voiceStore subscription -> videoModeCtrl.checkVideoMode()     |
  |   - Text channel select -> videoModeCtrl.showChat()               |
  |                                                                   |
  +--------+---------------------------+-----------------------------+
           |                           |
           v                           v
  +--------+---------+    +-----------+------------------+
  | VideoModeController|    |        VideoGrid.ts          |
  |                    |    |                              |
  | - showChat()       |    | - addStream(id,name,stream,  |
  | - showVideoGrid()  |    |     config?)                 |
  | - checkVideoMode() |    | - removeStream(id)           |
  | - setFocus(tileId) |    | - hasStreams()                |
  | - isVideoMode()    |    | - setFocusedTile(id)         |
  | - destroy()        |    | - getFocusedTileId()         |
  |                    |    | - mount(container) / destroy()|
  | Manages:           |    |                              |
  | - Local camera tile|    | Renders:                     |
  | - Local SS tile    |    | - Equal-size CSS grid        |
  | - Slot visibility  |    | - Focus mode layout          |
  | - Focus tile state |    | - Per-tile overlay controls   |
  +--------------------+    +------------------------------+
```

---

## 3. VideoGrid Component

### 3.1 Interface

**File:** `Client/tauri-client/src/components/VideoGrid.ts`

```typescript
interface VideoGridComponent extends MountableComponent {
  addStream(userId: number, username: string, stream: MediaStream, config?: TileConfig): void;
  removeStream(userId: number): void;
  hasStreams(): boolean;
  setFocusedTile(tileId: number): void;
  getFocusedTileId(): number | null;
}
```

### 3.2 Internal State

```typescript
let root: HTMLDivElement | null = null;          // Grid container
const cells = new Map<number, {                   // Tile registry
  el: HTMLDivElement;
  config?: TileConfig;
}>();
let focusedTileId: number | null = null;          // Currently focused tile
```

### 3.3 Grid Layout Algorithm

The grid uses CSS `grid-template-columns` to determine column count
based on the number of active streams:

```typescript
function computeGridColumns(count: number): string {
  if (count <= 1) return "1fr";          // Single tile: full width
  if (count <= 4) return "1fr 1fr";      // 2-4 tiles: 2 columns
  if (count <= 9) return "1fr 1fr 1fr";  // 5-9 tiles: 3 columns
  return "1fr 1fr 1fr 1fr";              // 10+ tiles: 4 columns
}
```

```
  1 tile:               2-4 tiles:          5-9 tiles:         10+ tiles:
  +----------------+    +-------+-------+   +----+----+----+   +---+---+---+---+
  |                |    |       |       |   |    |    |    |   |   |   |   |   |
  |    1fr full    |    | 1fr   | 1fr   |   | 1fr|1fr |1fr |   |1fr|1fr|1fr|1fr|
  |                |    |       |       |   |    |    |    |   |   |   |   |   |
  +----------------+    +-------+-------+   +----+----+----+   +---+---+---+---+
                        |       |       |   |    |    |    |   |   |   |   |   |
                        | 1fr   | 1fr   |   | 1fr|1fr |1fr |   |1fr|1fr|1fr|1fr|
                        +-------+-------+   +----+----+----+   +---+---+---+---+
```

Each cell has `aspect-ratio: 16/9`, `overflow: hidden`, and the
`<video>` element uses `object-fit: cover`.

### 3.4 Adding Streams

When `addStream` is called:

1. **Existing tile:** If a cell exists for the userId, update the
   `<video>` srcObject only if tracks actually changed (avoids
   flicker on redundant calls). Update username label.
2. **New tile:** Create DOM structure:
   ```html
   <div class="video-cell" data-user-id="{id}">
     <video autoplay playsinline muted />
     <div class="video-username">{username}</div>
     <!-- If config.isSelf === false: -->
     <div class="video-tile-overlay">
       <input type="range" class="tile-volume-slider" ... />
       <button class="tile-mute-btn"> <svg/> </button>
     </div>
   </div>
   ```
3. Register click handler for focus mode switching
4. Store in cells Map
5. Append to root and recalculate layout

### 3.5 Removing Streams

When `removeStream` is called:

1. Get cell from Map, null-out video srcObject
2. Remove DOM element
3. Delete from cells Map
4. If the removed tile was focused:
   - Focus the next available tile (first key in Map)
   - If no tiles remain, clear focus
5. Rebuild layout

---

## 4. Focus Mode

### 4.1 Layout Structure

When a tile is focused, the grid switches from CSS grid to flex
layout:

```
  +--------------------------------------------------+
  |                                                    |
  |               FOCUSED TILE (large)                 |
  |             video-focus-main (flex: 1)             |
  |                                                    |
  |                                                    |
  +--------------------------------------------------+
  | [thumb1] [thumb2] [thumb3] ... (horizontal scroll) |
  |          video-focus-strip (height: 90px)          |
  +--------------------------------------------------+
```

```html
<div class="video-grid focus-mode">
  <div class="video-focus-main">
    <div class="video-cell focused" data-user-id="42">...</div>
  </div>
  <div class="video-focus-strip">
    <div class="video-cell thumb" data-user-id="7">...</div>
    <div class="video-cell thumb" data-user-id="99">...</div>
  </div>
</div>
```

### 4.2 CSS for Focus Mode

**File:** `Client/tauri-client/src/styles/app.css` lines 2152-2188

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
  overflow-x: auto;       /* Horizontal scroll for many thumbnails */
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

### 4.3 Focus Mode Switching

```
rebuildFocusLayout():
  |
  +-- focusedTileId === null OR cells.size === 0?
  |    Yes: Remove "focus-mode" class, use regular grid layout
  |         Clear all "focused" and "thumb" classes
  |
  +-- focusedTileId is set:
       1. Add "focus-mode" class to root
       2. Clear grid-template-columns (flex takes over)
       3. Create video-focus-main div
       4. Move focused cell into main, add "focused" class
       5. Create video-focus-strip div
       6. Move all other cells into strip, add "thumb" class
       7. Append main and strip to root
       8. Only show strip if there are thumbnails
```

### 4.4 Click-to-Focus

Clicking any tile (that is not the focused tile) switches focus:

```typescript
cell.addEventListener("click", (e) => {
  // Don't switch focus when clicking mute button
  if ((e.target as Element).closest(".tile-mute-btn")) return;
  if (focusedTileId !== null && focusedTileId !== userId) {
    focusedTileId = userId;
    rebuildFocusLayout();
  }
});
```

Focus can only be changed when already in focus mode (focusedTileId
is not null). Entering focus mode is done via `setFocusedTile(id)`.

### 4.5 Single Stream Behavior

When only one stream is active, the focused tile fills the entire
area. The thumbnail strip is hidden (`stripArea.childElementCount === 0`
means the strip div is not appended).

---

## 5. VideoModeController

### 5.1 Interface

**File:** `Client/tauri-client/src/pages/main-page/VideoModeController.ts`

```typescript
interface VideoModeController {
  checkVideoMode(): void;     // Tile lifecycle + auto-close
  showChat(): void;           // Switch to chat view
  showVideoGrid(): void;      // Switch to video grid view
  isVideoMode(): boolean;     // Current mode query
  setFocus(tileId: number): void;    // Enter/change focus
  getFocusedTileId(): number | null; // Current focus query
  destroy(): void;            // Cleanup
}
```

### 5.2 Slot Management

The controller manages four DOM slots that constitute the chat area:

```typescript
interface VideoModeSlots {
  readonly messagesSlot: HTMLDivElement;  // Message list container
  readonly typingSlot: HTMLDivElement;    // Typing indicator
  readonly inputSlot: HTMLDivElement;     // Message input
  readonly videoGridSlot: HTMLDivElement; // Video grid container
}
```

**Mode switching:**
- `showVideoGrid()`: Hides messages/typing/input (display: none),
  shows video grid (display: block)
- `showChat()`: Restores messages/typing/input (display: ""),
  hides video grid (display: none)
- `showChat()` also resets focus state and tile-added flags

### 5.3 Tile Lifecycle (checkVideoMode)

`checkVideoMode()` is called whenever the voice store state changes
(via subscription in MainPage). It manages tile lifecycle without
auto-switching views:

```
checkVideoMode():
  |
  +-- No voice channel? -> showChat() if in video mode
  |
  +-- No users in channel? -> showChat() if in video mode
  |
  +-- Check if ANY camera or screenshare is active
  |    (local or remote)
  |    No active video? -> showChat() (auto-close when all stop)
  |
  +-- LOCAL CAMERA TILE:
  |    localCamera on + !localTileAdded?
  |      -> getLocalCameraStream()
  |      -> videoGrid.addStream(userId, "You", stream,
  |           { isSelf: true, audioUserId: userId, isScreenshare: false })
  |      -> localTileAdded = true
  |    localCamera off?
  |      -> videoGrid.removeStream(userId)
  |      -> localTileAdded = false
  |
  +-- LOCAL SCREENSHARE TILE:
  |    localScreenshare on + !localScreenshareTileAdded?
  |      -> getLocalScreenshareStream()
  |      -> videoGrid.addStream(userId + 1_000_000, "(Screen)", stream,
  |           { isSelf: true, audioUserId: userId, isScreenshare: true })
  |      -> localScreenshareTileAdded = true
  |    localScreenshare off?
  |      -> videoGrid.removeStream(userId + 1_000_000)
  |      -> localScreenshareTileAdded = false
  |
  +-- REMOTE TILE CLEANUP:
       For each user in channel:
         If !camera && !screenshare && userId !== currentUser:
           -> videoGrid.removeStream(userId)
```

### 5.4 Auto-Close vs Manual Watch

The current implementation has a **hybrid behavior**:

- **Auto-close:** When ALL cameras and screenshares turn off, the
  video grid automatically switches back to chat view.
- **Manual open:** The video grid must be explicitly opened via
  `showVideoGrid()`, which is triggered by sidebar interactions
  or camera/screenshare button clicks.

This differs from the original spec's "manual-activate only" design.
The auto-close behavior prevents a user from staring at an empty
video grid when all streams end.

### 5.5 Screenshare Tile ID Offset

```typescript
const SCREENSHARE_TILE_ID_OFFSET = 1_000_000;
```

This allows the grid to contain both a camera tile (userId) and a
screenshare tile (userId + 1,000,000) for the same participant.
The offset is used consistently across:
- VideoModeController (tile creation)
- VideoGrid (tile storage and focus)
- MainPage (remote video callbacks)

---

## 6. Camera Enable/Disable Flow

### 6.1 Enable Camera

**File:** `Client/tauri-client/src/lib/livekitSession.ts`, `enableCamera()` (line 802)

```
enableCamera():
  1. Guard: room !== null && ws !== null
  2. Set voiceStore.localCamera = true (optimistic)
  3. Stop any existing manual camera track
  4. Read quality preset + saved video device
  5. createLocalVideoTrack(captureOptions)
  6. Store as manualCameraTrack
  7. room.localParticipant.publishTrack(track, {
       source: Camera,
       simulcast: quality !== "source",
       videoEncoding: { maxBitrate, maxFramerate }
     })
  8. ws.send("voice_camera", { enabled: true })
  9. Re-apply audio pipeline (renegotiation protection)
```

### 6.2 Disable Camera

```
disableCamera():
  1. Stop manual camera track (unpublish + stop)
  2. Fallback: setCameraEnabled(false) for any LiveKit-managed track
  3. Set voiceStore.localCamera = false
  4. ws.send("voice_camera", { enabled: false })
```

### 6.3 Camera Quality Presets

| Quality | Resolution | Max Bitrate | Max FPS | Simulcast |
|---------|-----------|-------------|---------|-----------|
| low     | 640x360   | 600 kbps    | 15      | Yes       |
| medium  | 1280x720  | 1.7 Mbps    | 30      | Yes       |
| high    | 1920x1080 | 4.0 Mbps    | 30      | Yes       |
| source  | 1920x1080 | 8.0 Mbps    | 30      | No        |

### 6.4 Server-Side Camera Handling

**File:** `Server/ws/voice_controls.go`, `handleVoiceCamera` (line 67)

The server enforces:
1. Rate limit: 2/sec per user
2. `USE_VIDEO` permission check
3. `MaxVideo` limit enforcement: if enabled AND channel has
   `voice_max_video > 0`, count active cameras via DB. If at limit,
   reject with `ErrCodeVideoLimit`.
4. DB update + voice_state broadcast

---

## 7. Remote Video Track Flow

### 7.1 Track Subscription (Receiver)

When a remote participant publishes a video track, LiveKit
triggers `RoomEvent.TrackSubscribed`:

```typescript
handleTrackSubscribed(track, publication, participant):
  if (track.kind === Track.Kind.Video):
    userId = parseUserId(participant.identity)  // "user-42" -> 42
    stream = new MediaStream([track.mediaStreamTrack])
    isScreenshare = (publication.source === Track.Source.ScreenShare)
    onRemoteVideoCallback(userId, stream, isScreenshare)
```

### 7.2 Callback Chain

```
LiveKitSession.handleTrackSubscribed
  -> onRemoteVideoCallback (set by MainPage)
    -> MainPage handler:
       tileId = isScreenshare ? userId + 1_000_000 : userId
       username = isScreenshare ? "username (Screen)" : username
       videoGrid.addStream(tileId, username, stream, {
         isSelf: false,
         audioUserId: userId,
         isScreenshare
       })
       if (!videoModeCtrl.isVideoMode()):
         videoModeCtrl.showVideoGrid()
         videoModeCtrl.setFocus(tileId)
```

### 7.3 Track Removal

```
LiveKitSession.handleTrackUnsubscribed
  -> onRemoteVideoRemovedCallback
    -> MainPage handler:
       tileId = isScreenshare ? userId + 1_000_000 : userId
       videoGrid.removeStream(tileId)
```

---

## 8. Related VoiceWidget Features

The VoiceWidget includes a **connection quality indicator** (signal
bars + ping) and a **voice call duration timer** (elapsed MM:SS /
HH:MM:SS). These are VoiceWidget-specific features, not part of the
video grid system. Key files:

- `Client/tauri-client/src/lib/connectionStats.ts` — WebRTC stats
  polling (2s interval), RTT-based quality levels
- `Client/tauri-client/src/components/VoiceWidget.ts` — signal bars,
  expandable stats pane, elapsed timer
- `Client/tauri-client/src/stores/voice.store.ts` — `joinedAt`
  timestamp for timer

Quality thresholds: <100ms = excellent (green), 100-200ms = fair
(yellow), 200-400ms = poor (red), >400ms = bad (red).

---

## 9. CSS: Video Grid Styles

**File:** `Client/tauri-client/src/styles/app.css`

```css
/* Container slot */
.video-grid-slot {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Base grid */
.video-grid {
  display: grid;
  gap: 4px;
  padding: 8px;
  height: 100%;
  background: var(--bg-primary, #313338);
}

/* Individual tile */
.video-cell {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: var(--radius-md, 8px);
  background: var(--bg-tertiary);
}

.video-cell video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Username label overlay */
.video-username {
  position: absolute;
  bottom: 8px;
  left: 8px;
  /* (styling details from CSS file) */
}
```

---

## 10. Implementation Status

| Component | Status | File |
|-----------|--------|------|
| VideoGrid component with CSS grid layout | DONE | `VideoGrid.ts` |
| Responsive column count (1-4 columns) | DONE | `computeGridColumns()` |
| Focus mode layout (main + strip) | DONE | `rebuildFocusLayout()` |
| Click-to-focus in thumbnail strip | DONE | Cell click handler |
| Auto-focus-transfer on tile removal | DONE | `removeStream()` |
| VideoModeController factory | DONE | `VideoModeController.ts` |
| Chat/video slot toggling | DONE | `showChat()`/`showVideoGrid()` |
| Local camera tile management | DONE | `checkVideoMode()` |
| Local screenshare tile management | DONE | `checkVideoMode()` |
| Remote tile cleanup | DONE | `checkVideoMode()` |
| Auto-close when no streams | DONE | `checkVideoMode()` |
| Camera enable/disable with quality presets | DONE | `livekitSession.ts` |
| Server MaxVideo limit enforcement | DONE | `voice_controls.go` |
| Per-tile volume/mute overlay | DONE | `VideoGrid.ts` (see [[SCREENSHARE-AUDIO]]) |

---

## 11. Files Reference

| File | Role |
|------|------|
| `Client/tauri-client/src/components/VideoGrid.ts` | Grid rendering, focus mode, tile lifecycle |
| `Client/tauri-client/src/pages/main-page/VideoModeController.ts` | Chat/video toggle, tile orchestration |
| `Client/tauri-client/src/lib/livekitSession.ts` | Camera/screenshare track management |
| `Client/tauri-client/src/lib/connectionStats.ts` | WebRTC stats polling and formatting |
| `Client/tauri-client/src/components/VoiceWidget.ts` | Signal bars, ping, timer, controls |
| `Client/tauri-client/src/stores/voice.store.ts` | localCamera, localScreenshare, joinedAt |
| `Client/tauri-client/src/pages/MainPage.ts` | Wires callbacks, store subscriptions |
| `Client/tauri-client/src/styles/app.css` | Grid, cell, focus mode, overlay CSS |
| `Server/ws/voice_controls.go` | Camera/screenshare permission + state |
| `Server/migrations/006_member_video_permissions.sql` | USE_VIDEO, SHARE_SCREEN permissions |

---

## 12. Known Limitations

1. **No auto-activate:** The video grid does not automatically open
   when a remote user starts their camera. Users must explicitly
   open it (by clicking camera/screenshare buttons, or via sidebar
   interaction in future).
2. **No picture-in-picture:** When switching to a text channel, the
   video grid is hidden entirely. No floating mini-player exists.
3. **No stream preview thumbnails:** Hovering a user in the sidebar
   does not show a preview of their camera/screenshare.
4. **No pop-out video window:** The video grid is inline only, cannot
   be popped out to a separate window.
5. **Focus state is ephemeral:** Not persisted. Lost when switching
   between chat and video modes.
6. **Grid layout is simple:** No drag-to-resize tiles, no pinning,
   no custom arrangements.
7. **No LIVE badge in sidebar:** The original spec called for a red
   "LIVE" badge next to screensharing users in the voice channel
   sidebar. This is not yet implemented.

---

## 13. Future Enhancements

- **Click-to-watch from sidebar:** Clicking a user with active
  camera/screenshare in the voice channel sidebar opens the video
  grid focused on their stream
- **"LIVE" badge:** Red pill badge in sidebar for screensharing users
- **Picture-in-picture mode:** Floating mini-player when switching
  to text channels
- **Stream preview on hover:** Thumbnail preview in the sidebar
- **Pop-out window:** Detachable video grid in a separate window
- **Manual-activate only:** Option to disable auto-close and only
  show video when explicitly requested
