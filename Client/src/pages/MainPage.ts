// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { addServer, loadSavedServers, switchToServer } from "../features/server-rail/switchServer";
import {
  confirmAndJoinInvite,
  currentServerName,
  parseInviteInput,
} from "../features/server-rail/joinInvite";
import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import type { WsClient } from "@lib/ws";
import { bracketBareIPv6Host } from "@lib/ws";
import type { UserStatus } from "@lib/types";
import { ApiClientError, errorText } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { desktop } from "../platform/desktop";
import { createRateLimiterSet } from "@lib/net/rateLimiter";
import type { CallState, VideoGridComponent } from "@components/VideoGrid";
import { isConnecting } from "@components/voiceStatusText";
import { createServerBanner, applyConnectionStatus } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import type { ToastContainer } from "@components/Toast";
import { initToast, teardownToast, showToast, showChangeOutcomeToast } from "@lib/ui/toast";
import { accountText as account } from "../i18n/account";
import { dmCallText } from "../i18n/dmCall";
import { shellText } from "../i18n/shell";
import { joinBackoffText } from "../features/voice/joinBackoffText";
import { shareBlockReason } from "../features/voice/shareGate";
import { sessionNoticeMessage, startSessionNotice } from "@lib/net/sessionNotice";
import { logout } from "@lib/net/logout";
import { authStore, clearAuth, onAuthCleared, updateUser } from "@stores/auth.store";
import { closeSettings, openSettings, setSessionReplaced, uiStore } from "@stores/ui.store";
import { loadUserStatus } from "@lib/presence/userStatus";
import { loadGlobalShortcutVks } from "@lib/voice/voiceShortcuts";
import {
  anyTriggerBound,
  clearPortalBound,
  globalKeysErrorCode,
  portalBoundBefore,
} from "@lib/ui/globalKeys";
import { loadPref, onPrefChange, savePref } from "@lib/prefs/preferences";
import { createPresenceSender, setActivePresenceSender } from "@lib/presence/presence";
import { startAutoIdle, type AutoIdleController } from "@lib/presence/autoIdle";
import type { GameActivityLoop } from "@lib/presence/gameActivity";
import type { MusicActivityLoop } from "@lib/presence/musicActivity";
import { startStatusTimerWatcher, type StatusTimerWatcher } from "@lib/presence/statusTimer";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { watchGroupDmExits } from "../features/direct-messages/groupExitWatch";
import {
  voiceStore,
  isSelfMuted,
  restoreSavedSelfVoiceState,
  streamViewers,
} from "@stores/voice.store";
import type { VoiceState } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import {
  cleanupAll as voiceCleanupAll,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
  enableCamera,
  getRemoteVideoStats,
  getLocalScreenshareStats,
  setRemoteVideoView,
  setRemoteVideoWatched,
  forgetRemoteVideoWatch,
} from "@lib/voice/livekitSession";
import { setServerHost } from "@components/message-list/renderers";
import {
  pruneAttachmentCacheScope,
  setAttachmentCacheScope,
} from "@components/message-list/attachments";
import { closeActiveLightbox } from "@components/message-list/media";
import {
  setReactionUsersFetcher,
  clearReactionUsersCache,
} from "../features/messaging/reactionUsers";
import { createNotesContext, setNotesContextSource } from "../features/profiles/userNotes";
import { markAllRead, setMarkReadSender } from "@lib/read-state";
import { setMarkUnreadSender } from "@components/message-list/mark-unread";
import { onChannelReselect, stepChannel } from "@lib/nav/channelNavigation";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
import { setAudioVolumeHost } from "@lib/voice/audioElements";
import { setScreenSourcePicker } from "../features/voice/native/screenPickerSlot";
import { createQuickSwitcherManager } from "./main-page/OverlayManagers";
import { attachGlobalKeybinds } from "./main-page/GlobalKeybinds";
import { createVoiceWidgetCallbacks } from "./main-page/VoiceCallbacks";
import { setChatHeaderCallChat } from "./main-page/ChatHeader";
import { createCallChat, type CallChat } from "./main-page/callChat";
import { createMessageController } from "./main-page/MessageController";
import type { MessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import type { ReactionController } from "./main-page/ReactionController";
import { createVideoModeController } from "./main-page/VideoModeController";
import type { VideoModeController, VideoPanelHost } from "./main-page/VideoModeController";
import { createChannelController } from "./main-page/ChannelController";
import type { ChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import type { DmProfileData, DmProfileSidebarComponent } from "@components/DmProfileSidebar";
import type { GroupMemberPanelController } from "./main-page/GroupMemberPanelController";
import { createIncomingCallBanner } from "@components/IncomingCallBanner";
import type { IncomingCallBannerComponent } from "@components/IncomingCallBanner";
import { createRingController, createOutgoingCall } from "@lib/voice/callRing";
import type { RingController, OutgoingCall } from "@lib/voice/callRing";
import type { DmCallPanelComponent } from "@components/DmCallPanel";
import {
  startRingChime,
  stopRingChime,
  startRingback,
  stopRingback,
} from "@lib/media/notificationSound";
import { startVoiceUiSounds } from "../features/voice/uiSounds";
import { createSidebarVoiceCallbacks } from "./main-page/VoiceCallbacks";
import { createSidebarArea } from "./main-page/SidebarArea";
import { createTileMenuActions } from "./main-page/tileMenuActions";
import { createChatArea } from "./main-page/ChatArea";
import type { SidebarDrawer } from "./main-page/SidebarDrawer";
import type { MemberColumn } from "./main-page/MemberColumn";
import { loadMemberLayout, MEMBER_LAYOUT_PREF } from "../features/members/memberLayout";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { NAVIGATION_DESTINATIONS } from "../features/navigation/destinations";
import { createContentNavigator } from "../features/navigation/contentView";
import { createNoticesBanner } from "../features/safety/Notices";
import type { ContentNavigator } from "../features/navigation/contentView";

const log = createLogger("main-page");
/** Long enough to read which sign-in it names (cf. toast.ts PARTIAL_SUCCESS_TOAST_MS). */
const SESSION_NOTICE_TOAST_MS = 12_000;

/** Whether the native voice-shortcut poller runs. App-wide, not per page: the
 *  poller outlives a logout or server switch, so a remount keeps standing down. */
let globalPollerActive = false;
/**
 * The call notification and missed-call notice. They are re-exported by the
 * DM call panel, which the page already loads at mount, so the ring's OS alert
 * costs no second dynamic chunk here.
 */
const callAlerts = () => import("@components/DmCallPanel");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MainPageOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  /** The connected server's retention sentence, or null when unknown. */
  readonly getRetentionNotice?: () => string | null;
}

// ---------------------------------------------------------------------------
// MainPage
// ---------------------------------------------------------------------------

/** The person's name as every identity surface shows it, or undefined. */
function personName(userId: number): string | undefined {
  const voice = voiceStore.getState();
  const channelId = voice.currentChannelId;
  const channelUsers = channelId !== null ? voice.voiceUsers.get(channelId) : undefined;
  const voiceUser = channelUsers?.get(userId);
  const member = membersStore.getState().members.get(userId);
  return (member !== undefined ? memberDisplayName(member) : "") || voiceUser?.username;
}

/** What the DM profile panel repaints from a member's song. */
function listeningKey(l: DmProfileData["listening"] | undefined): string {
  return l == null ? "" : `${l.title}|${l.artist}|${l.player}|${l.startedAt}|${l.durationMs}`;
}

/** Saved preference: the 1:1 DM profile panel opens with the conversation. */
const DM_PROFILE_PREF = "dmProfileOpen";

/**
 * Build the profile panel's data from the live stores for a 1:1 DM channel.
 * Null for a group (no single "recipient" -- see the caller) or a channel
 * that is no longer a DM. Shared by the initial open and by the live
 * refresh below so the two can never disagree on how a status/name is
 * derived.
 */
function buildDmProfileUser(channelId: number): DmProfileData | null {
  const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
  // A group has no single "recipient" — dm.store.ts documents .recipient as
  // just the first of .participants for a group, with group-correct code
  // expected to read .participants instead. A 1:1 profile panel built from
  // it would present one arbitrary member's identity as the conversation.
  if (dmChannel === undefined || dmChannel.isGroup) return null;

  const recipient = dmChannel.recipient;
  // Prefer membersStore's status, like the chat header's refreshDmHeader
  // does (ChannelController.ts) -- falling back to dmStore's own copy keeps
  // this correct even for a DM partner who isn't a guild member.
  const member = membersStore.getState().members.get(recipient.id);
  const rawStatus = member?.status ?? recipient.status;
  const status =
    rawStatus === "online" || rawStatus === "idle" || rawStatus === "dnd" || rawStatus === "offline"
      ? rawStatus
      : ("offline" as const);

  return {
    id: recipient.id,
    username: recipient.username,
    // The DM header this panel opens from renders through dmDisplayName,
    // which prefers the nickname -- drop it here and the panel shows a
    // different identity from the header the reader just clicked.
    displayName: recipient.displayName ?? null,
    avatar: recipient.avatar || null,
    status,
    // The live copy first, as for the status; the DM list's own copy covers a
    // partner who is not a member of this server.
    activity: member === undefined ? (recipient.activity ?? null) : (member.activity ?? null),
    listening: member === undefined ? (recipient.listening ?? null) : (member.listening ?? null),
    about: null,
    joinDate: null,
    banner: member?.banner ?? null,
    banner_color: member?.banner_color ?? null,
  };
}

/**
 * Resolve a channel's display name. A DM is named by who is in it (or, for a
 * group, by its name), and the store is the authority on that — the channels
 * store carries a synthesised copy that can lag a rename or a departure.
 */
function resolveChannelName(channelId: number, channelName: string, channelType?: string): string {
  if (channelType === "dm") {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm !== undefined) return dmDisplayName(dm);
  }
  return channelName;
}

function getCurrentUserId(): number {
  return authStore.getState().user?.id ?? 0;
}

/**
 * The device's own network fact, apart from the server's reachability: a LAN
 * server with no internet still answers `onLine`. `undefined` where the host
 * does not expose the API, so a notice never claims the internet is required.
 */
function deviceNetworkOffline(): boolean | undefined {
  return typeof navigator.onLine === "boolean" ? !navigator.onLine : undefined;
}

export function createMainPage(options: MainPageOptions): MountableComponent {
  const { ws, api } = options;

  // Let voiceSession send signaling messages over this WS connection
  setWsClient(ws);

  // Set server host for resolving relative attachment URLs and LiveKit proxy
  const apiConfig = api.getConfig();
  if (apiConfig.host) {
    setServerHost(apiConfig.host);
    setLiveKitServerHost(apiConfig.host);
  }

  // Channel ids are only unique per server, so anything persisted under a bare
  // channel id collides across profiles in the multi-server client. Scope both
  // stores to the connected host — including the null case, so a disconnect
  // cannot leave the previous server's scope armed for the next connection.
  setChannelMutesHost(apiConfig.host ?? null);
  setAudioVolumeHost(apiConfig.host ?? null);
  // Mute and deafen outlive a restart; the next join applies them.
  restoreSavedSelfVoiceState();
  // Server images are cached per account, not per host: two accounts on one
  // server see different channels. Expired the moment auth clears, so a
  // profile switch isolates the cache even before this page is destroyed.
  const cacheScope = apiConfig.host ? `${apiConfig.host}#${getCurrentUserId()}` : null;
  setAttachmentCacheScope(cacheScope);
  const unsubCacheScope = onAuthCleared(() => setAttachmentCacheScope(null));

  // "Mark as Read" affordances need the socket but are reached from deep inside
  // the sidebar; register the sender once instead of threading ws through.
  setMarkReadSender((channelId, messageId) => {
    const payload = { channel_id: channelId };
    ws.send({
      type: "mark_read",
      payload: messageId === undefined ? payload : { ...payload, message_id: messageId },
    });
  });
  setMarkUnreadSender((channelId, messageId) =>
    ws.send({ type: "mark_unread", payload: { channel_id: channelId, message_id: messageId } }),
  );

  // The native screen-share picker adapter is a lower layer and may not import
  // a component; the UI registers the dialog here. It is loaded on
  // demand — the dialog is its own lazy chunk, not part of startup — and
  // the dynamic import is the sanctioned lower-layer-to-UI seam (Queue.ts's
  // NsfwGate does the same).
  setScreenSourcePicker((request) =>
    import("@components/ScreenSharePicker").then((m) => m.showScreenSharePicker(request)),
  );

  // The who-reacted tooltip fetches on hover; give it the live REST client the
  // same way the attachment renderer is given the server host.
  clearReactionUsersCache();
  setReactionUsersFetcher(async (channelId, messageId, emoji) => {
    const res = await api.getReactionUsers(channelId, messageId, emoji);
    return res.users;
  });

  // Cards opened from anywhere (member list, message author) take the notes
  // context of this session when they open, never later.
  setNotesContextSource(() => createNotesContext(api, apiConfig.host ?? ""));

  const limiters = createRateLimiterSet();

  // The one presence_update sender for this session — owns the limiter
  // token, the drop-window retry, and the local optimistic update, so
  // every producer (auto-idle, the settings Account tab via applyPresence
  // below, and the UserBar status picker it's threaded to through
  // SidebarArea) shares the exact same budget the server enforces (1
  // update / 10s, keyed by user id — service/channel.go). A limiter created
  // per producer instead cannot predict that shared, cross-surface budget.
  const presenceSender = createPresenceSender(ws, limiters.presence);
  // Publish this as the session's one PresenceSender so producers wired up
  // outside MainPage — main.ts's tray "status-change" listener — share the
  // same limiter token, coalescing retry, and optimistic update instead of
  // opening a second budget the server doesn't know about. Cleared
  // in this page's teardown, alongside presenceSender.destroy() below.
  setActivePresenceSender(presenceSender);

  let container: Element | null = null;
  let root: HTMLDivElement | null = null;
  /** Set by destroy(), so a lazily-loaded controller that resolves after the
   *  page is gone never mounts its listeners onto a dead tree. */
  let tornDown = false;

  // Child components tracked for cleanup
  let children: MountableComponent[] = [];
  let unsubscribers: Array<() => void> = [];

  // Refs we need to update reactively
  let banner: ServerBannerControl | null = null;
  // Video grid (owned by ChatArea, referenced for remote video wiring)
  let videoGrid: VideoGridComponent | null = null;

  // Extracted controllers (created in mount)
  let msgCtrl: MessageController | null = null;
  let reactionCtrl: ReactionController | null = null;
  let videoModeCtrl: VideoModeController | null = null;
  let callChat: CallChat | null = null;
  let channelCtrl: ChannelController | null = null;
  /** Inactivity watcher that flips the status to idle after ten quiet
   *  minutes. Started once the socket is up, torn down with the page. */
  let autoIdle: AutoIdleController | null = null;
  /** Reports the game running on this machine. Desktop only, and
   *  loaded on first use so the web build and the startup path never carry it. */
  let gameActivity: GameActivityLoop | null = null;
  let musicActivity: MusicActivityLoop | null = null;
  let speakingActivityTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimerWatcher: StatusTimerWatcher | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // DM profile sidebar (right panel, toggled via DM header click)
  let dmProfileSidebar: DmProfileSidebarComponent | null = null;
  let dmProfileSlot: HTMLDivElement | null = null;
  /** The header's "Show User Profile" toggle; its aria-pressed follows the panel. */
  let dmProfileBtn: HTMLButtonElement | null = null;
  /** The DM the open panel shows; moves with a DM-to-DM switch. */
  let dmProfileChannelId = 0;
  /** Tears down the store subscriptions that keep an open profile panel's
   *  status/name live (see toggleDmProfile) -- null while the panel is
   *  closed. Always cleared alongside dmProfileSidebar itself. */
  let dmProfileUnsub: (() => void) | null = null;
  /** The in-flight load of the lazily-imported panel -- non-null from an open
   *  click until the panel mounts. The panel opens rarely (a DM header click),
   *  so its code stays out of the eager bundle. A pending load counts as open,
   *  and closeDmProfile clears it, so the import mounts only if it is still
   *  the current load when it resolves. */
  let dmProfileLoad: object | null = null;

  // Group DM member panel: mounted in the same slot as the 1:1
  // profile panel, only one of the two showing at a time.
  // The controller's code loads the first time a group DM is on screen, so a
  // session that never opens one never pays for it.
  let groupPanelCtrl: GroupMemberPanelController | null = null;
  let groupPanelLoad: Promise<void> | null = null;
  /** The header's "Show Member List" toggle; its aria-pressed follows the panel. */
  let dmMembersBtn: HTMLButtonElement | null = null;

  /** Run `act` on the group panel controller, loading it first if a group DM
   *  is active (or `force`d by the header toggle). With no controller and no
   *  group on screen there is nothing to sync or close, so nothing loads. */
  function withGroupPanel(act: (ctrl: GroupMemberPanelController) => void, force = false): void {
    if (groupPanelCtrl !== null) {
      act(groupPanelCtrl);
      return;
    }
    const active = getActiveChannel();
    const groupActive =
      active !== null &&
      active.type === "dm" &&
      dmStore.getState().channels.some((c) => c.channelId === active.id && c.isGroup);
    if (!force && !groupActive) return;
    groupPanelLoad ??= import("./main-page/GroupMemberPanelController").then(
      ({ createGroupMemberPanelController }) => {
        if (tornDown) return;
        groupPanelCtrl = createGroupMemberPanelController({
          api,
          getSlot: () => dmProfileSlot,
          getButton: () => dmMembersBtn,
          notify: (message) => showToast(message, "error"),
        });
      },
      () => {
        // The chunk could not load; a later group switch or click retries.
        groupPanelLoad = null;
      },
    );
    void groupPanelLoad.then(() => {
      if (groupPanelCtrl !== null) act(groupPanelCtrl);
    });
  }

  // The content view (Message Requests, Moderation) shown in place of
  // the chat column. Created in mount, once the chat column exists.
  let contentNav: ContentNavigator | null = null;

  // DM calls: the banner draws a ring, the controller owns its lifetime.
  let callBanner: IncomingCallBannerComponent | null = null;
  let ringCtrl: RingController | null = null;
  // The caller's side of a ring, and the in-DM panel that draws both sides.
  let outgoingCall: OutgoingCall | null = null;
  let callPanel: DmCallPanelComponent | null = null;
  /** The loaded panel as the video controller's host: one object per panel,
   *  since the controller tells hosts apart by identity. */
  let callPanelHost: VideoPanelHost | null = null;
  /** "Join with video": turn the camera on once this call is connected. */
  let cameraOnJoin: number | null = null;

  // The narrow-width sidebar drawer (WCAG 1.4.10). Null above 800px in
  // practice, but always created so the breakpoint is decided by CSS, not JS.
  let sidebarDrawer: SidebarDrawer | null = null;

  // The right-hand member column's controller (3C-6b). Loaded on demand; the
  // <aside> itself always exists so the header toggle's aria-controls resolves.
  let memberColumn: MemberColumn | null = null;
  /** The call view is up in this window (callChat's capable state). */
  let callViewUp = false;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Re-assert the status the user picked, if the server disagrees.
   *
   * This used to fire on every connect, because the server stamped everyone
   * online at handshake and the client had to race to correct it — which is
   * what made a chosen Do Not Disturb (and "appear offline") flash online on
   * every reconnect. The server now reads the saved status and announces
   * *that*, so this is a no-op in the normal case and only speaks up when the
   * two genuinely differ (an older server, or a status changed while the
   * socket was down).
   */
  function restoreSavedPresence(): void {
    const status = loadUserStatus();
    const serverStatus = authStore.getState().user?.status;
    if (serverStatus === status) return;
    applyPresence(status);
  }

  /** Send a presence change and reflect it locally. Shared by the settings
   *  tab, the user bar and the auto-idle timer so all three agree.
   *
   *  The presence limiter is 1 token per 10s, and auto-idle's return-to-
   *  online fires unthrottled milliseconds after its own idle transition
   *  (autoIdle.ts) — routinely losing the token race. Dropping that frame
   *  silently would leave the server, and everyone else's member list,
   *  stuck on "idle" with nothing left to correct it. `presenceSender`
   *  retries once the window reopens instead, re-reading the status at that
   *  time so a burst of calls in between coalesces onto one retry carrying
   *  the latest value — see @lib/presence/presence. */
  function applyPresence(status: UserStatus): void {
    presenceSender.send(status);
  }

  /** Toggle the DM profile sidebar open/closed for the current DM partner.
   *
   *  The panel's code is loaded on first open (it is opened only by a DM
   *  header click, so it stays out of the eager MainPage chunk). The slot check
   *  and the DM-mode check run synchronously, and the panel mounts once the
   *  import resolves. A panel still loading counts as open, so the last click
   *  wins as it did when the panel mounted synchronously: a second click during
   *  the fetch closes it (the import is then dropped) and a third opens it
   *  again, and only one panel is ever mounted.
   */
  function toggleDmProfile(): void {
    if (dmProfileSlot === null) return;

    // If already open (or loading), close it
    if (dmProfileSidebar !== null || dmProfileLoad !== null) {
      closeDmProfileByUser();
      return;
    }

    // Only open in DM mode
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    if (openDmProfileFor(active.id, true)) savePref(DM_PROFILE_PREF, true);
  }

  /** A close the user asked for (the X, Escape, the header button): remembered. */
  function closeDmProfileByUser(): void {
    closeDmProfile();
    savePref(DM_PROFILE_PREF, false);
  }

  /** Mirror the panel's state on the header's "Show User Profile" toggle. */
  function syncDmProfileButton(): void {
    dmProfileBtn?.setAttribute(
      "aria-pressed",
      String(dmProfileSidebar !== null || dmProfileLoad !== null),
    );
  }

  /**
   * Make the panel match the active conversation, without touching the saved
   * preference: a 1:1 DM shows it while the preference is on (updated for the
   * new person on a DM-to-DM switch), a group or a server channel hides it.
   */
  function syncDmProfileToActive(): void {
    const active = getActiveChannel();
    if (active !== null && active.type === "dm" && loadPref<boolean>(DM_PROFILE_PREF, true)) {
      // Already showing: a switch to another 1:1 DM repaints the same panel
      // (no slide-in, no focus move) and follows the new person live.
      const next = dmProfileSidebar !== null ? buildDmProfileUser(active.id) : null;
      if (dmProfileSidebar !== null && next !== null) {
        bindDmProfileLive(active.id, next.id);
        dmProfileSidebar.update(next);
        return;
      }
      closeDmProfile();
      // It opened by itself: never take focus from what the user is typing in.
      openDmProfileFor(active.id, false);
      return;
    }
    closeDmProfile();
  }

  /**
   * Keep the panel's status and name live across presence/rename/nickname
   * changes for as long as it stays open on this DM -- otherwise it is painted
   * once from an open-time snapshot and never updated until re-mounted, leaving
   * it disagreeing with the chat header (which ChannelController's
   * refreshDmHeader already keeps live the same way). Re-binding replaces the
   * previous DM's subscriptions; closeDmProfile drops them.
   */
  function bindDmProfileLive(channelId: number, recipientId: number): void {
    dmProfileUnsub?.();
    dmProfileChannelId = channelId;
    const refresh = (): void => {
      const next = buildDmProfileUser(channelId);
      if (next !== null) dmProfileSidebar?.update(next);
    };
    const unsubMembers = membersStore.subscribeSelector(
      (s) =>
        `${s.members.get(recipientId)?.status ?? ""}|${s.members.get(recipientId)?.activity?.name ?? ""}|${listeningKey(s.members.get(recipientId)?.listening)}`,
      refresh,
    );
    // A banner change shows without reopening the panel.
    const unsubBanner = membersStore.subscribeSelector((s) => {
      const m = s.members.get(recipientId);
      return `${m?.banner ?? ""}|${m?.banner_color ?? ""}`;
    }, refresh);
    const unsubDm = dmStore.subscribeSelector(
      (s) => s.channels.find((c) => c.channelId === channelId),
      refresh,
    );
    dmProfileUnsub = () => {
      unsubMembers();
      unsubBanner();
      unsubDm();
    };
  }

  /** Who a Block confirm names: the person the panel shows now. */
  function dmProfileBlockName(fallback: string): string {
    const current = buildDmProfileUser(dmProfileChannelId);
    return current?.displayName ?? current?.username ?? fallback;
  }

  /** Mount the panel for a 1:1 DM; false (nothing opened) for a group or an unknown DM. */
  function openDmProfileFor(channelId: number, focus: boolean): boolean {
    if (dmProfileSlot === null) return false;
    const profileUser = buildDmProfileUser(channelId);
    if (profileUser === null) return false;

    const load = {};
    dmProfileLoad = load;
    syncDmProfileButton();
    void import("@components/DmProfileSidebar").then(
      ({ createDmProfileSidebar }) => {
        // A close (or teardown) since the click supersedes this import: drop it.
        if (tornDown || dmProfileLoad !== load || dmProfileSlot === null) return;
        dmProfileLoad = null;

        dmProfileSidebar = createDmProfileSidebar({
          user: profileUser,
          host: apiConfig.host ?? "",
          notes: createNotesContext(api, apiConfig.host ?? ""),
          focus,
          onClose: () => {
            closeDmProfileByUser();
          },
          onToggleBlock: (userId, block) => {
            void import("../features/blocks/blockActions").then(
              ({ confirmAndToggleBlock }) =>
                confirmAndToggleBlock(
                  { api, notify: showToast },
                  userId,
                  // The panel may have moved to another DM since it opened.
                  dmProfileBlockName(profileUser.username),
                  block,
                ),
              () =>
                showToast(
                  shellText(block ? "members.blockFailed" : "members.unblockFailed"),
                  "error",
                ),
            );
          },
        });
        dmProfileSidebar.mount(dmProfileSlot);
        syncDmProfileButton();

        bindDmProfileLive(channelId, profileUser.id);
      },
      () => {
        // The panel could not load; a later click may retry.
        if (dmProfileLoad === load) dmProfileLoad = null;
        syncDmProfileButton();
      },
    );
    return true;
  }

  /** Join a DM's live call: the call panel's Join strip and a call log row's Join button. */
  function joinDmCall(channelId: number): void {
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(shellText("channel.notConnected"), "error");
      return;
    }
    cameraOnJoin = null;
    createSidebarVoiceCallbacks(ws).onVoiceJoin(channelId);
  }

  /**
   * Start a call in the currently open DM: join its voice channel and ring the
   * other participants.
   *
   * Joining first is deliberate. A "call" is presence in the DM's voice
   * channel, so the ring is only truthful once the caller is actually there —
   * ringing first would offer an empty room to whoever accepts.
   */
  function startCall(withVideo = false): void {
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    // onVoiceJoin silently refuses to join when the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — without this check the ring
    // and "Calling…" toast fire anyway, promising a call nobody can hear.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(shellText("channel.notConnected"), "error");
      return;
    }
    cameraOnJoin = null;
    createSidebarVoiceCallbacks(ws).onVoiceJoin(active.id);
    if (withVideo) {
      const v = voiceStore.getState();
      if (v.currentChannelId === active.id && v.voiceStatus === "connected") {
        // Already in this call: the join was a no-op, so there is no
        // "connected" to wait for.
        if (!v.localCamera) {
          enableCamera().catch((err: unknown) => {
            log.error("Camera on call start failed", { error: String(err) });
          });
        }
      } else if (v.currentChannelId === active.id) {
        // The join started; the voiceStore subscriber turns the camera on once
        // connected. A refused join (backoff) leaves nothing armed.
        cameraOnJoin = active.id;
      }
    }
    ringAfterJoin(active.id);
  }

  /** The server allows one call_ring per user per 3s (Server/ws/handlers_call.go);
   *  a refused ring's error frame would also roll back a join still in flight.
   *  The extra 250ms covers transport jitter: lastRingAt is stamped before the
   *  async send, so two rings exactly 3s apart here can land under the window. */
  const RING_SPACING_MS = 3250;
  let lastRingAt = Number.NEGATIVE_INFINITY;
  /** Envelope id of the newest call_ring, so a refusal answering an earlier
   *  ring cannot clear a newer outgoing call. */
  let lastRingId: string | null = null;
  let ringTimer: ReturnType<typeof setTimeout> | null = null;
  let ringJoinWatch: (() => void) | null = null;

  function cancelPendingRing(): void {
    if (ringTimer !== null) clearTimeout(ringTimer);
    ringTimer = null;
    ringJoinWatch?.();
    ringJoinWatch = null;
  }

  /** Ring once the caller is actually in the channel; send nothing when the
   *  join was refused or the caller left. */
  function ringAfterJoin(channelId: number): void {
    cancelPendingRing();
    const settle = (): boolean => {
      const v = voiceStore.getState();
      if (v.currentChannelId !== channelId) {
        cancelPendingRing();
        return true;
      }
      // "securing" is E2EE setup and room.connect(): not yet in the room.
      if (v.voiceStatus === "joining" || v.voiceStatus === "securing") return false;
      ringJoinWatch?.();
      ringJoinWatch = null;
      ringCallees(channelId, true);
      return true;
    };
    if (settle()) return;
    ringJoinWatch = voiceStore.subscribe(() => void settle());
  }

  /** Send a ring no sooner than the server's window allows, through one owned
   *  timer, and start (or restart) the caller's 30s window when it goes out.
   *  The panel is the caller's feedback: it shows "Calling…" from then on,
   *  unless the call is already answered (a redial from inside a live call). */
  function ringCallees(channelId: number, inCall = false): void {
    cancelPendingRing();
    const wasHere = voiceStore.getState().currentChannelId === channelId;
    const wait = lastRingAt + RING_SPACING_MS - Date.now();
    if (wait > 0) {
      ringTimer = setTimeout(() => {
        ringTimer = null;
        const v = voiceStore.getState();
        // A ring that follows a join, or a redial from inside the call, needs
        // the caller still in it; Ring again pressed outside a call stays
        // valid until the caller moves to another channel.
        const here = v.currentChannelId === channelId;
        if (here || (!inCall && !wasHere && v.currentChannelId === null)) sendRing(channelId);
      }, wait);
      return;
    }
    sendRing(channelId);
  }

  function sendRing(channelId: number): void {
    // An unplanned drop keeps the voice channel, so a ring queued before it
    // would otherwise show "Calling…" for 30s with nobody notified.
    if (uiStore.getState().connectionStatus !== "connected") return;
    lastRingAt = Date.now();
    lastRingId = ws.send({ type: "call_ring", payload: { channel_id: channelId } });
    const roster = voiceStore.getState().voiceUsers.get(channelId);
    const self = getCurrentUserId();
    // The ring above already went out to the whole DM (a group redial from inside
    // a live call too, 3B-8); with someone else in the room there is no
    // "Calling…" to show, and the voice subscription would clear it at once.
    if (roster !== undefined && [...roster.keys()].some((id) => id !== self)) return;
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    // The server drops rings to offline members, so waiting on them would
    // hold "Calling…" to the 30s timeout after every online callee declined.
    // Keep them when nobody is online: nothing else to wait on.
    const all = dm?.participants ?? [];
    const online = all.filter((p) => p.status !== "offline");
    outgoingCall?.start(
      channelId,
      (online.length > 0 ? online : all).map((p) => p.id),
      // A 1:1 callee shown offline is told at once. The ring above still
      // went out: an invisible contact shows offline but can answer.
      dm?.isGroup === false && online.length === 0,
    );
  }

  /**
   * Draw the incoming ring on exactly one surface. While the ringing DM is on
   * screen the call panel is the answer surface and the banner stays hidden,
   * so there are never two Accept buttons; everywhere else the banner is the
   * only way to answer.
   */
  function syncRingSurfaces(): void {
    const ring = ringCtrl?.current() ?? null;
    // setIncoming re-derives the panel from the live stores first, so the
    // check below never reads a panel one channel switch behind.
    callPanel?.setIncoming(ring);
    const ui = uiStore.getState();
    const panelAnswers =
      ring !== null &&
      callPanel?.showsRingFor(ring.channelId) === true &&
      ui.activeView === null &&
      !ui.settingsOpen;
    callBanner?.setRing(panelAnswers ? null : ring);
  }

  /** Accept the ring from either surface. */
  function acceptRing(withVideo: boolean): void {
    // ringCtrl.accept() unconditionally consumes the ring (stopRinging)
    // before onVoiceJoin ever runs, and onVoiceJoin itself silently refuses
    // to join while the socket is down (VoiceCallbacks.ts's socketLive()
    // guard) — so accepting while reconnecting would otherwise discard the
    // ring for good with no join and no retry. Guarded here, the only caller
    // of accept(), so the ring survives for the user to accept again once
    // reconnected.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(account("voice.canAnswerWhileReconnecting"), "error");
      return;
    }
    const backoffText = joinBackoffText();
    if (backoffText !== null) {
      showToast(backoffText, "error");
      return;
    }
    const ring = ringCtrl?.current() ?? null;
    if (ring === null) return;
    cameraOnJoin = withVideo ? ring.channelId : null;
    ringCtrl?.accept();
  }

  /** Close the DM profile sidebar if open. */
  function closeDmProfile(): void {
    // Supersede any in-flight lazy open, so it cannot mount after this close.
    dmProfileLoad = null;
    if (dmProfileUnsub !== null) {
      dmProfileUnsub();
      dmProfileUnsub = null;
    }
    if (dmProfileSidebar !== null) {
      dmProfileSidebar.destroy?.();
      dmProfileSidebar = null;
    }
    syncDmProfileButton();
  }

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(target: Element): void {
    log.info("MainPage mounting");
    container = target;

    root = createElement("div", {
      style: "display:flex;flex-direction:column;height:100vh;width:100%",
    });

    // --- Reconnect banner ---
    banner = createServerBanner();
    root.appendChild(banner.element);
    // The live region is a sibling: the visible banner rewrites its restart
    // countdown every second, which a live region would read out each tick.
    root.appendChild(banner.liveElement);

    // "Use here" takes the connection back: this device connects again and
    // the server displaces the other one (last connect wins). It serves both
    // a displaced socket (SESSION_REPLACED) and a wake reconnect the server
    // refused because another device held the session (ANOTHER_DEVICE_ACTIVE,
    // U4) — the two are the same user choice, so they share one prompt.
    const useHere = (): void => {
      const token = authStore.getState().token;
      if (token === null) return;
      setSessionReplaced(false);
      ws.connect({ host: api.getConfig().host, token }, { takeover: true });
    };
    // Retry is safe on a plain disconnect: connect() re-dials and the native
    // proxy re-validates the certificate, so a TOFU mismatch re-latches rather
    // than being bypassed. It also cancels any pending backoff attempt, so it
    // cannot race the reconnect loop.
    const retryConnection = (): void => {
      const token = authStore.getState().token;
      if (token === null) return;
      ws.connect({ host: api.getConfig().host, token });
    };
    // Signed-in-elsewhere outranks the connection status it leaves behind
    // ("disconnected"), so every banner refresh goes through here. The device's
    // own network fact stays apart from the server's reachability: a LAN server
    // with no internet still answers onLine, and `undefined` (host without the
    // API) never claims the internet is required.
    const syncBanner = (): void => {
      if (banner === null) return;
      const state = uiStore.getState();
      if (state.sessionReplaced) banner.showSignedInElsewhere(useHere);
      else
        applyConnectionStatus(banner, state.connectionStatus, {
          offline: deviceNetworkOffline(),
          dialFailed: state.connectionDialFailed,
          onRetry: retryConnection,
        });
    };
    unsubscribers.push(uiStore.subscribeSelector((s) => s.sessionReplaced, syncBanner));
    unsubscribers.push(uiStore.subscribeSelector((s) => s.connectionDialFailed, syncBanner));

    // Losing or regaining the device's network only re-renders, so the banner
    // says the true thing immediately; the reconnect loop and Retry own
    // recovery. Only re-render while the socket is actually down — a network
    // flap during a live connection (a VPN toggle, a Wi-Fi flap) must not
    // route to `applyConnectionStatus("connected")` and clear an announced
    // server-restart countdown. Owned by a Disposable so the lifecycle guard
    // sees both listeners torn down with the page.
    const networkOwner = new Disposable();
    unsubscribers.push(() => networkOwner.destroy());
    const syncBannerIfNotConnected = (): void => {
      if (uiStore.getState().connectionStatus !== "connected") syncBanner();
    };
    window.addEventListener("online", syncBannerIfNotConnected, {
      signal: networkOwner.signal,
    });
    window.addEventListener("offline", syncBannerIfNotConnected, {
      signal: networkOwner.signal,
    });

    // A sign-in not yet reviewed: listed on connect and on window focus.
    const sessionNotice = new Disposable();
    unsubscribers.push(() => sessionNotice.destroy());
    const pollSessions = startSessionNotice({
      fetchSessions: (signal) => api.getSessions(signal),
      notify: (unseen) => showToast(sessionNoticeMessage(unseen), "info", SESSION_NOTICE_TOAST_MS),
      signal: sessionNotice.signal,
    });

    // Banner reacts to the store-backed connection status (single source of
    // truth, docs/architecture/ux §3). "disconnected" keeps the banner visible
    // — a fatal drop navigates away via clearAuth, and anything short of that
    // must not leave a stale "Reconnecting..." on screen.
    unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        (status) => {
          try {
            if (status === "connected") {
              restoreSavedPresence();
              pollSessions();
            }
            syncBanner();
          } catch (err) {
            log.error("Connection status handler error", err);
          }
        },
      ),
    );
    // Synchronous initial sync: the selector subscription baselines on the
    // current value and only fires on change, so a MainPage mounted mid-outage
    // (status already "reconnecting") would otherwise never show the banner —
    // the whole retry cycle maps to the same 3-state value.
    syncBanner();
    // Idle / Do Not Disturb / Invisible "for 1 hour": reverts to Online when
    // the stored timer ends, and at once if it ended while the app was closed.
    // Before the restore below, so that reads (and re-asserts) the reverted status.
    statusTimerWatcher = startStatusTimerWatcher({ onRevert: (status) => applyPresence(status) });
    if (uiStore.getState().connectionStatus === "connected") restoreSavedPresence();

    // Auto-idle. It only ever moves a status it is itself responsible for
    // (see @lib/presence/autoIdle) — a manually chosen Idle, Do Not Disturb or
    // Invisible is never touched — so it is safe to leave running for the
    // whole session. The OS idle source makes input in other apps count too.
    autoIdle = startAutoIdle({
      onStatusChange: (status) => applyPresence(status),
      systemIdleMs: () => desktop.systemIdle.idleMs(),
    });
    // The game being played, for other members' "Playing <game>" line. The
    // loop sends nothing unless the setting is on and the server advertises
    // game_activity; the web build has no detector and never loads it.
    if (desktop.gameDetector.available) {
      void import("@lib/presence/gameActivity").then(
        ({ startGameActivity }) => {
          if (tornDown) return;
          gameActivity = startGameActivity({
            ws,
            detect: (prefs) => desktop.gameDetector.detect(prefs),
          });
        },
        (err: unknown) => log.warn("Game activity failed to load", { error: String(err) }),
      );
    }
    // The song being listened to, for the "Listening to <player>" line. Same
    // rules as the game loop, with its own capability (listening_activity).
    if (desktop.mediaDetector.available) {
      void import("@lib/presence/musicActivity").then(
        ({ startMusicActivity }) => {
          if (tornDown) return;
          musicActivity = startMusicActivity({
            ws,
            detect: (prefs) => desktop.mediaDetector.detect(prefs),
          });
        },
        (err: unknown) => log.warn("Music activity failed to load", { error: String(err) }),
      );
    }
    // Talking in a call is being here even with hands off the keyboard and
    // mouse, which neither the window nor (for another app) the OS poll sees.
    // The local ring is the same on web and native (voice.store withLocalRing).
    unsubscribers.push(
      voiceStore.subscribeSelector(
        (v) => {
          const uid = authStore.getState().user?.id ?? 0;
          const ch = v.currentChannelId;
          return ch !== null && v.voiceUsers.get(ch)?.get(uid)?.speaking === true;
        },
        (speaking) => {
          if (speakingActivityTimer !== null) clearInterval(speakingActivityTimer);
          speakingActivityTimer = null;
          if (!speaking) return;
          autoIdle?.notifyActivity();
          // Talking for longer than the idle delay must keep counting.
          speakingActivityTimer = setInterval(() => autoIdle?.notifyActivity(), 60_000);
        },
      ),
      () => {
        if (speakingActivityTimer !== null) clearInterval(speakingActivityTimer);
        speakingActivityTimer = null;
      },
    );

    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        try {
          // Every reason counts down: the session survives the restart
          // and ws.ts reconnects once the socket drops.
          if (banner !== null) {
            if (payload.delay_seconds <= 0) {
              // A zero/negative delay is a cancel, not a countdown (e.g.
              // "update_aborted" correcting an earlier restart announcement
              // after the staged update failed to apply — the socket never
              // actually dropped). Re-sync to the real connection status
              // instead of letting showRestart's countdown fall straight
              // through to a permanent "Reconnecting..." banner.
              syncBanner();
            } else {
              banner.showRestart(payload.delay_seconds);
            }
          }
        } catch (err) {
          log.error("Server restart handler error", err);
        }
      }),
    );

    // --- Main .app row ---
    const app = createElement("div", { class: "app", "data-testid": "app-layout" });

    // --- Sidebar (server strip + channel sidebar + voice widget + user bar) ---
    const sidebar = createSidebarArea({
      ws,
      api,
      limiters,
      presenceSender,
      getRoot: () => root,
      getToast: () => toast,
      onWatchStream: (userId) => {
        if (videoModeCtrl === null) return;
        videoModeCtrl.checkVideoMode();
        videoModeCtrl.showVideoGrid();
        videoModeCtrl.setFocus(userId);
        videoGrid?.watch(userId);
      },
      onOpenCall: () => callChat?.openVoiceCall(),
      destinations: NAVIGATION_DESTINATIONS,
      onOpenView: (id, opener) => contentNav?.open(id, opener),
      // The member list's profile popup Call action opens the DM then starts
      // its call through this, the same startCall the DM header uses.
      onStartCall: () => startCall(),
      // The DM row menu's Profile: select the DM, then show its panel fresh
      // (a panel already open for another DM is replaced, not toggled away) and
      // remember it as open. Deferred a microtask: the store's active-channel
      // listener (which re-syncs the panel on any DM switch) runs in the
      // microtask selecting the DM queued.
      onOpenDmProfile: () => {
        queueMicrotask(() => {
          closeDmProfile();
          toggleDmProfile();
        });
      },
    });
    children.push(...sidebar.children);
    unsubscribers.push(...sidebar.unsubscribers);

    // --- Chat area ---
    const chatAreaResult = createChatArea({
      api,
      getRoot: () => root,
      getToast: () => toast,
      getChannelCtrl: () => channelCtrl,
      onToggleDmProfile: () => {
        toggleDmProfile();
      },
      onToggleMemberList: () => {
        withGroupPanel((ctrl) => ctrl.toggle(), true);
      },
      onToggleGuildMemberList: () => {
        memberColumn?.toggle();
      },
      onStartCall: () => {
        startCall();
      },
      onStartVideoCall: () => {
        startCall(true);
      },
      onRenameGroup: () => {
        const active = getActiveChannel();
        if (active !== null && active.type === "dm") sidebar.renameGroup(active.id);
      },
    });
    dmProfileSlot = chatAreaResult.dmProfileSlot;
    dmProfileBtn = chatAreaResult.chatHeaderRefs.profileBtn;
    dmMembersBtn = chatAreaResult.chatHeaderRefs.membersBtn ?? null;
    children.push(...chatAreaResult.children);
    unsubscribers.push(...chatAreaResult.unsubscribers);
    videoGrid = chatAreaResult.videoGrid;

    // Video mode controller (chat/video toggle + tile management)
    videoModeCtrl = createVideoModeController({
      slots: chatAreaResult.slots,
      videoGrid: chatAreaResult.videoGrid,
      getCurrentUserId,
      // The DM call panel hosts the video of its own call (chat stays up).
      panelHost: () => callPanelHost,
      chatColumn: chatAreaResult.chatArea,
      onGridChange: () => callChat?.refresh(),
    });
    // Opening the call view selects the voice channel; its chat sits beside the grid.
    const callChatBtn = chatAreaResult.chatHeaderRefs.callChatBtn;
    callChat = createCallChat({
      videoModeCtrl,
      onStateChange: (state) => {
        setChatHeaderCallChat(chatAreaResult.chatHeaderRefs, state);
        // The call view takes the member column's width while it is up.
        callViewUp = state.capable;
        memberColumn?.setCallView(callViewUp);
      },
    });
    callChatBtn.addEventListener("click", () => callChat?.toggleChat());

    // The composer of the channel on screen, else the header's menu button
    // (shown only at narrow width, where the closed sidebar is inert), else
    // the sidebar's first control that is not hidden (a hidden header action
    // — Invite or Audit Log without the permission, Mark All as Read with
    // nothing unread — would swallow the focus call and leave it on <body>):
    // the first of them that takes focus.
    const focusReachable = (): HTMLElement | null => {
      const candidates = [
        chatAreaResult.slots.inputSlot.querySelector<HTMLElement>("textarea:enabled"),
        chatAreaResult.sidebarToggle,
        ...Array.from(sidebar.sidebarWrapper.querySelectorAll<HTMLElement>("button")).filter(
          (b) => b.style.display !== "none" && b.style.visibility !== "hidden",
        ),
      ];
      for (const el of candidates) {
        el?.focus();
        if (el != null && document.activeElement === el) return el;
      }
      return null;
    };

    contentNav = createContentNavigator({
      destinations: NAVIGATION_DESTINATIONS,
      api,
      chatArea: chatAreaResult.chatArea,
      rememberChannel: sidebar.rememberChannel,
      forgetChannel: sidebar.forgetChannel,
      returnToChannel: sidebar.returnToChannel,
      // The opener is gone (the Requests entry leaves with DM mode).
      fallbackFocus: focusReachable,
    });

    // The member column: always present, hidden until MemberColumn shows it.
    const memberColumnEl = createElement("aside", {
      id: "member-column",
      class: "member-column",
      "data-testid": "member-column",
      "aria-label": shellText("members.region"),
    });
    memberColumnEl.hidden = true;
    const memberColumnBody = createElement("div", { class: "member-column-body" });
    memberColumnEl.appendChild(memberColumnBody);

    // The server rail sits left of the sidebar. The web portal serves exactly
    // one server, so it has none there. The slot holds the rail's width while
    // the rail loads on demand, keeping it out of the eager MainPage chunk.
    let railSlot: HTMLDivElement | null = null;
    if (!__OWNCORD_WEB__) {
      railSlot = createElement("div", { class: "server-rail-slot" });
      app.classList.add("has-server-rail");
      const slot = railSlot;
      const railHost = api.getConfig().host ?? "";
      void import("@components/ServerRail")
        .then(({ createServerRail }) => {
          if (tornDown) return;
          const rail = createServerRail({
            currentHost: railHost,
            currentName: authStore.getState().serverName ?? "",
            loadServers: loadSavedServers,
            switchServer: switchToServer,
            addServer,
            onOpenDm: (dm) => sidebar.openDm(dm),
            onShowServer: () => sidebar.returnToChannel(),
            joinInvite: (text) => {
              const invite = parseInviteInput(text);
              if (invite === null) return false;
              confirmAndJoinInvite(invite, currentServerName(railHost));
              return true;
            },
          });
          rail.mount(slot);
          unsubscribers.push(() => rail.destroy?.());
        })
        .catch((err: unknown) => log.warn("Server rail failed to load", err));
    }

    if (railSlot !== null) app.appendChild(railSlot);
    appendChildren(
      app,
      sidebar.sidebarWrapper,
      chatAreaResult.chatArea,
      chatAreaResult.threadSlot,
      contentNav.element,
      memberColumnEl,
      chatAreaResult.dmProfileSlot,
    );
    root.appendChild(app);

    // The narrow-width sidebar drawer (WCAG 1.4.10 Reflow): the header's menu
    // button opens the existing sidebar over the chat area below 800px. Built
    // after the sidebar is in `app`, so the backdrop shares their container.
    // Loaded on demand: the drawer only matters below the 800px breakpoint,
    // so its controller stays out of the eager MainPage chunk (bundle budget).
    void import("./main-page/SidebarDrawer").then(({ createSidebarDrawer }) => {
      if (tornDown) return;
      sidebarDrawer = createSidebarDrawer({
        sidebar: sidebar.sidebarWrapper,
        toggle: chatAreaResult.sidebarToggle,
        fallbackFocus: focusReachable,
        onOpen: () => {
          chatAreaResult.closePinnedPanel();
          memberColumn?.closeOverlay();
        },
      });
    });
    unsubscribers.push(() => {
      sidebarDrawer?.destroy();
      sidebarDrawer = null;
    });

    // The member list lives in exactly one place at a time (MemberList keeps
    // module-level popup state, so two live instances would close each other's
    // menus): "left" is SidebarArea's section, "right" is the column. This is
    // the one layout-change handler, so the order is decided here: the
    // outgoing host destroys its panel before the incoming host builds one.
    // The column's own listener ignores the layout key.
    void import("./main-page/MemberColumn").then(({ createMemberColumn }) => {
      if (tornDown) return;
      memberColumn = createMemberColumn({
        column: memberColumnEl,
        body: memberColumnBody,
        button: chatAreaResult.chatHeaderRefs.memberListBtn,
        buildPanel: sidebar.buildMemberPanel,
        fallbackFocus: focusReachable,
      });
      memberColumn.setCallView(callViewUp);
      memberColumn.sync();
    });
    const layoutOwner = new Disposable();
    onPrefChange(
      [MEMBER_LAYOUT_PREF],
      () => {
        if (loadMemberLayout() === "right") {
          sidebar.syncMemberSection();
          memberColumn?.sync();
        } else {
          memberColumn?.sync();
          sidebar.syncMemberSection();
        }
      },
      layoutOwner.signal,
    );
    unsubscribers.push(() => {
      layoutOwner.destroy();
      memberColumn?.destroy();
      memberColumn = null;
    });

    // --- Moderation notices: persistent, above the app row ---
    const notices = new Disposable();
    unsubscribers.push(() => notices.destroy());
    root.insertBefore(
      createNoticesBanner({ api, signal: notices.signal, fallbackFocus: focusReachable }),
      app,
    );

    // Settings overlay
    // Bumped by every local 2FA change so an in-flight profile refresh
    // cannot overwrite it with an older answer.
    let totpEpoch = 0;
    const safety = NAVIGATION_DESTINATIONS.safety;
    const settingsOverlay = createSettingsOverlay({
      onClose: () => closeSettings(),
      fallbackFocus: focusReachable,
      onChangePassword: async (oldPassword, newPassword) => {
        try {
          const outcome = await api.changePassword(oldPassword, newPassword);
          showChangeOutcomeToast(outcome, account("toast.passwordChanged"));
          // The form shows the same outcome inline, so a partial success is
          // never a green "changed successfully" beside the warning toast.
          return outcome;
        } catch (err) {
          const msg = errorText(err, account("toast.passwordChangeFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onUpdateProfile: async (patch) => {
        try {
          // The username is required by the API but optional in the patch (the
          // profile form only edits the display name and about), so fill it in
          // from the current user rather than making every caller repeat it.
          const username = patch.username ?? authStore.getState().user?.username ?? "";
          const updated = await api.updateProfile({ ...patch, username });
          updateUser({
            username: updated.username,
            display_name: updated.display_name ?? null,
            about: updated.about ?? null,
            // An older server sends no banner keys: leave the stored colour be.
            ...(updated.banner_color === undefined ? {} : { banner_color: updated.banner_color }),
          });
          showToast(account("toast.profileUpdated"), "success");
        } catch (err) {
          const msg = errorText(err, account("toast.profileUpdateFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onUploadAvatar: async (file) => {
        try {
          const uploaded = await api.uploadAvatar(file);
          // The server has already pointed the column at the served file and
          // broadcast a user_update; this keeps the local copy from lagging a
          // round-trip behind.
          updateUser({ avatar: uploaded.url });
          showToast(account("toast.avatarUpdated"), "success");
          return uploaded.url;
        } catch (err) {
          const msg = errorText(err, account("toast.avatarUploadFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onRemoveAvatar: async () => {
        try {
          const username = authStore.getState().user?.username ?? "";
          const updated = await api.removeAvatar(username);
          // Same as the upload path: the user_update broadcast also lands, but
          // this keeps the local copy from lagging a round-trip behind.
          updateUser({ avatar: updated.avatar ?? null });
          showToast(account("toast.avatarRemoved"), "success");
        } catch (err) {
          const msg = errorText(err, account("toast.avatarRemoveFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onUploadBanner: async (file) => {
        try {
          const uploaded = await api.uploadBanner(file);
          // The user_update broadcast also lands; this keeps the card from lagging.
          updateUser({ banner: uploaded.url });
          showToast(account("toast.bannerUpdated"), "success");
          return uploaded.url;
        } catch (err) {
          // 404: the server advertises banners but has attachment storage off,
          // so the upload route is not mounted.
          const msg =
            err instanceof ApiClientError && err.status === 404
              ? account("profile.bannerStorageOff")
              : errorText(err, account("profile.bannerUploadFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onRemoveBanner: async () => {
        try {
          const updated = await api.removeBanner();
          updateUser({ banner: updated.banner ?? null });
          showToast(account("toast.bannerRemoved"), "success");
        } catch (err) {
          showToast(errorText(err, account("toast.bannerRemoveFailed")), "error");
          throw err;
        }
      },
      onLogout: () => logout(api),
      getRetentionNotice: options.getRetentionNotice,
      ...(safety === undefined ? {} : { safetyTab: (signal) => safety.build(signal, api) }),
      onDeleteAccount: async (password) => {
        await api.deleteAccount(password);
        clearAuth();
        // The account is gone, so its cached server images go too.
        // clearAuth has already disarmed the scope, so no late write follows.
        if (cacheScope !== null) await pruneAttachmentCacheScope(cacheScope);
        showToast(account("toast.accountDeleted"), "success");
      },
      onEnableTotp: async (password) => {
        try {
          return await api.enableTotp(password);
        } catch (err) {
          const msg = errorText(err, account("toast.enableTotpFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onConfirmTotp: async (password, code) => {
        try {
          const outcome = await api.confirmTotp(password, code);
          totpEpoch++;
          updateUser({ totp_enabled: true });
          showChangeOutcomeToast(outcome, account("toast.totpEnabled"));
        } catch (err) {
          const msg = errorText(err, account("toast.confirmTotpFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onDisableTotp: async (password) => {
        try {
          const outcome = await api.disableTotp(password);
          totpEpoch++;
          updateUser({ totp_enabled: false });
          showChangeOutcomeToast(outcome, account("toast.totpDisabled"));
        } catch (err) {
          const msg = errorText(err, account("toast.disableTotpFailed"));
          showToast(msg, "error");
          throw err;
        }
      },
      onRefreshTotpStatus: async () => {
        // GET /auth/me is the only response that states totp_enabled;
        // auth_ok never does. A failed read changes nothing, and
        // a read that lands after the user enabled or disabled 2FA in the
        // meantime is discarded: the local change is newer than the answer.
        const epoch = totpEpoch;
        try {
          const me = await api.getMe();
          if (epoch === totpEpoch && typeof me.totp_enabled === "boolean") {
            updateUser({ totp_enabled: me.totp_enabled });
          }
        } catch (err) {
          log.warn("Failed to refresh the 2FA state", err);
        }
      },
      onRegenerateRecoveryCodes: async (password) =>
        (await api.regenerateRecoveryCodes(password)).backup_codes,
      onEnrolRecoveryKit: (password) => api.enrolRecoveryKit(password),
      onGetRecoveryKitStatus: () => api.getRecoveryKitStatus(),
      onStatusChange: (status) => applyPresence(status),
      onListSessions: () => api.getSessions(),
      onRevokeSession: (id) => api.revokeSession(id),
      onRevokeAllSessions: async () => {
        const result = await api.revokeAllSessions();
        // The token died with the response: leave for the connect page now
        // rather than let the next request fail with a 401.
        if (result.current_session_revoked) clearAuth();
        return result;
      },
    });
    settingsOverlay.mount(root);
    children.push(settingsOverlay);

    // Quick switcher (Ctrl+K)
    // Don't fire while the settings panel is on top of it — same guard as
    // attachGlobalKeybinds below, reading the same source of truth.
    const qsManager = createQuickSwitcherManager(
      () => root,
      () => uiStore.getState().settingsOpen,
      // A voice row in the switcher joins voice (matching the sidebar row): a
      // pick joins, as a click on the row does. The call view's own chat
      // reaches the voice channel through navigateToChannel (callChat).
      (channelId: number) => createSidebarVoiceCallbacks(ws).onVoiceJoin(channelId),
      () => sidebar.rememberChannel(),
      () => sidebar.forgetChannel(),
    );
    unsubscribers.push(qsManager.attach());

    // The rest of the shortcuts listed on the settings Keybinds tab.
    const voiceKeybindActions = createVoiceWidgetCallbacks(ws, limiters);
    let shortcutsOverlay: typeof import("@components/ShortcutsOverlay") | null = null;
    let shortcutsClosed = false;
    unsubscribers.push(() => {
      shortcutsClosed = true;
      shortcutsOverlay?.closeShortcutsOverlay();
    });
    unsubscribers.push(
      attachGlobalKeybinds({
        onSearch: () => chatAreaResult.searchCtrl.open(),
        onOpenSettings: () => openSettings(),
        onOpenShortcuts: () =>
          void import("@components/ShortcutsOverlay")
            .then((m) => {
              // The page may have unmounted while the chunk loaded.
              if (shortcutsClosed) return;
              shortcutsOverlay = m;
              m.openShortcutsOverlay();
            })
            .catch((err: unknown) => log.warn("Shortcuts overlay failed to open", err)),
        onToggleMute: () => voiceKeybindActions.onMuteToggle(),
        onToggleDeafen: () => voiceKeybindActions.onDeafenToggle(),
        onToggleCamera: () => voiceKeybindActions.onCameraToggle(),
        onToggleScreenshare: () => voiceKeybindActions.onScreenshareToggle(),
        onDisconnect: () => voiceKeybindActions.onDisconnect(),
        onUploadFile: () => channelCtrl?.openFilePicker(),
        onTogglePicker: (kind) => channelCtrl?.togglePicker(kind),
        onMarkChannelRead: () => channelCtrl?.messageList?.markReadAndJumpToPresent(),
        // A server-wide action, like the header's Mark Server as Read: DMs stay as they are.
        onMarkServerRead: () => markAllRead({ includeDms: false }),
        onScrollMessages: (direction) => channelCtrl?.messageList?.scrollPage(direction),
        onStepChannel: (direction, unreadOnly) => {
          if (uiStore.getState().sidebarMode === "dms") sidebar.rememberChannel();
          stepChannel(direction, unreadOnly);
        },
        ringActive: () => ringCtrl?.current() != null,
        onAcceptRing: () => acceptRing(false),
        onDeclineRing: () => ringCtrl?.decline(),
        // Don't fire app shortcuts while the settings panel is on top of them.
        isSuspended: () => uiStore.getState().settingsOpen,
        isGlobalPollerActive: () => globalPollerActive,
      }),
    );

    // U6: Ctrl+Shift+M/Ctrl+Shift+D and the tray's Mute/Deafen items work
    // while the app is unfocused. The native host polls the keys (Windows and
    // X11 Linux) and the tray emits the same event; both run the same toggles
    // as the in-app shortcuts, in a call or not.
    unsubscribers.push(
      desktop.globalShortcuts.onShortcut((action) => {
        if (action === "mute") voiceKeybindActions.onMuteToggle();
        else voiceKeybindActions.onDeafenToggle();
      }),
    );
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
    let refreshSeq = 0;
    const refreshGlobalKeys = (): void => {
      const seq = ++refreshSeq;
      void desktop.globalShortcuts
        .supported()
        .then(async (supported) => {
          if (seq !== refreshSeq || tornDown) return;
          globalPollerActive = supported;
          await desktop.globalShortcuts.start();
        })
        .catch(() => {
          // Not a Tauri host, or the command was refused: the tray and the in-app
          // shortcuts still work; the global key path simply is not live.
          if (seq === refreshSeq && !tornDown) globalPollerActive = false;
        });
    };
    refreshGlobalKeys();
    unsubscribers.push(desktop.globalShortcuts.onStatusChange(refreshGlobalKeys));
    // An earlier successful portal bind is restored with the saved keys; a
    // desktop that remembers the approval answers without a dialog. Nothing
    // is asked when the desktop already holds a trigger, and a dialog the
    // user cancels forgets the earlier bind, so the next start is quiet.
    void desktop.globalShortcuts
      .status()
      .then(async (status) => {
        if (tornDown || status.backend !== "portal" || !portalBoundBefore()) return;
        if (anyTriggerBound(status)) return;
        const keys = loadGlobalShortcutVks();
        try {
          await desktop.globalShortcuts.bindPortal({
            pttVk: loadPref<number>("pttVk", 0),
            muteVk: keys.mute,
            deafenVk: keys.deafen,
          });
        } catch (err) {
          if (globalKeysErrorCode(err) === "bind_cancelled") clearPortalBound();
          return;
        }
        if (!tornDown) refreshGlobalKeys();
      })
      .catch(() => {
        // The host could not answer: the keys stay as they were.
      });
    // Push the persisted rebind onto the running poller at startup, so a
    // choice made in Settings survives a restart (the native default is
    // Ctrl+Shift+M / Ctrl+Shift+D).
    const globalKeys = loadGlobalShortcutVks();
    void desktop.globalShortcuts
      .setKeys({ muteVk: globalKeys.mute, deafenVk: globalKeys.deafen })
      .catch(() => {
        // Not a Tauri host, or the command was refused: keep the native default.
      });

    // Timed mutes: redraws the sidebars when one ends. Page-owned, so a socket
    // reconnect leaves it alone and a server switch remounts a fresh one.
    // Loaded on demand; the same !tornDown guard as the badge below.
    void import("@lib/prefs/channelMuteExpiry").then((expiry) => {
      if (!tornDown) unsubscribers.push(expiry.startMuteExpiryWatch());
    });

    // The taskbar and tray unread badge, cleared again on teardown so a
    // logout or server switch does not leave this session's count behind.
    // destroy() sets tornDown before it runs unsubscribers, so a stopper
    // pushed while !tornDown always runs.
    void import("../features/unread-badge/unreadBadge").then((badge) => {
      if (!tornDown) unsubscribers.push(badge.startUnreadBadge(desktop.notifier));
    });

    // Short voice UI sounds on join/leave and mute/deafen. This module
    // statically imports stores the page already pulls in, so it rides the
    // MainPage chunk rather than splitting a new shared one off the entry.
    if (!tornDown) unsubscribers.push(startVoiceUiSounds());

    // Toast container
    toast = createToastContainer();
    toast.mount(root);
    children.push(toast);
    initToast(toast);

    // --- DM calls ---
    // The banner is mounted on the page root rather than inside the chat area
    // so a ring stays visible while the user is looking at another channel —
    // which is exactly when a call most needs to be answerable.
    ringCtrl = createRingController({
      onRingStateChange: () => syncRingSurfaces(),
      onChime: (playing) => (playing ? startRingChime() : stopRingChime()),
      onAccept: (channelId) => {
        createSidebarVoiceCallbacks(ws).onVoiceJoin(channelId);
      },
      onDecline: (channelId) => {
        ws.send({ type: "call_decline", payload: { channel_id: channelId } });
      },
      onRingStart: (ring) => void callAlerts().then((m) => m.alertIncomingCall(ring)),
      onMissed: (ring) => void callAlerts().then((m) => m.alertMissedCall(ring)),
      onRingEnd: (ring, reason) =>
        void callAlerts().then((m) => {
          m.clearIncomingCall(ring);
          if (reason === "superseded") m.alertSupersededCall(ring);
        }),
    });
    callBanner = createIncomingCallBanner({
      onAccept: (withVideo) => acceptRing(withVideo),
      onDecline: () => ringCtrl?.decline(),
    });
    callBanner.mount(root);
    children.push(callBanner);

    outgoingCall = createOutgoingCall({
      onChange: (state) => {
        callPanel?.setOutgoing(state);
        // The panel is the caller's feedback only while their DM is on screen;
        // elsewhere the ringback and a toast are all they get.
        if (state !== null && state.phase !== "ringing") {
          const ui = uiStore.getState();
          const panelShows =
            ui.activeView === null &&
            !ui.settingsOpen &&
            channelsStore.getState().activeChannelId === state.channelId;
          if (!panelShows) {
            const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
            // The same name the call panel would show: a 1:1 DM resolves the
            // recipient through the members store (the nickname every other
            // identity surface uses), a group uses the DM's own name.
            let name = dm !== undefined ? dmDisplayName(dm) : "";
            if (dm !== undefined && !dm.isGroup) {
              const member = membersStore.getState().members.get(dm.recipient.id);
              name =
                (member !== undefined ? memberDisplayName(member) : "") ||
                (dm.recipient.displayName ?? "") ||
                dm.recipient.username ||
                name;
            }
            const text =
              state.phase === "declined"
                ? dmCallText("declinedStatus", { name })
                : state.phase === "offline"
                  ? dmCallText("offline", { name })
                  : dmCallText("noAnswerStatus");
            showToast(text, "info", 6000);
          }
        }
      },
      onRingback: (playing) => (playing ? startRingback() : stopRingback()),
    });
    // Loaded on demand like the sidebar drawer: the panel is only drawn in a
    // DM with a call, so its code stays out of the eager MainPage chunk
    // (bundle budget). Until it lands, the banner answers every ring.
    void callAlerts().then(({ createDmCallPanel }) => {
      if (tornDown) return;
      const panel = createDmCallPanel({
        onMuteToggle: () => voiceKeybindActions.onMuteToggle(),
        onDeafenToggle: () => voiceKeybindActions.onDeafenToggle(),
        onCameraToggle: () => voiceKeybindActions.onCameraToggle(),
        onScreenshareToggle: () => voiceKeybindActions.onScreenshareToggle(),
        onLeave: () => voiceKeybindActions.onDisconnect(),
        onAccept: (withVideo) => acceptRing(withVideo),
        onDecline: () => ringCtrl?.decline(),
        onJoin: joinDmCall,
        onRingAgain: (channelId) => {
          if (uiStore.getState().connectionStatus !== "connected") {
            showToast(shellText("channel.notConnected"), "error");
            return;
          }
          ringCallees(channelId);
        },
        onVideoHostChange: () => videoModeCtrl?.checkVideoMode(),
        videoGrid: chatAreaResult.videoGrid,
      });
      // Published before mount: mounting reports whether it can host video,
      // and the video controller reads the panel through callPanelHost.
      callPanel = panel;
      callPanelHost = {
        ownsCall: (channelId) => panel.ownsCall(channelId),
        element: () => panel.videoElement(),
        setActive: (active) => panel.setVideoActive(active),
      };
      panel.mount(chatAreaResult.callPanelSlot);
      children.push(panel);
      panel.setOutgoing(outgoingCall?.current() ?? null);
      syncRingSurfaces();
    });

    // The ring's surface depends on what is on screen.
    unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => s.activeChannelId,
        () => syncRingSurfaces(),
      ),
      uiStore.subscribeSelector(
        (s) => s.activeView === null && !s.settingsOpen,
        () => syncRingSurfaces(),
      ),
      // A queued ring must not outlive a drop, even one that reconnects before
      // the timer fires: voice has not rejoined yet, so it would ring an empty room.
      uiStore.subscribeSelector(
        (s) => s.connectionStatus !== "connected",
        (down) => {
          if (down) cancelPendingRing();
        },
      ),
    );

    // The outgoing ring is over once anyone else is in the room, or once
    // the caller is not; an incoming ring is answered by being in its room,
    // however you got there; and "Join with video" turns the camera on as
    // soon as the accepted call is connected.
    unsubscribers.push(
      voiceStore.subscribe((state) => {
        const ring = ringCtrl?.current() ?? null;
        if (ring !== null && state.currentChannelId === ring.channelId) {
          ringCtrl?.cancel(ring.channelId);
        }
        const out = outgoingCall?.current() ?? null;
        if (out !== null) {
          const roster = state.voiceUsers.get(out.channelId);
          const self = getCurrentUserId();
          const answered = roster !== undefined && [...roster.keys()].some((id) => id !== self);
          if (state.currentChannelId !== out.channelId || answered) outgoingCall?.clear();
        }
        if (cameraOnJoin !== null) {
          if (state.currentChannelId !== cameraOnJoin) {
            cameraOnJoin = null;
          } else if (state.voiceStatus === "connected") {
            cameraOnJoin = null;
            if (!state.localCamera) {
              enableCamera().catch((err: unknown) => {
                log.error("Camera on join failed", { error: String(err) });
              });
            }
          }
        }
      }),
    );

    // Losing a group (left, or removed) ends its ring without a missed call:
    // the server stops sending that room's voice_leave, so the 30 s timeout
    // would otherwise report a call from a group the user is no longer in.
    // A leave the server then refuses restores the row but not the ring.
    unsubscribers.push(
      watchGroupDmExits((channelId) => {
        if (ringCtrl?.current()?.channelId === channelId) ringCtrl.cancel(channelId);
        if (outgoingCall?.current()?.channelId === channelId) outgoingCall.clear();
      }),
    );

    unsubscribers.push(
      ws.on("call_incoming", (payload) => {
        try {
          // Being in the room already answers the ring (a redial from
          // someone in the call re-rings everyone else in the DM).
          if (voiceStore.getState().currentChannelId === payload.channel_id) return;
          // A call in the DM you are already sitting in still rings: the
          // channel being open does not mean the app has focus, and Discord
          // rings there too.
          // Resolve through the members store, same as every other identity
          // surface (voice roster, member list, DM header) -- the raw wire
          // username is only a fallback for a caller this client hasn't
          // seen yet.
          const caller = membersStore.getState().members.get(payload.from_user);
          ringCtrl?.incoming({
            channelId: payload.channel_id,
            fromUserId: payload.from_user,
            fromUsername: caller !== undefined ? memberDisplayName(caller) : payload.username,
          });
        } catch (err) {
          log.error("call_incoming handler error", err);
        }
      }),
    );
    unsubscribers.push(
      ws.on("call_declined", (payload) => {
        // Addressed to every other DM participant, not just the caller — the
        // server holds no call state to target with (see handlers_call.go).
        // In a group DM that includes fellow callees who are also ringing;
        // only the actual ringer declining should silence this client's ring.
        // The caller hears about it too: in a 1:1 a decline ends the ring,
        // in a group it takes that callee off the list.
        outgoingCall?.declined(payload.channel_id, payload.from_user);
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.from_user === ringing.fromUserId) {
          ringCtrl?.cancel(payload.channel_id);
        }
      }),
    );
    // Anyone leaving the ringing room: when it has emptied there is no call
    // left to answer, and no call record to close, so the voice_leave is the
    // only signal. Ringing for a room with nobody in it is worse than a
    // missed call, so a leave stops the ring for that channel — but only
    // when it actually emptied the room. A group DM can still hold other
    // callees who already accepted (voiceStore.voiceUsers answers that), and
    // the ringer hanging up must not silence a call that is still live for
    // them; the last one out, ringer or not, ends it.
    unsubscribers.push(
      ws.on("voice_leave", (payload) => {
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.channel_id !== ringing.channelId) return;
        const roster = voiceStore.getState().voiceUsers.get(payload.channel_id);
        const othersStillIn =
          roster !== undefined && [...roster.keys()].some((id) => id !== payload.user_id);
        if (!othersStillIn) {
          ringCtrl?.cancel(payload.channel_id, "ringer-left");
        }
      }),
    );
    // The server answers a ring it refuses with an error frame carrying the
    // ring's envelope id, whatever the code (CALL_REQUIRES_ACCEPTANCE,
    // RATE_LIMITED, FORBIDDEN, TIMED_OUT, NOT_FOUND, VOICE_ERROR, INTERNAL):
    // nobody was rung, so end the caller's "Calling…" and ringback now. The
    // correlation id is the guard, not the code. The dispatcher shows the
    // server's explanation as the toast; the caller stays in the room.
    unsubscribers.push(
      ws.on("error", (_payload, id) => {
        if (id === lastRingId) outgoingCall?.clear();
      }),
    );
    unsubscribers.push(() => {
      ringCtrl?.destroy();
      ringCtrl = null;
      callBanner = null;
      callPanel = null;
      callPanelHost = null;
      outgoingCall?.destroy();
      outgoingCall = null;
      cameraOnJoin = null;
    });

    // Message loading controller
    msgCtrl = createMessageController({
      api,
      showError: (msg) => showToast(msg, "error"),
    });

    // Reaction controller
    reactionCtrl = createReactionController({
      ws,
      reactionsLimiter: limiters.reactions,
      getChannelId: () => channelCtrl?.currentChannelId ?? 0,
      showError: (msg) => showToast(msg, "error"),
    });

    // Channel controller (mount/destroy MessageList, TypingIndicator, MessageInput per channel)
    channelCtrl = createChannelController({
      ws,
      api,
      msgCtrl: msgCtrl,
      reactionCtrl: reactionCtrl,
      typingLimiter: limiters.typing,
      showToast: (msg, type) => showToast(msg, type as "success" | "error" | "info"),
      getCurrentUserId,
      slots: {
        messagesSlot: chatAreaResult.slots.messagesSlot,
        typingSlot: chatAreaResult.slots.typingSlot,
        inputSlot: chatAreaResult.slots.inputSlot,
        threadSlot: chatAreaResult.threadSlot,
      },
      chatHeaderName: chatAreaResult.chatHeaderName,
      chatHeaderRefs: chatAreaResult.chatHeaderRefs,
      onContentGated: closeActiveLightbox,
      focusFallback: focusReachable,
      onJoinCall: joinDmCall,
      onOpenPins: () => {
        void chatAreaResult.openPinnedPanel();
      },
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => showToast(msg, "error"));

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

    function tileLabel(userId: number, isScreenshare: boolean): string {
      const name = personName(userId);
      const isSelf = userId === getCurrentUserId();
      if (name === undefined || name === "") {
        if (isSelf) return isScreenshare ? shellText("tile.yourScreen") : shellText("tile.you");
        return isScreenshare
          ? shellText("tile.userScreen", { id: String(userId) })
          : shellText("tile.user", { id: String(userId) });
      }
      if (isScreenshare) return shellText("tile.nameScreen", { name });
      return isSelf ? shellText("tile.nameYou", { name }) : name;
    }

    // Wire remote video callbacks to video grid
    setOnRemoteVideo((userId, stream, isScreenshare) => {
      if (videoGrid === null) return;
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return;
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      const username = tileLabel(userId, isScreenshare);
      const name = personName(userId);
      videoGrid.addStream(tileId, username, stream, {
        isSelf: false,
        audioUserId: userId,
        isScreenshare,
        ...(name === undefined || name === "" ? {} : { name }),
      });
      videoModeCtrl?.checkVideoMode();
    });
    setOnRemoteVideoRemoved((userId, isScreenshare) => {
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      videoGrid?.removeStream(tileId);
      videoModeCtrl?.checkVideoMode();
    });
    unsubscribers.push(() => clearOnRemoteVideo());

    const tileMenu = createTileMenuActions(ws, sidebar.messageUser, () =>
      videoModeCtrl?.showChat(),
    );
    unsubscribers.push(tileMenu.destroy);
    // The cover on your own screen-share preview stops the share.
    chatAreaResult.videoGrid.setCallbacks({
      onStopSharing: () => {
        if (voiceStore.getState().localScreenshare) voiceKeybindActions.onScreenshareToggle();
      },
      // HTML full screen fills only the webview in WebView2: take the window
      // along (a no-op where the webview already filled it), or a stream
      // pop-out window by its label.
      setWindowFullscreen: (...args) => desktop.window.setFullscreen(...args),
      callControls: {
        onMuteToggle: () => voiceKeybindActions.onMuteToggle(),
        onDeafenToggle: () => voiceKeybindActions.onDeafenToggle(),
        onLeave: () => voiceKeybindActions.onDisconnect(),
        onCameraToggle: () => voiceKeybindActions.onCameraToggle(),
        onCameraDevice: (anchor, signal) =>
          void import("../features/voice/cameraMenu")
            .then((m) => m.showCameraMenu(anchor, signal))
            .catch((err: unknown) => log.warn("Camera menu failed to open", err)),
        cameraFlip: {
          available: () =>
            import("../features/voice/cameraFlip").then((m) => m.cameraFlipAvailable()),
          flip: () => import("../features/voice/cameraFlip").then((m) => m.flipCamera()),
        },
        onScreenshareToggle: () => voiceKeybindActions.onScreenshareToggle(),
      },
      getStreamStats: (tileId) =>
        tileId >= SCREENSHARE_TILE_ID_OFFSET
          ? getRemoteVideoStats(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare")
          : getRemoteVideoStats(tileId, "camera"),
      getLocalShareStats: () => getLocalScreenshareStats(),
      onStreamRemoved: () => videoModeCtrl?.checkVideoMode(),
      isStreamLive: (userId, screenshare) => {
        const { currentChannelId, voiceUsers } = voiceStore.getState();
        if (currentChannelId === null) return false;
        const user = voiceUsers.get(currentChannelId)?.get(userId);
        return (screenshare ? user?.screenshare : user?.camera) === true;
      },
      setStreamView: (tileId, view) =>
        tileId >= SCREENSHARE_TILE_ID_OFFSET
          ? setRemoteVideoView(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare", view)
          : setRemoteVideoView(tileId, "camera", view),
      setStreamWatched: (tileId, on) =>
        tileId >= SCREENSHARE_TILE_ID_OFFSET
          ? setRemoteVideoWatched(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare", on)
          : setRemoteVideoWatched(tileId, "camera", on),
      forgetStreamWatch: (tileId) =>
        tileId >= SCREENSHARE_TILE_ID_OFFSET
          ? forgetRemoteVideoWatch(tileId - SCREENSHARE_TILE_ID_OFFSET, "screenshare")
          : forgetRemoteVideoWatch(tileId, "camera"),
      // The grid header's exit control: back to chat without leaving voice.
      onExitGrid: () => videoModeCtrl?.showChat(),
      onCallPopout: (out, restore) => videoModeCtrl?.setCallPoppedOut(out, restore),
      // The mini-player's way back to the full stream view.
      focusFallback: () => void focusReachable(),
      onReturnToStream: (tileId) => {
        videoModeCtrl?.showVideoGrid();
        videoModeCtrl?.setFocus(tileId);
      },
      tileMenu,
    });

    let prevVideoSignature = "";
    let prevSpeaking = "";
    let prevAudioState = "";
    let prevViewers = "";
    let prevCallState = "";
    /** Your call state for the grid's call controls, from the voice store and
     *  the chat socket (camera and share freeze while it is down). */
    const syncCallState = (state: VoiceState): void => {
      const socket = uiStore.getState().connectionStatus;
      const shareBlock = shareBlockReason(state);
      const callState: CallState = {
        muted: isSelfMuted(state),
        deafened: state.localDeafened,
        listenOnly: state.listenOnly,
        camera: state.localCamera,
        screenshare: state.localScreenshare,
        connecting: isConnecting(state.voiceStatus),
        serverMuted: state.localServerMuted === true,
        serverDeafened: state.localServerDeafened === true,
        ...(socket === "connected" ? {} : { offline: socket }),
        ...(shareBlock === null ? {} : { shareBlock }),
      };
      const callKey = JSON.stringify(callState);
      if (callKey === prevCallState) return;
      prevCallState = callKey;
      videoGrid?.setCallState(callState);
    };
    unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => syncCallState(voiceStore.getState()),
      ),
    );
    const prevTileLabels = new Map<number, string>();
    // A page rebuilt while already in voice (reconnect) loads the grid now.
    let gridLoadChannel: number | null = voiceStore.getState().currentChannelId;
    if (gridLoadChannel !== null) chatAreaResult.videoGrid.ensureLoaded();
    // Subscribe to voice store for camera/screenshare state changes, voice
    // channel switches, remote-tile identity changes and who is speaking.
    unsubscribers.push(
      voiceStore.subscribe((state) => {
        try {
          const channelId = state.currentChannelId;
          // The grid's code loads on a join, so the import overlaps the
          // connect. Once per channel: a failed import retries on the next
          // join, not on every voice update (speaking changes fire often).
          if (channelId !== gridLoadChannel) {
            gridLoadChannel = channelId;
            if (channelId !== null) chatAreaResult.videoGrid.ensureLoaded();
          }
          // Speaking rings on the video tiles: only when who is speaking
          // changes, not on every store update.
          const talking = new Set<number>();
          for (const u of channelId !== null
            ? (state.voiceUsers.get(channelId)?.values() ?? [])
            : []) {
            if (u.speaking && !u.muted) talking.add(u.userId);
          }
          const speakingKey = [...talking].join(",");
          if (speakingKey !== prevSpeaking) {
            prevSpeaking = speakingKey;
            videoGrid?.setSpeaking(talking);
          }
          // Mute/deafen badges on the camera tiles, from the same roster state.
          let audioKey = "";
          const audioState = new Map<number, { muted: boolean; deafened: boolean }>();
          for (const u of channelId !== null
            ? (state.voiceUsers.get(channelId)?.values() ?? [])
            : []) {
            if (u.muted || u.deafened) {
              audioState.set(u.userId, { muted: u.muted, deafened: u.deafened });
              audioKey += `${String(u.userId)}:${String(u.muted)}${String(u.deafened)};`;
            }
          }
          if (audioKey !== prevAudioState) {
            prevAudioState = audioKey;
            videoGrid?.setUserAudioState(audioState);
          }
          // Eye + count on each screen-share tile: the other members watching it.
          let viewersKey = "";
          const viewerNames = new Map<number, readonly string[]>();
          const roster = channelId !== null ? state.voiceUsers.get(channelId) : undefined;
          for (const u of roster?.values() ?? []) {
            if (!u.screenshare) continue;
            const names = streamViewers(u.userId, false, state).flatMap((id) => {
              const name = roster?.get(id)?.username;
              return name === undefined ? [] : [name];
            });
            if (names.length === 0) continue;
            viewerNames.set(u.userId, names);
            viewersKey += `${String(u.userId)}:${names.join("\u0000")};`;
          }
          if (viewersKey !== prevViewers) {
            prevViewers = viewersKey;
            videoGrid?.setStreamViewers(viewerNames);
          }
          syncCallState(state);

          // Seed the signature with the channel id so ANY voice-channel
          // switch changes it, even one where the camera/screenshare flags
          // happen to be identical on both sides (e.g. both channels empty).
          // Without this, VideoModeController.checkVideoMode() — the only
          // writer of its own lastChannelId — never runs for that switch,
          // so lastChannelId is still the old channel the next time it runs
          // (e.g. right after setOnRemoteVideo adds a fresh remote tile),
          // and it clears the grid it was just given.
          let sig =
            `${String(channelId)}|` +
            (state.localCamera ? `c${String(state.localCameraRev ?? 0)}` : "") +
            (state.localScreenshare ? `s${String(state.localShareRev ?? 0)}` : "");
          if (channelId !== null) {
            const users = state.voiceUsers.get(channelId);
            if (users) {
              for (const [uid, u] of users) {
                // Everyone in the call: the call view draws an avatar tile each.
                sig += `:u${uid}`;
                if (u.camera) sig += `:c${uid}`;
                if (u.screenshare) sig += `:s${uid}`;
                // Relabel an already-open remote tile whose display name
                // changed (mid-call rename) — addStream only runs once per
                // tile, so nothing else keeps its label in sync.
                // setLabel() no-ops for a tile that isn't open yet.
                const name = personName(uid) || undefined;
                if (u.camera) {
                  const label = tileLabel(uid, false);
                  if (prevTileLabels.get(uid) !== label) {
                    prevTileLabels.set(uid, label);
                    videoGrid?.setLabel(uid, label, name);
                  }
                }
                if (u.screenshare) {
                  const tileId = uid + SCREENSHARE_TILE_ID_OFFSET;
                  const label = tileLabel(uid, true);
                  if (prevTileLabels.get(tileId) !== label) {
                    prevTileLabels.set(tileId, label);
                    videoGrid?.setLabel(tileId, label, name);
                  }
                }
              }
            }
          }
          if (sig !== prevVideoSignature) {
            prevVideoSignature = sig;
            videoModeCtrl?.checkVideoMode();
          }
        } catch (err) {
          log.error("Voice store subscription error", err);
        }
      }),
    );

    // Auto-update notifier — checks server for newer client version
    if (apiConfig.host) {
      // A bare IPv6 literal must be bracketed or the URL is unparseable and
      // the updater silently reports "no update available" forever.
      // Same helper as ws.ts, admin-panel.ts and attachments.ts.
      const serverUrl = `https://${bracketBareIPv6Host(apiConfig.host)}`;
      const updateNotifier = createUpdateNotifier({ serverUrl, keepChecking: true });
      updateNotifier.mount(root);
      children.push(updateNotifier);
    }

    // Release notes, once, on the first start after an update. Loaded on
    // demand so the prompt stays out of the eager MainPage chunk (bundle budget).
    const promptHost = root;
    void import("../features/whats-new/whatsNewPrompt").then(({ createWhatsNewPrompt }) => {
      if (tornDown) return;
      // i18n-exempt: settings tab key, not shown text
      const whatsNewPrompt = createWhatsNewPrompt(() => openSettings("About"));
      whatsNewPrompt.mount(promptHost);
      unsubscribers.push(() => whatsNewPrompt.destroy?.());
    });

    container.appendChild(root);

    // Only the channel that owns the current call keeps the grid up: the joined
    // voice channel (its chat sits beside the grid) or the DM whose
    // call panel shows the video above the chat (its own update re-seats the
    // grid through onVideoHostChange). Every other channel mounts a chat
    // surface and must dismiss it, another voice channel's chat opened from
    // its menu included.
    const showChatFor = (active: { id: number; type: string }): void => {
      const ownsCall =
        (active.type === "dm" || active.type === "voice") &&
        voiceStore.getState().currentChannelId === active.id;
      if (!ownsCall) videoModeCtrl?.showChat({ keepWatching: true });
    };
    // A click on the channel already open under the stream view changes no
    // store, so the subscriber below never sees it.
    unsubscribers.push(
      onChannelReselect(() => {
        const active = getActiveChannel();
        if (active !== null) showChatFor(active);
      }),
    );

    // --- Subscribe to channel changes ---
    const unsubChannels = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => {
        try {
          const active = getActiveChannel();
          if (active !== null) {
            showChatFor(active);
            // The profile panel follows the conversation: a 1:1 DM keeps it
            // (rebuilt for the new person) while the saved preference is on, a
            // group or a server channel hides it without changing the preference.
            syncDmProfileToActive();
            withGroupPanel((ctrl) => ctrl.syncToActive());
            channelCtrl?.mountChannel(
              active.id,
              resolveChannelName(active.id, active.name, active.type),
              active.type,
            );
          } else {
            // The active channel was cleared with nothing to replace it
            // (deleted, or a DM closed while offline) — without this the
            // previous channel's MessageList/composer stayed mounted and
            // enabled against a channel the server no longer recognizes.
            closeDmProfile();
            withGroupPanel((ctrl) => ctrl.close());
            channelCtrl?.destroyChannel();
          }
        } catch (err) {
          log.error("Channel mount failed", err);
        }
      },
    );
    unsubscribers.push(unsubChannels);

    const active = getActiveChannel();
    if (active !== null) {
      channelCtrl?.mountChannel(
        active.id,
        resolveChannelName(active.id, active.name, active.type),
        active.type,
      );
      // A 1:1 DM already active at mount opens its remembered panel.
      syncDmProfileToActive();
      withGroupPanel((ctrl) => ctrl.syncToActive());
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    tornDown = true;
    // Each step is isolated: a throw is logged and the rest still run, so a
    // failing step can never skip the store unsubscriptions below. The module
    // caches this page used to clear here reset with the session instead
    // (sessionRegistry, cache phase).
    const step = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        log.error("MainPage teardown step failed", { name, error: String(err) });
      }
    };
    step("cancelPendingRing", cancelPendingRing);
    try {
      // closeSettings() is otherwise only ever called from the overlay's own
      // onClose — a non-user-initiated unmount (401, ban, server shutdown)
      // left `settingsOpen` stale, and the next page to mount an (initially
      // hidden) SettingsOverlay off that flag — ConnectPage, after logout —
      // would show it over the login screen.
      step("closeSettings", closeSettings);
      // Before the chat teardown below: the view and its private content go
      // first, and the next page starts with no view open.
      step("contentNav", () => {
        contentNav?.destroy();
        contentNav = null;
      });
      step("teardownToast", teardownToast);
      step("notesContext", () => setNotesContextSource(null));
      // Full voice cleanup — tears down room, callbacks, ws ref, serverHost.
      // Prevents stale module-level state persisting across logout/reconnect cycles.
      step("voiceCleanupAll", voiceCleanupAll);
      step("unsubCacheScope", unsubCacheScope);
      // The lightbox is a module-level overlay appended straight to
      // document.body — renderPage only clears #app, so a forced logout with
      // it open would otherwise leave it floating over the login screen with
      // live document listeners and a since-revoked blob URL.
      step("closeActiveLightbox", closeActiveLightbox);
      step("autoIdle", () => {
        autoIdle?.destroy();
        autoIdle = null;
      });
      step("musicActivity", () => {
        musicActivity?.destroy();
        musicActivity = null;
      });
      step("gameActivity", () => {
        gameActivity?.destroy();
        gameActivity = null;
      });
      step("statusTimerWatcher", () => {
        statusTimerWatcher?.destroy();
        statusTimerWatcher = null;
      });
      step("presenceSender", () => {
        presenceSender.destroy();
        setActivePresenceSender(null);
      });
      // Drop the mark-read sender (and, via setMarkReadSender's own
      // cancelPendingMarkAll, any still-armed "Mark All as Read" burst
      // timers) at the moment this connection is abandoned. Without this,
      // a paced burst survives teardown and fires against whichever server
      // is live when its timer elapses — channel ids are per-server, so
      // that can silently mark an unrelated channel read on the NEXT
      // connection.
      step("markReadSender", () => setMarkReadSender(null));
      step("markUnreadSender", () => setMarkUnreadSender(null));
      // The native screen-share picker is registered per page; drop it so a
      // torn-down connection cannot leave the next page's dialog pointed at a
      // dead one (a share with none registered resolves to cancelled).
      step("screenSourcePicker", () => setScreenSourcePicker(null));
      step("channelCtrl", () => {
        channelCtrl?.destroy();
        channelCtrl = null;
      });
      step("reactionCtrl", () => {
        reactionCtrl?.destroy();
        reactionCtrl = null;
        msgCtrl = null;
      });
      step("callChat", () => {
        callChat?.destroy();
        callChat = null;
      });
      step("videoModeCtrl", () => {
        videoModeCtrl?.destroy();
        videoModeCtrl = null;
        videoGrid = null;
      });
      step("closeDmProfile", closeDmProfile);
      step("groupPanelCtrl", () => {
        groupPanelCtrl?.destroy();
        groupPanelCtrl = null;
        dmMembersBtn = null;
        dmProfileSlot = null;
      });

      for (const child of children) {
        try {
          child.destroy?.();
        } catch (err) {
          log.error("Child destroy error", err);
        }
      }
      children = [];

      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch (err) {
          log.error("Unsubscribe error", err);
        }
      }
      unsubscribers = [];

      step("banner", () => {
        banner?.destroy();
        banner = null;
      });
    } finally {
      if (root !== null) {
        root.remove();
        root = null;
      }
      container = null;
    }
  }

  return { mount, destroy };
}
