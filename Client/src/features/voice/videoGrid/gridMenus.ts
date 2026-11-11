/**
 * The video grid's tile menus and per-user volume, split from gridStreams.ts.
 */
import { getUserLocalMute, getUserVolume } from "@lib/voice/livekitSession";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { CellEntry } from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { TileConfig } from "./VideoGrid";
import type { TileSize } from "./packLayout";

export function createGridMenus(st: GridState, api: GridApi) {
  /** The Size and Pin rows, in the grid layout only: focus mode sizes by CSS and a full-screen tile
   *  fills the screen. */
  function arrangeOf(tileId: number) {
    if (st.focusedTileId !== null || api.isFullscreen(tileId)) return {};
    const { size, pinned } = api.tileArrangement(tileId);
    return {
      arrange: {
        size,
        pinned,
        onSize: (next: TileSize) => api.setTileSize(tileId, next),
        onPin: () => api.toggleTilePin(tileId),
      },
    };
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
    const actions = st.callbacks.tileMenu;
    // Profile and Message leave the tile, which a full-screen tile would hide.
    const leaving = (run: () => void) => (): void => {
      if (api.isFullscreen(tileId)) api.leaveFullscreen();
      run();
    };
    // The profile card opens in the app window, out of sight of a pop-out.
    const onProfile = st.callPop === null ? actions?.onProfile : undefined;
    const onMessage = actions?.onMessage;
    const moderation = actions?.moderation?.(personId);
    return {
      x,
      y,
      name: entry.name,
      config,
      doc: api.doc(),
      signal: entry.listeners.signal,
      onVolumeChange: (isScreenshare: boolean, level: number, muted: boolean) =>
        applyVolume(personId, isScreenshare, level, muted),
      onStopWatching: () => api.setWatching(tileId, false),
      ...arrangeOf(tileId),
      view: {
        focused: st.focusedTileId === tileId,
        fullscreen: api.isFullscreen(tileId),
        poppedOut: entry.popout !== undefined,
        onFocus: () => api.setFocusedTile(st.focusedTileId === tileId ? null : tileId),
        onFullscreen: () => api.toggleFullscreen(tileId),
        onPopout: () => api.togglePopout(tileId),
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
    const onCamera = st.callbacks.callControls?.onCameraToggle;
    // A hidden full-screen tile would leave a blank screen; focus goes to
    // the toggle that brings the tile back (on a phone, View options).
    const hide = (): void => {
      if (api.isFullscreen(tileId)) api.leaveFullscreen();
      api.setView("selfCamera", false);
      const back = isPhoneLayout()
        ? st.callBar?.querySelector<HTMLElement>("[data-call-control='views']")
        : st.viewBar?.querySelector<HTMLElement>("[data-view-toggle='selfCamera']");
      back?.focus();
    };
    return {
      x,
      y,
      doc: api.doc(),
      signal: entry.listeners.signal,
      ...arrangeOf(tileId),
      ...(st.callView ? { onHide: hide } : {}),
      ...(onCamera === undefined
        ? {}
        : { onCameraOff: onCamera, cameraLocked: api.mediaLockReason() }),
    };
  }

  /** A volume changed from a tile menu: draw it on every tile of that
   *  person showing the same setting (stream or voice). */
  function applyVolume(
    audioUserId: number,
    isScreenshare: boolean,
    volume: number,
    muted: boolean,
  ): void {
    for (const entry of st.cells.values()) {
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

  return { tileMenuOptions, selfMenuOptions, applyVolume, onUserLocalMute };
}

export type GridMenus = ReturnType<typeof createGridMenus>;
