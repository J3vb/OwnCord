/**
 * Main page mount steps for the shell: the connection banner and its watchers,
 * then the layout (sidebar, chat area, member column, server rail, drawer,
 * notices).
 */
import {
  addServer,
  loadSavedServers,
  switchToServer,
} from "../../features/server-rail/switchServer";
import {
  confirmAndJoinInvite,
  currentServerName,
  parseInviteInput,
} from "../../features/server-rail/joinInvite";
import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { desktop } from "../../platform/desktop";
import { createServerBanner, applyConnectionStatus } from "@components/ServerBanner";
import { showToast } from "@lib/ui/toast";
import { shellText } from "../../i18n/shell";
import { sessionNoticeMessage, startSessionNotice } from "@lib/net/sessionNotice";
import { authStore } from "@stores/auth.store";
import { setSessionReplaced, uiStore } from "@stores/ui.store";
import { onPrefChange } from "@lib/prefs/preferences";
import { startAutoIdle } from "@lib/presence/autoIdle";
import { startStatusTimerWatcher } from "@lib/presence/statusTimer";
import { getActiveChannel } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { setChatHeaderCallChat } from "./ChatHeader";
import { createCallChat } from "./callChat";
import { createVideoModeController } from "./VideoModeController";
import { createSidebarArea } from "./SidebarArea";
import { createChatArea } from "./ChatArea";
import { createVoiceWidgetCallbacks } from "./VoiceCallbacks";
import { loadMemberLayout, MEMBER_LAYOUT_PREF } from "../../features/members/memberLayout";
import { NAVIGATION_DESTINATIONS } from "../../features/navigation/destinations";
import { createContentNavigator } from "../../features/navigation/contentView";
import { createNoticesBanner } from "../../features/safety/Notices";
import { log, SESSION_NOTICE_TOAST_MS, getCurrentUserId, deviceNetworkOffline } from "./pageShared";
import type { PageState, PageApi, MountScope } from "./pageState";

export function mountConnectionBanner(st: PageState, pg: PageApi, ms: MountScope): void {
  // --- Reconnect banner ---
  st.banner = createServerBanner();

  st.root!.appendChild(st.banner.element);

  // The live region is a sibling: the visible banner rewrites its restart
  // countdown every second, which a live region would read out each tick.
  st.root!.appendChild(st.banner.liveElement);

  // "Use here" takes the connection back: this device connects again and
  // the server displaces the other one (last connect wins). It serves both
  // a displaced socket (SESSION_REPLACED) and a wake reconnect the server
  // refused because another device held the session (ANOTHER_DEVICE_ACTIVE,
  // U4) — the two are the same user choice, so they share one prompt.
  ms.useHere = (): void => {
    const token = authStore.getState().token;
    if (token === null) return;
    setSessionReplaced(false);
    st.ws.connect({ host: st.api.getConfig().host, token }, { takeover: true });
  };

  // Retry is safe on a plain disconnect: connect() re-dials and the native
  // proxy re-validates the certificate, so a TOFU mismatch re-latches rather
  // than being bypassed. It also cancels any pending backoff attempt, so it
  // cannot race the reconnect loop.
  ms.retryConnection = (): void => {
    const token = authStore.getState().token;
    if (token === null) return;
    st.ws.connect({ host: st.api.getConfig().host, token });
  };

  // Signed-in-elsewhere outranks the connection status it leaves behind
  // ("disconnected"), so every banner refresh goes through here. The device's
  // own network fact stays apart from the server's reachability: a LAN server
  // with no internet still answers onLine, and `undefined` (host without the
  // API) never claims the internet is required.
  ms.syncBanner = (): void => {
    if (st.banner === null) return;
    const state = uiStore.getState();
    if (state.sessionReplaced) st.banner.showSignedInElsewhere(ms.useHere);
    else
      applyConnectionStatus(st.banner, state.connectionStatus, {
        offline: deviceNetworkOffline(),
        dialFailed: state.connectionDialFailed,
        onRetry: ms.retryConnection,
      });
  };

  st.unsubscribers.push(uiStore.subscribeSelector((s) => s.sessionReplaced, ms.syncBanner));

  st.unsubscribers.push(uiStore.subscribeSelector((s) => s.connectionDialFailed, ms.syncBanner));

  // Losing or regaining the device's network only re-renders, so the banner
  // says the true thing immediately; the reconnect loop and Retry own
  // recovery. Only re-render while the socket is actually down — a network
  // flap during a live connection (a VPN toggle, a Wi-Fi flap) must not
  // route to `applyConnectionStatus("connected")` and clear an announced
  // server-restart countdown. Owned by a Disposable so the lifecycle guard
  // sees both listeners torn down with the page.
  ms.networkOwner = new Disposable();

  st.unsubscribers.push(() => ms.networkOwner.destroy());

  ms.syncBannerIfNotConnected = (): void => {
    if (uiStore.getState().connectionStatus !== "connected") ms.syncBanner();
  };

  window.addEventListener("online", ms.syncBannerIfNotConnected, {
    signal: ms.networkOwner.signal,
  });

  window.addEventListener("offline", ms.syncBannerIfNotConnected, {
    signal: ms.networkOwner.signal,
  });

  // A sign-in not yet reviewed: listed on connect and on window focus.
  ms.sessionNotice = new Disposable();

  st.unsubscribers.push(() => ms.sessionNotice.destroy());

  ms.pollSessions = startSessionNotice({
    fetchSessions: (signal) => st.api.getSessions(signal),
    notify: (unseen) => showToast(sessionNoticeMessage(unseen), "info", SESSION_NOTICE_TOAST_MS),
    signal: ms.sessionNotice.signal,
  });

  // Banner reacts to the store-backed connection status (single source of
  // truth, docs/architecture/ux §3). "disconnected" keeps the banner visible
  // — a fatal drop navigates away via clearAuth, and anything short of that
  // must not leave a stale "Reconnecting..." on screen.
  st.unsubscribers.push(
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (status) => {
        try {
          if (status === "connected") {
            pg.restoreSavedPresence();
            ms.pollSessions();
          }
          ms.syncBanner();
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
  ms.syncBanner();

  // Idle / Do Not Disturb / Invisible "for 1 hour": reverts to Online when
  // the stored timer ends, and at once if it ended while the app was closed.
  // Before the restore below, so that reads (and re-asserts) the reverted status.
  st.statusTimerWatcher = startStatusTimerWatcher({
    onRevert: (status) => pg.applyPresence(status),
  });

  if (uiStore.getState().connectionStatus === "connected") pg.restoreSavedPresence();

  // Auto-idle. It only ever moves a status it is itself responsible for
  // (see @lib/presence/autoIdle) — a manually chosen Idle, Do Not Disturb or
  // Invisible is never touched — so it is safe to leave running for the
  // whole session. The OS idle source makes input in other apps count too.
  st.autoIdle = startAutoIdle({
    onStatusChange: (status) => pg.applyPresence(status),
    systemIdleMs: () => desktop.systemIdle.idleMs(),
  });

  // The game being played, for other members' "Playing <game>" line. The
  // loop sends nothing unless the setting is on and the server advertises
  // game_activity; the web build has no detector and never loads it.
  if (desktop.gameDetector.available) {
    void import("@lib/presence/gameActivity").then(
      ({ startGameActivity }) => {
        if (st.tornDown) return;
        st.gameActivity = startGameActivity({
          ws: st.ws,
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
        if (st.tornDown) return;
        st.musicActivity = startMusicActivity({
          ws: st.ws,
          detect: (prefs) => desktop.mediaDetector.detect(prefs),
        });
      },
      (err: unknown) => log.warn("Music activity failed to load", { error: String(err) }),
    );
  }

  // Talking in a call is being here even with hands off the keyboard and
  // mouse, which neither the window nor (for another app) the OS poll sees.
  // The local ring is the same on web and native (voice.store withLocalRing).
  st.unsubscribers.push(
    voiceStore.subscribeSelector(
      (v) => {
        const uid = authStore.getState().user?.id ?? 0;
        const ch = v.currentChannelId;
        return ch !== null && v.voiceUsers.get(ch)?.get(uid)?.speaking === true;
      },
      (speaking) => {
        if (st.speakingActivityTimer !== null) clearInterval(st.speakingActivityTimer);
        st.speakingActivityTimer = null;
        if (!speaking) return;
        st.autoIdle?.notifyActivity();
        // Talking for longer than the idle delay must keep counting.
        st.speakingActivityTimer = setInterval(() => st.autoIdle?.notifyActivity(), 60_000);
      },
    ),
    () => {
      if (st.speakingActivityTimer !== null) clearInterval(st.speakingActivityTimer);
      st.speakingActivityTimer = null;
    },
  );

  st.unsubscribers.push(
    st.ws.on("server_restart", (payload) => {
      try {
        // Every reason counts down: the session survives the restart
        // and ws.ts reconnects once the socket drops.
        if (st.banner !== null) {
          if (payload.delay_seconds <= 0) {
            // A zero/negative delay is a cancel, not a countdown (e.g.
            // "update_aborted" correcting an earlier restart announcement
            // after the staged update failed to apply — the socket never
            // actually dropped). Re-sync to the real connection status
            // instead of letting showRestart's countdown fall straight
            // through to a permanent "Reconnecting..." banner.
            ms.syncBanner();
          } else {
            st.banner.showRestart(payload.delay_seconds);
          }
        }
      } catch (err) {
        log.error("Server restart handler error", err);
      }
    }),
  );
}

export function mountLayout(st: PageState, pg: PageApi, ms: MountScope): void {
  // --- Main .app row ---
  ms.app = createElement("div", { class: "app", "data-testid": "app-layout" });

  // --- Sidebar (server strip + channel sidebar + voice widget + user bar) ---
  ms.sidebar = createSidebarArea({
    ws: st.ws,
    api: st.api,
    limiters: st.limiters,
    presenceSender: st.presenceSender,
    getRoot: () => st.root,
    getToast: () => st.toast,
    onWatchStream: (userId) => {
      if (st.videoModeCtrl === null) return;
      st.videoModeCtrl.checkVideoMode();
      st.videoModeCtrl.showVideoGrid();
      st.videoModeCtrl.setFocus(userId);
      st.videoGrid?.watch(userId);
    },
    onOpenCall: () => st.callChat?.openVoiceCall(),
    destinations: NAVIGATION_DESTINATIONS,
    onOpenView: (id, opener) => st.contentNav?.open(id, opener),
    // The member list's profile popup Call action opens the DM then starts
    // its call through this, the same startCall the DM header uses.
    onStartCall: () => pg.startCall(),
    // The DM row menu's Profile: select the DM, then show its panel fresh
    // (a panel already open for another DM is replaced, not toggled away) and
    // remember it as open. Deferred a microtask: the store's active-channel
    // listener (which re-syncs the panel on any DM switch) runs in the
    // microtask selecting the DM queued.
    onOpenDmProfile: () => {
      queueMicrotask(() => {
        pg.closeDmProfile();
        pg.toggleDmProfile();
      });
    },
  });

  st.children.push(...ms.sidebar.children);

  st.unsubscribers.push(...ms.sidebar.unsubscribers);

  // --- Chat area ---
  const callBarActions = createVoiceWidgetCallbacks(st.ws, st.limiters);
  ms.chatAreaResult = createChatArea({
    api: st.api,
    getRoot: () => st.root,
    getToast: () => st.toast,
    getChannelCtrl: () => st.channelCtrl,
    callBar: {
      isGridUp: () => st.videoModeCtrl?.isGridInWindow() ?? false,
      onMuteToggle: () => callBarActions.onMuteToggle(),
      onLeave: () => callBarActions.onDisconnect(),
      onOpenCall: (channelId) => ms.sidebar.openCall(channelId),
    },
    subscribeDeletes: (listener) => {
      const offOne = st.ws.on("chat_deleted", (p) => listener(p.channel_id, [p.message_id]));
      const offMany = st.ws.on("chat_bulk_deleted", (p) => listener(p.channel_id, p.ids));
      return () => {
        offOne();
        offMany();
      };
    },
    subscribeAttachments: (listener) =>
      st.ws.on("chat_edited", (p) => {
        if (p.attachments !== undefined) {
          listener(
            p.channel_id,
            p.message_id,
            p.attachments.map((a) => a.id),
          );
        }
      }),
    onToggleDmProfile: () => {
      pg.toggleDmProfile();
    },
    onToggleMemberList: () => {
      pg.withGroupPanel((ctrl) => ctrl.toggle(), true);
    },
    onToggleGuildMemberList: () => {
      st.memberColumn?.toggle();
    },
    onStartCall: () => {
      pg.startCall();
    },
    onStartVideoCall: () => {
      pg.startCall(true);
    },
    onRenameGroup: () => {
      const active = getActiveChannel();
      if (active !== null && active.type === "dm") ms.sidebar.renameGroup(active.id);
    },
  });

  st.dmProfileSlot = ms.chatAreaResult.dmProfileSlot;

  st.dmProfileBtn = ms.chatAreaResult.chatHeaderRefs.profileBtn;

  st.dmMembersBtn = ms.chatAreaResult.chatHeaderRefs.membersBtn ?? null;

  st.children.push(...ms.chatAreaResult.children);

  st.unsubscribers.push(...ms.chatAreaResult.unsubscribers);

  st.videoGrid = ms.chatAreaResult.videoGrid;

  // Video mode controller (chat/video toggle + tile management)
  st.videoModeCtrl = createVideoModeController({
    slots: ms.chatAreaResult.slots,
    videoGrid: ms.chatAreaResult.videoGrid,
    getCurrentUserId,
    // The DM call panel hosts the video of its own call (chat stays up).
    panelHost: () => st.callPanelHost,
    chatColumn: ms.chatAreaResult.chatArea,
    onGridChange: () => {
      st.callChat?.refresh();
      ms.chatAreaResult.refreshCallBar();
    },
  });

  // Opening the call view selects the voice channel; its chat sits beside the grid.
  ms.callChatBtn = ms.chatAreaResult.chatHeaderRefs.callChatBtn;

  st.callChat = createCallChat({
    videoModeCtrl: st.videoModeCtrl,
    onStateChange: (state) => {
      setChatHeaderCallChat(ms.chatAreaResult.chatHeaderRefs, state);
      // The call view takes the member column's width while it is up.
      st.callViewUp = state.capable;
      st.memberColumn?.setCallView(st.callViewUp);
    },
  });

  ms.callChatBtn.addEventListener("click", () => st.callChat?.toggleChat());

  // The composer of the channel on screen, else the header's menu button
  // (shown only at narrow width, where the closed sidebar is inert), else
  // the sidebar's first control that is not hidden (a hidden header action
  // — Invite or Audit Log without the permission, Mark All as Read with
  // nothing unread — would swallow the focus call and leave it on <body>):
  // the first of them that takes focus.
  ms.focusReachable = (): HTMLElement | null => {
    const candidates = [
      ms.chatAreaResult.slots.inputSlot.querySelector<HTMLElement>("textarea:enabled"),
      ms.chatAreaResult.sidebarToggle,
      ...Array.from(ms.sidebar.sidebarWrapper.querySelectorAll<HTMLElement>("button")).filter(
        (b) => b.style.display !== "none" && b.style.visibility !== "hidden",
      ),
    ];
    for (const el of candidates) {
      el?.focus();
      if (el != null && document.activeElement === el) return el;
    }
    return null;
  };

  st.contentNav = createContentNavigator({
    destinations: NAVIGATION_DESTINATIONS,
    api: st.api,
    chatArea: ms.chatAreaResult.chatArea,
    rememberChannel: ms.sidebar.rememberChannel,
    forgetChannel: ms.sidebar.forgetChannel,
    returnToChannel: ms.sidebar.returnToChannel,
    // The opener is gone (the Requests entry leaves with DM mode).
    fallbackFocus: ms.focusReachable,
  });

  // The member column: always present, hidden until MemberColumn shows it.
  ms.memberColumnEl = createElement("aside", {
    id: "member-column",
    class: "member-column",
    "data-testid": "member-column",
    "aria-label": shellText("members.region"),
  });

  ms.memberColumnEl.hidden = true;

  ms.memberColumnBody = createElement("div", { class: "member-column-body" });

  ms.memberColumnEl.appendChild(ms.memberColumnBody);

  // The server rail sits left of the sidebar. The web portal serves exactly
  // one server, so it has none there. The slot holds the rail's width while
  // the rail loads on demand, keeping it out of the eager MainPage chunk.
  ms.railSlot = null;

  if (!__OWNCORD_WEB__) {
    ms.railSlot = createElement("div", { class: "server-rail-slot" });
    ms.app.classList.add("has-server-rail");
    const slot = ms.railSlot;
    const railHost = st.api.getConfig().host ?? "";
    void import("@components/ServerRail")
      .then(({ createServerRail }) => {
        if (st.tornDown) return;
        const rail = createServerRail({
          currentHost: railHost,
          currentName: authStore.getState().serverName ?? "",
          loadServers: loadSavedServers,
          switchServer: switchToServer,
          addServer,
          onOpenDm: (dm) => ms.sidebar.openDm(dm),
          onShowServer: () => ms.sidebar.returnToChannel(),
          joinInvite: (text) => {
            const invite = parseInviteInput(text);
            if (invite === null) return false;
            confirmAndJoinInvite(invite, currentServerName(railHost));
            return true;
          },
        });
        rail.mount(slot);
        st.unsubscribers.push(() => rail.destroy?.());
      })
      .catch((err: unknown) => log.warn("Server rail failed to load", err));
  }

  if (ms.railSlot !== null) ms.app.appendChild(ms.railSlot);

  appendChildren(
    ms.app,
    ms.sidebar.sidebarWrapper,
    ms.chatAreaResult.chatArea,
    ms.chatAreaResult.threadSlot,
    st.contentNav.element,
    ms.memberColumnEl,
    ms.chatAreaResult.dmProfileSlot,
  );

  st.root!.appendChild(ms.app);

  // The narrow-width sidebar drawer (WCAG 1.4.10 Reflow): the header's menu
  // button opens the existing sidebar over the chat area below 800px. Built
  // after the sidebar is in `app`, so the backdrop shares their container.
  // Loaded on demand: the drawer only matters below the 800px breakpoint,
  // so its controller stays out of the eager MainPage chunk (bundle budget).
  void import("./SidebarDrawer").then(({ createSidebarDrawer }) => {
    if (st.tornDown) return;
    st.sidebarDrawer = createSidebarDrawer({
      sidebar: ms.sidebar.sidebarWrapper,
      toggle: ms.chatAreaResult.sidebarToggle,
      fallbackFocus: ms.focusReachable,
      onOpen: () => {
        ms.chatAreaResult.closePinnedPanel();
        ms.chatAreaResult.closeMediaGallery();
        st.memberColumn?.closeOverlay();
      },
    });
  });

  st.unsubscribers.push(() => {
    st.sidebarDrawer?.destroy();
    st.sidebarDrawer = null;
  });

  // The member list lives in exactly one place at a time (MemberList keeps
  // module-level popup state, so two live instances would close each other's
  // menus): "left" is SidebarArea's section, "right" is the column. This is
  // the one layout-change handler, so the order is decided here: the
  // outgoing host destroys its panel before the incoming host builds one.
  // The column's own listener ignores the layout key.
  void import("./MemberColumn").then(({ createMemberColumn }) => {
    if (st.tornDown) return;
    st.memberColumn = createMemberColumn({
      column: ms.memberColumnEl,
      body: ms.memberColumnBody,
      button: ms.chatAreaResult.chatHeaderRefs.memberListBtn,
      buildPanel: ms.sidebar.buildMemberPanel,
      fallbackFocus: ms.focusReachable,
    });
    st.memberColumn.setCallView(st.callViewUp);
    st.memberColumn.sync();
  });

  ms.layoutOwner = new Disposable();

  onPrefChange(
    [MEMBER_LAYOUT_PREF],
    () => {
      if (loadMemberLayout() === "right") {
        ms.sidebar.syncMemberSection();
        st.memberColumn?.sync();
      } else {
        st.memberColumn?.sync();
        ms.sidebar.syncMemberSection();
      }
    },
    ms.layoutOwner.signal,
  );

  st.unsubscribers.push(() => {
    ms.layoutOwner.destroy();
    st.memberColumn?.destroy();
    st.memberColumn = null;
  });

  // --- Moderation notices: persistent, above the app row ---
  ms.notices = new Disposable();

  st.unsubscribers.push(() => ms.notices.destroy());

  st.root!.insertBefore(
    createNoticesBanner({
      api: st.api,
      signal: ms.notices.signal,
      fallbackFocus: ms.focusReachable,
    }),
    ms.app,
  );
}
