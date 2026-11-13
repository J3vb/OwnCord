// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { createElement } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { type WsClient } from "@lib/ws";
import { type ApiClient } from "@lib/api";
import { createRateLimiterSet } from "@lib/net/rateLimiter";
import { createToastContainer } from "@lib/ui/toastContainer";
import { initToast, teardownToast, showToast } from "@lib/ui/toast";
import { onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { Disposable } from "@lib/disposable";
import { onAuthCleared } from "@stores/auth.store";
import { closeSettings, openSettings, uiStore } from "@stores/ui.store";
import { createPresenceSender } from "@lib/presence/presence";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { voiceStore, restoreSavedSelfVoiceState } from "@stores/voice.store";
import {
  cleanupAll as voiceCleanupAll,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
} from "@lib/voice/livekitSession";
import { setServerHost } from "../features/messaging/message-list/renderers";
import { setAttachmentCacheScope } from "../features/messaging/content/attachments";
import { closeActiveLightbox } from "../features/messaging/content/media";
import { markAllRead } from "@lib/readState";
import { onChannelReselect, stepChannel } from "@lib/nav/channelNavigation";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
import { setAudioVolumeHost } from "@lib/voice/audioElements";
import { attachGlobalKeybinds } from "./main-page/GlobalKeybinds";
import { createVoiceWidgetCallbacks } from "./main-page/VoiceCallbacks";
import { createMessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import { createChannelController } from "./main-page/ChannelController";
import { log, resolveChannelName, getCurrentUserId } from "./main-page/pageShared";
import type { PageState, PageApi } from "./main-page/pageState";
import { createDmProfilePanel } from "../features/direct-messages/dmProfilePanel";
import { createPageDmCalls } from "./main-page/pageDmCalls";
import { createPagePresence } from "./main-page/pagePresence";
import { mountConnectionBanner, mountLayout } from "./main-page/pageMountShell";
import { mountSettings } from "./main-page/pageMountSettings";
import { mountCalls, mountVideo } from "./main-page/pageMountCalls";
import type { MountScope } from "./main-page/pageState";
import { sessionHooks } from "./main-page/sessionHooks";
import { backgroundFeatures, overlayFeatures } from "./main-page/pageFeatures";
import { isGlobalPollerActive, startGlobalVoiceKeys } from "./main-page/globalVoiceKeys";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MainPageOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  /** The connected server's retention sentence, or null when unknown. */
  readonly getRetentionNotice?: () => string | null;
}

/** One teardown step: a throw is logged and the rest still run. */
function step(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error("MainPage teardown step failed", { name, error: String(err) });
  }
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

  const limiters = createRateLimiterSet();

  // The one presence_update sender for this session — owns the limiter
  // token, the drop-window retry, and the local optimistic update, so
  // every producer (auto-idle, the settings Account tab via applyPresence
  // below, and the UserBar status picker it's threaded to through
  // SidebarArea) shares the exact same budget the server enforces (1
  // update / 10s, keyed by user id — service/channel.go). A limiter created
  // per producer instead cannot predict that shared, cross-surface budget.
  const presenceSender = createPresenceSender(ws, limiters.presence);

  const st: PageState = {
    options,
    ws: ws,
    api: api,
    apiConfig: apiConfig,
    cacheScope: cacheScope,
    unsubCacheScope: unsubCacheScope,
    limiters: limiters,
    presenceSender: presenceSender,
    container: null,
    root: null,
    tornDown: false,
    children: [],
    unsubscribers: [],
    banner: null,
    videoGrid: null,
    msgCtrl: null,
    reactionCtrl: null,
    videoModeCtrl: null,
    callChat: null,
    channelCtrl: null,
    autoIdle: null,
    gameActivity: null,
    musicActivity: null,
    speakingActivityTimer: null,
    statusTimerWatcher: null,
    toast: null,
    dmProfileSidebar: null,
    dmProfileSlot: null,
    dmProfileBtn: null,
    dmProfileChannelId: 0,
    dmProfileUnsub: null,
    dmProfileLoad: null,
    groupPanelCtrl: null,
    groupPanelLoad: null,
    dmMembersBtn: null,
    contentNav: null,
    callBanner: null,
    ringCtrl: null,
    outgoingCall: null,
    callPanel: null,
    callPanelHost: null,
    cameraOnJoin: null,
    sidebarDrawer: null,
    memberColumn: null,
    callViewUp: false,
    lastRingAt: Number.NEGATIVE_INFINITY,
    lastRingId: null,
    ringTimer: null,
    ringJoinWatch: null,
  };
  for (const hook of sessionHooks) hook.install(st);
  const pg = {} as PageApi;
  Object.assign(
    pg,
    createDmProfilePanel(st, pg),
    createPageDmCalls(st, pg),
    createPagePresence(st, pg),
  );

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(target: Element): void {
    const ms = {} as MountScope;
    ms.target = target;

    log.info("MainPage mounting");
    st.container = ms.target;

    st.root = createElement("div", {
      style: "display:flex;flex-direction:column;height:100vh;width:100%",
    });
    mountConnectionBanner(st, pg, ms);
    mountLayout(st, pg, ms);
    mountSettings(st, pg, ms);

    // The rest of the shortcuts listed on the settings Keybinds tab.
    ms.voiceKeybindActions = createVoiceWidgetCallbacks(st.ws, st.limiters);
    ms.shortcutsOverlay = null;
    ms.shortcutsClosed = false;
    st.unsubscribers.push(() => {
      ms.shortcutsClosed = true;
      ms.shortcutsOverlay?.closeShortcutsOverlay();
    });
    st.unsubscribers.push(
      attachGlobalKeybinds({
        onSearch: () => ms.chatAreaResult.searchCtrl.open(),
        onOpenSettings: () => openSettings(),
        onOpenShortcuts: () =>
          void import("../features/navigation/ShortcutsOverlay")
            .then((m) => {
              // The page may have unmounted while the chunk loaded.
              if (ms.shortcutsClosed) return;
              ms.shortcutsOverlay = m;
              m.openShortcutsOverlay();
            })
            .catch((err: unknown) => log.warn("Shortcuts overlay failed to open", err)),
        onToggleMute: () => ms.voiceKeybindActions.onMuteToggle(),
        onToggleDeafen: () => ms.voiceKeybindActions.onDeafenToggle(),
        onToggleCamera: () => ms.voiceKeybindActions.onCameraToggle(),
        onToggleScreenshare: () => ms.voiceKeybindActions.onScreenshareToggle(),
        onDisconnect: () => ms.voiceKeybindActions.onDisconnect(),
        onUploadFile: () => st.channelCtrl?.openFilePicker(),
        onTogglePicker: (kind) => st.channelCtrl?.togglePicker(kind),
        onMarkChannelRead: () => st.channelCtrl?.messageList?.markReadAndJumpToPresent(),
        // A server-wide action, like the header's Mark Server as Read: DMs stay as they are.
        onMarkServerRead: () => markAllRead({ includeDms: false }),
        onScrollMessages: (direction) => st.channelCtrl?.messageList?.scrollPage(direction),
        onStepChannel: (direction, unreadOnly) => {
          if (uiStore.getState().sidebarMode === "dms") ms.sidebar.rememberChannel();
          stepChannel(direction, unreadOnly);
        },
        ringActive: () => st.ringCtrl?.current() != null,
        onAcceptRing: () => pg.acceptRing(false),
        onDeclineRing: () => st.ringCtrl?.decline(),
        // Don't fire app shortcuts while the settings panel is on top of them.
        isSuspended: () => uiStore.getState().settingsOpen,
        isGlobalPollerActive,
      }),
    );

    startGlobalVoiceKeys(st, ms.voiceKeybindActions);

    for (const start of backgroundFeatures) start(st, st.root);

    // Toast container
    st.toast = createToastContainer();
    st.toast.mount(st.root);
    st.toast.anchorTo(ms.chatAreaResult.slots.inputSlot);
    st.children.push(st.toast);
    initToast(st.toast);
    mountCalls(st, pg, ms);

    // Message loading controller
    st.msgCtrl = createMessageController({
      api: st.api,
      showError: (msg) => showToast(msg, "error"),
    });

    // Reaction controller
    st.reactionCtrl = createReactionController({
      ws: st.ws,
      reactionsLimiter: st.limiters.reactions,
      getChannelId: () => st.channelCtrl?.currentChannelId ?? 0,
      showError: (msg) => showToast(msg, "error"),
    });

    // Channel controller (mount/destroy MessageList, TypingIndicator, MessageInput per channel)
    st.channelCtrl = createChannelController({
      ws: st.ws,
      api: st.api,
      msgCtrl: st.msgCtrl,
      reactionCtrl: st.reactionCtrl,
      typingLimiter: st.limiters.typing,
      showToast: (msg, type) => showToast(msg, type as "success" | "error" | "info"),
      getCurrentUserId,
      slots: {
        messagesSlot: ms.chatAreaResult.slots.messagesSlot,
        typingSlot: ms.chatAreaResult.slots.typingSlot,
        inputSlot: ms.chatAreaResult.slots.inputSlot,
        threadSlot: ms.chatAreaResult.threadSlot,
      },
      chatHeaderName: ms.chatAreaResult.chatHeaderName,
      chatHeaderRefs: ms.chatAreaResult.chatHeaderRefs,
      onContentGated: closeActiveLightbox,
      focusFallback: ms.focusReachable,
      onJoinCall: pg.joinDmCall,
      onOpenPins: () => void ms.chatAreaResult.openPinnedPanel(),
      onOpenThreadList: () => void ms.chatAreaResult.openThreadList(),
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => showToast(msg, "error"));
    mountVideo(st, pg, ms);

    for (const start of overlayFeatures) start(st, st.root);

    st.container.appendChild(st.root);

    // Only the channel that owns the current call keeps the grid up: the joined
    // voice channel (its chat sits beside the grid) or the DM whose
    // call panel shows the video above the chat (its own update re-seats the
    // grid through onVideoHostChange). Every other channel mounts a chat
    // surface and must dismiss it, another voice channel's chat opened from
    // its menu included.
    ms.showChatFor = (active: { id: number; type: string }): void => {
      const ownsCall =
        (active.type === "dm" || active.type === "voice") &&
        voiceStore.getState().currentChannelId === active.id;
      if (!ownsCall) st.videoModeCtrl?.showChat({ keepWatching: true });
    };
    // A click on the channel already open under the stream view changes no
    // store, so the subscriber below never sees it.
    st.unsubscribers.push(
      onChannelReselect(() => {
        const active = getActiveChannel();
        if (active !== null) ms.showChatFor(active);
      }),
    );

    // --- Subscribe to channel changes ---
    ms.unsubChannels = channelsStore.subscribeSelector(
      (s) => s.activeChannelId,
      () => {
        try {
          const active = getActiveChannel();
          if (active !== null) {
            ms.showChatFor(active);
            // The profile panel follows the conversation: a 1:1 DM keeps it
            // (rebuilt for the new person) while the saved preference is on, a
            // group or a server channel hides it without changing the preference.
            pg.syncDmProfileToActive();
            pg.withGroupPanel((ctrl) => ctrl.syncToActive());
            st.channelCtrl?.mountChannel(
              active.id,
              resolveChannelName(active.id, active.name, active.type),
              active.type,
            );
          } else {
            // The active channel was cleared with nothing to replace it
            // (deleted, or a DM closed while offline) — without this the
            // previous channel's MessageList/composer stayed mounted and
            // enabled against a channel the server no longer recognizes.
            pg.closeDmProfile();
            pg.withGroupPanel((ctrl) => ctrl.close());
            st.channelCtrl?.destroyChannel();
          }
        } catch (err) {
          log.error("Channel mount failed", err);
        }
      },
    );
    st.unsubscribers.push(ms.unsubChannels);

    ms.active = getActiveChannel();
    if (ms.active !== null) {
      st.channelCtrl?.mountChannel(
        ms.active.id,
        resolveChannelName(ms.active.id, ms.active.name, ms.active.type),
        ms.active.type,
      );
      // A 1:1 DM already active at mount opens its remembered panel.
      pg.syncDmProfileToActive();
      pg.withGroupPanel((ctrl) => ctrl.syncToActive());
    }

    // Turning the device onto the phone layout puts the side panels away;
    // back on the desktop layout they follow the saved preference again.
    const layoutWatch = new Disposable();
    st.unsubscribers.push(() => layoutWatch.destroy());
    onPhoneLayoutChange(() => {
      pg.syncDmProfileToActive();
      pg.withGroupPanel((ctrl) => ctrl.syncToActive());
    }, layoutWatch.signal);
  }

  function destroy(): void {
    log.info("MainPage destroying");
    st.tornDown = true;
    // Each step is isolated: a throw is logged and the rest still run, so a
    // failing step can never skip the store unsubscriptions below. The module
    // caches this page used to clear here reset with the session instead
    // (sessionRegistry, cache phase).
    step("cancelPendingRing", pg.cancelPendingRing);
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
        st.contentNav?.destroy();
        st.contentNav = null;
      });
      step("teardownToast", teardownToast);
      // Full voice cleanup — tears down room, callbacks, ws ref, serverHost.
      // Prevents stale module-level state persisting across logout/reconnect cycles.
      step("voiceCleanupAll", voiceCleanupAll);
      step("unsubCacheScope", st.unsubCacheScope);
      // The lightbox is a module-level overlay appended straight to
      // document.body — renderPage only clears #app, so a forced logout with
      // it open would otherwise leave it floating over the login screen with
      // live document listeners and a since-revoked blob URL.
      step("closeActiveLightbox", closeActiveLightbox);
      step("autoIdle", () => {
        st.autoIdle?.destroy();
        st.autoIdle = null;
      });
      step("musicActivity", () => {
        st.musicActivity?.destroy();
        st.musicActivity = null;
      });
      step("gameActivity", () => {
        st.gameActivity?.destroy();
        st.gameActivity = null;
      });
      step("statusTimerWatcher", () => {
        st.statusTimerWatcher?.destroy();
        st.statusTimerWatcher = null;
      });
      // Before the controllers below: a torn-down connection must not leave a
      // slot pointed at a dead socket.
      for (const hook of sessionHooks) step(hook.name, () => hook.uninstall(st));
      step("channelCtrl", () => {
        st.channelCtrl?.destroy();
        st.channelCtrl = null;
      });
      step("reactionCtrl", () => {
        st.reactionCtrl?.destroy();
        st.reactionCtrl = null;
        st.msgCtrl = null;
      });
      step("callChat", () => {
        st.callChat?.destroy();
        st.callChat = null;
      });
      step("videoModeCtrl", () => {
        st.videoModeCtrl?.destroy();
        st.videoModeCtrl = null;
        st.videoGrid = null;
      });
      step("closeDmProfile", pg.closeDmProfile);
      step("groupPanelCtrl", () => {
        st.groupPanelCtrl?.destroy();
        st.groupPanelCtrl = null;
        st.dmMembersBtn = null;
        st.dmProfileSlot = null;
      });

      for (const child of st.children) {
        try {
          child.destroy?.();
        } catch (err) {
          log.error("Child destroy error", err);
        }
      }
      st.children = [];

      for (const unsub of st.unsubscribers) {
        try {
          unsub();
        } catch (err) {
          log.error("Unsubscribe error", err);
        }
      }
      st.unsubscribers = [];

      step("banner", () => {
        st.banner?.destroy();
        st.banner = null;
      });
    } finally {
      if (st.root !== null) {
        st.root.remove();
        st.root = null;
      }
      st.container = null;
    }
  }

  return { mount, destroy };
}
