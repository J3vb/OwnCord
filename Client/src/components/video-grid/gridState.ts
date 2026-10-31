/** The mutable state one video grid instance keeps, shared by its modules. */
import type { Disposable } from "@lib/disposable";
import type { IconName } from "@lib/icons";
import type { StreamInfo } from "./streamInfo";
import type { VideoView } from "../../features/voice/remoteTracks";
import type { PopoutWindow } from "../../features/voice/popout";
import type { ViewToggle, CellEntry } from "./gridShared";
import type { TileConfig, VideoGridCallbacks, GridPerson, CallState } from "../VideoGrid";

export interface GridState {
  root: HTMLDivElement | null;
  readonly cells: Map<number, CellEntry>;
  focusedTileId: number | null;
  people: readonly GridPerson[];
  readonly personCells: Map<number, HTMLDivElement>;
  resizeObserver: ResizeObserver | null;
  resizeRafId: number;
  /** The window `resizeRafId` was requested on. */
  rafWindow: Window;
  callbacks: VideoGridCallbacks;
  speaking: ReadonlySet<number>;
  userAudioState: ReadonlyMap<number, { muted: boolean; deafened: boolean }>;
  streamViewers: ReadonlyMap<number, readonly string[]>;
  /** The tile in HTML full screen, or in the theatre fallback. */
  fullscreenTile: number | null;
  theatreTile: number | null;
  /** Back and the landscape request held for a full-screen tile on a phone. */
  phoneFullscreen: { end(): void } | null;
  callState: CallState;
  /** Whether the flip button may show: asked once per camera-on. */
  flipCheck: "idle" | "checking" | "yes" | "no";
  flipCheckGen: number;
  flipping: boolean;
  exitBtn: HTMLButtonElement | null;
  /** The call view (setExitVisible): header toggles, control bar, filters. */
  callView: boolean;
  viewBar: HTMLElement | null;
  callBar: HTMLElement | null;
  readonly viewOn: Record<ViewToggle, boolean>;
  statsTimer: ReturnType<typeof setInterval> | null;
  statsTile: number | null;
  viewResizeTimer: ReturnType<typeof setTimeout> | null;
  /** Streams the voice roster asked to watch before their tile was offered. */
  readonly pendingWatch: Set<number>;
  /** Owns the grid's document listeners (full-screen changes, theatre keys). */
  readonly gridListeners: Disposable;
  /** The whole call in a window of its own (the call view's Pop out), and
   *  where the grid goes back to. */
  callPop: PopoutWindow | null;
  callHome: Element | null;
  popBtn: HTMLButtonElement | null;
  /** The pop-out closes for Bring back (true) or because the call view ended. */
  popRestore: boolean;
  readonly lastInfo: Map<number, StreamInfo>;
  /** The readout module, once a poll has loaded it (the chip shows only
   *  after one has). */
  infoModule: typeof import("./streamInfo") | null;
  /** Bumped by every show and hide, so a mini-player still loading opens
   *  only if nothing has changed the request since. */
  miniRequest: number;
}

/** Every function the grid's modules share, filled in once by createVideoGrid. */
export interface GridApi {
  doc(): Document;
  applyGridSizes(): void;
  syncPeople(): void;
  hiddenByView(el: HTMLDivElement, config: TileConfig | undefined): boolean;
  applyViewFilters(): void;
  shownTiles(): HTMLDivElement[];
  allTiles(): HTMLDivElement[];
  relayout(): void;
  scheduleResize(): void;
  captureFocusedControl(): { userId: number; control: string } | null;
  restoreFocusedControl(saved: { userId: number; control: string } | null): void;
  syncTileNav(): void;
  rebuildFocusLayout(): void;
  appendChrome(): void;
  isChrome(node: Node): boolean;
  beforeChrome(el: HTMLElement): void;
  setFocusedTile(tileId: number | null): void;
  isFullscreen(tileId: number): boolean;
  toggleFullscreen(tileId: number): void;
  leaveFullscreen(): void;
  enterTheatre(tileId: number): void;
  leaveTheatre(): void;
  onTheatreKey(e: KeyboardEvent): void;
  onFullscreenChange(): void;
  syncFullscreenUi(): void;
  observeGrid(): void;
  windowFullscreen(on: boolean): void;
  dropFullscreen(): void;
  buildCallControls(
    cc: NonNullable<VideoGridCallbacks["callControls"]>,
    inCallView?: boolean,
  ): HTMLElement;
  drawCallState(bar: Element): void;
  redrawCallBars(): void;
  syncFlipCheck(): void;
  mediaLockReason(): string | null;
  drawMediaButton(btn: HTMLButtonElement, on: boolean, icon: IconName): void;
  buildViewBar(): HTMLElement;
  syncPopButton(): void;
  popOutCall(): void;
  closeCallPopout(restore: boolean): void;
  bringCallBack(byUser: boolean): void;
  setView(key: ViewToggle, on: boolean): void;
  syncViewBar(): void;
  loadViewPrefs(): void;
  setCallView(on: boolean): void;
  syncStatsPolling(): void;
  pollStats(tileId: number): Promise<void>;
  toggleStats(tileId: number, chip: HTMLButtonElement): void;
  viewOf(id: number, entry: CellEntry): VideoView;
  syncViews(): void;
  scheduleViewSync(): void;
  togglePopout(tileId: number): void;
  bringBack(entry: CellEntry, byUser: boolean): void;
  watchedTile(): number | null;
  showMiniPlayer(): void;
  hideMiniPlayer(): void;
  getFocusedTileIdFn(): number | null;
  forgetWatch(tileId: number): void;
  setWatching(tileId: number, on: boolean): void;
  setStopped(tileId: number, stopped: boolean, moveFocus?: boolean): void;
  watch(tileId: number): void;
  attachTrackLifecycle(userId: number, stream: MediaStream): void;
  buildSelfCover(
    tileId: number,
    stream: MediaStream,
    hasAudio: boolean,
    signal: AbortSignal,
  ): HTMLDivElement;
  addStream(
    userId: number,
    username: string,
    stream: MediaStream | null,
    config?: TileConfig,
  ): void;
  tileMenuOptions(x: number, y: number, tileId: number, entry: CellEntry, config: TileConfig): void;
  selfMenuOptions(x: number, y: number, tileId: number, entry: CellEntry): void;
  applyVolume(audioUserId: number, isScreenshare: boolean, volume: number, muted: boolean): void;
  onUserLocalMute(e: Event): void;
  setLabel(userId: number, username: string, name?: string): void;
  removeStream(userId: number): void;
  holdForRepublish(userId: number, entry: CellEntry, owner: number, screenshare: boolean): void;
  endStream(userId: number): void;
  dropTile(userId: number, keepWatch?: boolean): void;
  clearStreams(): void;
  hasStreams(): boolean;
  stateTiles(): [HTMLDivElement, number | null][];
  applySpeaking(): void;
  applyUserAudioState(): void;
  applyStreamViewers(): void;
}
