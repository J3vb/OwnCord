/**
 * VideoGrid component — renders remote video streams in a responsive CSS grid.
 * Replaces the chat area when cameras are active.
 */

import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import { USER_LOCAL_MUTE_CHANGED } from "@lib/constants";
import { syncVideoSurface } from "@lib/voice/videoSurface";
import type { MountableComponent } from "@lib/text/safeRender";
import { voiceText } from "../i18n/voice";
import type { StreamInfo } from "./video-grid/streamInfo";
import type { VoiceModMenuOptions } from "./channel-sidebar/volumeMenu";
import type { StreamSample, VideoView } from "../features/voice/remoteTracks";
import type { ShareSenderSample } from "../features/voice/shareSenderStats";
import type { CellEntry } from "./video-grid/gridShared";
import type { GridState, GridApi } from "./video-grid/gridState";
import { createGridLayout } from "./video-grid/gridLayout";
import { createGridCallBar } from "./video-grid/gridCallBar";
import { createGridWatch } from "./video-grid/gridWatch";
import { createGridStreams } from "./video-grid/gridStreams";

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
    /** Front to back camera and back: shown while the camera is on, once
     *  `available` says this device has both. */
    readonly cameraFlip?: {
      readonly available: () => Promise<boolean>;
      readonly flip: () => Promise<void>;
    };
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

export { computeGridLayout, type GridLayout } from "./video-grid/gridShared";

export function createVideoGrid(): VideoGridComponent {
  const st: GridState = {
    root: null,
    cells: new Map<number, CellEntry>(),
    focusedTileId: null,
    people: [],
    personCells: new Map<number, HTMLDivElement>(),
    resizeObserver: null,
    resizeRafId: 0,
    rafWindow: window,
    callbacks: {},
    speaking: new Set(),
    userAudioState: new Map(),
    streamViewers: new Map(),
    fullscreenTile: null,
    theatreTile: null,
    phoneFullscreen: null,
    callState: { muted: false, deafened: false, listenOnly: false },
    flipCheck: "idle",
    flipCheckGen: 0,
    flipping: false,
    exitBtn: null,
    callView: false,
    viewBar: null,
    callBar: null,
    viewOn: { nonVideo: true, selfCamera: true, strip: true },
    statsTimer: null,
    statsTile: null,
    viewResizeTimer: null,
    pendingWatch: new Set<number>(),
    gridListeners: new Disposable(),
    callPop: null,
    callHome: null,
    popBtn: null,
    popRestore: true,
    lastInfo: new Map<number, StreamInfo>(),
    infoModule: null,
    miniRequest: 0,
  };
  const api = {} as GridApi;
  Object.assign(
    api,
    createGridLayout(st, api),
    createGridCallBar(st, api),
    createGridWatch(st, api),
    createGridStreams(st, api),
  );

  function setPeople(next: readonly GridPerson[]): void {
    st.people = next;
    api.relayout();
  }

  function setSpeaking(userIds: ReadonlySet<number>): void {
    st.speaking = userIds;
    api.applySpeaking();
  }

  function setUserAudioState(
    state: ReadonlyMap<number, { muted: boolean; deafened: boolean }>,
  ): void {
    st.userAudioState = state;
    api.applyUserAudioState();
  }

  function setStreamViewers(viewers: ReadonlyMap<number, readonly string[]>): void {
    st.streamViewers = viewers;
    api.applyStreamViewers();
  }

  function mount(container: Element): void {
    api.loadViewPrefs();
    st.root = createElement("div", {
      class: "video-grid",
      "data-testid": "video-grid",
      // Programmatic fallback target: when the focused tile control is gone
      // (its peer left), focus lands here rather than dropping to <body>.
      tabindex: "-1",
    });

    // An exit control, always reachable in focus mode too: the focused
    // tile's own "Back to grid" nav can be scrolled off, and an empty grid
    // could otherwise cover the chat with no way back (OC video-grid exit).
    st.exitBtn = createElement("button", {
      type: "button",
      class: "video-grid__exit",
      "aria-label": voiceText("grid.showChat"),
      title: voiceText("grid.showChat"),
      "data-tile-control": "exit-grid",
    });
    st.exitBtn.appendChild(createIcon("message-square", 18));
    st.exitBtn.hidden = true;
    st.exitBtn.addEventListener("click", () => {
      // Clearing the grid's own focus keeps it consistent if the host only
      // hides the grid (rather than tearing it down) and later reopens it.
      api.setFocusedTile(null);
      st.callbacks.onExitGrid?.();
    });
    st.root.appendChild(st.exitBtn);

    container.appendChild(st.root);
    if (st.callView) api.setCallView(true);
    document.addEventListener("fullscreenchange", api.onFullscreenChange, {
      signal: st.gridListeners.signal,
    });
    document.addEventListener("keydown", api.onTheatreKey, { signal: st.gridListeners.signal });
    document.addEventListener("visibilitychange", api.syncViews, {
      signal: st.gridListeners.signal,
    });
    window.addEventListener(USER_LOCAL_MUTE_CHANGED, api.onUserLocalMute, {
      signal: st.gridListeners.signal,
    });

    // Observe container size changes to recalculate tile layout, and the
    // remote tiles' sizes (0 once the grid is closed) for their video views.
    api.observeGrid();
  }

  function destroy(): void {
    api.closeCallPopout(false);
    if (st.theatreTile !== null) api.leaveTheatre();
    if (st.fullscreenTile !== null) {
      st.fullscreenTile = null;
      api.leaveFullscreen();
      void st.callbacks.setWindowFullscreen?.(false).catch(() => {});
    }
    st.phoneFullscreen?.end();
    st.phoneFullscreen = null;
    st.gridListeners.destroy();
    if (st.statsTimer !== null) {
      clearInterval(st.statsTimer);
      st.statsTimer = null;
    }
    st.statsTile = null;
    if (st.resizeRafId !== 0) st.rafWindow.cancelAnimationFrame(st.resizeRafId);
    st.resizeRafId = 0;
    if (st.viewResizeTimer !== null) clearTimeout(st.viewResizeTimer);
    st.viewResizeTimer = null;

    if (st.resizeObserver !== null) {
      st.resizeObserver.disconnect();
      st.resizeObserver = null;
    }

    for (const [tileId, entry] of st.cells) {
      // An ended tile still holds its stream's watch for a re-share.
      if (entry.ending !== undefined) api.forgetWatch(tileId);
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
    st.cells.clear();
    st.focusedTileId = null;
    st.people = [];
    st.personCells.clear();
    st.callView = false;
    st.viewBar = null;
    st.popBtn = null;
    st.callBar = null;

    if (st.root !== null) {
      st.root.remove();
      st.root = null;
    }
  }

  return {
    mount,
    destroy,
    addStream: api.addStream,
    watch: api.watch,
    setLabel: api.setLabel,
    removeStream: api.removeStream,
    clearStreams: api.clearStreams,
    hasStreams: api.hasStreams,
    setFocusedTile: api.setFocusedTile,
    getFocusedTileId: api.getFocusedTileIdFn,
    setPeople,
    setSpeaking,
    setUserAudioState,
    setStreamViewers,
    setCallbacks(next: VideoGridCallbacks): void {
      st.callbacks = next;
      if (st.callView) {
        // The control bar is built from the callbacks: rebuild it.
        st.callBar?.remove();
        st.callBar = null;
        api.setCallView(true);
      }
    },
    setCallState(next: CallState): void {
      st.callState = { ...next };
      for (const bar of st.root?.querySelectorAll(".video-fs-calls") ?? []) api.drawCallState(bar);
    },
    setExitVisible: api.setCallView,
    showMiniPlayer: api.showMiniPlayer,
    hideMiniPlayer: api.hideMiniPlayer,
    raiseCallPopout(): boolean {
      st.callPop?.focus();
      return st.callPop !== null;
    },
  };
}
