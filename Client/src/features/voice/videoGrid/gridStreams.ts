/**
 * The video grid's tiles: adding, relabelling and removing streams, the self-
 * camera cover, tile menus and per-user volume.
 */
import { createElement } from "@lib/dom";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import { voiceText } from "../../../i18n/voice";
import {
  log,
  type CellEntry,
  ENDED_COVER_MS,
  REPUBLISH_HOLD_MS,
  REPUBLISH_HOLD_POLL_MS,
  isPlayingHere,
  isSelfCamera,
} from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { TileConfig } from "./VideoGrid";
import { createGridBadges } from "./gridBadges";
import { createGridMenus } from "./gridMenus";
import { createGridTileBuild } from "./gridTileBuild";
import { applyNames, sameTracks, setTrackMuted } from "./tileParts";
import { drawSmallInFocus, leaveFocus } from "./tileFocus";

export function createGridStreams(st: GridState, api: GridApi) {
  const menus = createGridMenus(st, api);
  const { tileMenuOptions, selfMenuOptions, applyVolume, onUserLocalMute } = menus;
  const { buildTile, buildSelfCover } = createGridTileBuild(st, api, menus);
  const { stateTiles, applySpeaking, applyUserAudioState, applyStreamViewers } =
    createGridBadges(st);
  /** Attach ended/mute/unmute listeners on the first video track to handle stale tiles. */
  /** On the tile and on its video, so a video in its pop-out window hides
   *  its stalled frame too. */

  function attachTrackLifecycle(userId: number, stream: MediaStream): void {
    // Clean up previous listeners for this tile
    const prev = st.cells.get(userId);
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
      const cell = st.cells.get(userId);
      if (cell !== undefined) setTrackMuted(cell, true);
    };
    const onTrackUnmute = (): void => {
      const cell = st.cells.get(userId);
      if (cell !== undefined) setTrackMuted(cell, false);
    };
    track.addEventListener("ended", onTrackEnded);
    track.addEventListener("mute", onTrackMute);
    track.addEventListener("unmute", onTrackUnmute);

    const entry = st.cells.get(userId);
    if (entry !== undefined) {
      entry.trackCleanup = () => {
        track.removeEventListener("ended", onTrackEnded);
        track.removeEventListener("mute", onTrackMute);
        track.removeEventListener("unmute", onTrackUnmute);
      };
    }
  }

  /** The republished share is back: it plays in the tile it left. */
  function endHold(userId: number, stream: MediaStream | null): void {
    const held = st.cells.get(userId);
    if (held?.holding === undefined || stream === null) return;
    clearTimeout(held.holding);
    held.holding = undefined;
  }

  /** No longer received (not watched): back to Watch stream. */
  function showUnreceived(
    userId: number,
    existing: CellEntry,
    username: string,
    config: TileConfig | undefined,
  ): void {
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
        st.callbacks.isStreamLive?.(owner.audioUserId, owner.isScreenshare) === true
      ) {
        holdForRepublish(userId, existing, owner.audioUserId, owner.isScreenshare);
      } else {
        api.setStopped(userId, true, false);
      }
    }
    applyNames(existing, username, config?.name ?? username);
  }

  /** Received again (or still): play it, and swap the picture only when its
   *  tracks changed. */
  function showReceived(
    userId: number,
    existing: CellEntry,
    stream: MediaStream,
    username: string,
    config: TileConfig | undefined,
  ): void {
    existing.lost = false;
    // Received only while watched: a stream on a tile showing Watch plays.
    if (existing.config?.isSelf !== true && existing.el.classList.contains("video-cell--stopped")) {
      api.setStopped(userId, false, false);
    }
    const video = existing.video;
    if (!sameTracks(video, stream)) {
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
      api.syncViews();
    }
    applyNames(existing, username, config?.name ?? username);
    // Sync stream type attribute in case it changed
    existing.el.dataset.streamType = config?.isScreenshare ? "screenshare" : "camera";
    existing.el.classList.toggle("video-cell--self", isSelfCamera(config));
  }

  function addStream(
    userId: number,
    username: string,
    stream: MediaStream | null,
    config?: TileConfig,
  ): void {
    if (st.root === null) return;

    // The same person shared again while their tile said it ended (a new
    // source, a quick re-share): a new tile, still watched and in focus.
    endHold(userId, stream);
    const reshared = st.cells.get(userId)?.ending !== undefined;
    const refocus = reshared && st.focusedTileId === userId;
    if (reshared) dropTile(userId, true);
    // If a cell already exists for this user, update it in place
    const existing = st.cells.get(userId);
    if (existing !== undefined) {
      if (stream === null) showUnreceived(userId, existing, username, config);
      else showReceived(userId, existing, stream, username, config);
      return;
    }

    const entry = buildTile(userId, stream, config);
    applyNames(entry, username, config?.name ?? username);
    st.cells.set(userId, entry);
    drawSmallInFocus(st, userId);
    api.syncTileArrange();
    st.pendingWatch.delete(userId);
    if (stream !== null) attachTrackLifecycle(userId, stream);
    else api.setStopped(userId, true, false);
    api.beforeChrome(entry.el);
    applySpeaking();
    applyUserAudioState();
    applyStreamViewers();
    api.syncTileNav();
    api.relayout();
    api.syncViews();
    if (refocus || (st.focusedTileId === userId && st.focusSaved === null)) {
      api.setFocusedTile(userId);
    }
  }

  /** Update an already-open tile's label in place. No-op if the tile isn't
   *  open — used to keep a remote tile's name in sync with a mid-call
   *  rename without re-creating the tile (addStream is only called once per
   *  tile, from the LiveKit TrackSubscribed callback). */
  function setLabel(userId: number, username: string, name?: string): void {
    const entry = st.cells.get(userId);
    if (entry === undefined) return;
    applyNames(entry, username, name ?? username);
  }

  /** A watched remote screen share that ends says so for a few seconds
   *  before its tile goes, instead of vanishing. */
  function removeStream(userId: number): void {
    st.pendingWatch.delete(userId);
    const entry = st.cells.get(userId);
    if (entry === undefined || entry.ending !== undefined || entry.holding !== undefined) return;
    const watched = (isPlayingHere(entry) && entry.mini === undefined) || entry.lost === true;
    const owner = entry.config;
    if (
      watched &&
      owner !== undefined &&
      !owner.isSelf &&
      st.callbacks.isStreamLive?.(owner.audioUserId, owner.isScreenshare) === true
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
      if (st.cells.get(userId) !== entry) return;
      waited += REPUBLISH_HOLD_POLL_MS;
      if (waited < REPUBLISH_HOLD_MS && st.callbacks.isStreamLive?.(owner, screenshare) === true) {
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
    const entry = st.cells.get(userId);
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
      st.callbacks.onStreamRemoved?.();
    }, ENDED_COVER_MS);
    api.syncStatsPolling();
  }

  /** Close the tile's windows, listeners and picture before it leaves. */
  function releaseEntry(userId: number, entry: CellEntry, keepWatch: boolean): void {
    entry.popout?.close();
    entry.mini?.close();
    // The stream is gone: so is the watch (a new one starts from the default).
    if (!keepWatch && entry.config !== undefined && !entry.config.isSelf) {
      api.forgetWatch(userId);
    }
    if (entry.trackCleanup) {
      entry.trackCleanup();
      entry.trackCleanup = undefined;
    }
    // The same stream coming back on a new tile keeps its size and pin.
    if (!keepWatch) api.forgetTileSize(userId);
    entry.listeners.destroy();
    st.resizeObserver?.unobserve(entry.el);
    if (st.theatreTile === userId) api.leaveTheatre();
    st.lastInfo.delete(userId);

    entry.video.srcObject = null;
    syncVideoSurface(entry.video);
  }

  /** `keepWatch`: the same stream is coming back on a new tile. */
  function dropTile(userId: number, keepWatch = false): void {
    const entry = st.cells.get(userId);
    if (entry === undefined) return;
    clearTimeout(entry.ending);
    clearTimeout(entry.holding);

    // Capture the focused tile control before detaching, so a user tabbing
    // through the overlay keeps a focus target when this tile leaves (Q1).
    const savedFocus = api.captureFocusedControl();
    const hadFocus = entry.el.contains(api.doc().activeElement);
    // The pinned stream ending is Back to grid: the others take their earlier
    // sizes. Before the release, which forgets the ended tile's own.
    const wasFocused = st.focusedTileId === userId;
    if (wasFocused) leaveFocus(st);

    releaseEntry(userId, entry, keepWatch);

    entry.el.remove();
    st.cells.delete(userId);

    api.syncPeople();
    if (wasFocused) api.syncTileNav();
    api.relayout();
    api.syncStatsPolling();
    api.restoreFocusedControl(savedFocus);
    // Focus was inside the tile that left: the grid takes it, not <body>.
    const active = api.doc().activeElement;
    if (hadFocus && (active === null || active === api.doc().body)) st.root?.focus();
  }

  /** Remove every tile at once (trackCleanup + srcObject=null via dropTile).
   *  Deleting the current key mid-iteration is well-defined for Map — no
   *  entries are skipped — so this needs no snapshot copy of the keys. */
  function clearStreams(): void {
    for (const id of st.pendingWatch) api.forgetWatch(id);
    st.pendingWatch.clear();
    api.forgetTileSizes();
    for (const userId of st.cells.keys()) {
      dropTile(userId);
    }
  }

  function hasStreams(): boolean {
    return st.cells.size > 0;
  }

  return {
    setTrackMuted,
    attachTrackLifecycle,
    buildSelfCover,
    addStream,
    tileMenuOptions,
    selfMenuOptions,
    applyNames,
    applyVolume,
    onUserLocalMute,
    setLabel,
    removeStream,
    holdForRepublish,
    endStream,
    dropTile,
    clearStreams,
    hasStreams,
    stateTiles,
    applySpeaking,
    applyUserAudioState,
    applyStreamViewers,
  };
}
