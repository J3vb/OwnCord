// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import { bracketBareIPv6Host } from "@lib/ws";
import type { UserStatus } from "@lib/types";
import { errorText } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createRateLimiterSet } from "@lib/rate-limiter";
import type { VideoGridComponent } from "@components/VideoGrid";
import { createServerBanner, applyConnectionStatus } from "@components/ServerBanner";
import type { ServerBannerControl } from "@components/ServerBanner";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { createToastContainer } from "@components/Toast";
import type { ToastContainer } from "@components/Toast";
import { initToast, teardownToast, showToast, showChangeOutcomeToast } from "@lib/toast";
import { accountText as account } from "../i18n/account";
import { shellText } from "../i18n/shell";
import { sessionNoticeMessage, startSessionNotice } from "@lib/session-notice";
import { logout } from "@lib/logout";
import { authStore, clearAuth, onAuthCleared, updateUser } from "@stores/auth.store";
import { closeSettings, setSessionReplaced, uiStore } from "@stores/ui.store";
import { loadUserStatus } from "@lib/userStatus";
import { createPresenceSender, setActivePresenceSender } from "@lib/presence";
import { startAutoIdle, type AutoIdleController } from "@lib/autoIdle";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { clearCustomEmoji } from "@stores/emoji.store";
import {
  cleanupAll as voiceCleanupAll,
  setOnRemoteVideo,
  setOnRemoteVideoRemoved,
  clearOnRemoteVideo,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
} from "@lib/livekitSession";
import { setServerHost } from "@components/message-list/renderers";
import {
  clearAttachmentCaches,
  clearExternalImageCache,
  pruneAttachmentCacheScope,
  setAttachmentCacheScope,
} from "@components/message-list/attachments";
import { clearEmbedCaches } from "@components/message-list/embeds";
import { clearMediaCaches, closeActiveLightbox } from "@components/message-list/media";
import { forgetAdmittedItems } from "../features/content-consent/external";
import {
  setReactionUsersFetcher,
  clearReactionUsersCache,
} from "@components/message-list/reaction-tooltip";
import { setMarkReadSender } from "@lib/read-state";
import { setChannelMutesHost } from "@lib/channel-mutes";
import { setAudioVolumeHost } from "@lib/audioElements";
import { createQuickSwitcherManager } from "./main-page/OverlayManagers";
import { attachGlobalKeybinds } from "./main-page/GlobalKeybinds";
import { createVoiceWidgetCallbacks } from "./main-page/VoiceCallbacks";
import { createMessageController, createPendingDeleteManager } from "./main-page/MessageController";
import type { MessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import type { ReactionController } from "./main-page/ReactionController";
import { createVideoModeController } from "./main-page/VideoModeController";
import type { VideoModeController } from "./main-page/VideoModeController";
import { createChannelController } from "./main-page/ChannelController";
import type { ChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import type { DmProfileData, DmProfileSidebarComponent } from "@components/DmProfileSidebar";
import { createIncomingCallBanner } from "@components/IncomingCallBanner";
import type { IncomingCallBannerComponent } from "@components/IncomingCallBanner";
import { createRingController } from "@lib/call-ring";
import type { RingController } from "@lib/call-ring";
import { startRingChime, stopRingChime } from "@lib/notifications";
import { createSidebarVoiceCallbacks } from "./main-page/VoiceCallbacks";
import { createSidebarArea } from "./main-page/SidebarArea";
import { createChatArea } from "./main-page/ChatArea";
import type { SidebarDrawer } from "./main-page/SidebarDrawer";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { NAVIGATION_DESTINATIONS } from "../features/navigation/destinations";
import { createContentNavigator } from "../features/navigation/contentView";
import { createNoticesBanner } from "../features/safety/Notices";
import type { ContentNavigator } from "../features/navigation/contentView";

const log = createLogger("main-page");
/** Long enough to read which sign-in it names (cf. toast.ts PARTIAL_SUCCESS_TOAST_MS). */
const SESSION_NOTICE_TOAST_MS = 12_000;

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
  const rawStatus = membersStore.getState().members.get(recipient.id)?.status ?? recipient.status;
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
    about: null,
    joinDate: null,
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
  // Server images are cached per account, not per host: two accounts on one
  // server see different channels. Expired the moment auth clears, so a
  // profile switch isolates the cache even before this page is destroyed.
  const cacheScope = apiConfig.host ? `${apiConfig.host}#${getCurrentUserId()}` : null;
  setAttachmentCacheScope(cacheScope);
  const unsubCacheScope = onAuthCleared(() => setAttachmentCacheScope(null));

  // "Mark as Read" affordances need the socket but are reached from deep inside
  // the sidebar; register the sender once instead of threading ws through.
  setMarkReadSender((channelId) => {
    ws.send({ type: "mark_read", payload: { channel_id: channelId } });
  });

  // The who-reacted tooltip fetches on hover; give it the live REST client the
  // same way the attachment renderer is given the server host.
  clearReactionUsersCache();
  setReactionUsersFetcher(async (channelId, messageId, emoji) => {
    const res = await api.getReactionUsers(channelId, messageId, emoji);
    return res.users;
  });

  const limiters = createRateLimiterSet();

  // The one presence_update sender for this session — owns the limiter
  // token, the drop-window retry, and the local optimistic update, so
  // every producer (auto-idle, the settings Account tab via applyPresence
  // below, and the UserBar status picker it's threaded to through
  // SidebarArea) shares the exact same budget the server enforces (1
  // update / 10s, keyed by user id — service/channel.go). A limiter created
  // per producer instead cannot predict that shared, cross-surface budget
  // (OC-0210).
  const presenceSender = createPresenceSender(ws, limiters.presence);
  // Publish this as the session's one PresenceSender so producers wired up
  // outside MainPage — main.ts's tray "status-change" listener — share the
  // same limiter token, coalescing retry, and optimistic update instead of
  // opening a second budget the server doesn't know about (OC-0176). Cleared
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

  // Pending delete confirmations (double-click to delete pattern)
  const pendingDeleteManager = createPendingDeleteManager();

  // Extracted controllers (created in mount)
  let msgCtrl: MessageController | null = null;
  let reactionCtrl: ReactionController | null = null;
  let videoModeCtrl: VideoModeController | null = null;
  let channelCtrl: ChannelController | null = null;
  /** Inactivity watcher that flips the status to idle after ten quiet
   *  minutes. Started once the socket is up, torn down with the page. */
  let autoIdle: AutoIdleController | null = null;

  // Toast container for user-facing error feedback
  let toast: ToastContainer | null = null;

  // DM profile sidebar (right panel, toggled via DM header click)
  let dmProfileSidebar: DmProfileSidebarComponent | null = null;
  let dmProfileSlot: HTMLDivElement | null = null;
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

  // B9-4: the content view (Message Requests, Moderation) shown in place of
  // the chat column. Created in mount, once the chat column exists.
  let contentNav: ContentNavigator | null = null;

  // DM calls: the banner draws a ring, the controller owns its lifetime.
  let callBanner: IncomingCallBannerComponent | null = null;
  let ringCtrl: RingController | null = null;

  // The narrow-width sidebar drawer (WCAG 1.4.10). Null above 800px in
  // practice, but always created so the breakpoint is decided by CSS, not JS.
  let sidebarDrawer: SidebarDrawer | null = null;

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
   *  the latest value — see @lib/presence. */
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
      closeDmProfile();
      return;
    }

    // Only open in DM mode
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;

    const channelId = active.id;
    const profileUser = buildDmProfileUser(channelId);
    if (profileUser === null) return;

    const load = {};
    dmProfileLoad = load;
    void import("@components/DmProfileSidebar").then(
      ({ createDmProfileSidebar }) => {
        // A close (or teardown) since the click supersedes this import: drop it.
        if (tornDown || dmProfileLoad !== load || dmProfileSlot === null) return;
        dmProfileLoad = null;

        dmProfileSidebar = createDmProfileSidebar({
          user: profileUser,
          host: apiConfig.host ?? "",
          onClose: () => {
            closeDmProfile();
          },
        });
        dmProfileSidebar.mount(dmProfileSlot);

        // Keep the panel's status and name live across presence/rename/
        // nickname changes for as long as it stays open on this DM --
        // otherwise it is painted once from this open-time snapshot and never
        // updated until re-mounted, leaving it disagreeing with the chat
        // header it was opened from (which ChannelController.ts:621-638
        // already keeps live the same way). Torn down in closeDmProfile.
        const recipientId = profileUser.id;
        const refresh = (): void => {
          const next = buildDmProfileUser(channelId);
          if (next !== null) dmProfileSidebar?.update(next);
        };
        const unsubMembers = membersStore.subscribeSelector(
          (s) => s.members.get(recipientId)?.status,
          refresh,
        );
        const unsubDm = dmStore.subscribeSelector(
          (s) => s.channels.find((c) => c.channelId === channelId),
          refresh,
        );
        dmProfileUnsub = () => {
          unsubMembers();
          unsubDm();
        };
      },
      () => {
        // The panel could not load; a later click may retry.
        if (dmProfileLoad === load) dmProfileLoad = null;
      },
    );
  }

  /**
   * Start a call in the currently open DM: join its voice channel and ring the
   * other participants.
   *
   * Joining first is deliberate. A "call" is presence in the DM's voice
   * channel, so the ring is only truthful once the caller is actually there —
   * ringing first would offer an empty room to whoever accepts.
   */
  function startCall(): void {
    const active = getActiveChannel();
    if (active === null || active.type !== "dm") return;
    // onVoiceJoin silently refuses to join when the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — without this check the ring
    // and "Calling…" toast fire anyway, promising a call nobody can hear.
    if (uiStore.getState().connectionStatus !== "connected") {
      showToast(shellText("channel.notConnected"), "error");
      return;
    }
    createSidebarVoiceCallbacks(ws).onVoiceJoin(active.id);
    ws.send({ type: "call_ring", payload: { channel_id: active.id } });
    showToast(account("toast.calling"), "info");
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
    // the server displaces the other one (last connect wins).
    const useHere = (): void => {
      const token = authStore.getState().token;
      if (token === null) return;
      setSessionReplaced(false);
      ws.connect({ host: api.getConfig().host, token });
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
    if (uiStore.getState().connectionStatus === "connected") restoreSavedPresence();

    // Auto-idle. It only ever moves a status it is itself responsible for
    // (see @lib/autoIdle) — a manually chosen Idle, Do Not Disturb or
    // Invisible is never touched — so it is safe to leave running for the
    // whole session.
    autoIdle = startAutoIdle({ onStatusChange: (status) => applyPresence(status) });

    unsubscribers.push(
      ws.on("server_restart", (payload) => {
        try {
          // A "shutdown" broadcast kicks back to the login screen (handled in
          // the dispatcher) — no point starting a countdown on a page that is
          // about to unmount.
          if (banner !== null && payload.reason !== "shutdown") {
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
        videoModeCtrl.showVideoGrid();
        videoModeCtrl.setFocus(userId);
      },
      destinations: NAVIGATION_DESTINATIONS,
      onOpenView: (id, opener) => contentNav?.open(id, opener),
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
      onStartCall: () => {
        startCall();
      },
    });
    dmProfileSlot = chatAreaResult.dmProfileSlot;
    children.push(...chatAreaResult.children);
    unsubscribers.push(...chatAreaResult.unsubscribers);
    videoGrid = chatAreaResult.videoGrid;

    // Video mode controller (chat/video toggle + tile management)
    videoModeCtrl = createVideoModeController({
      slots: chatAreaResult.slots,
      videoGrid: chatAreaResult.videoGrid,
      getCurrentUserId,
    });

    // The composer of the channel on screen, else the sidebar's first control.
    const focusReachable = (): HTMLElement | null => {
      const reachable =
        chatAreaResult.slots.inputSlot.querySelector<HTMLElement>("textarea:enabled") ??
        sidebar.sidebarWrapper.querySelector<HTMLElement>("button");
      reachable?.focus();
      return reachable;
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

    appendChildren(
      app,
      sidebar.sidebarWrapper,
      chatAreaResult.chatArea,
      contentNav.element,
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
        onOpen: chatAreaResult.closePinnedPanel,
      });
    });
    unsubscribers.push(() => {
      sidebarDrawer?.destroy();
      sidebarDrawer = null;
    });

    // --- Moderation notices (B9-15, Q4): persistent, above the app row ---
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
      onLogout: () => logout(api),
      getRetentionNotice: options.getRetentionNotice,
      ...(safety === undefined ? {} : { safetyTab: (signal) => safety.build(signal, api) }),
      onDeleteAccount: async (password) => {
        await api.deleteAccount(password);
        clearAuth();
        // The account is gone, so its cached server images go too (B7-15c).
        // clearAuth has already disarmed the scope, so no late write follows.
        if (cacheScope !== null) void pruneAttachmentCacheScope(cacheScope);
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
        // auth_ok never does (OC-0354). A failed read changes nothing, and
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
    );
    unsubscribers.push(qsManager.attach());

    // The rest of the shortcuts listed on the settings Keybinds tab.
    const voiceKeybindActions = createVoiceWidgetCallbacks(ws, limiters);
    unsubscribers.push(
      attachGlobalKeybinds({
        onSearch: () => chatAreaResult.searchCtrl.open(),
        onToggleMute: () => voiceKeybindActions.onMuteToggle(),
        onToggleDeafen: () => voiceKeybindActions.onDeafenToggle(),
        onToggleCamera: () => voiceKeybindActions.onCameraToggle(),
        onUploadFile: () => channelCtrl?.openFilePicker(),
        // Don't fire app shortcuts while the settings panel is on top of them.
        isSuspended: () => uiStore.getState().settingsOpen,
      }),
    );

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
      onRingStateChange: (state) => callBanner?.setRing(state),
      onChime: (playing) => (playing ? startRingChime() : stopRingChime()),
      onAccept: (channelId) => {
        createSidebarVoiceCallbacks(ws).onVoiceJoin(channelId);
      },
      onDecline: (channelId) => {
        ws.send({ type: "call_decline", payload: { channel_id: channelId } });
      },
    });
    callBanner = createIncomingCallBanner({
      onAccept: () => {
        // ringCtrl.accept() unconditionally consumes the ring
        // (stopRinging) before onVoiceJoin ever runs, and onVoiceJoin itself
        // silently refuses to join while the socket is down (VoiceCallbacks
        // .ts's socketLive() guard) — so accepting while reconnecting would
        // otherwise discard the ring for good with no join and no retry.
        // Guarded here, the banner's only caller of accept(), so the ring
        // survives for the user to accept again once reconnected.
        if (uiStore.getState().connectionStatus !== "connected") {
          showToast(account("voice.canAnswerWhileReconnecting"), "error");
          return;
        }
        ringCtrl?.accept();
      },
      onDecline: () => ringCtrl?.decline(),
    });
    callBanner.mount(root);
    children.push(callBanner);

    unsubscribers.push(
      ws.on("call_incoming", (payload) => {
        try {
          // A call in the DM you are already sitting in still rings: the
          // channel being open does not mean the app has focus, and Discord
          // rings there too.
          // Resolve through the members store, same as every other identity
          // surface (voice roster, member list, DM header) -- the raw wire
          // username is only a fallback for a caller this client hasn't
          // seen yet (OC-0303).
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
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.from_user === ringing.fromUserId) {
          ringCtrl?.cancel(payload.channel_id);
        }
      }),
    );
    // The ringer hanging up before anyone answered: their voice_leave is the
    // only signal there is that the call is over, because there is no call
    // record to close. Ringing for a room with nobody in it is worse than a
    // missed call, so a leave stops the ring for that channel — but only
    // when the ringer leaving actually emptied it. A group DM can still hold
    // other callees who already accepted (voiceStore.voiceUsers answers
    // that), and the ringer hanging up must not silence a call that is
    // still live for them (OC-0235).
    unsubscribers.push(
      ws.on("voice_leave", (payload) => {
        const ringing = ringCtrl?.current();
        if (ringing === null || ringing === undefined) return;
        if (payload.user_id !== ringing.fromUserId) return;
        const roster = voiceStore.getState().voiceUsers.get(payload.channel_id);
        const othersStillIn =
          roster !== undefined && [...roster.keys()].some((id) => id !== payload.user_id);
        if (!othersStillIn) {
          ringCtrl?.cancel(payload.channel_id);
        }
      }),
    );
    unsubscribers.push(() => {
      ringCtrl?.destroy();
      ringCtrl = null;
      callBanner = null;
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
      pendingDeleteManager,
      reactionCtrl: reactionCtrl,
      typingLimiter: limiters.typing,
      showToast: (msg, type) => showToast(msg, type as "success" | "error" | "info"),
      getCurrentUserId,
      slots: {
        messagesSlot: chatAreaResult.slots.messagesSlot,
        typingSlot: chatAreaResult.slots.typingSlot,
        inputSlot: chatAreaResult.slots.inputSlot,
      },
      chatHeaderName: chatAreaResult.chatHeaderName,
      chatHeaderRefs: chatAreaResult.chatHeaderRefs,
      onContentGated: closeActiveLightbox,
      focusFallback: focusReachable,
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => showToast(msg, "error"));

    // The label shown on a video tile: memberDisplayName when known —
    // the same identity a rename shows everywhere else (ChannelSidebar's
    // voice roster, message rows, the member list) — falling back to the
    // voice roster's (possibly frozen) username, then a placeholder. Single
    // writer so tile creation (setOnRemoteVideo below) and tile relabeling
    // on a mid-call rename (the voiceStore subscriber below) cannot disagree
    // (OC-0227).
    //
    // Self-aware, because the relabel loop walks the whole voice roster and the
    // roster includes you: VideoModeController registers the local tiles as
    // "<name> (You)" / "Your Screen", and a bare remote label written over them
    // leaves your own tile indistinguishable from a participant's (OC-0375).
    // These two branches must keep matching VideoModeController's addStream
    // labels — that is what the OC-0375 test pins.
    function tileLabel(userId: number, isScreenshare: boolean): string {
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      const channelUsers = channelId !== null ? voice.voiceUsers.get(channelId) : undefined;
      const voiceUser = channelUsers?.get(userId);
      const member = membersStore.getState().members.get(userId);
      const name = (member !== undefined ? memberDisplayName(member) : "") || voiceUser?.username;
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
      videoGrid.addStream(tileId, username, stream, {
        isSelf: false,
        audioUserId: userId,
        isScreenshare,
      });
      videoModeCtrl?.checkVideoMode();
    });
    setOnRemoteVideoRemoved((userId, isScreenshare) => {
      const tileId = isScreenshare ? userId + SCREENSHARE_TILE_ID_OFFSET : userId;
      videoGrid?.removeStream(tileId);
      videoModeCtrl?.checkVideoMode();
    });
    unsubscribers.push(() => clearOnRemoteVideo());

    // Subscribe to voice store for camera/screenshare state changes, voice
    // channel switches, and remote-tile identity changes (not speaking ticks)
    let prevVideoSignature = "";
    const prevTileLabels = new Map<number, string>();
    unsubscribers.push(
      voiceStore.subscribe((state) => {
        try {
          const channelId = state.currentChannelId;
          // Seed the signature with the channel id so ANY voice-channel
          // switch changes it, even one where the camera/screenshare flags
          // happen to be identical on both sides (e.g. both channels empty).
          // Without this, VideoModeController.checkVideoMode() — the only
          // writer of its own lastChannelId — never runs for that switch,
          // so lastChannelId is still the old channel the next time it runs
          // (e.g. right after setOnRemoteVideo adds a fresh remote tile),
          // and it clears the grid it was just given (OC-0207).
          let sig =
            `${String(channelId)}|` +
            (state.localCamera ? "c" : "") +
            (state.localScreenshare ? "s" : "");
          if (channelId !== null) {
            const users = state.voiceUsers.get(channelId);
            if (users) {
              for (const [uid, u] of users) {
                if (u.camera) sig += `:c${uid}`;
                if (u.screenshare) sig += `:s${uid}`;
                // Relabel an already-open remote tile whose display name
                // changed (mid-call rename) — addStream only runs once per
                // tile, so nothing else keeps its label in sync (OC-0227).
                // setLabel() no-ops for a tile that isn't open yet.
                if (u.camera) {
                  const label = tileLabel(uid, false);
                  if (prevTileLabels.get(uid) !== label) {
                    prevTileLabels.set(uid, label);
                    videoGrid?.setLabel(uid, label);
                  }
                }
                if (u.screenshare) {
                  const tileId = uid + SCREENSHARE_TILE_ID_OFFSET;
                  const label = tileLabel(uid, true);
                  if (prevTileLabels.get(tileId) !== label) {
                    prevTileLabels.set(tileId, label);
                    videoGrid?.setLabel(tileId, label);
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
      // the updater silently reports "no update available" forever (OC-0332).
      // Same helper as ws.ts, admin-panel.ts and attachments.ts.
      const serverUrl = `https://${bracketBareIPv6Host(apiConfig.host)}`;
      const updateNotifier = createUpdateNotifier({ serverUrl });
      updateNotifier.mount(root);
      children.push(updateNotifier);
    }

    container.appendChild(root);

    // --- Subscribe to channel changes ---
    const unsubChannels = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => {
        try {
          const active = getActiveChannel();
          if (active !== null) {
            // Voice is the only channel type that should keep the grid up;
            // text, dm and announcement all mount a chat surface and must
            // dismiss it, not just "text" (a dm/announcement switch used to
            // leave the grid covering an unrelated channel's chat).
            if (active.type !== "voice") {
              videoModeCtrl?.showChat();
            }
            // Close DM profile sidebar when switching channels
            if (active.type !== "dm") {
              closeDmProfile();
            } else {
              // Also close when switching to a different DM
              closeDmProfile();
            }
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
    }
  }

  function destroy(): void {
    log.info("MainPage destroying");
    tornDown = true;
    try {
      // closeSettings() is otherwise only ever called from the overlay's own
      // onClose — a non-user-initiated unmount (401, ban, server shutdown)
      // left `settingsOpen` stale, and the next page to mount an (initially
      // hidden) SettingsOverlay off that flag — ConnectPage, after logout —
      // would show it over the login screen.
      closeSettings();
      // Before the chat teardown below: the view and its private content go
      // first, and the next page starts with no view open.
      contentNav?.destroy();
      contentNav = null;
      teardownToast();
      // Full voice cleanup — tears down room, callbacks, ws ref, serverHost.
      // Prevents stale module-level state persisting across logout/reconnect cycles.
      voiceCleanupAll();
      // Custom emoji belong to the server this page was connected to. The set
      // is module-global, so without this a switch to another server would keep
      // rendering the previous one's shortcodes until its own list arrived.
      clearCustomEmoji();
      // Image/video/audio caches are module-global too — without this every
      // clip viewed this session stays pinned (as a blob: URL or a cached
      // data: URI) past logout.
      clearAttachmentCaches();
      unsubCacheScope();
      // External content (link previews, YouTube titles, image heights, and
      // broker-fetched images) was fetched for this server. Clearing it here
      // — and moving the broker to a fresh partition — is what keeps one
      // server's previews from being served on the next (B7-16).
      clearEmbedCaches();
      clearMediaCaches();
      clearExternalImageCache();
      forgetAdmittedItems();
      // The lightbox is a module-level overlay appended straight to
      // document.body — renderPage only clears #app, so a forced logout with
      // it open would otherwise leave it floating over the login screen with
      // live document listeners and a since-revoked blob URL (B6-15).
      closeActiveLightbox();
      autoIdle?.destroy();
      autoIdle = null;
      presenceSender.destroy();
      setActivePresenceSender(null);
      // Drop the mark-read sender (and, via setMarkReadSender's own
      // cancelPendingMarkAll, any still-armed "Mark All as Read" burst
      // timers) at the moment this connection is abandoned. Without this,
      // a paced burst survives teardown and fires against whichever server
      // is live when its timer elapses — channel ids are per-server, so
      // that can silently mark an unrelated channel read on the NEXT
      // connection (OC-0418).
      setMarkReadSender(null);
      channelCtrl?.destroyChannel();
      channelCtrl = null;

      reactionCtrl?.destroy();
      reactionCtrl = null;
      msgCtrl = null;
      videoModeCtrl?.destroy();
      videoModeCtrl = null;

      videoGrid = null;

      closeDmProfile();
      dmProfileSlot = null;

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

      if (banner !== null) {
        banner.destroy();
        banner = null;
      }
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
