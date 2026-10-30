/**
 * The video grid's tiles: adding, relabelling and removing streams, the self-
 * camera cover, tile menus and per-user volume.
 */
import { createElement, appendChildren, setText, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { openMenuOnKeyboard } from "@lib/ui/contextMenu";
import { createIcon } from "@lib/icons";
import { getUserLocalMute, getUserVolume } from "@lib/voice/livekitSession";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import { bindVideoZoom } from "@lib/ui/zoomPan";
import { voiceText } from "../../i18n/voice";
import { viewersLabel } from "./viewers";
import type { ShareSenderSample } from "../../features/voice/shareSenderStats";
import {
  STATS_POLL_MS,
  log,
  tileButton,
  type CellEntry,
  ENDED_COVER_MS,
  REPUBLISH_HOLD_MS,
  REPUBLISH_HOLD_POLL_MS,
  isPlayingHere,
  buildVolumeControls,
  isFullscreenKey,
  isSelfCamera,
} from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { TileConfig } from "../VideoGrid";

function setTrackMuted(entry: CellEntry, muted: boolean): void {
  entry.el.classList.toggle("track-muted", muted);
  entry.video.classList.toggle("track-muted", muted);
}

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

export function createGridStreams(st: GridState, api: GridApi) {
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

  function addStream(
    userId: number,
    username: string,
    stream: MediaStream | null,
    config?: TileConfig,
  ): void {
    if (st.root === null) return;

    // The same person shared again while their tile said it ended (a new
    // source, a quick re-share): a new tile, still watched and in focus.
    const held = st.cells.get(userId);
    if (held?.holding !== undefined && stream !== null) {
      // The republished share is back: it plays in the tile it left.
      clearTimeout(held.holding);
      held.holding = undefined;
    }
    const reshared = st.cells.get(userId)?.ending !== undefined;
    const refocus = reshared && st.focusedTileId === userId;
    if (reshared) dropTile(userId, true);
    // If a cell already exists for this user, update it in place
    const existing = st.cells.get(userId);
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
          st.callbacks.isStreamLive?.(owner.audioUserId, owner.isScreenshare) === true
        ) {
          holdForRepublish(userId, existing, owner.audioUserId, owner.isScreenshare);
        } else {
          api.setStopped(userId, true, false);
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
        api.setStopped(userId, false, false);
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
        api.syncViews();
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
    select.addEventListener("click", () => api.setFocusedTile(userId));

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
        api.toggleStats(userId, chip);
      });
      label.appendChild(chip);
    }

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

    appendChildren(cell, video, select, label, nav);
    syncVideoSurface(video);
    if (viewers !== null) cell.appendChild(viewers);
    // A click anywhere on a filmstrip thumb (not on one of its controls)
    // swaps it into focus, as the tile button does.
    cell.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button, input") !== null) return;
      if (st.focusedTileId !== null && st.focusedTileId !== userId) api.setFocusedTile(userId);
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
          api.toggleFullscreen(userId);
        }
      },
      { signal: entry.listeners.signal },
    );
    cell.addEventListener(
      "dblclick",
      (e) => {
        const skip = "button:not(.video-cell-select), input, .context-menu";
        if ((e.target as Element).closest(skip) !== null) return;
        api.toggleFullscreen(userId);
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
          api.setWatching(userId, false),
        ),
        back,
      );
      st.resizeObserver?.observe(cell);
    }
    // Loaded on first use: the menu opens only on a right-click or Shift+F10,
    // so it stays out of the eager bundle. Your own screen share has none.
    if (config !== undefined && (!config.isSelf || !config.isScreenshare)) {
      const openMenu = (x: number, y: number): void =>
        void import("./tileMenu").then((menus) => {
          if (entry.listeners.signal.aborted || st.root?.contains(cell) !== true) return;
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
    st.cells.set(userId, entry);
    st.pendingWatch.delete(userId);
    if (stream !== null) attachTrackLifecycle(userId, stream);
    else api.setStopped(userId, true, false);
    st.root.appendChild(cell);
    applySpeaking();
    applyUserAudioState();
    applyStreamViewers();
    api.syncTileNav();
    api.relayout();
    api.syncViews();
    if (refocus) api.setFocusedTile(userId);
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
    // the toggle that brings the tile back.
    const hide = (): void => {
      if (api.isFullscreen(tileId)) api.leaveFullscreen();
      api.setView("selfCamera", false);
      st.viewBar?.querySelector<HTMLElement>("[data-view-toggle='selfCamera']")?.focus();
    };
    return {
      x,
      y,
      doc: api.doc(),
      signal: entry.listeners.signal,
      ...(st.callView ? { onHide: hide } : {}),
      ...(onCamera === undefined
        ? {}
        : { onCameraOff: onCamera, cameraLocked: api.mediaLockReason() }),
    };
  }

  /** The tile's label, and the person's name on its controls and menu. */

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

  /** `keepWatch`: the same stream is coming back on a new tile. */
  function dropTile(userId: number, keepWatch = false): void {
    const entry = st.cells.get(userId);
    if (entry === undefined) return;
    clearTimeout(entry.ending);
    clearTimeout(entry.holding);

    // Capture the focused tile control before detaching, so a user tabbing
    // through the overlay keeps a focus target when this tile leaves (Q1).
    const savedFocus = api.captureFocusedControl();

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
    entry.listeners.destroy();
    st.resizeObserver?.unobserve(entry.el);
    if (st.theatreTile === userId) api.leaveTheatre();
    st.lastInfo.delete(userId);

    entry.video.srcObject = null;
    syncVideoSurface(entry.video);

    entry.el.remove();
    st.cells.delete(userId);

    // If focused tile was removed, focus the first remaining tile or clear
    const wasFocusMode = st.focusedTileId !== null;
    if (st.focusedTileId === userId) {
      // Never onto a tile the view toggles hide.
      st.focusedTileId = [...st.cells].find(([, e]) => !e.el.hidden)?.[0] ?? null;
    }

    api.syncPeople();
    if (st.focusedTileId !== null || wasFocusMode) {
      api.rebuildFocusLayout();
    } else {
      api.relayout();
    }
    api.syncStatsPolling();
    api.restoreFocusedControl(savedFocus);
  }

  /** Remove every tile at once (trackCleanup + srcObject=null via dropTile).
   *  Deleting the current key mid-iteration is well-defined for Map — no
   *  entries are skipped — so this needs no snapshot copy of the keys. */
  function clearStreams(): void {
    for (const id of st.pendingWatch) api.forgetWatch(id);
    st.pendingWatch.clear();
    for (const userId of st.cells.keys()) {
      dropTile(userId);
    }
  }

  function hasStreams(): boolean {
    return st.cells.size > 0;
  }

  /** Every camera and avatar tile with whose state it marks, or null for a
   *  tile that marks none (a screen share, or a host-drawn avatar). */
  function stateTiles(): [HTMLDivElement, number | null][] {
    const tiles: [HTMLDivElement, number | null][] = [];
    for (const [id, entry] of st.cells) {
      const cfg = entry.config;
      tiles.push([entry.el, cfg?.isScreenshare === true ? null : (cfg?.audioUserId ?? id)]);
    }
    for (const person of st.people) {
      const cell = st.personCells.get(person.userId);
      if (cell !== undefined) {
        tiles.push([cell, person.marksOwnState === true ? null : person.userId]);
      }
    }
    return tiles;
  }

  function applySpeaking(): void {
    for (const [el, userId] of stateTiles()) {
      el.classList.toggle("video-cell--speaking", userId !== null && st.speaking.has(userId));
    }
  }

  /** Draw each camera and avatar tile's mute/deafen badge from the roster
   *  state. */
  function applyUserAudioState(): void {
    for (const [el, userId] of stateTiles()) {
      const state = userId === null ? undefined : st.userAudioState.get(userId);
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

  /** Draw each screen-share tile's viewer badge: the other members watching
   *  it, and you while a remote share plays here. Hidden at zero. */
  function applyStreamViewers(): void {
    for (const entry of st.cells.values()) {
      const config = entry.config;
      if (config?.isScreenshare !== true) continue;
      const badge = entry.el.querySelector<HTMLElement>(".video-viewers");
      if (badge === null) continue;
      const names = [...(st.streamViewers.get(config.audioUserId) ?? [])];
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
