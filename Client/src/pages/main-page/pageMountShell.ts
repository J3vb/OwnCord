/**
 * Main page mount steps for the shell: the connection banner and its watchers,
 * then the layout (sidebar, chat area, member column, server rail, drawer,
 * notices).
 */
import { mountServerRail } from "../../features/server-rail/mountServerRail";
import {
  startDetectedActivities,
  followSpeakingActivity,
} from "../../features/presence/pageActivities";
import {
  subscribeDeletedMessages,
  subscribeEditedAttachments,
} from "../../features/messaging/chatSocketSubscriptions";
import { Disposable } from "@lib/disposable";
import { createElement, appendChildren } from "@lib/dom";
import { desktop } from "../../platform/desktop";
import { createServerBanner } from "../../features/server-rail/ServerBanner";
import { wireConnectionBanner } from "../../features/connection/connectionBanner";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { focusFirst } from "@lib/ui/focusFirst";
import { shellText } from "../../i18n/shell";
import { startSessionNotice } from "@lib/net/sessionNotice";
import { uiStore } from "@stores/ui.store";
import { onPrefChange } from "@lib/prefs/preferences";
import { startAutoIdle } from "@lib/presence/autoIdle";
import { startStatusTimerWatcher } from "@lib/presence/statusTimer";
import { getActiveChannel } from "@stores/channels.store";
import { setChatHeaderCallChat } from "./ChatHeader";
import { createCallChat } from "../../features/voice/callChat";
import { createVideoModeController } from "../../features/voice/VideoModeController";
import { createSidebarArea } from "./SidebarArea";
import { createChatArea } from "./ChatArea";
import { installPhoneNavWhenPhone } from "./lazyPhoneNav";
import { createVoiceWidgetCallbacks } from "./VoiceCallbacks";
import { loadMemberLayout, MEMBER_LAYOUT_PREF } from "../../features/members/memberLayout";
import { NAVIGATION_DESTINATIONS } from "../../features/navigation/destinations";
import { createContentNavigator } from "../../features/navigation/contentView";
import { createNoticesBanner } from "../../features/safety/Notices";
import { notifySignIn } from "../../features/safety/lazySignInNotice";
import { getCurrentUserId } from "./pageShared";
import type { PageState, PageApi, MountScope } from "./pageState";

export function mountConnectionBanner(st: PageState, pg: PageApi, ms: MountScope): void {
  // --- Reconnect banner ---
  st.banner = createServerBanner();

  st.root!.appendChild(st.banner.element);

  // The live region is a sibling: the visible banner rewrites its restart
  // countdown every second, which a live region would read out each tick.
  st.root!.appendChild(st.banner.liveElement);

  // A sign-in not yet reviewed: listed on connect and on window focus.
  ms.sessionNotice = new Disposable();

  st.unsubscribers.push(() => ms.sessionNotice.destroy());

  ms.pollSessions = startSessionNotice({
    fetchSessions: (signal) => st.api.getSessions(signal),
    notify: (unseen) => void notifySignIn(unseen, ms.sessionNotice.signal),
    signal: ms.sessionNotice.signal,
  });

  st.unsubscribers.push(
    wireConnectionBanner({
      getBanner: () => st.banner,
      ws: st.ws,
      getHost: () => st.api.getConfig().host,
      onConnected: () => {
        pg.restoreSavedPresence();
        ms.pollSessions();
      },
    }),
  );

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
    followSystemIdle: (signal, delay, ask) => desktop.systemIdle.follow(signal, delay, ask),
  });

  startDetectedActivities(st);

  st.unsubscribers.push(...followSpeakingActivity(st));
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
    subscribeDeletes: (listener) => subscribeDeletedMessages(st.ws, listener),
    subscribeAttachments: (listener) => subscribeEditedAttachments(st.ws, listener),
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
  // the first of them that takes focus. On a phone the composer is skipped:
  // focusing it raises the keyboard over the chat.
  ms.focusReachable = (): HTMLElement | null => {
    return focusFirst([
      isPhoneLayout()
        ? null
        : ms.chatAreaResult.slots.inputSlot.querySelector<HTMLElement>("textarea:enabled"),
      ms.chatAreaResult.sidebarToggle,
      ...Array.from(ms.sidebar.sidebarWrapper.querySelectorAll<HTMLElement>("button")).filter(
        (b) => b.style.display !== "none" && b.style.visibility !== "hidden",
      ),
    ]);
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
    messageUser: ms.sidebar.messageUser,
    openSidebar: () => ms.chatAreaResult.sidebarToggle.click(),
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
    mountServerRail({
      host: st.api.getConfig().host ?? "",
      slot: ms.railSlot,
      isTornDown: () => st.tornDown,
      onOpenDm: (dm) => ms.sidebar.openDm(dm),
      onShowServer: () => ms.sidebar.returnToChannel(),
      own: (destroy) => st.unsubscribers.push(destroy),
    });
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
      rail: ms.railSlot,
      onSearch: () => ms.qsManager.open(),
      onOpen: () => {
        ms.chatAreaResult.closeSidePanels();
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

  // Phone: swipes between the chat, the drawer and the member list, swipe to
  // reply, and Back closing overlays. Loaded once the window is a phone.
  const phoneNavOwner = new Disposable();
  st.unsubscribers.push(() => phoneNavOwner.destroy());
  installPhoneNavWhenPhone({
    signal: phoneNavOwner.signal,
    root: st.root!,
    chatArea: ms.chatAreaResult.chatArea,
    drawerSurfaces:
      ms.railSlot === null ? [ms.sidebar.sidebarWrapper] : [ms.sidebar.sidebarWrapper, ms.railSlot],
    memberColumn: ms.memberColumnEl,
    drawer: () => st.sidebarDrawer,
    members: () => st.memberColumn,
    closeView: () => st.contentNav?.close(),
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
