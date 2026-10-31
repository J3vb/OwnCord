/** Constants and small helpers the video grid modules share. */
import { createElement, appendChildren, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon, type IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
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
import { videoSurfaceOf } from "@lib/voice/videoSurface";
import type { ZoomPan } from "@lib/ui/zoomPan";
import { voiceText } from "../../i18n/voice";
import type { StreamSample } from "../../features/voice/remoteTracks";
import type { Popout } from "../../features/voice/popout";
import type { MiniPlayer } from "../../features/voice/miniPlayer";
import type { TileConfig } from "../VideoGrid";

/** How often a watched stream's quality chip refreshes. */
export const STATS_POLL_MS = 2000;

/** How long tile sizes settle (a window drag) before their views are sent. */
export const VIEW_RESIZE_MS = 150;

/** The call view's control bar sits in this much room below the tiles
 *  (`.video-grid--call`'s extra bottom padding). */
export const CALL_BAR_SPACE = 56;

/** The same on a phone, where the view toggles ride above a taller control row
 *  (`.video-grid--call` in the phone media query). */
export const CALL_BAR_SPACE_PHONE = 104;

/** The call view's saved view toggles: pref key and default. */
export const VIEW_PREFS = {
  nonVideo: "callShowNonVideo",
  selfCamera: "callShowSelfCamera",
  strip: "callShowStrip",
} as const;

export type ViewToggle = keyof typeof VIEW_PREFS;

export const log = createLogger("VideoGrid");

/** Create a fresh volume icon element. */
export function volumeIcon(): SVGSVGElement {
  return createIcon("volume-2", 16);
}

/** Create a fresh volume-x (muted) icon element. */
export function volumeXIcon(): SVGSVGElement {
  return createIcon("volume-x", 16);
}

/** Replace a button's icon child with a new one. */
export function setButtonIcon(btn: HTMLButtonElement, icon: SVGSVGElement): void {
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

export const GRID_GAP = 4;

export const GRID_PAD = 8;

export const ASPECT = 16 / 9;

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
export function isShown(el: HTMLElement): boolean {
  return (
    el.closest("[hidden]") === null &&
    (typeof el.checkVisibility !== "function" || el.checkVisibility())
  );
}

/** A labelled icon button on a tile, above the tile's own select button. */
export function tileButton(
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
export function callButton(
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

export interface CellEntry {
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
export const ENDED_COVER_MS = 3000;

/** How long a watched share whose owner still shares waits for its republish
 *  before the tile says it ended, and how often it looks at the owner's state
 *  meanwhile (a real stop shows its cover as soon as the owner's state says so). */
export const REPUBLISH_HOLD_MS = 2500;

export const REPUBLISH_HOLD_POLL_MS = 250;

/** The picture's size, from the canvas when one draws it (Linux). */
export function sizeOf(video: HTMLVideoElement): { width: number; height: number } {
  const surface = videoSurfaceOf(video);
  return surface !== null
    ? { width: surface.width, height: surface.height }
    : { width: video.videoWidth, height: video.videoHeight };
}

/** A remote stream playing in its tile (watched, not in a pop-out window). */
export function isPlayingHere(e: CellEntry | undefined): boolean {
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
export function buildVolumeControls(config: TileConfig): {
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
export function isFullscreenKey(e: KeyboardEvent): boolean {
  const typing =
    (e.target instanceof HTMLInputElement && e.target.type !== "range") ||
    e.target instanceof HTMLTextAreaElement;
  return (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
}

/** Your own camera tile, which shows mirrored like a mirror does. Never a
 *  screen share: that must read the way viewers see it. */
export function isSelfCamera(config: TileConfig | undefined): boolean {
  return config?.isSelf === true && !config.isScreenshare;
}
