/**
 * Which streams the video grid shows: watching and stopping a stream, per-tile
 * pop-outs and the mini player.
 */
import { createElement, appendChildren } from "@lib/dom";
import { showToast } from "@lib/ui/toast";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import { voiceText } from "../../i18n/voice";
import type { VideoView } from "../../features/voice/remoteTracks";
import { openPopout } from "../../features/voice/popout";
import { VIEW_RESIZE_MS, log, type CellEntry, isPlayingHere } from "./gridShared";
import type { GridState, GridApi } from "./gridState";

export function createGridWatch(st: GridState, api: GridApi) {
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
    if (api.doc().hidden || width === 0 || entry.el.classList.contains("video-cell--stopped")) {
      return { enabled: false };
    }
    if (id === st.focusedTileId || api.isFullscreen(id)) return { enabled: true };
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
    for (const [id, entry] of st.cells) {
      if (entry.config === undefined || entry.config.isSelf) continue;
      const view = viewOf(id, entry);
      const key = JSON.stringify(view);
      if (key === entry.view) continue;
      entry.view = key;
      st.callbacks.setStreamView?.(id, view);
    }
  }

  /** Resizes come every frame while the window drags: send the views once
   *  the sizes settle. */
  function scheduleViewSync(): void {
    if (st.viewResizeTimer !== null) clearTimeout(st.viewResizeTimer);
    st.viewResizeTimer = setTimeout(() => {
      st.viewResizeTimer = null;
      syncViews();
    }, VIEW_RESIZE_MS);
  }

  // --- Pop out ---------------------------------------------------------------

  /** Move the tile's video into a window of its own, or bring it back. Where
   *  no window opens, the video stays in the grid. */
  function togglePopout(tileId: number): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    if (entry.popout !== undefined) {
      entry.popout.close();
      return;
    }
    if (api.isFullscreen(tileId)) api.leaveFullscreen();
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
        st.callbacks.setWindowFullscreen?.(on, label) ?? Promise.resolve(),
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
    const d = api.doc();
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
    if (st.focusedTileId !== null && isPlayingHere(st.cells.get(st.focusedTileId)))
      return st.focusedTileId;
    for (const [id, e] of st.cells) if (isPlayingHere(e)) return id;
    return null;
  }

  function showMiniPlayer(): void {
    if ([...st.cells.values()].some((e) => e.mini !== undefined)) return;
    // Picked now: the grid drops its focus as it closes.
    const tileId = watchedTile();
    if (tileId === null) return;
    const request = ++st.miniRequest;
    if (api.isFullscreen(tileId)) api.leaveFullscreen();
    // Loaded on first use: only leaving a watched stream needs it.
    void import("../../features/voice/miniPlayer").then(({ openMiniPlayer }) => {
      const entry = st.cells.get(tileId);
      if (request !== st.miniRequest || st.root === null || entry === undefined) return;
      if (entry.mini !== undefined || !isPlayingHere(entry)) return;
      entry.mini = openMiniPlayer({
        name: entry.name,
        video: entry.video,
        onReturn: () => {
          st.callbacks.onReturnToStream?.(tileId);
          if (st.root !== null && !st.root.contains(document.activeElement)) {
            api.restoreFocusedControl({ userId: tileId, control: "grid" });
          }
        },
        onPopout: () => togglePopout(tileId),
        onStopWatching: () => {
          st.callbacks.setStreamWatched?.(tileId, false);
          // The grid is closed: no focus to move into it.
          setStopped(tileId, true, false);
        },
        onClosed: (hadFocus) => {
          entry.mini = undefined;
          if (hadFocus) st.callbacks.focusFallback?.();
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
    st.miniRequest++;
    for (const entry of st.cells.values()) entry.mini?.close();
  }

  function getFocusedTileIdFn(): number | null {
    return st.focusedTileId;
  }

  /** A stream ended or its pending watch was dropped: not Stop watching. */
  function forgetWatch(tileId: number): void {
    if (st.callbacks.forgetStreamWatch !== undefined) st.callbacks.forgetStreamWatch(tileId);
    else st.callbacks.setStreamWatched?.(tileId, false);
  }

  /** Watch a remote stream or stop (opt-in watching): it is subscribed only
   *  while watched. */
  function setWatching(tileId: number, on: boolean): void {
    st.callbacks.setStreamWatched?.(tileId, on);
    setStopped(tileId, !on);
  }

  /** Draw a tile stopped (behind Watch stream, or your own hidden preview)
   *  or playing. `moveFocus` false for a change the user did not make here. */
  function setStopped(tileId: number, stopped: boolean, moveFocus = true): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    const cell = entry.el;
    if (stopped) {
      entry.popout?.close();
      entry.mini?.close();
      entry.zoom?.reset();
    }
    if (!stopped) entry.lost = false;
    cell.classList.toggle("video-cell--stopped", stopped);
    api.applyStreamViewers();
    syncViews();
    entry.video.hidden = stopped;
    cell.querySelector(".video-stopped")?.remove();
    const self = entry.config?.isSelf === true;
    if (!stopped) {
      if (moveFocus) {
        api.restoreFocusedControl({ userId: tileId, control: self ? "hide-preview" : "stop" });
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
    const entry = st.cells.get(tileId);
    if (entry === undefined) {
      st.pendingWatch.add(tileId);
      st.callbacks.setStreamWatched?.(tileId, true);
      return;
    }
    if (entry.config?.isSelf === true) return;
    if (entry.el.classList.contains("video-cell--stopped")) setWatching(tileId, true);
  }

  return {
    viewOf,
    syncViews,
    scheduleViewSync,
    togglePopout,
    bringBack,
    watchedTile,
    showMiniPlayer,
    hideMiniPlayer,
    getFocusedTileIdFn,
    forgetWatch,
    setWatching,
    setStopped,
    watch,
  };
}
