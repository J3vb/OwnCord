/**
 * The video grid's tile construction, split from gridStreams.ts: the tile's
 * elements, controls, zoom, keys, menu and the self-share cover. One factory
 * per grid, sharing the grid's state and api.
 */
import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import { bindVideoZoom } from "@lib/ui/zoomPan";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { voiceText } from "../../../i18n/voice";
import type { ShareSenderSample } from "../shareSenderStats";
import {
  STATS_POLL_MS,
  log,
  tileButton,
  type CellEntry,
  buildVolumeControls,
  isFullscreenKey,
  isSelfCamera,
} from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { TileConfig } from "./VideoGrid";
import type { GridMenus } from "./gridMenus";
import { buildTileLabel, buildTileVideo, buildViewersBadge } from "./tileParts";

export function createGridTileBuild(st: GridState, api: GridApi, menus: GridMenus) {
  const { selfMenuOptions, tileMenuOptions } = menus;

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
        sample = (await st.callbacks.getLocalShareStats?.()) ?? null;
        st.infoModule ??= await import("./streamInfo");
      } catch (err) {
        log.debug("Local share stats unavailable", { tileId, err });
      }
      if (signal.aborted) return;
      renderDetail(sample?.sentFps ?? null);
      const text = st.infoModule?.senderText(sample) ?? "";
      senderLine.textContent = text;
      senderLine.title = st.infoModule?.layersText(sample) ?? "";
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
      st.callbacks.onStopSharing?.();
    });
    const hide = createElement(
      "button",
      { type: "button", class: "btn-ghost", "data-tile-control": "hide-preview" },
      voiceText("tile.hidePreview"),
    );
    hide.addEventListener("click", (e) => {
      e.stopPropagation();
      api.setStopped(tileId, true);
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

  /** Filled by the stats poll while you watch this screen share. */
  function buildStatsChip(userId: number): HTMLElement {
    const chip = createElement("button", {
      type: "button",
      class: "video-quality",
      "aria-expanded": "false",
      "data-tile-control": "stats",
    });
    chip.hidden = true;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      api.toggleStats(userId, chip);
    });
    return chip;
  }

  function buildTileNav(userId: number): { nav: HTMLElement; back: HTMLElement } {
    const nav = createElement("div", { class: "video-tile-nav" });
    const back = tileButton(voiceText("tile.backToGrid"), "layout-grid", "grid", () =>
      api.setFocusedTile(null),
    );
    back.hidden = true;
    // Pop out: the stream in a window of its own (togglePopout), and the
    // same control brings it back.
    const pip = tileButton(voiceText("tile.popOut"), "picture-in-picture-2", "pip", () =>
      api.togglePopout(userId),
    );
    pip.setAttribute("aria-pressed", "false");
    const fullscreen = tileButton(voiceText("tile.fullscreen"), "maximize", "fullscreen", () =>
      api.toggleFullscreen(userId),
    );
    appendChildren(nav, back, pip, fullscreen);
    return { nav, back };
  }

  /** A click anywhere on a filmstrip thumb (not on one of its controls)
   *  swaps it into focus, as the tile button does. On a phone a tap on the
   *  focused tile itself gives the focus back (a tile is focused by a tap on
   *  it, so it is unfocused the same way); an open tile menu or a pinch-zoomed
   *  picture takes the tap for itself. */
  function onTileClick(e: MouseEvent, userId: number, cell: HTMLElement): void {
    if ((e.target as Element).closest("button, input, .context-menu") !== null) return;
    if (st.focusedTileId !== null && st.focusedTileId !== userId) {
      api.setFocusedTile(userId);
      return;
    }
    if (st.focusedTileId !== userId || !isPhoneLayout()) return;
    if (api.isFullscreen(userId) || cell.classList.contains("video-zoomed")) return;
    if (api.doc().querySelector(".video-tile-menu") !== null) return;
    api.setFocusedTile(null);
  }

  /** F toggles full screen from anywhere in the tile (not while typing), a
   *  double-click too. The theatre fallback's own keys are on the document
   *  (onTheatreKey). */
  function bindFullscreenKeys(cell: HTMLElement, userId: number, signal: AbortSignal): void {
    cell.addEventListener(
      "keydown",
      (e) => {
        if (isFullscreenKey(e)) {
          e.preventDefault();
          api.toggleFullscreen(userId);
        }
      },
      { signal },
    );
    cell.addEventListener(
      "dblclick",
      (e) => {
        const skip = "button:not(.video-cell-select), input, .context-menu";
        if ((e.target as Element).closest(skip) !== null) return;
        api.toggleFullscreen(userId);
      },
      { signal },
    );
  }

  /** Remote tiles: volume, Stop watching and the tile menu. */
  function addRemoteControls(
    userId: number,
    entry: CellEntry,
    config: TileConfig,
    nav: HTMLElement,
    back: HTMLElement,
  ): void {
    const volume = buildVolumeControls(config);
    entry.applyVolume = volume.apply;
    entry.volumeOverlay = volume.overlay;
    entry.el.appendChild(volume.overlay);
    nav.insertBefore(
      tileButton(voiceText("tile.stopWatching"), "eye-off", "stop", () =>
        api.setWatching(userId, false),
      ),
      back,
    );
    st.resizeObserver?.observe(entry.el);
  }

  /** Loaded on first use: the menu opens only on a right-click or Shift+F10,
   *  so it stays out of the eager bundle. */
  function bindTileMenu(userId: number, entry: CellEntry, config: TileConfig): void {
    const cell = entry.el;
    const openMenu = (x: number, y: number): void =>
      void import("./tileMenu").then((tileMenus) => {
        if (entry.listeners.signal.aborted || st.root?.contains(cell) !== true) return;
        if (config.isSelf) tileMenus.showSelfTileMenu(selfMenuOptions(x, y, userId, entry));
        else tileMenus.showTileMenu(tileMenuOptions(x, y, userId, entry, config));
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

  function buildTile(
    userId: number,
    stream: MediaStream | null,
    config: TileConfig | undefined,
  ): CellEntry {
    const video = buildTileVideo(userId, stream);
    const cell = createElement("div", {
      class: isSelfCamera(config) ? "video-cell video-cell--self" : "video-cell",
      "data-user-id": String(userId),
      "data-stream-type": config?.isScreenshare ? "screenshare" : "camera",
    });

    // The whole tile is one real button (click, Enter, Space) that opens it
    // in focus view; the tile's own controls sit above it, never inside it.
    const select = createElement("button", {
      type: "button",
      class: "video-cell-select",
      "data-tile-control": "select",
    });
    select.addEventListener("click", () => api.setFocusedTile(userId));

    const label = buildTileLabel(config);
    const viewers = config?.isScreenshare === true ? buildViewersBadge() : null;
    if (config !== undefined && !config.isSelf && config.isScreenshare) {
      label.appendChild(buildStatsChip(userId));
    }
    const { nav, back } = buildTileNav(userId);

    appendChildren(cell, video, select, label, nav);
    syncVideoSurface(video);
    if (viewers !== null) cell.appendChild(viewers);
    cell.addEventListener("click", (e) => onTileClick(e, userId, cell));

    const entry: CellEntry = { el: cell, video, config, listeners: new Disposable(), name: "" };
    equipTile(userId, entry, stream, nav, back);
    return entry;
  }

  /** The tile's zoom, keys, remote controls, menu and self-share cover. */
  function equipTile(
    userId: number,
    entry: CellEntry,
    stream: MediaStream | null,
    nav: HTMLElement,
    back: HTMLElement,
  ): void {
    const { el: cell, config } = entry;
    // Your own screen share shows its cover, not the picture: nothing to zoom.
    if (config?.isSelf !== true || !config.isScreenshare) {
      entry.zoom = bindVideoZoom(cell, entry.listeners.signal);
    }
    bindFullscreenKeys(cell, userId, entry.listeners.signal);
    api.watchTileShape(entry);
    if (config !== undefined && !config.isSelf) addRemoteControls(userId, entry, config, nav, back);
    // Your own screen share has no menu.
    if (config !== undefined && (!config.isSelf || !config.isScreenshare)) {
      bindTileMenu(userId, entry, config);
    }

    // Your own screen share: say what is going out instead of showing a
    // hall of mirrors, with Stop sharing always at hand.
    if (config?.isSelf === true && config.isScreenshare && stream !== null) {
      cell.appendChild(
        buildSelfCover(userId, stream, config.hasAudio === true, entry.listeners.signal),
      );
    }
  }

  return { buildTile, buildSelfCover };
}
