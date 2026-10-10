/**
 * VideoGrid component — renders remote video streams in a responsive CSS grid.
 * Replaces the chat area when cameras are active.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { openMenuOnKeyboard } from "@lib/context-menu";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import {
  getScreenshareAudioMuted,
  getScreenshareAudioVolume,
  getUserVolume,
  muteScreenshareAudio,
  setScreenshareAudioVolume,
  setUserVolume,
} from "@lib/livekitSession";
import type { MountableComponent } from "@lib/safe-render";
import { voiceText } from "../i18n/voice";
import type { StreamInfo } from "./video-grid/stream-info";
import type { StreamSample, VideoView } from "../features/voice/remoteTracks";
import { openPopout, type Popout } from "../features/voice/popout";

/** How often a watched stream's quality chip refreshes. */
const STATS_POLL_MS = 2000;
/** How long tile sizes settle (a window drag) before their views are sent. */
const VIEW_RESIZE_MS = 150;

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
  /** The call controls a full-screen tile keeps at hand. */
  readonly callControls?: {
    readonly onMuteToggle: () => void;
    readonly onDeafenToggle: () => void;
    readonly onLeave: () => void;
  };
  /** One receiver sample for a remote tile's quality chip, or null. */
  readonly getStreamStats?: (tileId: number) => Promise<StreamSample | null>;
  /** What a remote tile shows now, so its stream sends only that. */
  readonly setStreamView?: (tileId: number, view: VideoView) => void;
  /** Opt-in watching: the viewer watches a remote stream, or stops. Nothing
   *  is received until they do. */
  readonly setStreamWatched?: (tileId: number, watched: boolean) => void;
  /** Leave video mode entirely (grid or focus) back to the chat. The grid's
   *  own header control offers this, so no state is a dead end. */
  readonly onExitGrid?: () => void;
}

/** Someone in the call the host wants drawn as an avatar tile while they have
 *  no camera tile up. The host owns `content` (and keeps it current). */
export interface GridPerson {
  readonly userId: number;
  readonly label: string;
  readonly content: HTMLElement;
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
  /** Ring the camera tiles of the users speaking now. */
  setSpeaking(userIds: ReadonlySet<number>): void;
  /** Mute/deafen state by userId, shown as a badge on the camera tile
   *  (the UX spec's roster parity for tiles; not drawn on screen-share tiles). */
  setUserAudioState(state: ReadonlyMap<number, { muted: boolean; deafened: boolean }>): void;
  setCallbacks(callbacks: VideoGridCallbacks): void;
  /** Your mute and deafen state, for a full-screen tile's call controls. */
  setCallState(state: {
    readonly muted: boolean;
    readonly deafened: boolean;
    /** Joined without a microphone: the mute control reads mic-off, inert. */
    readonly listenOnly: boolean;
  }): void;
  /** Show or hide the grid header's exit control (video mode only). */
  setExitVisible(visible: boolean): void;
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
  /** The previous receiver sample, for the frame rate. */
  prevSample?: StreamSample;
  /** The view last reported for the tile, as JSON. */
  view?: string;
}

/** The stream (screen-share audio, 0-100 %) or voice (mic, 0-100 %) volume
 *  of a remote tile: mute, a slider named for whose it is, and its value. */
function buildVolumeControls(config: TileConfig): {
  overlay: HTMLDivElement;
  apply: (volume: number, muted: boolean) => void;
} {
  // Mic and screenshare audio state both survive tile rebuilds —
  // initialize from the same persisted values the sidebar volume menu
  // reads, instead of hardcoding "unmuted at 100%" (B3-5). Both sliders
  // are 0-100 (HTMLAudioElement.volume caps at 1.0).
  const savedVolume = config.isScreenshare
    ? Math.round(getScreenshareAudioVolume(config.audioUserId) * 100)
    : getUserVolume(config.audioUserId);
  let currentVolume = savedVolume;
  let muted = config.isScreenshare
    ? getScreenshareAudioMuted(config.audioUserId)
    : savedVolume === 0;
  /** What the slider shows: the stored level on open (even if muted), 0
   *  once muted from here, the level again on unmute. */
  let shown = currentVolume;

  const overlay = createElement("div", { class: "video-tile-overlay" });
  const volumeSlider = createElement("input", {
    type: "range",
    min: "0",
    max: "100",
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
      // BUG-102: Set actual volume, not just mute toggle. Slider 100 maps
      // to element volume 1.0 (the attach-time default).
      muteScreenshareAudio(config.audioUserId, muted);
      if (!muted) setScreenshareAudioVolume(config.audioUserId, currentVolume / 100);
    } else {
      setUserVolume(config.audioUserId, muted ? 0 : currentVolume);
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

export function createVideoGrid(): VideoGridComponent {
  let root: HTMLDivElement | null = null;
  const cells = new Map<number, CellEntry>();
  let focusedTileId: number | null = null;
  let people: readonly GridPerson[] = [];
  const personCells = new Map<number, HTMLDivElement>();
  let resizeObserver: ResizeObserver | null = null;
  let resizeRafId = 0;
  let callbacks: VideoGridCallbacks = {};
  let speaking: ReadonlySet<number> = new Set();
  let userAudioState: ReadonlyMap<number, { muted: boolean; deafened: boolean }> = new Map();
  /** The tile in HTML full screen, or in the theatre fallback. */
  let fullscreenTile: number | null = null;
  let theatreTile: number | null = null;
  let callState = { muted: false, deafened: false, listenOnly: false };
  let exitBtn: HTMLButtonElement | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let statsTile: number | null = null;
  let viewResizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Streams the voice roster asked to watch before their tile was offered. */
  const pendingWatch = new Set<number>();
  /** Owns the grid's document listeners (full-screen changes, theatre keys). */
  const gridListeners = new Disposable();

  /** Apply JS-calculated tile sizes to all grid-mode cells. */
  function applyGridSizes(): void {
    const tiles = allTiles();
    if (root === null || focusedTileId !== null || tiles.length === 0) return;

    const { width: cw, height: ch } = root.getBoundingClientRect();
    if (cw === 0 || ch === 0) return;

    const layout = computeGridLayout(cw, ch, tiles.length);

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
    if (root === null) return;
    if (focusedTileId !== null) {
      rebuildFocusLayout();
      return;
    }
    for (const el of allTiles()) {
      if (el.classList.contains("video-cell--avatar") || el.parentElement !== root) {
        root.appendChild(el);
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
    if (resizeRafId !== 0) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
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
    const active = document.activeElement;
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
      // No focus — use regular flex-wrap layout
      while (root.firstChild) root.removeChild(root.firstChild);
      root.classList.remove("focus-mode");
      for (const el of allTiles()) {
        el.classList.remove("focused", "thumb");
        root.appendChild(el);
      }
      if (exitBtn !== null) root.appendChild(exitBtn);
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
    for (const child of Array.from(root.childNodes)) if (child !== mainArea) child.remove();
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

    if (mainArea.parentNode !== root) root.appendChild(mainArea);
    // Only show strip if there are thumbnails
    if (stripArea.childElementCount > 0) {
      root.appendChild(stripArea);
    }
    // Keep the exit control in the DOM (it was stripped with the other
    // children above) and on top, so focus mode is never a dead end.
    if (exitBtn !== null) root.appendChild(exitBtn);

    restoreFocusedControl(savedFocus);
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
    if (document.fullscreenElement !== null && document.fullscreenElement !== undefined) {
      void document.exitFullscreen().catch((err: unknown) => {
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
    void callbacks.setWindowFullscreen?.(true).catch(() => {});
  }

  function leaveTheatre(): void {
    const entry = theatreTile === null ? undefined : cells.get(theatreTile);
    entry?.el.classList.remove("video-cell--theatre");
    theatreTile = null;
    syncFullscreenUi();
    void callbacks.setWindowFullscreen?.(false).catch(() => {});
  }

  /** Escape or F leaves the theatre fallback wherever focus is: a click on the
   *  video moves it to the grid, outside the tile (HTML full screen handles
   *  its own Escape). A tile's F handler has already acted when it prevented
   *  the default. */
  function onTheatreKey(e: KeyboardEvent): void {
    if (theatreTile === null || e.defaultPrevented) return;
    if (e.key !== "Escape" && !isFullscreenKey(e)) return;
    e.preventDefault();
    leaveTheatre();
  }

  function onFullscreenChange(): void {
    const el = document.fullscreenElement ?? null;
    let next: number | null = null;
    for (const [id, entry] of cells) if (entry.el === el) next = id;
    const was = fullscreenTile;
    fullscreenTile = next;
    if (was === next) return;
    syncFullscreenUi();
    void callbacks.setWindowFullscreen?.(next !== null).catch(() => {});
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
    const deafen = bar.querySelector<HTMLElement>("[data-call-control='deafen']");
    if (mute !== null) {
      mute.setAttribute("aria-pressed", String(callState.muted));
      mute.querySelector("svg")?.remove();
      mute.appendChild(createIcon(callState.muted || callState.listenOnly ? "mic-off" : "mic", 18));
      mute.disabled = callState.listenOnly;
      mute.title = voiceText(
        callState.listenOnly ? "widget.control.listenOnly" : "widget.control.mute",
      );
    }
    if (deafen !== null) {
      deafen.setAttribute("aria-pressed", String(callState.deafened));
      deafen.querySelector("svg")?.remove();
      deafen.appendChild(createIcon(callState.deafened ? "headphones-off" : "headphones", 18));
    }
  }

  // --- Stream info -------------------------------------------------------------

  /** Poll the stream you are watching (focused or full screen), and only it. */
  function syncStatsPolling(): void {
    const target = fullscreenTile ?? theatreTile ?? focusedTileId;
    const entry = target === null ? undefined : cells.get(target);
    const wanted =
      entry !== undefined && entry.config !== undefined && !entry.config.isSelf ? target : null;
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
    infoModule ??= await import("./video-grid/stream-info");
    const { chipText, renderStats, streamInfo } = infoModule;
    if (statsTile !== tileId || cells.get(tileId) !== entry) return;
    const info =
      sample !== null
        ? streamInfo(sample, entry.prevSample)
        : { width: entry.video.videoWidth, height: entry.video.videoHeight };
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
  let infoModule: typeof import("./video-grid/stream-info") | null = null;

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
        if (e.key !== "Escape") return;
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

  // --- Video layers (P3-07) -------------------------------------------------------

  /** Nothing while no one can see the tile (grid closed, app hidden or
   *  minimised, stopped); the top layer for the stream you are watching
   *  (focused, full screen or popped out); otherwise its rendered size. */
  function viewOf(id: number, entry: CellEntry): VideoView {
    if (entry.popout !== undefined) {
      return { enabled: true };
    }
    const { width, height } = entry.el.getBoundingClientRect();
    if (document.hidden || width === 0 || entry.el.classList.contains("video-cell--stopped")) {
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
   *  (it froze tiles, OC-0455), so this is what keeps hidden and small tiles
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
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    const hadFocus = cover?.contains(active) === true || (byUser && lost);
    cover?.remove();
    for (const child of entry.el.children) child.removeAttribute("inert");
    const pip = entry.el.querySelector<HTMLElement>("[data-tile-control='pip']");
    pip?.setAttribute("aria-pressed", "false");
    if (hadFocus) pip?.focus();
    entry.el.insertBefore(entry.video, entry.el.firstChild);
    if (entry.volumeOverlay !== undefined) entry.el.appendChild(entry.volumeOverlay);
    entry.video.play()?.catch(() => {});
    syncViews();
  }

  function getFocusedTileIdFn(): number | null {
    return focusedTileId;
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
    if (stopped) entry.popout?.close();
    cell.classList.toggle("video-cell--stopped", stopped);
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

  function buildSelfCover(tileId: number, stream: MediaStream, hasAudio: boolean): HTMLDivElement {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const surface = (settings as { displaySurface?: string }).displaySurface;
    const title =
      surface === "window"
        ? voiceText("tile.sharingWindow")
        : surface === "browser"
          ? voiceText("tile.sharingTab")
          : voiceText("tile.sharingScreen");
    const parts: string[] = [];
    if (settings.height !== undefined && settings.frameRate !== undefined) {
      parts.push(
        voiceText("tile.shareQuality", {
          // Plain strings: the catalog would group 1080 as "1,080".
          height: String(settings.height),
          fps: String(Math.round(settings.frameRate)),
        }),
      );
    }
    parts.push(hasAudio ? voiceText("tile.withAudio") : voiceText("tile.noAudio"));

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
      createElement("div", { class: "video-self-detail" }, parts.join(" · ")),
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

    // If a cell already exists for this user, update it in place
    const existing = cells.get(userId);
    if (existing !== undefined && stream === null) {
      // No longer received (not watched): back to Watch stream.
      existing.trackCleanup?.();
      existing.trackCleanup = undefined;
      existing.video.srcObject = null;
      setTrackMuted(existing, false);
      if (!existing.el.classList.contains("video-cell--stopped")) setStopped(userId, true, false);
      applyNames(existing, username, config?.name ?? username);
      return;
    }
    if (existing !== undefined && stream !== null) {
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
        video.srcObject = stream;
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
      class: "video-cell",
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
    if (config !== undefined && !config.isSelf) {
      // Filled by the stats poll while you watch this stream.
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
    // A click anywhere on a filmstrip thumb (not on one of its controls)
    // swaps it into focus, as the tile button does.
    cell.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, input") !== null) return;
      if (focusedTileId !== null && focusedTileId !== userId) setFocusedTile(userId);
    });

    const entry: CellEntry = { el: cell, video, config, listeners: new Disposable(), name: "" };
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
      // Loaded on first use: the menu opens only on a right-click or
      // Shift+F10, so it stays out of the eager bundle.
      const openMenu = (x: number, y: number): void =>
        void import("./video-grid/tile-menu").then(({ showTileMenu }) => {
          if (entry.listeners.signal.aborted || root?.contains(cell) !== true) return;
          showTileMenu({
            x,
            y,
            name: entry.name,
            config,
            signal: entry.listeners.signal,
            onVolumeChange: (isScreenshare, level, muted) =>
              applyVolume(config.audioUserId, isScreenshare, level, muted),
            onStopWatching: () => setWatching(userId, false),
          });
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
      resizeObserver?.observe(cell);
    }

    // Your own screen share: say what is going out instead of showing a
    // hall of mirrors, with Stop sharing always at hand.
    if (config?.isSelf === true && config.isScreenshare && stream !== null) {
      cell.appendChild(buildSelfCover(userId, stream, config.hasAudio === true));
    }
    applyNames(entry, username, config?.name ?? username);
    cells.set(userId, entry);
    pendingWatch.delete(userId);
    if (stream !== null) attachTrackLifecycle(userId, stream);
    else setStopped(userId, true, false);
    root.appendChild(cell);
    applySpeaking();
    applyUserAudioState();
    syncTileNav();
    relayout();
    syncViews();
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

  /** Update an already-open tile's label in place. No-op if the tile isn't
   *  open — used to keep a remote tile's name in sync with a mid-call
   *  rename without re-creating the tile (addStream is only called once per
   *  tile, from the LiveKit TrackSubscribed callback). */
  function setLabel(userId: number, username: string, name?: string): void {
    const entry = cells.get(userId);
    if (entry === undefined) return;
    applyNames(entry, username, name ?? username);
  }

  function removeStream(userId: number): void {
    pendingWatch.delete(userId);
    const entry = cells.get(userId);
    if (entry === undefined) return;

    // Capture the focused tile control before detaching, so a user tabbing
    // through the overlay keeps a focus target when this tile leaves (Q1).
    const savedFocus = captureFocusedControl();

    entry.popout?.close();
    // The stream is gone: so is the watch (a new one starts unwatched).
    if (entry.config !== undefined && !entry.config.isSelf) {
      callbacks.setStreamWatched?.(userId, false);
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

    entry.el.remove();
    cells.delete(userId);

    // If focused tile was removed, focus the first remaining tile or clear
    const wasFocusMode = focusedTileId !== null;
    if (focusedTileId === userId) {
      const firstKey = cells.keys().next().value;
      focusedTileId = firstKey ?? null;
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

  /** Remove every tile (trackCleanup + srcObject=null via removeStream).
   *  Deleting the current key mid-iteration is well-defined for Map — no
   *  entries are skipped — so this needs no snapshot copy of the keys. */
  function clearStreams(): void {
    for (const id of pendingWatch) callbacks.setStreamWatched?.(id, false);
    pendingWatch.clear();
    for (const userId of cells.keys()) {
      removeStream(userId);
    }
  }

  function hasStreams(): boolean {
    return cells.size > 0;
  }

  function setPeople(next: readonly GridPerson[]): void {
    people = next;
    relayout();
  }

  function applySpeaking(): void {
    for (const [id, entry] of cells) {
      const cfg = entry.config;
      const on = cfg?.isScreenshare !== true && speaking.has(cfg?.audioUserId ?? id);
      entry.el.classList.toggle("video-cell--speaking", on);
    }
  }

  function setSpeaking(userIds: ReadonlySet<number>): void {
    speaking = userIds;
    applySpeaking();
  }

  /** Draw each camera tile's mute/deafen badge from the roster state. */
  function applyUserAudioState(): void {
    for (const [id, entry] of cells) {
      const cfg = entry.config;
      if (cfg?.isScreenshare === true) continue;
      const state = userAudioState.get(cfg?.audioUserId ?? id);
      let badge = entry.el.querySelector<HTMLElement>("[data-testid='tile-audio-state']");
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
        entry.el.appendChild(badge);
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

  function mount(container: Element): void {
    root = createElement("div", {
      class: "video-grid",
      "data-testid": "video-grid",
      // Programmatic fallback target: when the focused tile control is gone
      // (its peer left), focus lands here rather than dropping to <body>.
      tabindex: "-1",
    });

    // A header exit control, always reachable in focus mode too: the focused
    // tile's own "Back to grid" nav can be scrolled off, and an empty grid
    // could otherwise cover the chat with no way back (OC video-grid exit).
    exitBtn = createElement("button", {
      type: "button",
      class: "video-grid__exit",
      "aria-label": voiceText("grid.showChat"),
      title: voiceText("grid.showChat"),
      "data-tile-control": "exit-grid",
    });
    exitBtn.appendChild(createIcon("x", 18));
    exitBtn.hidden = true;
    exitBtn.addEventListener("click", () => {
      // Clearing the grid's own focus keeps it consistent if the host only
      // hides the grid (rather than tearing it down) and later reopens it.
      setFocusedTile(null);
      callbacks.onExitGrid?.();
    });
    root.appendChild(exitBtn);

    container.appendChild(root);
    document.addEventListener("fullscreenchange", onFullscreenChange, {
      signal: gridListeners.signal,
    });
    document.addEventListener("keydown", onTheatreKey, { signal: gridListeners.signal });
    document.addEventListener("visibilitychange", syncViews, { signal: gridListeners.signal });

    // Observe container size changes to recalculate tile layout, and the
    // remote tiles' sizes (0 once the grid is closed) for their video views.
    resizeObserver = new ResizeObserver(() => {
      scheduleResize();
      scheduleViewSync();
    });
    resizeObserver.observe(root);
  }

  function destroy(): void {
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
    if (resizeRafId !== 0) cancelAnimationFrame(resizeRafId);
    resizeRafId = 0;
    if (viewResizeTimer !== null) clearTimeout(viewResizeTimer);
    viewResizeTimer = null;

    if (resizeObserver !== null) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    for (const [, entry] of cells) {
      entry.popout?.close();
      if (entry.trackCleanup) {
        entry.trackCleanup();
        entry.trackCleanup = undefined;
      }
      entry.listeners.destroy();
      entry.video.srcObject = null;
    }
    cells.clear();
    focusedTileId = null;
    people = [];
    personCells.clear();

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
    setCallbacks(next: VideoGridCallbacks): void {
      callbacks = next;
    },
    setCallState(next: {
      readonly muted: boolean;
      readonly deafened: boolean;
      readonly listenOnly: boolean;
    }): void {
      callState = { muted: next.muted, deafened: next.deafened, listenOnly: next.listenOnly };
      for (const bar of root?.querySelectorAll(".video-fs-calls") ?? []) drawCallState(bar);
    },
    setExitVisible(visible: boolean): void {
      if (exitBtn !== null) exitBtn.hidden = !visible;
    },
  };
}
