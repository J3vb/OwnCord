/**
 * VideoGrid component — renders remote video streams in a responsive CSS grid.
 * Replaces the chat area when cameras are active.
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren, setText, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import {
  getScreenshareAudioMuted,
  getScreenshareAudioVolume,
  getUserLocalMute,
  getUserVolume,
  muteScreenshareAudio,
  setScreenshareAudioVolume,
  setUserLocalMute,
  setUserVolume,
} from "@lib/voice/livekitSession";
import { USER_LOCAL_MUTE_CHANGED } from "@lib/constants";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { syncVideoSurface, videoSurfaceOf } from "@lib/voice/videoSurface";
import { bindVideoZoom } from "@lib/ui/zoomPan";
import type { ZoomPan } from "@lib/ui/zoomPan";
import type { MountableComponent } from "@lib/text/safeRender";
import { voiceText } from "../i18n/voice";
import { viewersLabel } from "./video-grid/viewers";
import type { StreamInfo } from "./video-grid/streamInfo";
import type { VoiceModMenuOptions } from "./channel-sidebar/volumeMenu";
import type { StreamSample, VideoView } from "../features/voice/remoteTracks";
import type { ShareSenderSample } from "../features/voice/shareSenderStats";
import {
  openPopout,
  openPopoutWindow,
  type Popout,
  type PopoutWindow,
} from "../features/voice/popout";
import type { MiniPlayer } from "../features/voice/miniPlayer";

/** How often a watched stream's quality chip refreshes. */
const STATS_POLL_MS = 2000;
/** How long tile sizes settle (a window drag) before their views are sent. */
const VIEW_RESIZE_MS = 150;
/** The call view's control bar sits in this much room below the tiles
 *  (`.video-grid--call`'s extra bottom padding). */
const CALL_BAR_SPACE = 56;

/** The call view's saved view toggles: pref key and default. */
const VIEW_PREFS = {
  nonVideo: "callShowNonVideo",
  selfCamera: "callShowSelfCamera",
  strip: "callShowStrip",
} as const;
type ViewToggle = keyof typeof VIEW_PREFS;

const log = createLogger("VideoGrid");

export interface TileConfig {
  /** True if this is the local user's own tile (no audio controls) */
  readonly isSelf: boolean;
  /** The real userId for audio control (differs from tile ID for screenshare tiles) */
  readonly audioUserId: number;
  /** True if this tile represents a screenshare (vs camera) */
  readonly isScreenshare: boolean;
  /** The person's display name, for control labels ("Otto stream volume").
   *  Falls back to the tile label. */
  readonly name?: string;
  /** Your own screen share is sending audio too (the self-share cover). */
  readonly hasAudio?: boolean;
}

/** What the grid reports back to its owner. */
export interface VideoGridCallbacks {
  /** Stop sharing, from the cover on your own screen-share preview. */
  readonly onStopSharing?: () => void;
  /** Keep the app window's full-screen state in step with a tile's. In a
   *  Tauri window, HTML full screen may fill only the webview (WebView2), so
   *  the window itself goes full screen too. With a label, a stream pop-out
   *  window's state in step with its page's. */
  readonly setWindowFullscreen?: (on: boolean, label?: string) => Promise<void>;
  /** The call controls: the call view's control bar, and a full-screen
   *  tile's. Camera and share are offered when given. */
  readonly callControls?: {
    readonly onMuteToggle: () => void;
    readonly onDeafenToggle: () => void;
    readonly onLeave: () => void;
    readonly onCameraToggle?: () => void;
    /** Pick the camera from a menu at `anchor`, closed with the grid
     *  (`signal`): the arrow beside Camera. */
    readonly onCameraDevice?: (anchor: HTMLElement, signal: AbortSignal) => void;
    readonly onScreenshareToggle?: () => void;
  };
  /** One receiver sample for a remote tile's quality chip, or null. */
  readonly getStreamStats?: (tileId: number) => Promise<StreamSample | null>;
  /** What your own screen share is sending, or null where nothing reports it. */
  readonly getLocalShareStats?: () => Promise<ShareSenderSample | null>;
  /** What a remote tile shows now, so its stream sends only that. */
  readonly setStreamView?: (tileId: number, view: VideoView) => void;
  /** Opt-in watching: the viewer watches a remote stream, or stops. Nothing
   *  is received until they do. */
  readonly setStreamWatched?: (tileId: number, watched: boolean) => void;
  /** The stream ended: drop its watch, which is not the viewer's Stop
   *  watching (a stopped camera stays stopped). */
  readonly forgetStreamWatch?: (tileId: number) => void;
  /** Leave video mode entirely (grid or focus) back to the chat. The grid's
   *  own header control offers this, so no state is a dead end. */
  readonly onExitGrid?: () => void;
  /** The whole call moved into its own window (`out`), or came back:
   *  `restore` when the main window should show it again (Bring back, or the
   *  user closed the window), not when the call view ended. */
  readonly onCallPopout?: (out: boolean, restore: boolean) => void;
  /** A tile left later than the removeStream call that ended it. */
  readonly onStreamRemoved?: () => void;
  /** Whether this user's voice state still says their screen share (or
   *  camera) is on. A codec switch unpublishes and publishes the same track,
   *  so a watched stream whose owner still has it on gets a moment
   *  to come back, keeping its watch, before its tile ends. */
  readonly isStreamLive?: (userId: number, screenshare: boolean) => boolean;
  /** Back to the full stream view of `tileId`, from its mini-player. */
  readonly onReturnToStream?: (tileId: number) => void;
  /** Focus a control on the main page, for focus that was in a mini-player
   *  that has just closed. */
  readonly focusFallback?: () => void;
  /** The person's rows in a remote tile's menu; each is left out without it. */
  readonly tileMenu?: {
    readonly onProfile?: (userId: number, x: number, y: number) => void;
    readonly onMessage?: (userId: number) => void;
    /** The voice roster's moderation section for this person, read when the
     *  menu opens: the options, why it is unavailable, or undefined to hide it. */
    readonly moderation?: (userId: number) => VoiceModMenuOptions | string | undefined;
  };
}

/** Someone in the call the host wants drawn as an avatar tile while they have
 *  no camera tile up. The host owns `content` (and keeps it current). */
export interface GridPerson {
  readonly userId: number;
  readonly label: string;
  readonly content: HTMLElement;
  /** The host draws this person's speaking and mute state itself (the DM
   *  call panel's avatars), so the tile adds no ring or badge. */
  readonly marksOwnState?: true;
}

export interface CallState {
  readonly muted: boolean;
  readonly deafened: boolean;
  /** Joined without a microphone: the mute control reads mic-off, inert. */
  readonly listenOnly: boolean;
  readonly camera?: boolean;
  readonly screenshare?: boolean;
  /** The join has not reached the room yet: camera and share are inert. */
  readonly connecting?: boolean;
  /** A moderator muted or deafened you: that control is inert. */
  readonly serverMuted?: boolean;
  readonly serverDeafened?: boolean;
  /** The chat socket is down: camera and share are inert until it is back. */
  readonly offline?: "reconnecting" | "disconnected";
  /** Why share is inert (no permission, video limit), when it is. */
  readonly shareBlock?: string;
}

export interface VideoGridComponent extends MountableComponent {
  /** A null stream: a remote stream published but not watched, drawn with
   *  Watch stream (opt-in watching). A stream makes it play. */
  addStream(
    userId: number,
    username: string,
    stream: MediaStream | null,
    config?: TileConfig,
  ): void;
  /** Watch a remote stream (the voice roster's click), now or as soon as
   *  its tile is offered. */
  watch(tileId: number): void;
  /** Update an already-open tile's label and the person's name in its
   *  control labels in place (e.g. a mid-call rename). No-op if no tile is
   *  open for this id — callers don't need to know whether the tile exists. */
  setLabel(userId: number, username: string, name?: string): void;
  removeStream(userId: number): void;
  /** Remove every tile — used on a real voice leave so stale remote tiles
   *  from the previous session don't survive into the next join. */
  clearStreams(): void;
  hasStreams(): boolean;
  setFocusedTile(tileId: number | null): void;
  getFocusedTileId(): number | null;
  /** The people to draw as avatar tiles, after the streams. A person's tile
   *  steps aside while their camera tile is up. Not counted by hasStreams. */
  setPeople(people: readonly GridPerson[]): void;
  /** Ring the camera and avatar tiles of the users speaking now. */
  setSpeaking(userIds: ReadonlySet<number>): void;
  /** Mute/deafen state by userId, shown as a badge on the camera and avatar
   *  tiles (the UX spec's roster parity for tiles; not on screen-share tiles). */
  setUserAudioState(state: ReadonlyMap<number, { muted: boolean; deafened: boolean }>): void;
  /** Display names of the other members watching each sharer's screen share
   *  (by the sharer's user id): an eye and the count on that share's tile,
   *  with the names on hover. You are added on a remote share you are
   *  playing here. */
  setStreamViewers(viewers: ReadonlyMap<number, readonly string[]>): void;
  setCallbacks(callbacks: VideoGridCallbacks): void;
  /** Your call state, for the call controls. */
  setCallState(state: CallState): void;
  /** The call view on the main page (video mode): shows the header's exit
   *  control and view toggles and the control bar, and applies the saved
   *  view toggles. Off where another host (the DM call panel) shows the grid. */
  setExitVisible(visible: boolean): void;
  /** Keep the watched remote stream (the focused one, else the first playing
   *  in the grid) playing in the mini-player while the grid is closed. A
   *  no-op when nothing is being watched here. */
  showMiniPlayer(): void;
  /** Put the mini-player's stream back in its tile. */
  hideMiniPlayer(): void;
  /** Bring the call's pop-out window to the front: false when the call is
   *  not popped out. */
  raiseCallPopout(): boolean;
}

/** Create a fresh volume icon element. */
function volumeIcon(): SVGSVGElement {
  return createIcon("volume-2", 16);
}
/** Create a fresh volume-x (muted) icon element. */
function volumeXIcon(): SVGSVGElement {
  return createIcon("volume-x", 16);
}
/** Replace a button's icon child with a new one. */
function setButtonIcon(btn: HTMLButtonElement, icon: SVGSVGElement): void {
  while (btn.firstChild) btn.removeChild(btn.firstChild);
  btn.appendChild(icon);
}

// ---------------------------------------------------------------------------
// Layout calculator — Discord-style tile sizing
// ---------------------------------------------------------------------------

export interface GridLayout {
  readonly cols: number;
  readonly rows: number;
  readonly tileW: number;
  readonly tileH: number;
}

const GRID_GAP = 4;
const GRID_PAD = 8;
const ASPECT = 16 / 9;

/**
 * Compute optimal tile arrangement that maximises tile area while fitting
 * all tiles inside the container.  Tries every possible column count and
 * picks the one whose tiles are largest.
 */
export function computeGridLayout(
  containerW: number,
  containerH: number,
  tileCount: number,
): GridLayout {
  if (tileCount <= 0) return { cols: 1, rows: 1, tileW: 0, tileH: 0 };

  let best: GridLayout = { cols: 1, rows: tileCount, tileW: 0, tileH: 0 };

  for (let cols = 1; cols <= tileCount; cols++) {
    const rows = Math.ceil(tileCount / cols);
    const availW = containerW - GRID_PAD * 2 - GRID_GAP * (cols - 1);
    const availH = containerH - GRID_PAD * 2 - GRID_GAP * (rows - 1);
    if (availW <= 0 || availH <= 0) continue;

    let tileW = availW / cols;
    let tileH = tileW / ASPECT;

    // Shrink if total row height exceeds available height
    if (tileH * rows > availH) {
      tileH = availH / rows;
      tileW = tileH * ASPECT;
    }

    // Floor width first, then derive height to preserve exact 16:9
    const floorW = Math.floor(tileW);
    const floorH = Math.floor(floorW / ASPECT);

    if (floorW * floorH > best.tileW * best.tileH) {
      best = { cols, rows, tileW: floorW, tileH: floorH };
    }
  }

  return best;
}

/** Rendered, so it can take focus: not hidden by the grid (`hidden`) or by
 *  the layout's CSS (the filmstrip hides a thumb's controls). */
function isShown(el: HTMLElement): boolean {
  return (
    el.closest("[hidden]") === null &&
    (typeof el.checkVisibility !== "function" || el.checkVisibility())
  );
}

/** A labelled icon button on a tile, above the tile's own select button. */
function tileButton(
  text: string,
  icon: IconName,
  control: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: "video-tile-btn",
    "aria-label": text,
    title: text,
    "data-tile-control": control,
  });
  btn.appendChild(createIcon(icon, 18));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** A call control on a full-screen tile. */
function callButton(
  label: string,
  icon: IconName,
  id: string,
  onClick: () => void,
  cls = "",
): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: `video-fs-btn${cls}`,
    "aria-label": label,
    title: label,
    "data-call-control": id,
  });
  btn.appendChild(createIcon(icon, 18));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

interface CellEntry {
  el: HTMLDivElement;
  /** The tile's video, in the tile or in its pop-out window. */
  video: HTMLVideoElement;
  /** The pop-out window the video is in, if any. */
  popout?: Popout;
  /** The mini-player the video is in, if any. */
  mini?: MiniPlayer;
  config?: TileConfig;
  trackCleanup?: () => void;
  /** Owns the tile's menu listeners and its open menu; goes with the tile. */
  listeners: Disposable;
  /** The person's name in the control labels and the tile menu. */
  name: string;
  /** Draw a volume set elsewhere (remote tiles only). */
  applyVolume?: (volume: number, muted: boolean) => void;
  /** The volume controls (remote tiles only): they go along into a pop-out. */
  volumeOverlay?: HTMLElement;
  /** Ctrl + wheel zoom and drag pan on the tile's video. */
  zoom?: ZoomPan;
  /** The previous receiver sample, for the frame rate. */
  prevSample?: StreamSample;
  /** The view last reported for the tile, as JSON. */
  view?: string;
  /** Playing until the stream stopped arriving without the viewer's Stop
   *  watching: an unpublish unsubscribes first, then removes the tile. */
  lost?: boolean;
  /** The stream ended: the tile shows who ended it until this timer drops it. */
  ending?: ReturnType<typeof setTimeout>;
  /** The stream is gone but its owner still shares: the tile waits, without a
   *  cover, for the republish to arrive. */
  holding?: ReturnType<typeof setTimeout>;
}

/** How long a watched stream's tile says it ended before it goes. */
const ENDED_COVER_MS = 3000;

/** How long a watched share whose owner still shares waits for its republish
 *  before the tile says it ended, and how often it looks at the owner's state
 *  meanwhile (a real stop shows its cover as soon as the owner's state says so). */
const REPUBLISH_HOLD_MS = 2500;
const REPUBLISH_HOLD_POLL_MS = 250;

/** The picture's size, from the canvas when one draws it (Linux). */
function sizeOf(video: HTMLVideoElement): { width: number; height: number } {
  const surface = videoSurfaceOf(video);
  return surface !== null
    ? { width: surface.width, height: surface.height }
    : { width: video.videoWidth, height: video.videoHeight };
}

/** A remote stream playing in its tile (watched, not in a pop-out window). */
function isPlayingHere(e: CellEntry | undefined): boolean {
  return (
    e?.config !== undefined &&
    !e.config.isSelf &&
    e.popout === undefined &&
    e.video.srcObject != null &&
    !e.el.classList.contains("video-cell--stopped")
  );
}

/** The stream (screen-share audio, 0-100 %) or voice (mic, 0-200 %) volume
 *  of a remote tile: mute, a slider named for whose it is, and its value. A
 *  voice tile's mute is the user's local Mute, shared with the sidebar menu. */
function buildVolumeControls(config: TileConfig): {
  overlay: HTMLDivElement;
  apply: (volume: number, muted: boolean) => void;
} {
  // Mic and screenshare audio state both survive tile rebuilds —
  // initialize from the same persisted values the sidebar volume menu
  // reads, instead of hardcoding "unmuted at 100%". Stream audio
  // plays on an element (volume caps at 1.0); voice has a gain node.
  const savedVolume = config.isScreenshare
    ? Math.round(getScreenshareAudioVolume(config.audioUserId) * 100)
    : getUserVolume(config.audioUserId);
  let currentVolume = savedVolume;
  let muted = config.isScreenshare
    ? getScreenshareAudioMuted(config.audioUserId)
    : getUserLocalMute(config.audioUserId) || savedVolume === 0;
  /** What the slider shows: the stored level on open (even if muted), 0
   *  once muted from here, the level again on unmute. */
  let shown = currentVolume;

  const overlay = createElement("div", { class: "video-tile-overlay" });
  const volumeSlider = createElement("input", {
    type: "range",
    min: "0",
    max: config.isScreenshare ? "100" : "200",
    value: String(currentVolume),
    class: "tile-volume-slider",
    // Lets a tile rebuild or removal put focus back on the same control
    // (captureFocusedControl), not just the tile.
    "data-tile-control": "volume",
  });
  const output = createElement("output", { class: "tile-volume-value" });
  const muteBtn = createElement("button", {
    type: "button",
    class: "tile-mute-btn",
    "data-tile-control": "mute",
  });

  /** Draw the state; the slider shows 0 while muted. */
  function render(): void {
    volumeSlider.value = String(shown);
    const text = voiceText("tile.percent", { percent: shown });
    volumeSlider.setAttribute("aria-valuetext", text);
    setText(output, text);
    setButtonIcon(muteBtn, muted ? volumeXIcon() : volumeIcon());
    muteBtn.setAttribute(
      "aria-label",
      muted ? voiceText("widget.control.unmute") : voiceText("widget.control.mute"),
    );
    overlay.classList.toggle("muted", muted);
  }

  function commit(): void {
    if (config.isScreenshare) {
      // Set actual volume, not just mute toggle. Slider 100 maps
      // to element volume 1.0 (the attach-time default).
      muteScreenshareAudio(config.audioUserId, muted);
      if (!muted) setScreenshareAudioVolume(config.audioUserId, currentVolume / 100);
    } else {
      // The saved level stays as it is under the Mute; a level of 0 (from an
      // older build's mute) comes back at 100.
      if (!muted && getUserVolume(config.audioUserId) !== currentVolume) {
        setUserVolume(config.audioUserId, currentVolume);
      }
      setUserLocalMute(config.audioUserId, muted);
    }
  }

  volumeSlider.addEventListener("input", () => {
    const value = Number(volumeSlider.value);
    muted = value === 0;
    shown = value;
    if (!muted) currentVolume = value;
    if (config.isScreenshare) {
      muteScreenshareAudio(config.audioUserId, muted);
      setScreenshareAudioVolume(config.audioUserId, value / 100);
    } else {
      setUserVolume(config.audioUserId, value);
      if (value > 0 && getUserLocalMute(config.audioUserId)) {
        setUserLocalMute(config.audioUserId, false);
      }
    }
    render();
  });

  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    if (!muted && currentVolume === 0) currentVolume = 100;
    shown = muted ? 0 : currentVolume;
    commit();
    render();
  });

  render();
  appendChildren(overlay, muteBtn, volumeSlider, output);
  return {
    overlay,
    // A tile menu changed the same setting: show it here too.
    apply(volume: number, isMuted: boolean): void {
      muted = isMuted;
      if (volume > 0) currentVolume = volume;
      shown = muted ? 0 : currentVolume;
      render();
    },
  };
}

/** F without a modifier, and not typed into a text field. */
function isFullscreenKey(e: KeyboardEvent): boolean {
  const typing =
    (e.target instanceof HTMLInputElement && e.target.type !== "range") ||
    e.target instanceof HTMLTextAreaElement;
  return (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
}

/** Your own camera tile, which shows mirrored like a mirror does. Never a
 *  screen share: that must read the way viewers see it. */
function isSelfCamera(config: TileConfig | undefined): boolean {
  return config?.isSelf === true && !config.isScreenshare;
}

export function createVideoGrid(): VideoGridComponent {
  let root: HTMLDivElement | null = null;
  const cells = new Map<number, CellEntry>();
  let focusedTileId: number | null = null;
  let people: readonly GridPerson[] = [];
  const personCells = new Map<number, HTMLDivElement>();
  let resizeObserver: ResizeObserver | null = null;
  let resizeRafId = 0;
  /** The window `resizeRafId` was requested on. */
  let rafWindow: Window = window;
  let callbacks: VideoGridCallbacks = {};
  let speaking: ReadonlySet<number> = new Set();
  let userAudioState: ReadonlyMap<number, { muted: boolean; deafened: boolean }> = new Map();
  let streamViewers: ReadonlyMap<number, readonly string[]> = new Map();
  /** The tile in HTML full screen, or in the theatre fallback. */
  let fullscreenTile: number | null = null;
  let theatreTile: number | null = null;
  let callState: CallState = { muted: false, deafened: false, listenOnly: false };
  let exitBtn: HTMLButtonElement | null = null;
  /** The call view (setExitVisible): header toggles, control bar, filters. */
  let callView = false;
  let viewBar: HTMLElement | null = null;
  let callBar: HTMLElement | null = null;
  const viewOn: Record<ViewToggle, boolean> = { nonVideo: true, selfCamera: true, strip: true };
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let statsTile: number | null = null;
  let viewResizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Streams the voice roster asked to watch before their tile was offered. */
  const pendingWatch = new Set<number>();
  /** Owns the grid's document listeners (full-screen changes, theatre keys). */
  const gridListeners = new Disposable();
  /** The whole call in a window of its own (the call view's Pop out), and
   *  where the grid goes back to. */
  let callPop: PopoutWindow | null = null;
  let callHome: Element | null = null;
  let popBtn: HTMLButtonElement | null = null;
  /** The pop-out closes for Bring back (true) or because the call view ended. */
  let popRestore = true;

  /** The document the grid is in: the call's pop-out window's, or the app's. */
  function doc(): Document {
    return root?.ownerDocument ?? document;
  }

  /** Apply JS-calculated tile sizes to all grid-mode cells. */
  function applyGridSizes(): void {
    const tiles = shownTiles();
    if (root === null || focusedTileId !== null || tiles.length === 0) return;

    const { width: cw, height: ch } = root.getBoundingClientRect();
    if (cw === 0 || ch === 0) return;

    const barSpace = callBar !== null ? CALL_BAR_SPACE : 0;
    const layout = computeGridLayout(cw, ch - barSpace, tiles.length);

    for (const el of tiles) {
      el.style.width = `${layout.tileW}px`;
      el.style.height = `${layout.tileH}px`;
    }
  }

  /** Bring the avatar tiles in line with `people` and the open camera tiles:
   *  one per person without a camera tile, reused across updates. */
  function syncPeople(): void {
    const wanted = new Set<number>();
    for (const person of people) {
      if (cells.has(person.userId)) continue;
      wanted.add(person.userId);
      let cell = personCells.get(person.userId);
      if (cell === undefined) {
        cell = createElement("div", {
          class: "video-cell video-cell--avatar",
          "data-person-id": String(person.userId),
        });
        personCells.set(person.userId, cell);
      }
      if (cell.firstChild !== person.content) {
        while (cell.firstChild) cell.removeChild(cell.firstChild);
        appendChildren(cell, person.content, createElement("div", { class: "video-username" }));
      }
      const label = cell.querySelector(".video-username");
      if (label !== null) label.textContent = person.label;
    }
    for (const [id, cell] of personCells) {
      if (wanted.has(id)) continue;
      cell.remove();
      personCells.delete(id);
    }
  }

  /** A tile the call view's toggles hide: avatar tiles without "Show
   *  non-video participants", your own camera without "Show my camera". */
  function hiddenByView(el: HTMLDivElement, config: TileConfig | undefined): boolean {
    if (!callView) return false;
    if (el.classList.contains("video-cell--avatar")) return !viewOn.nonVideo;
    return !viewOn.selfCamera && isSelfCamera(config);
  }

  /** Mark each tile hidden or shown by the view toggles. A focused tile that
   *  is now hidden gives the focus up. */
  function applyViewFilters(): void {
    for (const [id, entry] of cells) {
      entry.el.hidden = hiddenByView(entry.el, entry.config);
      if (entry.el.hidden && id === focusedTileId) focusedTileId = null;
    }
    for (const cell of personCells.values()) cell.hidden = hiddenByView(cell, undefined);
  }

  /** The tiles on screen, for sizing. */
  function shownTiles(): HTMLDivElement[] {
    return allTiles().filter((el) => !el.hidden);
  }

  /** Every tile in layout order: streams, then the avatar tiles. */
  function allTiles(): HTMLDivElement[] {
    const tiles = [...cells.values()].map((e) => e.el);
    for (const person of people) {
      const cell = personCells.get(person.userId);
      if (cell !== undefined) tiles.push(cell);
    }
    return tiles;
  }

  /** Re-seat the tiles after a change: people follow the streams. */
  function relayout(): void {
    syncPeople();
    // A focused tile the view toggles hide drops focus: back to the grid.
    const wasFocused = focusedTileId !== null;
    applyViewFilters();
    applySpeaking();
    applyUserAudioState();
    if (root === null) return;
    if (wasFocused) {
      rebuildFocusLayout();
      return;
    }
    for (const el of allTiles()) {
      if (el.classList.contains("video-cell--avatar") || el.parentElement !== root) {
        beforeChrome(el);
      }
    }
    applyGridSizes();
  }

  /** Attach ended/mute/unmute listeners on the first video track to handle stale tiles. */
  /** On the tile and on its video, so a video in its pop-out window hides
   *  its stalled frame too. */
  function setTrackMuted(entry: CellEntry, muted: boolean): void {
    entry.el.classList.toggle("track-muted", muted);
    entry.video.classList.toggle("track-muted", muted);
  }

  function attachTrackLifecycle(userId: number, stream: MediaStream): void {
    // Clean up previous listeners for this tile
    const prev = cells.get(userId);
    if (prev?.trackCleanup) {
      prev.trackCleanup();
      prev.trackCleanup = undefined;
    }

    const track = stream.getVideoTracks()[0];
    // A replacement can already be live without ever emitting `unmute`.
    // Reset the old track's CSS state and seed it from this track instead.
    if (prev !== undefined) setTrackMuted(prev, track?.muted === true);
    if (track === undefined) return;

    const onTrackEnded = (): void => {
      removeStream(userId);
    };
    const onTrackMute = (): void => {
      // Temporarily hide video — track may unmute after network recovery
      const cell = cells.get(userId);
      if (cell !== undefined) setTrackMuted(cell, true);
    };
    const onTrackUnmute = (): void => {
      const cell = cells.get(userId);
      if (cell !== undefined) setTrackMuted(cell, false);
    };
    track.addEventListener("ended", onTrackEnded);
    track.addEventListener("mute", onTrackMute);
    track.addEventListener("unmute", onTrackUnmute);

    const entry = cells.get(userId);
    if (entry !== undefined) {
      entry.trackCleanup = () => {
        track.removeEventListener("ended", onTrackEnded);
        track.removeEventListener("mute", onTrackMute);
        track.removeEventListener("unmute", onTrackUnmute);
      };
    }
  }

  /** Schedule a layout recalculation on the next animation frame. */
  function scheduleResize(): void {
    // The grid's own window: the app window can be minimised under a pop-out.
    const view = doc().defaultView ?? window;
    if (resizeRafId !== 0) rafWindow.cancelAnimationFrame(resizeRafId);
    rafWindow = view;
    resizeRafId = view.requestAnimationFrame(() => {
      resizeRafId = 0;
      applyGridSizes();
    });
  }

  /** The tile control the user is currently focused on, if any. `rebuildFocusLayout`
   *  detaches and re-appends every cell (and `removeStream` drops one), which
   *  blurs a focused overlay control to `<body>` — so both capture this first
   *  and restore it after, keeping focus predictable as tiles move or leave
   *  (Q1 focus stability). Keyed on the tile's `data-user-id` and the control's
   *  `data-tile-control` role, not node identity. */
  function captureFocusedControl(): { userId: number; control: string } | null {
    if (root === null) return null;
    const active = doc().activeElement;
    if (active === null || !root.contains(active)) return null;
    const cell = active.closest(".video-cell");
    const control = (active as HTMLElement).dataset["tileControl"];
    if (cell === null || control === undefined) return null;
    const userId = Number(cell.getAttribute("data-user-id"));
    if (Number.isNaN(userId)) return null;
    return { userId, control };
  }

  /** Put focus back on a captured tile control; when the layout hid it, on
   *  the same tile's way in or out (Back to grid on the focused tile, its
   *  select button elsewhere); when that tile is gone (its peer left), on
   *  the grid itself — so focus never drops to `<body>` or a hidden control
   *  and never lands on another peer's identically named control. */
  function restoreFocusedControl(saved: { userId: number; control: string } | null): void {
    if (saved === null || root === null) return;
    const cell = root.querySelector(`.video-cell[data-user-id='${saved.userId}']`);
    const way = saved.userId === focusedTileId ? "grid" : "select";
    const target = [saved.control, way]
      .map((control) => cell?.querySelector<HTMLElement>(`[data-tile-control='${control}']`))
      .find((el) => el != null && isShown(el));
    (target ?? root).focus();
  }

  /** The focused tile needs no "watch" button, and only it offers Back to
   *  grid. */
  function syncTileNav(): void {
    for (const [id, entry] of cells) {
      const isMain = id === focusedTileId;
      const select = entry.el.querySelector<HTMLElement>(".video-cell-select");
      if (select !== null) select.hidden = isMain;
      const back = entry.el.querySelector<HTMLElement>("[data-tile-control='grid']");
      if (back !== null) back.hidden = !isMain;
    }
  }

  function rebuildFocusLayout(): void {
    if (root === null) return;
    const savedFocus = captureFocusedControl();
    syncTileNav();

    if (focusedTileId === null || cells.size === 0) {
      // No focus — use regular flex-wrap layout. The grid's own controls stay
      // put, so a control the user is on keeps focus.
      for (const child of Array.from(root.childNodes)) if (!isChrome(child)) child.remove();
      root.classList.remove("focus-mode");
      for (const el of allTiles()) {
        el.classList.remove("focused", "thumb");
        beforeChrome(el);
      }
      appendChrome();
      applyGridSizes();
      restoreFocusedControl(savedFocus);
      return;
    }

    root.classList.add("focus-mode");

    // Clear inline sizes on cells (focus mode uses CSS flex sizing)
    for (const el of allTiles()) {
      el.style.width = "";
      el.style.height = "";
    }

    // Main area
    const mainArea =
      root.querySelector<HTMLDivElement>(":scope > .video-focus-main") ??
      createElement("div", { class: "video-focus-main" });
    for (const child of Array.from(root.childNodes)) {
      if (child !== mainArea && !isChrome(child)) child.remove();
    }
    // Strip area
    const stripArea = createElement("div", { class: "video-focus-strip" });

    const focusedEntry = cells.get(focusedTileId);
    if (focusedEntry === undefined) {
      mainArea.replaceChildren();
    } else {
      focusedEntry.el.classList.add("focused");
      focusedEntry.el.classList.remove("thumb");
      if (focusedEntry.el.parentNode !== mainArea) mainArea.replaceChildren(focusedEntry.el);
    }

    for (const [id, entry] of cells) {
      if (id === focusedTileId) continue;
      entry.el.classList.remove("focused");
      entry.el.classList.add("thumb");
      stripArea.appendChild(entry.el);
    }
    for (const el of allTiles()) {
      if (!el.classList.contains("video-cell--avatar")) continue;
      el.classList.add("thumb");
      stripArea.appendChild(el);
    }

    if (mainArea.parentNode !== root) beforeChrome(mainArea);
    // Only show strip if there are thumbnails. The call view's toggle hides
    // it rather than detaching it: a detached video pauses.
    const shownThumbs = [...stripArea.children].some((el) => !(el as HTMLElement).hidden);
    if (shownThumbs) {
      stripArea.hidden = callView && !viewOn.strip;
      beforeChrome(stripArea);
    }
    // Keep the exit control in the DOM (it was stripped with the other
    // children above) and on top, so focus mode is never a dead end.
    appendChrome();

    restoreFocusedControl(savedFocus);
  }

  /** The grid's own controls, after the tiles: the exit control, the view
   *  toggles and the call view's control bar. */
  function appendChrome(): void {
    if (root === null) return;
    // In the call view the exit control rides in the view bar.
    for (const el of [viewBar === null ? exitBtn : null, viewBar, callBar]) {
      if (el !== null && el.parentNode !== root) root.appendChild(el);
    }
    syncViewBar();
  }

  function isChrome(node: Node): boolean {
    return node === exitBtn || node === viewBar || node === callBar;
  }

  /** Seat a tile (or layout area) after the tiles and before the grid's own
   *  controls, which stay last in tab order. */
  function beforeChrome(el: HTMLElement): void {
    if (root === null) return;
    // The trailing run of controls (mount puts the exit control first).
    let anchor: Element | null = null;
    for (let c = root.lastElementChild; c !== null && isChrome(c); c = c.previousElementSibling) {
      anchor = c;
    }
    root.insertBefore(el, anchor);
  }

  function setFocusedTile(tileId: number | null): void {
    const watching = fullscreenTile ?? theatreTile;
    if (watching !== null && watching !== tileId) leaveFullscreen();
    focusedTileId = tileId;
    rebuildFocusLayout();
    syncStatsPolling();
    syncViews();
  }

  // --- Full screen -----------------------------------------------------------

  function isFullscreen(tileId: number): boolean {
    return fullscreenTile === tileId || theatreTile === tileId;
  }

  function toggleFullscreen(tileId: number): void {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    if (isFullscreen(tileId)) {
      leaveFullscreen();
      return;
    }
    if (focusedTileId !== tileId) setFocusedTile(tileId);
    // A popped-out stream comes back for full screen in the app window (its
    // own window has a full-screen control of its own).
    entry.popout?.close();
    const request = entry.el.requestFullscreen as (() => Promise<void>) | undefined;
    if (typeof request !== "function") {
      enterTheatre(tileId);
      return;
    }
    // The fullscreenchange listener draws the result; a refusal falls back
    // to a window-filling view.
    request.call(entry.el).catch(() => enterTheatre(tileId));
  }

  function leaveFullscreen(): void {
    if (theatreTile !== null) {
      leaveTheatre();
      return;
    }
    const d = doc();
    if (d.fullscreenElement !== null && d.fullscreenElement !== undefined) {
      void d.exitFullscreen().catch((err: unknown) => {
        log.debug("Exit full screen failed", { err });
      });
    }
  }

  function enterTheatre(tileId: number): void {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    theatreTile = tileId;
    entry.el.classList.add("video-cell--theatre");
    syncFullscreenUi();
    windowFullscreen(true);
  }

  function leaveTheatre(): void {
    const entry = theatreTile === null ? undefined : cells.get(theatreTile);
    entry?.el.classList.remove("video-cell--theatre");
    theatreTile = null;
    syncFullscreenUi();
    windowFullscreen(false);
  }

  /** Escape or F leaves the theatre fallback wherever focus is: a click on the
   *  video moves it to the grid, outside the tile (HTML full screen handles
   *  its own Escape). A tile's F handler has already acted when it prevented
   *  the default. */
  function onTheatreKey(e: KeyboardEvent): void {
    if (theatreTile === null || e.defaultPrevented) return;
    if (e.key === "Escape" && isImeCommit(e)) return;
    if (e.key !== "Escape" && !isFullscreenKey(e)) return;
    e.preventDefault();
    leaveTheatre();
  }

  function onFullscreenChange(): void {
    const el = doc().fullscreenElement ?? null;
    let next: number | null = null;
    for (const [id, entry] of cells) if (entry.el === el) next = id;
    const was = fullscreenTile;
    fullscreenTile = next;
    if (was === next) return;
    syncFullscreenUi();
    windowFullscreen(next !== null);
  }

  /** Label the full-screen buttons and give a full-screen tile the call
   *  controls, so you can mute or leave without leaving full screen. */
  function syncFullscreenUi(): void {
    for (const [id, entry] of cells) {
      const on = isFullscreen(id);
      const btn = entry.el.querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']");
      if (btn !== null) {
        const text = on ? voiceText("tile.exitFullscreen") : voiceText("tile.fullscreen");
        btn.setAttribute("aria-label", text);
        btn.title = text;
        btn.querySelector("svg")?.remove();
        btn.appendChild(createIcon(on ? "minimize" : "maximize", 18));
      }
      const calls = entry.el.querySelector(".video-fs-calls");
      if (on && calls === null && callbacks.callControls !== undefined) {
        entry.el.appendChild(buildCallControls(callbacks.callControls));
      } else if (!on) {
        calls?.remove();
      }
    }
    syncStatsPolling();
    syncViews();
  }

  function buildCallControls(cc: NonNullable<VideoGridCallbacks["callControls"]>): HTMLElement {
    const bar = createElement("div", {
      class: "video-fs-calls",
      role: "toolbar",
      "aria-label": voiceText("tile.callControls"),
    });
    appendChildren(
      bar,
      callButton(voiceText("widget.control.mute"), "mic", "mute", cc.onMuteToggle),
      callButton(voiceText("widget.control.deafen"), "headphones", "deafen", cc.onDeafenToggle),
    );
    if (cc.onCameraToggle !== undefined) {
      const onCamera = cc.onCameraToggle;
      bar.appendChild(
        callButton(voiceText("widget.control.cameraOn"), "camera", "camera", onCamera),
      );
      const onDevice = cc.onCameraDevice;
      if (onDevice !== undefined) {
        const pick: HTMLButtonElement = callButton(
          voiceText("call.chooseCamera"),
          "chevron-up",
          "camera-device",
          () => onDevice(pick, gridListeners.signal),
          " video-fs-btn--device",
        );
        pick.setAttribute("aria-haspopup", "menu");
        bar.appendChild(pick);
      }
    }
    if (__OWNCORD_WEB__ && typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      // No getDisplayMedia (phones): the call bar offers no screen share.
    } else if (cc.onScreenshareToggle !== undefined) {
      const toggle = cc.onScreenshareToggle;
      // Starting a share opens its picker in the app window: the call comes
      // back there first, so the picker is in view.
      const onShare = (): void => {
        if (callPop !== null && callState.screenshare !== true) closeCallPopout(true);
        toggle();
      };
      bar.appendChild(
        callButton(voiceText("widget.control.shareStart"), "monitor", "share", onShare),
      );
    }
    appendChildren(
      bar,
      callButton(
        voiceText("tile.leaveCall"),
        "phone-off",
        "leave",
        cc.onLeave,
        " video-fs-btn--leave",
      ),
    );
    drawCallState(bar);
    return bar;
  }

  function drawCallState(bar: Element): void {
    const mute = bar.querySelector<HTMLButtonElement>("[data-call-control='mute']");
    const deafen = bar.querySelector<HTMLButtonElement>("[data-call-control='deafen']");
    if (mute !== null) {
      mute.setAttribute("aria-pressed", String(callState.muted));
      mute.querySelector("svg")?.remove();
      mute.appendChild(createIcon(callState.muted || callState.listenOnly ? "mic-off" : "mic", 18));
      mute.disabled = callState.listenOnly || callState.serverMuted === true;
      mute.title = voiceText(
        callState.serverMuted === true
          ? "widget.mutedByModerator"
          : callState.listenOnly
            ? "widget.control.listenOnly"
            : "widget.control.mute",
      );
    }
    if (deafen !== null) {
      deafen.setAttribute("aria-pressed", String(callState.deafened));
      deafen.querySelector("svg")?.remove();
      deafen.appendChild(createIcon(callState.deafened ? "headphones-off" : "headphones", 18));
      deafen.disabled = callState.serverDeafened === true;
      deafen.title = voiceText(
        callState.serverDeafened === true ? "widget.deafenedByModerator" : "widget.control.deafen",
      );
    }
    const camera = bar.querySelector<HTMLButtonElement>("[data-call-control='camera']");
    if (camera !== null) {
      const on = callState.camera === true;
      drawMediaButton(camera, on, on ? "camera-off" : "camera");
      const label = voiceText(on ? "widget.control.cameraOff" : "widget.control.cameraOn");
      camera.setAttribute("aria-label", label);
      camera.title = mediaLockReason() ?? label;
    }
    const pick = bar.querySelector<HTMLButtonElement>("[data-call-control='camera-device']");
    if (pick !== null) {
      pick.disabled = mediaLockReason() !== null;
      // Its menu opens in the app window.
      pick.style.display = callPop === null ? "" : "none";
    }
    const share = bar.querySelector<HTMLButtonElement>("[data-call-control='share']");
    if (share !== null) {
      const on = callState.screenshare === true;
      drawMediaButton(share, on, on ? "monitor-off" : "monitor");
      const label = voiceText(on ? "widget.control.shareStop" : "widget.control.shareStart");
      share.setAttribute("aria-label", label);
      share.title = mediaLockReason() ?? callState.shareBlock ?? label;
      if (callState.shareBlock !== undefined) share.disabled = true;
    }
  }

  /** Why camera and share are inert now, or null: the chat socket is down,
   *  or the join has not reached the room yet. */
  function mediaLockReason(): string | null {
    if (callState.offline === "reconnecting") return voiceText("status.reconnectingShort");
    if (callState.offline === "disconnected") return voiceText("status.notConnected");
    if (callState.connecting === true) return voiceText("status.joining");
    return null;
  }

  /** Camera or share: pressed while on, inert while locked. */
  function drawMediaButton(btn: HTMLButtonElement, on: boolean, icon: IconName): void {
    btn.setAttribute("aria-pressed", String(on));
    btn.querySelector("svg")?.remove();
    btn.appendChild(createIcon(icon, 18));
    btn.disabled = mediaLockReason() !== null;
  }

  // --- Call view: view toggles and control bar --------------------------------

  const VIEW_TOGGLES: readonly [ViewToggle, string, IconName][] = [
    ["nonVideo", voiceText("grid.showNonVideo"), "user"],
    ["selfCamera", voiceText("grid.showMyCamera"), "camera"],
    ["strip", voiceText("grid.showStrip"), "layout-grid"],
  ];

  function buildViewBar(): HTMLElement {
    const bar = createElement("div", {
      class: "video-grid__views",
      role: "toolbar",
      "aria-label": voiceText("grid.viewOptions"),
    });
    for (const [key, label, icon] of VIEW_TOGGLES) {
      const btn = createElement("button", {
        type: "button",
        class: "video-grid__view",
        "aria-label": label,
        title: label,
        "data-view-toggle": key,
      });
      btn.appendChild(createIcon(icon, 18));
      btn.addEventListener("click", () => setView(key, !viewOn[key]));
      bar.appendChild(btn);
    }
    popBtn = createElement("button", {
      type: "button",
      class: "video-grid__view",
      "data-grid-control": "popout",
    });
    popBtn.appendChild(createIcon("external-link", 18));
    popBtn.addEventListener("click", () => {
      if (callPop === null) popOutCall();
      else closeCallPopout(true);
    });
    bar.appendChild(popBtn);
    if (exitBtn !== null) bar.appendChild(exitBtn);
    syncPopButton();
    return bar;
  }

  // --- Pop out the whole call ----------------------------------------------------

  function syncPopButton(): void {
    if (exitBtn !== null) exitBtn.hidden = !callView || callPop !== null;
    for (const bar of root?.querySelectorAll(".video-fs-calls") ?? []) drawCallState(bar);
    if (popBtn === null) return;
    const label = voiceText(callPop === null ? "grid.popOutCall" : "grid.popInCall");
    popBtn.setAttribute("aria-label", label);
    popBtn.title = label;
    popBtn.setAttribute("aria-pressed", String(callPop !== null));
  }

  /** Watch the grid's sizes with its own window's observer: the pop-out's
   *  layout runs there. */
  function observeGrid(): void {
    resizeObserver?.disconnect();
    if (root === null) return;
    const Observer = doc().defaultView?.ResizeObserver ?? ResizeObserver;
    resizeObserver = new Observer(() => {
      scheduleResize();
      scheduleViewSync();
    });
    resizeObserver.observe(root);
    for (const entry of cells.values()) {
      if (entry.config !== undefined && !entry.config.isSelf) resizeObserver.observe(entry.el);
    }
  }

  /** The full-screen state of the window the grid is in. */
  function windowFullscreen(on: boolean): void {
    const args: [boolean, string?] = callPop === null ? [on] : [on, callPop.label];
    void callbacks.setWindowFullscreen?.(...args).catch(() => {});
  }

  /** Full screen ends where the grid leaves its window. */
  function dropFullscreen(): void {
    if (theatreTile !== null) leaveTheatre();
    if (fullscreenTile === null) return;
    leaveFullscreen();
    fullscreenTile = null;
    syncFullscreenUi();
    windowFullscreen(false);
  }

  /** Move the grid, with its toggles and control bar, into a window of its
   *  own; the app window goes back to the chat. */
  function popOutCall(): void {
    const grid = root;
    if (grid === null || callPop !== null) return;
    dropFullscreen();
    callHome = grid.parentElement;
    const frame = createElement("div", { style: "position:fixed;inset:0" });
    callPop = openPopoutWindow({
      title: voiceText("grid.popoutTitle"),
      content: frame,
      onDraw: (d, signal) => {
        frame.appendChild(grid);
        d.addEventListener("fullscreenchange", onFullscreenChange, { signal });
        d.addEventListener("keydown", onTheatreKey, { signal });
        d.addEventListener("visibilitychange", syncViews, { signal });
        observeGrid();
        for (const entry of cells.values()) entry.video.play()?.catch(() => {});
      },
      onClosed: (byUser) => bringCallBack(byUser),
    });
    if (callPop === null) {
      log.warn("Call pop out window refused");
      showToast(voiceText("tile.popoutFailed"), "error");
      return;
    }
    syncPopButton();
    callbacks.onCallPopout?.(true, false);
    relayout();
    syncViews();
  }

  function closeCallPopout(restore: boolean): void {
    if (callPop === null) return;
    popRestore = restore;
    callPop.close();
  }

  /** The call's window closed: the grid goes back to the app window. */
  function bringCallBack(byUser: boolean): void {
    const restore = byUser || popRestore;
    popRestore = true;
    dropFullscreen();
    callPop = null;
    if (root !== null) callHome?.appendChild(root);
    callHome = null;
    observeGrid();
    syncPopButton();
    callbacks.onCallPopout?.(false, restore);
    for (const entry of cells.values()) entry.video.play()?.catch(() => {});
    if (restore) popBtn?.focus();
    relayout();
    syncViews();
  }

  /** Turn a view toggle on or off, and remember it. */
  function setView(key: ViewToggle, on: boolean): void {
    viewOn[key] = on;
    savePref(VIEW_PREFS[key], on);
    relayout();
    syncViewBar();
    syncStatsPolling();
    syncViews();
  }

  /** Each toggle's pressed state; the strip toggle only in focus mode. */
  function syncViewBar(): void {
    if (viewBar === null) return;
    for (const btn of viewBar.querySelectorAll<HTMLButtonElement>("[data-view-toggle]")) {
      const key = btn.dataset["viewToggle"] as ViewToggle;
      btn.setAttribute("aria-pressed", String(viewOn[key]));
      if (key === "strip") btn.hidden = focusedTileId === null;
    }
  }

  function loadViewPrefs(): void {
    for (const key of Object.keys(VIEW_PREFS) as ViewToggle[]) {
      viewOn[key] = loadPref(VIEW_PREFS[key], true);
    }
  }

  /** Show or take down the call view's header toggles and control bar. */
  function setCallView(on: boolean): void {
    if (!on) closeCallPopout(false);
    callView = on;
    if (exitBtn !== null) exitBtn.hidden = !on || callPop !== null;
    if (root === null) return;
    if (on && viewBar === null) viewBar = buildViewBar();
    if (!on && viewBar !== null) {
      if (exitBtn !== null) root.insertBefore(exitBtn, root.firstChild);
      viewBar.remove();
      viewBar = null;
      popBtn = null;
    }
    const cc = callbacks.callControls;
    if (on && callBar === null && cc !== undefined) {
      callBar = buildCallControls(cc);
      callBar.classList.add("video-grid__controls");
    }
    if (!on && callBar !== null) {
      callBar.remove();
      callBar = null;
    }
    root.classList.toggle("video-grid--call", callBar !== null);
    appendChrome();
    relayout();
  }

  // --- Stream info -------------------------------------------------------------

  /** Poll the screen share you are watching (focused or full screen), and
   *  only it: a camera tile has no quality chip. */
  function syncStatsPolling(): void {
    const target = fullscreenTile ?? theatreTile ?? focusedTileId;
    const entry = target === null ? undefined : cells.get(target);
    const wanted =
      entry?.config?.isScreenshare === true && !entry.config.isSelf && entry.ending === undefined
        ? target
        : null;
    if (wanted === statsTile) return;
    if (statsTimer !== null) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    statsTile = wanted;
    if (wanted === null) return;
    const poll = (): void => void pollStats(wanted);
    poll();
    statsTimer = setInterval(poll, STATS_POLL_MS);
  }

  async function pollStats(tileId: number): Promise<void> {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    let sample: StreamSample | null = null;
    try {
      sample = (await callbacks.getStreamStats?.(tileId)) ?? null;
    } catch (err) {
      log.debug("Stream stats unavailable", { tileId, err });
    }
    // Loaded on first use: only a watched stream needs the readout.
    infoModule ??= await import("./video-grid/streamInfo");
    const { chipText, renderStats, streamInfo } = infoModule;
    if (statsTile !== tileId || cells.get(tileId) !== entry) return;
    const info = sample !== null ? streamInfo(sample, entry.prevSample) : sizeOf(entry.video);
    if (sample !== null) entry.prevSample = sample;
    const chip = entry.el.querySelector<HTMLButtonElement>(".video-quality");
    const text = chipText(info);
    if (chip !== null) {
      chip.hidden = text === null;
      if (text !== null) {
        chip.textContent = text.text;
        chip.setAttribute("aria-label", text.label);
      }
    }
    const pop = entry.el.querySelector<HTMLElement>(".video-stats");
    if (pop !== null) renderStats(pop, entry.name, info);
    lastInfo.set(tileId, info);
  }

  const lastInfo = new Map<number, StreamInfo>();
  /** The readout module, once a poll has loaded it (the chip shows only
   *  after one has). */
  let infoModule: typeof import("./video-grid/streamInfo") | null = null;

  function toggleStats(tileId: number, chip: HTMLButtonElement): void {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    const open = entry.el.querySelector<HTMLElement>(".video-stats");
    if (open !== null) {
      open.remove();
      chip.setAttribute("aria-expanded", "false");
      return;
    }
    const pop = createElement("div", {
      class: "video-stats",
      role: "dialog",
      "aria-label": voiceText("tile.stats"),
      tabindex: "-1",
    });
    infoModule?.renderStats(pop, entry.name, lastInfo.get(tileId) ?? {});
    pop.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || isImeCommit(e)) return;
        e.stopPropagation();
        pop.remove();
        chip.setAttribute("aria-expanded", "false");
        chip.focus();
      },
      { signal: entry.listeners.signal },
    );
    entry.el.appendChild(pop);
    chip.setAttribute("aria-expanded", "true");
    pop.focus();
  }

  // --- Video layers -------------------------------------------------------

  /** Nothing while no one can see the tile (grid closed, app hidden or
   *  minimised, stopped); the top layer for the stream you are watching
   *  (focused, full screen or popped out); otherwise its rendered size. */
  function viewOf(id: number, entry: CellEntry): VideoView {
    if (entry.popout !== undefined) {
      return { enabled: true };
    }
    if (entry.mini !== undefined) {
      if (document.hidden) return { enabled: false };
      const box = entry.mini.element.getBoundingClientRect();
      return {
        enabled: true,
        size: {
          width: Math.round(box.width * devicePixelRatio),
          height: Math.round(box.height * devicePixelRatio),
        },
      };
    }
    const { width, height } = entry.el.getBoundingClientRect();
    if (doc().hidden || width === 0 || entry.el.classList.contains("video-cell--stopped")) {
      return { enabled: false };
    }
    if (id === focusedTileId || isFullscreen(id)) return { enabled: true };
    return {
      enabled: true,
      size: {
        width: Math.round(width * devicePixelRatio),
        height: Math.round(height * devicePixelRatio),
      },
    };
  }

  /** Report each remote tile's view when it changes. adaptiveStream is off
   *  (it froze tiles), so this is what keeps hidden and small tiles
   *  from pulling the top layer. */
  function syncViews(): void {
    for (const [id, entry] of cells) {
      if (entry.config === undefined || entry.config.isSelf) continue;
      const view = viewOf(id, entry);
      const key = JSON.stringify(view);
      if (key === entry.view) continue;
      entry.view = key;
      callbacks.setStreamView?.(id, view);
    }
  }

  /** Resizes come every frame while the window drags: send the views once
   *  the sizes settle. */
  function scheduleViewSync(): void {
    if (viewResizeTimer !== null) clearTimeout(viewResizeTimer);
    viewResizeTimer = setTimeout(() => {
      viewResizeTimer = null;
      syncViews();
    }, VIEW_RESIZE_MS);
  }

  // --- Pop out ---------------------------------------------------------------

  /** Move the tile's video into a window of its own, or bring it back. Where
   *  no window opens, the video stays in the grid. */
  function togglePopout(tileId: number): void {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    if (entry.popout !== undefined) {
      entry.popout.close();
      return;
    }
    if (isFullscreen(tileId)) leaveFullscreen();
    entry.mini?.close();
    entry.zoom?.reset();
    // Popping out a stopped tile means watching it: its video is hidden.
    if (entry.el.classList.contains("video-cell--stopped")) setWatching(tileId, true);
    const username = entry.el.querySelector(".video-username")?.textContent ?? entry.name;
    const popout = openPopout({
      title: voiceText("tile.popoutTitle", { name: username }),
      video: entry.video,
      // The stream's volume and mute, where it is being watched.
      controls: entry.volumeOverlay,
      onClosed: (byUser) => bringBack(entry, byUser),
      setWindowFullscreen: (on, label) =>
        callbacks.setWindowFullscreen?.(on, label) ?? Promise.resolve(),
    });
    if (popout === null) {
      log.warn("Pop out window refused", { tileId });
      showToast(voiceText("tile.popoutFailed"), "error");
      return;
    }
    entry.popout = popout;
    const cover = createElement("div", { class: "video-popped" });
    const back = createElement(
      "button",
      { type: "button", class: "video-watch-btn", "data-tile-control": "pop-in" },
      voiceText("tile.popIn"),
    );
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      entry.popout?.close();
    });
    appendChildren(cover, createElement("div", {}, voiceText("tile.poppedOut")), back);
    // The cover hides the tile's own controls: out of the tab order and
    // inactive until the stream comes back, Bring back the one way in.
    for (const child of entry.el.children) child.toggleAttribute("inert", true);
    entry.el.appendChild(cover);
    entry.el.querySelector("[data-tile-control='pip']")?.setAttribute("aria-pressed", "true");
    syncViews();
  }

  /** The pop-out window closed: the video goes back into its tile. */
  function bringBack(entry: CellEntry, byUser: boolean): void {
    entry.popout = undefined;
    const cover = entry.el.querySelector(".video-popped");
    // Keep a keyboard user on the tile: Bring back goes with its cover, and a
    // window the user closed leaves focus nowhere (Pop out was inert).
    const d = doc();
    const active = d.activeElement;
    const lost = active === null || active === d.body;
    const hadFocus = cover?.contains(active) === true || (byUser && lost);
    cover?.remove();
    for (const child of entry.el.children) child.removeAttribute("inert");
    const pip = entry.el.querySelector<HTMLElement>("[data-tile-control='pip']");
    pip?.setAttribute("aria-pressed", "false");
    if (hadFocus) pip?.focus();
    entry.el.insertBefore(entry.video, entry.el.firstChild);
    // WebKitGTK drops a <video>'s player with the window it played in: back
    // here it would stay empty without its stream given again.
    if (entry.video.readyState === HTMLMediaElement.HAVE_NOTHING) {
      const stream = entry.video.srcObject;
      entry.video.srcObject = null;
      entry.video.srcObject = stream;
    }
    syncVideoSurface(entry.video);
    if (entry.volumeOverlay !== undefined) entry.el.appendChild(entry.volumeOverlay);
    entry.video.play()?.catch(() => {});
    syncViews();
  }

  // --- Mini-player -----------------------------------------------------------

  /** The remote stream being watched in the grid: the focused tile, else the
   *  first playing one. Not one in a pop-out window (it plays there). */
  function watchedTile(): number | null {
    if (focusedTileId !== null && isPlayingHere(cells.get(focusedTileId))) return focusedTileId;
    for (const [id, e] of cells) if (isPlayingHere(e)) return id;
    return null;
  }

  /** Bumped by every show and hide, so a mini-player still loading opens
   *  only if nothing has changed the request since. */
  let miniRequest = 0;

  function showMiniPlayer(): void {
    if ([...cells.values()].some((e) => e.mini !== undefined)) return;
    // Picked now: the grid drops its focus as it closes.
    const tileId = watchedTile();
    if (tileId === null) return;
    const request = ++miniRequest;
    if (isFullscreen(tileId)) leaveFullscreen();
    // Loaded on first use: only leaving a watched stream needs it.
    void import("../features/voice/miniPlayer").then(({ openMiniPlayer }) => {
      const entry = cells.get(tileId);
      if (request !== miniRequest || root === null || entry === undefined) return;
      if (entry.mini !== undefined || !isPlayingHere(entry)) return;
      entry.mini = openMiniPlayer({
        name: entry.name,
        video: entry.video,
        onReturn: () => {
          callbacks.onReturnToStream?.(tileId);
          if (root !== null && !root.contains(document.activeElement)) {
            restoreFocusedControl({ userId: tileId, control: "grid" });
          }
        },
        onPopout: () => togglePopout(tileId),
        onStopWatching: () => {
          callbacks.setStreamWatched?.(tileId, false);
          // The grid is closed: no focus to move into it.
          setStopped(tileId, true, false);
        },
        onClosed: (hadFocus) => {
          entry.mini = undefined;
          if (hadFocus) callbacks.focusFallback?.();
          entry.el.insertBefore(entry.video, entry.el.firstChild);
          syncVideoSurface(entry.video);
          entry.video.play()?.catch(() => {});
          syncViews();
        },
      });
      syncViews();
    });
  }

  function hideMiniPlayer(): void {
    miniRequest++;
    for (const entry of cells.values()) entry.mini?.close();
  }

  function getFocusedTileIdFn(): number | null {
    return focusedTileId;
  }

  /** A stream ended or its pending watch was dropped: not Stop watching. */
  function forgetWatch(tileId: number): void {
    if (callbacks.forgetStreamWatch !== undefined) callbacks.forgetStreamWatch(tileId);
    else callbacks.setStreamWatched?.(tileId, false);
  }

  /** Watch a remote stream or stop (opt-in watching): it is subscribed only
   *  while watched. */
  function setWatching(tileId: number, on: boolean): void {
    callbacks.setStreamWatched?.(tileId, on);
    setStopped(tileId, !on);
  }

  /** Draw a tile stopped (behind Watch stream, or your own hidden preview)
   *  or playing. `moveFocus` false for a change the user did not make here. */
  function setStopped(tileId: number, stopped: boolean, moveFocus = true): void {
    const entry = cells.get(tileId);
    if (entry === undefined) return;
    const cell = entry.el;
    if (stopped) {
      entry.popout?.close();
      entry.mini?.close();
      entry.zoom?.reset();
    }
    if (!stopped) entry.lost = false;
    cell.classList.toggle("video-cell--stopped", stopped);
    applyStreamViewers();
    syncViews();
    entry.video.hidden = stopped;
    cell.querySelector(".video-stopped")?.remove();
    const self = entry.config?.isSelf === true;
    if (!stopped) {
      if (moveFocus) {
        restoreFocusedControl({ userId: tileId, control: self ? "hide-preview" : "stop" });
      }
      return;
    }
    const cover = createElement("div", { class: "video-stopped" });
    const again = createElement(
      "button",
      { type: "button", class: "video-watch-btn", "data-tile-control": "watch" },
      self ? voiceText("tile.showPreview") : voiceText("tile.watchStream"),
    );
    again.addEventListener("click", (e) => {
      e.stopPropagation();
      if (self) setStopped(tileId, false);
      else setWatching(tileId, true);
    });
    cover.appendChild(again);
    cell.appendChild(cover);
    if (moveFocus) again.focus();
  }

  function watch(tileId: number): void {
    const entry = cells.get(tileId);
    if (entry === undefined) {
      pendingWatch.add(tileId);
      callbacks.setStreamWatched?.(tileId, true);
      return;
    }
    if (entry.config?.isSelf === true) return;
    if (entry.el.classList.contains("video-cell--stopped")) setWatching(tileId, true);
  }

  function buildSelfCover(
    tileId: number,
    stream: MediaStream,
    hasAudio: boolean,
    signal: AbortSignal,
  ): HTMLDivElement {
    const track = stream.getVideoTracks()[0];
    const surface = track?.getSettings?.()?.displaySurface;
    const title =
      surface === "window"
        ? voiceText("tile.sharingWindow")
        : surface === "browser"
          ? voiceText("tile.sharingTab")
          : voiceText("tile.sharingScreen");
    const detail = createElement("div", { class: "video-self-detail" });
    // The rate actually sent, never the requested one: the capture can fall
    // short of it (a 60 Hz monitor, a busy encoder).
    const renderDetail = (fps: number | null): void => {
      const parts: string[] = [];
      // Read each time: the share's quality can change while it runs.
      const shown = track?.getSettings?.().height;
      if (shown !== undefined) {
        // Plain strings: the catalog would group 1080 as "1,080".
        const height = String(shown);
        parts.push(
          fps === null
            ? voiceText("tile.qualityHeight", { height })
            : voiceText("tile.shareQuality", { height, fps: String(Math.round(fps)) }),
        );
      }
      parts.push(hasAudio ? voiceText("tile.withAudio") : voiceText("tile.noAudio"));
      detail.textContent = parts.join(" · ");
    };
    renderDetail(null);
    // Why the share sends what it does: the capture rate, what limits
    // the encoder, and which encoder. Filled once the first poll is back.
    const senderLine = createElement("div", { class: "video-self-stats" });
    senderLine.hidden = true;
    const pollSender = async (): Promise<void> => {
      let sample: ShareSenderSample | null = null;
      try {
        sample = (await callbacks.getLocalShareStats?.()) ?? null;
        infoModule ??= await import("./video-grid/streamInfo");
      } catch (err) {
        log.debug("Local share stats unavailable", { tileId, err });
      }
      if (signal.aborted) return;
      renderDetail(sample?.sentFps ?? null);
      const text = infoModule?.senderText(sample) ?? "";
      senderLine.textContent = text;
      senderLine.title = infoModule?.layersText(sample) ?? "";
      senderLine.hidden = text === "";
      setOwnedTimeout(signal, () => void pollSender(), STATS_POLL_MS);
    };
    setOwnedTimeout(signal, () => void pollSender(), STATS_POLL_MS);

    const cover = createElement("div", { class: "video-self-cover" });
    const actions = createElement("div", { class: "video-self-actions" });
    const stop = createElement(
      "button",
      { type: "button", class: "btn-danger", "data-tile-control": "stop-sharing" },
      voiceText("tile.stopSharing"),
    );
    stop.addEventListener("click", (e) => {
      e.stopPropagation();
      callbacks.onStopSharing?.();
    });
    const hide = createElement(
      "button",
      { type: "button", class: "btn-ghost", "data-tile-control": "hide-preview" },
      voiceText("tile.hidePreview"),
    );
    hide.addEventListener("click", (e) => {
      e.stopPropagation();
      setStopped(tileId, true);
    });
    appendChildren(actions, stop, hide);
    appendChildren(
      cover,
      createElement("div", { class: "video-self-title" }, title),
      detail,
      senderLine,
      actions,
    );
    return cover;
  }

  function addStream(
    userId: number,
    username: string,
    stream: MediaStream | null,
    config?: TileConfig,
  ): void {
    if (root === null) return;

    // The same person shared again while their tile said it ended (a new
    // source, a quick re-share): a new tile, still watched and in focus.
    const held = cells.get(userId);
    if (held?.holding !== undefined && stream !== null) {
      // The republished share is back: it plays in the tile it left.
      clearTimeout(held.holding);
      held.holding = undefined;
    }
    const reshared = cells.get(userId)?.ending !== undefined;
    const refocus = reshared && focusedTileId === userId;
    if (reshared) dropTile(userId, true);
    // If a cell already exists for this user, update it in place
    const existing = cells.get(userId);
    if (existing !== undefined && stream === null) {
      // No longer received (not watched): back to Watch stream.
      existing.trackCleanup?.();
      existing.trackCleanup = undefined;
      existing.video.srcObject = null;
      syncVideoSurface(existing.video);
      setTrackMuted(existing, false);
      if (!existing.el.classList.contains("video-cell--stopped")) {
        existing.lost = existing.mini === undefined && existing.config?.isSelf !== true;
        // A codec switch unsubscribes before it unpublishes: a stream whose
        // owner still has it on waits for its republish, pop-out and mini open.
        const owner = existing.config;
        if (
          owner !== undefined &&
          !owner.isSelf &&
          existing.holding === undefined &&
          callbacks.isStreamLive?.(owner.audioUserId, owner.isScreenshare) === true
        ) {
          holdForRepublish(userId, existing, owner.audioUserId, owner.isScreenshare);
        } else {
          setStopped(userId, true, false);
        }
      }
      applyNames(existing, username, config?.name ?? username);
      return;
    }
    if (existing !== undefined && stream !== null) {
      existing.lost = false;
      // Received only while watched: a stream on a tile showing Watch plays.
      if (
        existing.config?.isSelf !== true &&
        existing.el.classList.contains("video-cell--stopped")
      ) {
        setStopped(userId, false, false);
      }
      const video = existing.video;
      // Only replace srcObject if the underlying tracks changed
      const oldTracks = (video.srcObject as MediaStream | null)?.getTracks() ?? [];
      const newTracks = stream.getTracks();
      const tracksMatch =
        video.srcObject != null &&
        oldTracks.length === newTracks.length &&
        oldTracks.every((t, i) => t.id === newTracks[i]?.id);
      if (!tracksMatch) {
        // A new picture starts unzoomed: the old view may frame nothing.
        existing.zoom?.reset();
        video.srcObject = stream;
        syncVideoSurface(video);
        video.play()?.catch((err) => {
          log.debug("Video autoplay rejected (track replacement)", { userId, err });
        });
        attachTrackLifecycle(userId, stream);
        // A new track can come with a new publication (a reconnect): tell it too.
        existing.view = undefined;
        syncViews();
      }
      applyNames(existing, username, config?.name ?? username);
      // Sync stream type attribute in case it changed
      existing.el.dataset.streamType = config?.isScreenshare ? "screenshare" : "camera";
      existing.el.classList.toggle("video-cell--self", isSelfCamera(config));
      return;
    }

    const video = createElement("video", {
      autoplay: "",
      playsinline: "",
    });
    video.muted = true;
    if (stream !== null) {
      video.srcObject = stream;
      video.play()?.catch((err) => {
        log.debug("Video autoplay rejected (new tile)", { userId, err });
      });
    }

    const streamType = config?.isScreenshare ? "screenshare" : "camera";
    const cell = createElement("div", {
      class: isSelfCamera(config) ? "video-cell video-cell--self" : "video-cell",
      "data-user-id": String(userId),
      "data-stream-type": streamType,
    });

    // The whole tile is one real button (click, Enter, Space) that opens it
    // in focus view; the tile's own controls sit above it, never inside it.
    const select = createElement("button", {
      type: "button",
      class: "video-cell-select",
      "data-tile-control": "select",
    });
    select.addEventListener("click", () => setFocusedTile(userId));

    const label = createElement("div", { class: "video-label" });
    label.appendChild(createElement("div", { class: "video-username" }));
    if (config?.isScreenshare === true) {
      label.appendChild(createElement("span", { class: "video-live" }, voiceText("tile.live")));
    }
    // Who is watching this screen share: an eye and the count, top-right,
    // hidden at zero (applyStreamViewers draws it).
    const viewers =
      config?.isScreenshare === true
        ? createElement("span", {
            class: "video-viewers",
            role: "img",
            "data-testid": "tile-viewers",
          })
        : null;
    if (viewers !== null) {
      viewers.hidden = true;
      viewers.appendChild(createIcon("eye", 14));
      viewers.appendChild(createElement("span", { class: "video-viewers__count" }));
    }
    if (config !== undefined && !config.isSelf && config.isScreenshare) {
      // Filled by the stats poll while you watch this screen share.
      const chip = createElement("button", {
        type: "button",
        class: "video-quality",
        "aria-expanded": "false",
        "data-tile-control": "stats",
      });
      chip.hidden = true;
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleStats(userId, chip);
      });
      label.appendChild(chip);
    }

    const nav = createElement("div", { class: "video-tile-nav" });
    const back = tileButton(voiceText("tile.backToGrid"), "layout-grid", "grid", () =>
      setFocusedTile(null),
    );
    back.hidden = true;
    // Pop out: the stream in a window of its own (togglePopout), and the
    // same control brings it back.
    const pip = tileButton(voiceText("tile.popOut"), "picture-in-picture-2", "pip", () =>
      togglePopout(userId),
    );
    pip.setAttribute("aria-pressed", "false");
    const fullscreen = tileButton(voiceText("tile.fullscreen"), "maximize", "fullscreen", () =>
      toggleFullscreen(userId),
    );
    appendChildren(nav, back, pip, fullscreen);

    appendChildren(cell, video, select, label, nav);
    syncVideoSurface(video);
    if (viewers !== null) cell.appendChild(viewers);
    // A click anywhere on a filmstrip thumb (not on one of its controls)
    // swaps it into focus, as the tile button does.
    cell.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, input") !== null) return;
      if (focusedTileId !== null && focusedTileId !== userId) setFocusedTile(userId);
    });

    const entry: CellEntry = { el: cell, video, config, listeners: new Disposable(), name: "" };
    // Your own screen share shows its cover, not the picture: nothing to zoom.
    if (config?.isSelf !== true || !config.isScreenshare) {
      entry.zoom = bindVideoZoom(cell, entry.listeners.signal);
    }
    // F toggles full screen from anywhere in the tile (not while typing), a
    // double-click too. The theatre fallback's own keys are on the document
    // (onTheatreKey).
    cell.addEventListener(
      "keydown",
      (e) => {
        if (isFullscreenKey(e)) {
          e.preventDefault();
          toggleFullscreen(userId);
        }
      },
      { signal: entry.listeners.signal },
    );
    cell.addEventListener(
      "dblclick",
      (e) => {
        const skip = "button:not(.video-cell-select), input, .context-menu";
        if ((e.target as Element).closest(skip) !== null) return;
        toggleFullscreen(userId);
      },
      { signal: entry.listeners.signal },
    );
    // Remote tiles: volume, Stop watching and the tile menu.
    if (config !== undefined && !config.isSelf) {
      const volume = buildVolumeControls(config);
      entry.applyVolume = volume.apply;
      entry.volumeOverlay = volume.overlay;
      cell.appendChild(volume.overlay);
      nav.insertBefore(
        tileButton(voiceText("tile.stopWatching"), "eye-off", "stop", () =>
          setWatching(userId, false),
        ),
        back,
      );
      resizeObserver?.observe(cell);
    }
    // Loaded on first use: the menu opens only on a right-click or Shift+F10,
    // so it stays out of the eager bundle. Your own screen share has none.
    if (config !== undefined && (!config.isSelf || !config.isScreenshare)) {
      const openMenu = (x: number, y: number): void =>
        void import("./video-grid/tileMenu").then((menus) => {
          if (entry.listeners.signal.aborted || root?.contains(cell) !== true) return;
          if (config.isSelf) menus.showSelfTileMenu(selfMenuOptions(x, y, userId, entry));
          else menus.showTileMenu(tileMenuOptions(x, y, userId, entry, config));
        });
      cell.addEventListener(
        "contextmenu",
        (e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        },
        { signal: entry.listeners.signal },
      );
      openMenuOnKeyboard(cell, openMenu, entry.listeners.signal);
    }

    // Your own screen share: say what is going out instead of showing a
    // hall of mirrors, with Stop sharing always at hand.
    if (config?.isSelf === true && config.isScreenshare && stream !== null) {
      cell.appendChild(
        buildSelfCover(userId, stream, config.hasAudio === true, entry.listeners.signal),
      );
    }
    applyNames(entry, username, config?.name ?? username);
    cells.set(userId, entry);
    pendingWatch.delete(userId);
    if (stream !== null) attachTrackLifecycle(userId, stream);
    else setStopped(userId, true, false);
    root.appendChild(cell);
    applySpeaking();
    applyUserAudioState();
    applyStreamViewers();
    syncTileNav();
    relayout();
    syncViews();
    if (refocus) setFocusedTile(userId);
  }

  /** A remote tile's menu, with the tile's view state as it is now. */
  function tileMenuOptions(
    x: number,
    y: number,
    tileId: number,
    entry: CellEntry,
    config: TileConfig,
  ) {
    const personId = config.audioUserId;
    const actions = callbacks.tileMenu;
    // Profile and Message leave the tile, which a full-screen tile would hide.
    const leaving = (run: () => void) => (): void => {
      if (isFullscreen(tileId)) leaveFullscreen();
      run();
    };
    // The profile card opens in the app window, out of sight of a pop-out.
    const onProfile = callPop === null ? actions?.onProfile : undefined;
    const onMessage = actions?.onMessage;
    const moderation = actions?.moderation?.(personId);
    return {
      x,
      y,
      name: entry.name,
      config,
      doc: doc(),
      signal: entry.listeners.signal,
      onVolumeChange: (isScreenshare: boolean, level: number, muted: boolean) =>
        applyVolume(personId, isScreenshare, level, muted),
      onStopWatching: () => setWatching(tileId, false),
      view: {
        focused: focusedTileId === tileId,
        fullscreen: isFullscreen(tileId),
        poppedOut: entry.popout !== undefined,
        onFocus: () => setFocusedTile(focusedTileId === tileId ? null : tileId),
        onFullscreen: () => toggleFullscreen(tileId),
        onPopout: () => togglePopout(tileId),
      },
      person: {
        ...(onProfile === undefined ? {} : { onProfile: leaving(() => onProfile(personId, x, y)) }),
        ...(onMessage === undefined ? {} : { onMessage: leaving(() => onMessage(personId)) }),
        ...(moderation === undefined ? {} : { moderation }),
      },
    };
  }

  /** Your own camera tile's menu: Hide my camera where the call view's toggle
   *  applies, Turn off camera where the host offers the camera control. */
  function selfMenuOptions(x: number, y: number, tileId: number, entry: CellEntry) {
    const onCamera = callbacks.callControls?.onCameraToggle;
    // A hidden full-screen tile would leave a blank screen; focus goes to
    // the toggle that brings the tile back.
    const hide = (): void => {
      if (isFullscreen(tileId)) leaveFullscreen();
      setView("selfCamera", false);
      viewBar?.querySelector<HTMLElement>("[data-view-toggle='selfCamera']")?.focus();
    };
    return {
      x,
      y,
      doc: doc(),
      signal: entry.listeners.signal,
      ...(callView ? { onHide: hide } : {}),
      ...(onCamera === undefined ? {} : { onCameraOff: onCamera, cameraLocked: mediaLockReason() }),
    };
  }

  /** The tile's label, and the person's name on its controls and menu. */
  function applyNames(entry: CellEntry, username: string, name: string): void {
    entry.name = name;
    const label = entry.el.querySelector(".video-username");
    if (label !== null) label.textContent = username;
    entry.el
      .querySelector(".video-cell-select")
      ?.setAttribute("aria-label", voiceText("tile.watch", { name: username }));
    entry.el
      .querySelector(".tile-volume-slider")
      ?.setAttribute(
        "aria-label",
        entry.config?.isScreenshare === true
          ? voiceText("tile.streamVolume", { name })
          : voiceText("tile.voiceVolume", { name }),
      );
  }

  /** A volume changed from a tile menu: draw it on every tile of that
   *  person showing the same setting (stream or voice). */
  function applyVolume(
    audioUserId: number,
    isScreenshare: boolean,
    volume: number,
    muted: boolean,
  ): void {
    for (const entry of cells.values()) {
      if (entry.config?.audioUserId !== audioUserId) continue;
      if (entry.config.isScreenshare !== isScreenshare) continue;
      entry.applyVolume?.(volume, muted);
    }
  }

  /** The sidebar menu (or another tile) changed a user's local Mute. */
  function onUserLocalMute(e: Event): void {
    const userId = (e as CustomEvent<{ userId: number }>).detail.userId;
    const volume = getUserVolume(userId);
    applyVolume(userId, false, volume, getUserLocalMute(userId) || volume === 0);
  }

  /** Update an already-open tile's label in place. No-op if the tile isn't
   *  open — used to keep a remote tile's name in sync with a mid-call
   *  rename without re-creating the tile (addStream is only called once per
   *  tile, from the LiveKit TrackSubscribed callback). */
  function setLabel(userId: number, username: string, name?: string): void {
    const entry = cells.get(userId);
    if (entry === undefined) return;
    applyNames(entry, username, name ?? username);
  }

  /** A watched remote screen share that ends says so for a few seconds
   *  before its tile goes, instead of vanishing. */
  function removeStream(userId: number): void {
    pendingWatch.delete(userId);
    const entry = cells.get(userId);
    if (entry === undefined || entry.ending !== undefined || entry.holding !== undefined) return;
    const watched = (isPlayingHere(entry) && entry.mini === undefined) || entry.lost === true;
    const owner = entry.config;
    if (
      watched &&
      owner !== undefined &&
      !owner.isSelf &&
      callbacks.isStreamLive?.(owner.audioUserId, owner.isScreenshare) === true
    ) {
      holdForRepublish(userId, entry, owner.audioUserId, owner.isScreenshare);
      return;
    }
    endStream(userId);
  }

  /** The stream went but its owner's voice state still says it is on: a
   *  codec switch republishes it. Show no cover and keep the watch until the
   *  owner's state says otherwise or the grace runs out. */
  function holdForRepublish(
    userId: number,
    entry: CellEntry,
    owner: number,
    screenshare: boolean,
  ): void {
    let waited = 0;
    const look = (): void => {
      entry.holding = undefined;
      if (cells.get(userId) !== entry) return;
      waited += REPUBLISH_HOLD_POLL_MS;
      if (waited < REPUBLISH_HOLD_MS && callbacks.isStreamLive?.(owner, screenshare) === true) {
        entry.holding = setTimeout(look, REPUBLISH_HOLD_POLL_MS);
        return;
      }
      endStream(userId);
    };
    entry.holding = setTimeout(look, REPUBLISH_HOLD_POLL_MS);
  }

  /** The cover and drop for a watched screen share that ended (or a plain
   *  drop for any other tile). */
  function endStream(userId: number): void {
    const entry = cells.get(userId);
    if (entry === undefined || entry.ending !== undefined) return;
    const watched = (isPlayingHere(entry) && entry.mini === undefined) || entry.lost === true;
    if (entry.config?.isScreenshare !== true || !watched) {
      dropTile(userId);
      return;
    }
    // The stream is gone; only the tile and its watch linger, so the same
    // person sharing again within the cover keeps being watched (dropTile
    // forgets the watch once it goes).
    entry.listeners.destroy();
    entry.trackCleanup?.();
    entry.trackCleanup = undefined;
    entry.video.srcObject = null;
    syncVideoSurface(entry.video);
    // Its controls are dead now: nothing under the cover can be reached.
    for (const child of entry.el.children) child.toggleAttribute("inert", true);
    const cover = createElement(
      "div",
      { class: "video-stopped video-ended", role: "status" },
      voiceText("tile.streamEnded", { name: entry.name }),
    );
    entry.el.appendChild(cover);
    entry.ending = setTimeout(() => {
      dropTile(userId);
      callbacks.onStreamRemoved?.();
    }, ENDED_COVER_MS);
    syncStatsPolling();
  }

  /** `keepWatch`: the same stream is coming back on a new tile. */
  function dropTile(userId: number, keepWatch = false): void {
    const entry = cells.get(userId);
    if (entry === undefined) return;
    clearTimeout(entry.ending);
    clearTimeout(entry.holding);

    // Capture the focused tile control before detaching, so a user tabbing
    // through the overlay keeps a focus target when this tile leaves (Q1).
    const savedFocus = captureFocusedControl();

    entry.popout?.close();
    entry.mini?.close();
    // The stream is gone: so is the watch (a new one starts from the default).
    if (!keepWatch && entry.config !== undefined && !entry.config.isSelf) {
      forgetWatch(userId);
    }
    if (entry.trackCleanup) {
      entry.trackCleanup();
      entry.trackCleanup = undefined;
    }
    entry.listeners.destroy();
    resizeObserver?.unobserve(entry.el);
    if (theatreTile === userId) leaveTheatre();
    lastInfo.delete(userId);

    entry.video.srcObject = null;
    syncVideoSurface(entry.video);

    entry.el.remove();
    cells.delete(userId);

    // If focused tile was removed, focus the first remaining tile or clear
    const wasFocusMode = focusedTileId !== null;
    if (focusedTileId === userId) {
      // Never onto a tile the view toggles hide.
      focusedTileId = [...cells].find(([, e]) => !e.el.hidden)?.[0] ?? null;
    }

    syncPeople();
    if (focusedTileId !== null || wasFocusMode) {
      rebuildFocusLayout();
    } else {
      relayout();
    }
    syncStatsPolling();
    restoreFocusedControl(savedFocus);
  }

  /** Remove every tile at once (trackCleanup + srcObject=null via dropTile).
   *  Deleting the current key mid-iteration is well-defined for Map — no
   *  entries are skipped — so this needs no snapshot copy of the keys. */
  function clearStreams(): void {
    for (const id of pendingWatch) forgetWatch(id);
    pendingWatch.clear();
    for (const userId of cells.keys()) {
      dropTile(userId);
    }
  }

  function hasStreams(): boolean {
    return cells.size > 0;
  }

  function setPeople(next: readonly GridPerson[]): void {
    people = next;
    relayout();
  }

  /** Every camera and avatar tile with whose state it marks, or null for a
   *  tile that marks none (a screen share, or a host-drawn avatar). */
  function stateTiles(): [HTMLDivElement, number | null][] {
    const tiles: [HTMLDivElement, number | null][] = [];
    for (const [id, entry] of cells) {
      const cfg = entry.config;
      tiles.push([entry.el, cfg?.isScreenshare === true ? null : (cfg?.audioUserId ?? id)]);
    }
    for (const person of people) {
      const cell = personCells.get(person.userId);
      if (cell !== undefined) {
        tiles.push([cell, person.marksOwnState === true ? null : person.userId]);
      }
    }
    return tiles;
  }

  function applySpeaking(): void {
    for (const [el, userId] of stateTiles()) {
      el.classList.toggle("video-cell--speaking", userId !== null && speaking.has(userId));
    }
  }

  function setSpeaking(userIds: ReadonlySet<number>): void {
    speaking = userIds;
    applySpeaking();
  }

  /** Draw each camera and avatar tile's mute/deafen badge from the roster
   *  state. */
  function applyUserAudioState(): void {
    for (const [el, userId] of stateTiles()) {
      const state = userId === null ? undefined : userAudioState.get(userId);
      let badge = el.querySelector<HTMLElement>("[data-testid='tile-audio-state']");
      if (state === undefined || (!state.muted && !state.deafened)) {
        badge?.remove();
        continue;
      }
      if (badge === null) {
        badge = createElement("span", {
          class: "video-cell__audio",
          "data-testid": "tile-audio-state",
          "aria-hidden": "true",
        });
        el.appendChild(badge);
      }
      badge.classList.toggle("video-cell__audio--muted", !state.deafened);
      badge.classList.toggle("video-cell__audio--deafened", state.deafened);
      while (badge.firstChild) badge.removeChild(badge.firstChild);
      badge.appendChild(createIcon(state.deafened ? "headphones-off" : "mic-off", 14));
    }
  }

  function setUserAudioState(
    state: ReadonlyMap<number, { muted: boolean; deafened: boolean }>,
  ): void {
    userAudioState = state;
    applyUserAudioState();
  }

  /** Draw each screen-share tile's viewer badge: the other members watching
   *  it, and you while a remote share plays here. Hidden at zero. */
  function applyStreamViewers(): void {
    for (const entry of cells.values()) {
      const config = entry.config;
      if (config?.isScreenshare !== true) continue;
      const badge = entry.el.querySelector<HTMLElement>(".video-viewers");
      if (badge === null) continue;
      const names = [...(streamViewers.get(config.audioUserId) ?? [])];
      if (!config.isSelf && !entry.el.classList.contains("video-cell--stopped")) {
        names.unshift(voiceText("tile.viewersYou"));
      }
      badge.hidden = names.length === 0;
      entry.el.classList.toggle("video-cell--has-viewers", names.length > 0);
      if (names.length === 0) continue;
      const label = viewersLabel(names);
      badge.title = label;
      badge.setAttribute("aria-label", label);
      const count = badge.querySelector(".video-viewers__count");
      if (count !== null) setText(count, String(names.length));
    }
  }

  function setStreamViewers(viewers: ReadonlyMap<number, readonly string[]>): void {
    streamViewers = viewers;
    applyStreamViewers();
  }

  function mount(container: Element): void {
    loadViewPrefs();
    root = createElement("div", {
      class: "video-grid",
      "data-testid": "video-grid",
      // Programmatic fallback target: when the focused tile control is gone
      // (its peer left), focus lands here rather than dropping to <body>.
      tabindex: "-1",
    });

    // An exit control, always reachable in focus mode too: the focused
    // tile's own "Back to grid" nav can be scrolled off, and an empty grid
    // could otherwise cover the chat with no way back (OC video-grid exit).
    exitBtn = createElement("button", {
      type: "button",
      class: "video-grid__exit",
      "aria-label": voiceText("grid.showChat"),
      title: voiceText("grid.showChat"),
      "data-tile-control": "exit-grid",
    });
    exitBtn.appendChild(createIcon("message-square", 18));
    exitBtn.hidden = true;
    exitBtn.addEventListener("click", () => {
      // Clearing the grid's own focus keeps it consistent if the host only
      // hides the grid (rather than tearing it down) and later reopens it.
      setFocusedTile(null);
      callbacks.onExitGrid?.();
    });
    root.appendChild(exitBtn);

    container.appendChild(root);
    if (callView) setCallView(true);
    document.addEventListener("fullscreenchange", onFullscreenChange, {
      signal: gridListeners.signal,
    });
    document.addEventListener("keydown", onTheatreKey, { signal: gridListeners.signal });
    document.addEventListener("visibilitychange", syncViews, { signal: gridListeners.signal });
    window.addEventListener(USER_LOCAL_MUTE_CHANGED, onUserLocalMute, {
      signal: gridListeners.signal,
    });

    // Observe container size changes to recalculate tile layout, and the
    // remote tiles' sizes (0 once the grid is closed) for their video views.
    observeGrid();
  }

  function destroy(): void {
    closeCallPopout(false);
    if (theatreTile !== null) leaveTheatre();
    if (fullscreenTile !== null) {
      fullscreenTile = null;
      leaveFullscreen();
      void callbacks.setWindowFullscreen?.(false).catch(() => {});
    }
    gridListeners.destroy();
    if (statsTimer !== null) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    statsTile = null;
    if (resizeRafId !== 0) rafWindow.cancelAnimationFrame(resizeRafId);
    resizeRafId = 0;
    if (viewResizeTimer !== null) clearTimeout(viewResizeTimer);
    viewResizeTimer = null;

    if (resizeObserver !== null) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    for (const [tileId, entry] of cells) {
      // An ended tile still holds its stream's watch for a re-share.
      if (entry.ending !== undefined) forgetWatch(tileId);
      clearTimeout(entry.ending);
      clearTimeout(entry.holding);
      entry.popout?.close();
      entry.mini?.close();
      if (entry.trackCleanup) {
        entry.trackCleanup();
        entry.trackCleanup = undefined;
      }
      entry.listeners.destroy();
      entry.video.srcObject = null;
      syncVideoSurface(entry.video);
    }
    cells.clear();
    focusedTileId = null;
    people = [];
    personCells.clear();
    callView = false;
    viewBar = null;
    popBtn = null;
    callBar = null;

    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return {
    mount,
    destroy,
    addStream,
    watch,
    setLabel,
    removeStream,
    clearStreams,
    hasStreams,
    setFocusedTile,
    getFocusedTileId: getFocusedTileIdFn,
    setPeople,
    setSpeaking,
    setUserAudioState,
    setStreamViewers,
    setCallbacks(next: VideoGridCallbacks): void {
      callbacks = next;
      if (callView) {
        // The control bar is built from the callbacks: rebuild it.
        callBar?.remove();
        callBar = null;
        setCallView(true);
      }
    },
    setCallState(next: CallState): void {
      callState = { ...next };
      for (const bar of root?.querySelectorAll(".video-fs-calls") ?? []) drawCallState(bar);
    },
    setExitVisible: setCallView,
    showMiniPlayer,
    hideMiniPlayer,
    raiseCallPopout(): boolean {
      callPop?.focus();
      return callPop !== null;
    },
  };
}
