/** The mutable state one main page instance keeps, shared by its modules. */
import type { MountableComponent } from "@lib/text/safeRender";
import type { UserStatus } from "@lib/types";
import type { VideoGridComponent } from "@components/VideoGrid";
import type { ServerBannerControl } from "@components/ServerBanner";
import type { ToastContainer } from "@components/Toast";
import type { AutoIdleController } from "@lib/presence/autoIdle";
import type { GameActivityLoop } from "@lib/presence/gameActivity";
import type { MusicActivityLoop } from "@lib/presence/musicActivity";
import type { StatusTimerWatcher } from "@lib/presence/statusTimer";
import type { CallChat } from "./callChat";
import type { MessageController } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import type { VideoModeController, VideoPanelHost } from "./VideoModeController";
import type { ChannelController } from "./ChannelController";
import type { DmProfileSidebarComponent } from "@components/DmProfileSidebar";
import type { GroupMemberPanelController } from "./GroupMemberPanelController";
import type { IncomingCallBannerComponent } from "@components/IncomingCallBanner";
import type { RingController, OutgoingCall } from "@lib/voice/callRing";
import type { DmCallPanelComponent } from "../../features/direct-messages/DmCallPanel";
import type { SidebarDrawer } from "./SidebarDrawer";
import type { MemberColumn } from "./MemberColumn";
import type { ContentNavigator } from "../../features/navigation/contentView";
import type { MainPageOptions } from "../MainPage";

import type { Disposable } from "@lib/disposable";
import type { ApiClient } from "@lib/api";
import type { VoiceState } from "@stores/voice.store";
import type { SidebarAreaResult } from "./SidebarArea";
import type { ChatAreaResult } from "./ChatArea";
import type { QuickSwitcherManager } from "./OverlayManagers";
import type { VoiceWidgetCallbacks } from "./VoiceCallbacks";
import type { GlobalShortcutVks } from "../../lib/voice/voiceShortcuts";
import type { Channel } from "../../stores/channels.store";
import type { VoiceModMenuOptions } from "../../components/channel-sidebar/volumeMenu";
export interface PageState {
  readonly options: MainPageOptions;
  readonly ws: MainPageOptions["ws"];
  readonly api: MainPageOptions["api"];
  readonly apiConfig: Readonly<import("@lib/api").ApiClientConfig>;
  readonly cacheScope: string | null;
  readonly unsubCacheScope: () => void;
  readonly limiters: import("@lib/net/rateLimiter").RateLimiterSet;
  readonly presenceSender: import("@lib/presence/presence").PresenceSender;
  container: Element | null;
  root: HTMLDivElement | null;
  /** Set by destroy(), so a lazily-loaded controller that resolves after the
   *  page is gone never mounts its listeners onto a dead tree. */
  tornDown: boolean;
  // Child components tracked for cleanup
  children: MountableComponent[];
  unsubscribers: Array<() => void>;
  // Refs we need to update reactively
  banner: ServerBannerControl | null;
  // Video grid (owned by ChatArea, referenced for remote video wiring)
  videoGrid: VideoGridComponent | null;
  // Extracted controllers (created in mount)
  msgCtrl: MessageController | null;
  reactionCtrl: ReactionController | null;
  videoModeCtrl: VideoModeController | null;
  callChat: CallChat | null;
  channelCtrl: ChannelController | null;
  /** Inactivity watcher that flips the status to idle after ten quiet
   *  minutes. Started once the socket is up, torn down with the page. */
  autoIdle: AutoIdleController | null;
  /** Reports the game running on this machine. Desktop only, and
   *  loaded on first use so the web build and the startup path never carry it. */
  gameActivity: GameActivityLoop | null;
  musicActivity: MusicActivityLoop | null;
  speakingActivityTimer: ReturnType<typeof setInterval> | null;
  statusTimerWatcher: StatusTimerWatcher | null;
  // Toast container for user-facing error feedback
  toast: ToastContainer | null;
  // DM profile sidebar (right panel, toggled via DM header click)
  dmProfileSidebar: DmProfileSidebarComponent | null;
  dmProfileSlot: HTMLDivElement | null;
  /** The header's "Show User Profile" toggle; its aria-pressed follows the panel. */
  dmProfileBtn: HTMLButtonElement | null;
  /** The DM the open panel shows; moves with a DM-to-DM switch. */
  dmProfileChannelId: number;
  /** Tears down the store subscriptions that keep an open profile panel's
   *  status/name live (see toggleDmProfile) -- null while the panel is
   *  closed. Always cleared alongside dmProfileSidebar itself. */
  dmProfileUnsub: (() => void) | null;
  /** The in-flight load of the lazily-imported panel -- non-null from an open
   *  click until the panel mounts. The panel opens rarely (a DM header click),
   *  so its code stays out of the eager bundle. A pending load counts as open,
   *  and closeDmProfile clears it, so the import mounts only if it is still
   *  the current load when it resolves. */
  dmProfileLoad: object | null;
  // Group DM member panel: mounted in the same slot as the 1:1
  // profile panel, only one of the two showing at a time.
  // The controller's code loads the first time a group DM is on screen, so a
  // session that never opens one never pays for it.
  groupPanelCtrl: GroupMemberPanelController | null;
  groupPanelLoad: Promise<void> | null;
  /** The header's "Show Member List" toggle; its aria-pressed follows the panel. */
  dmMembersBtn: HTMLButtonElement | null;
  // The content view (Message Requests, Moderation) shown in place of
  // the chat column. Created in mount, once the chat column exists.
  contentNav: ContentNavigator | null;
  // DM calls: the banner draws a ring, the controller owns its lifetime.
  callBanner: IncomingCallBannerComponent | null;
  ringCtrl: RingController | null;
  // The caller's side of a ring, and the in-DM panel that draws both sides.
  outgoingCall: OutgoingCall | null;
  callPanel: DmCallPanelComponent | null;
  /** The loaded panel as the video controller's host: one object per panel,
   *  since the controller tells hosts apart by identity. */
  callPanelHost: VideoPanelHost | null;
  /** "Join with video": turn the camera on once this call is connected. */
  cameraOnJoin: number | null;
  // The narrow-width sidebar drawer (WCAG 1.4.10). Null above 800px in
  // practice, but always created so the breakpoint is decided by CSS, not JS.
  sidebarDrawer: SidebarDrawer | null;
  // The right-hand member column's controller (3C-6b). Loaded on demand; the
  // <aside> itself always exists so the header toggle's aria-controls resolves.
  memberColumn: MemberColumn | null;
  /** The call view is up in this window (callChat's capable state). */
  callViewUp: boolean;
  lastRingAt: number;
  /** Envelope id of the newest call_ring, so a refusal answering an earlier
   *  ring cannot clear a newer outgoing call. */
  lastRingId: string | null;
  ringTimer: ReturnType<typeof setTimeout> | null;
  ringJoinWatch: (() => void) | null;
}

/** Every function the main page's modules share, filled in once by createMainPage. */
export interface PageApi {
  withGroupPanel(act: (ctrl: GroupMemberPanelController) => void, force?: boolean): void;
  toggleDmProfile(): void;
  closeDmProfileByUser(): void;
  syncDmProfileButton(): void;
  syncDmProfileToActive(): void;
  bindDmProfileLive(channelId: number, recipientId: number): void;
  dmProfileBlockName(fallback: string): string;
  openDmProfileFor(channelId: number, focus: boolean): boolean;
  closeDmProfile(): void;
  joinDmCall(channelId: number): void;
  startCall(withVideo?: boolean): void;
  cancelPendingRing(): void;
  ringAfterJoin(channelId: number): void;
  ringCallees(channelId: number, inCall?: boolean): void;
  sendRing(channelId: number): void;
  syncRingSurfaces(): void;
  acceptRing(withVideo: boolean): void;
  restoreSavedPresence(): void;
  applyPresence(status: UserStatus): void;
}

/** The values main page's mount() builds, shared by its mount steps. */
export interface MountScope {
  target: Element;
  // "Use here" takes the connection back: this device connects again and
  // the server displaces the other one (last connect wins). It serves both
  // a displaced socket (SESSION_REPLACED) and a wake reconnect the server
  // refused because another device held the session (ANOTHER_DEVICE_ACTIVE,
  // U4) — the two are the same user choice, so they share one prompt.
  useHere: () => void;
  // Retry is safe on a plain disconnect: connect() re-dials and the native
  // proxy re-validates the certificate, so a TOFU mismatch re-latches rather
  // than being bypassed. It also cancels any pending backoff attempt, so it
  // cannot race the reconnect loop.
  retryConnection: () => void;
  // Signed-in-elsewhere outranks the connection status it leaves behind
  // ("disconnected"), so every banner refresh goes through here. The device's
  // own network fact stays apart from the server's reachability: a LAN server
  // with no internet still answers onLine, and `undefined` (host without the
  // API) never claims the internet is required.
  syncBanner: () => void;
  // Losing or regaining the device's network only re-renders, so the banner
  // says the true thing immediately; the reconnect loop and Retry own
  // recovery. Only re-render while the socket is actually down — a network
  // flap during a live connection (a VPN toggle, a Wi-Fi flap) must not
  // route to `applyConnectionStatus("connected")` and clear an announced
  // server-restart countdown. Owned by a Disposable so the lifecycle guard
  // sees both listeners torn down with the page.
  networkOwner: Disposable;
  syncBannerIfNotConnected: () => void;
  // A sign-in not yet reviewed: listed on connect and on window focus.
  sessionNotice: Disposable;
  pollSessions: () => void;
  // --- Main .app row ---
  app: HTMLDivElement;
  // --- Sidebar (server strip + channel sidebar + voice widget + user bar) ---
  sidebar: SidebarAreaResult;
  // --- Chat area ---
  chatAreaResult: ChatAreaResult;
  // Opening the call view selects the voice channel; its chat sits beside the grid.
  callChatBtn: HTMLButtonElement;
  // The composer of the channel on screen, else the header's menu button
  // (shown only at narrow width, where the closed sidebar is inert), else
  // the sidebar's first control that is not hidden (a hidden header action
  // — Invite or Audit Log without the permission, Mark All as Read with
  // nothing unread — would swallow the focus call and leave it on <body>):
  // the first of them that takes focus.
  focusReachable: () => HTMLElement | null;
  // The member column: always present, hidden until MemberColumn shows it.
  memberColumnEl: HTMLElement;
  memberColumnBody: HTMLDivElement;
  // The server rail sits left of the sidebar. The web portal serves exactly
  // one server, so it has none there. The slot holds the rail's width while
  // the rail loads on demand, keeping it out of the eager MainPage chunk.
  railSlot: HTMLDivElement | null;
  layoutOwner: Disposable;
  // --- Moderation notices: persistent, above the app row ---
  notices: Disposable;
  // Settings overlay
  // Bumped by every local 2FA change so an in-flight profile refresh
  // cannot overwrite it with an older answer.
  totpEpoch: number;
  safety: { readonly build: (signal: AbortSignal, api: ApiClient) => HTMLDivElement } | undefined;
  settingsOverlay: MountableComponent & { open(): void; close(): void };
  // Quick switcher (Ctrl+K)
  // Don't fire while the settings panel is on top of it — same guard as
  // attachGlobalKeybinds below, reading the same source of truth.
  qsManager: QuickSwitcherManager;
  // The rest of the shortcuts listed on the settings Keybinds tab.
  voiceKeybindActions: VoiceWidgetCallbacks;
  shortcutsOverlay: typeof import("@components/ShortcutsOverlay") | null;
  shortcutsClosed: boolean;
  // Once the poller runs it also sees the keys while the window is focused,
  // so the in-app handler stands down to avoid a double toggle. The flag is
  // set before start() so a press during startup is missed, never doubled.
  // On a Wayland session the desktop's shortcut service is the "poller": it
  // is live only once both keys are bound, so the flag follows the host's
  // status changes too (a bind, the user editing the keys, a portal restart).
  // start() runs whether or not the host says it is supported: the host
  // decides whether anything can observe keys, and on Wayland it arms the
  // portal so a press from a key the compositor itself was told to deliver
  // (Hyprland: the portal names no keys, so it never reads as bound) gets
  // through. Only the in-app stand-down follows `supported`.
  // Answers can arrive out of order (a status change during startup), so
  // only the latest query may set the flag.
  refreshSeq: number;
  refreshGlobalKeys: () => void;
  // Push the persisted rebind onto the running poller at startup, so a
  // choice made in Settings survives a restart (the native default is
  // Ctrl+Shift+M / Ctrl+Shift+D).
  globalKeys: GlobalShortcutVks;
  // The label shown on a video tile: memberDisplayName when known —
  // the same identity a rename shows everywhere else (ChannelSidebar's
  // voice roster, message rows, the member list) — falling back to the
  // voice roster's (possibly frozen) username, then a placeholder. Single
  // writer so tile creation (setOnRemoteVideo below) and tile relabeling
  // on a mid-call rename (the voiceStore subscriber below) cannot disagree.
  //
  // Self-aware, because the relabel loop walks the whole voice roster and the
  // roster includes you: VideoModeController registers the local tiles as
  // "<name> (You)" / "Your Screen", and a bare remote label written over them
  // leaves your own tile indistinguishable from a participant's.
  // These two branches must keep matching VideoModeController's addStream
  // labels — that is what the test pins.
  tileMenu: {
    readonly onProfile?: (userId: number, x: number, y: number) => void;
    readonly onMessage?: (userId: number) => void;
    readonly moderation?: (userId: number) => VoiceModMenuOptions | string | undefined;
  } & { readonly destroy: () => void };
  prevVideoSignature: string;
  prevSpeaking: string;
  prevAudioState: string;
  prevViewers: string;
  prevCallState: string;
  /** Your call state for the grid's call controls, from the voice store and
   *  the chat socket (camera and share freeze while it is down). */
  syncCallState: (state: VoiceState) => void;
  prevTileLabels: Map<number, string>;
  // A page rebuilt while already in voice (reconnect) loads the grid now.
  gridLoadChannel: number | null;
  // Release notes, once, on the first start after an update. Loaded on
  // demand so the prompt stays out of the eager MainPage chunk (bundle budget).
  promptHost: HTMLDivElement;
  // Only the channel that owns the current call keeps the grid up: the joined
  // voice channel (its chat sits beside the grid) or the DM whose
  // call panel shows the video above the chat (its own update re-seats the
  // grid through onVideoHostChange). Every other channel mounts a chat
  // surface and must dismiss it, another voice channel's chat opened from
  // its menu included.
  showChatFor: (active: { id: number; type: string }) => void;
  // --- Subscribe to channel changes ---
  unsubChannels: () => void;
  active: Channel | null;
}
