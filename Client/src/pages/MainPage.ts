// MainPage — primary app layout after login.
// Composes standalone components; never sets innerHTML with user content.
// Delegates sidebar and chat-area DOM construction to sub-orchestrators.

import { createElement } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { type WsClient, bracketBareIPv6Host } from "@lib/ws";
import { type ApiClient } from "@lib/api";
import { desktop } from "../platform/desktop";
import { createRateLimiterSet } from "@lib/net/rateLimiter";
import { createToastContainer } from "@components/Toast";
import { initToast, teardownToast, showToast } from "@lib/ui/toast";
import { onAuthCleared } from "@stores/auth.store";
import { closeSettings, openSettings, uiStore } from "@stores/ui.store";
import { loadGlobalShortcutVks } from "@lib/voice/voiceShortcuts";
import {
  anyTriggerBound,
  clearPortalBound,
  globalKeysErrorCode,
  portalBoundBefore,
} from "@lib/ui/globalKeys";
import { loadPref } from "@lib/prefs/preferences";
import { createPresenceSender, setActivePresenceSender } from "@lib/presence/presence";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { voiceStore, restoreSavedSelfVoiceState } from "@stores/voice.store";
import {
  cleanupAll as voiceCleanupAll,
  setWsClient,
  setServerHost as setLiveKitServerHost,
  setOnError as setVoiceOnError,
} from "@lib/voice/livekitSession";
import { setServerHost } from "@components/message-list/renderers";
import { setAttachmentCacheScope } from "@components/message-list/attachments";
import { closeActiveLightbox } from "@components/message-list/media";
import {
  setReactionUsersFetcher,
  clearReactionUsersCache,
} from "../features/messaging/reactionUsers";
import { createNotesContext, setNotesContextSource } from "../features/profiles/userNotes";
import { markAllRead, setMarkReadSender } from "@lib/readState";
import { setMarkUnreadSender } from "@components/message-list/markUnread";
import { onChannelReselect, stepChannel } from "@lib/nav/channelNavigation";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
import { setAudioVolumeHost } from "@lib/voice/audioElements";
import { setScreenSourcePicker } from "../features/voice/native/screenPickerSlot";
import { attachGlobalKeybinds } from "./main-page/GlobalKeybinds";
import { createVoiceWidgetCallbacks } from "./main-page/VoiceCallbacks";
import { createMessageController } from "./main-page/MessageController";
import { createReactionController } from "./main-page/ReactionController";
import { createChannelController } from "./main-page/ChannelController";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import { startVoiceUiSounds } from "../features/voice/uiSounds";
import { log, resolveChannelName, getCurrentUserId } from "./main-page/pageShared";
import type { PageState, PageApi } from "./main-page/pageState";
import { createDmProfilePanel } from "./main-page/dmProfilePanel";
import { createDmCalls } from "./main-page/dmCalls";
import { createPagePresence } from "./main-page/pagePresence";
import { mountConnectionBanner, mountLayout } from "./main-page/pageMountShell";
import { mountSettings } from "./main-page/pageMountSettings";
import { mountCalls, mountVideo } from "./main-page/pageMountCalls";
import type { MountScope } from "./main-page/pageState";

/** Whether the native voice-shortcut poller runs. App-wide, not per page: the
 *  poller outlives a logout or server switch, so a remount keeps standing down. */
let globalPollerActive = false;

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
  const pg = {} as PageApi;
  Object.assign(
    pg,
    createDmProfilePanel(st, pg),
    createDmCalls(st, pg),
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
          void import("@components/ShortcutsOverlay")
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
        isGlobalPollerActive: () => globalPollerActive,
      }),
    );

    // U6: Ctrl+Shift+M/Ctrl+Shift+D and the tray's Mute/Deafen items work
    // while the app is unfocused. The native host polls the keys (Windows and
    // X11 Linux) and the tray emits the same event; both run the same toggles
    // as the in-app shortcuts, in a call or not.
    st.unsubscribers.push(
      desktop.globalShortcuts.onShortcut((action) => {
        if (action === "mute") ms.voiceKeybindActions.onMuteToggle();
        else ms.voiceKeybindActions.onDeafenToggle();
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
    ms.refreshSeq = 0;
    ms.refreshGlobalKeys = (): void => {
      const seq = ++ms.refreshSeq;
      void desktop.globalShortcuts
        .supported()
        .then(async (supported) => {
          if (seq !== ms.refreshSeq || st.tornDown) return;
          globalPollerActive = supported;
          await desktop.globalShortcuts.start();
        })
        .catch(() => {
          // Not a Tauri host, or the command was refused: the tray and the in-app
          // shortcuts still work; the global key path simply is not live.
          if (seq === ms.refreshSeq && !st.tornDown) globalPollerActive = false;
        });
    };
    ms.refreshGlobalKeys();
    st.unsubscribers.push(desktop.globalShortcuts.onStatusChange(ms.refreshGlobalKeys));
    // An earlier successful portal bind is restored with the saved keys; a
    // desktop that remembers the approval answers without a dialog. Nothing
    // is asked when the desktop already holds a trigger, and a dialog the
    // user cancels forgets the earlier bind, so the next start is quiet.
    void desktop.globalShortcuts
      .status()
      .then(async (status) => {
        if (st.tornDown || status.backend !== "portal" || !portalBoundBefore()) return;
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
        if (!st.tornDown) ms.refreshGlobalKeys();
      })
      .catch(() => {
        // The host could not answer: the keys stay as they were.
      });
    // Push the persisted rebind onto the running poller at startup, so a
    // choice made in Settings survives a restart (the native default is
    // Ctrl+Shift+M / Ctrl+Shift+D).
    ms.globalKeys = loadGlobalShortcutVks();
    void desktop.globalShortcuts
      .setKeys({ muteVk: ms.globalKeys.mute, deafenVk: ms.globalKeys.deafen })
      .catch(() => {
        // Not a Tauri host, or the command was refused: keep the native default.
      });

    // Timed mutes: redraws the sidebars when one ends. Page-owned, so a socket
    // reconnect leaves it alone and a server switch remounts a fresh one.
    // Loaded on demand; the same !tornDown guard as the badge below.
    void import("@lib/prefs/channelMuteExpiry").then((expiry) => {
      if (!st.tornDown) st.unsubscribers.push(expiry.startMuteExpiryWatch());
    });

    // The taskbar and tray unread badge, cleared again on teardown so a
    // logout or server switch does not leave this session's count behind.
    // destroy() sets tornDown before it runs unsubscribers, so a stopper
    // pushed while !tornDown always runs.
    void import("../features/unread-badge/unreadBadge").then((badge) => {
      if (!st.tornDown) st.unsubscribers.push(badge.startUnreadBadge(desktop.notifier));
    });

    // Short voice UI sounds on join/leave and mute/deafen. This module
    // statically imports stores the page already pulls in, so it rides the
    // MainPage chunk rather than splitting a new shared one off the entry.
    if (!st.tornDown) st.unsubscribers.push(startVoiceUiSounds());

    // Toast container
    st.toast = createToastContainer();
    st.toast.mount(st.root);
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
      onOpenPins: () => {
        void ms.chatAreaResult.openPinnedPanel();
      },
    });

    // Wire voice error callback to toast
    setVoiceOnError((msg) => showToast(msg, "error"));
    mountVideo(st, pg, ms);

    // Auto-update notifier — checks server for newer client version
    if (st.apiConfig.host) {
      // A bare IPv6 literal must be bracketed or the URL is unparseable and
      // the updater silently reports "no update available" forever.
      // Same helper as ws.ts, admin-panel.ts and attachments.ts.
      const serverUrl = `https://${bracketBareIPv6Host(st.apiConfig.host)}`;
      const updateNotifier = createUpdateNotifier({ serverUrl, keepChecking: true });
      updateNotifier.mount(st.root);
      st.children.push(updateNotifier);
    }

    // Release notes, once, on the first start after an update. Loaded on
    // demand so the prompt stays out of the eager MainPage chunk (bundle budget).
    ms.promptHost = st.root;
    void import("../features/whats-new/whatsNewPrompt").then(({ createWhatsNewPrompt }) => {
      if (st.tornDown) return;
      // i18n-exempt: settings tab key, not shown text
      const whatsNewPrompt = createWhatsNewPrompt(() => openSettings("About"));
      whatsNewPrompt.mount(ms.promptHost);
      st.unsubscribers.push(() => whatsNewPrompt.destroy?.());
    });

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
      step("notesContext", () => setNotesContextSource(null));
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
      step("presenceSender", () => {
        st.presenceSender.destroy();
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
