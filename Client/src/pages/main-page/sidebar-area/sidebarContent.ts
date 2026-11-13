/**
 * Sidebar build step: the member section and switching the sidebar between
 * channels and DMs.
 */
import { createElement, clearChildren } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import type { DmSidebar } from "../../../features/direct-messages/DmSidebar";
import { createVoiceModerationCallbacks } from "../VoiceCallbacks";
import { createSidebarMemberSection, memberPanelUi } from "../SidebarMemberSection";
import { loadMemberLayout } from "../../../features/members/memberLayout";
import { createMemberPanel, type MemberPanel } from "../../../features/members/memberPanel";
import {
  selectDmConversation,
  handleCreateDm,
  findDirectDm,
  dmConversations,
} from "../../../features/direct-messages/SidebarDmHelpers";
import { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";
import { createSidebarDmSection } from "../../../features/direct-messages/SidebarDmSection";
import { uiStore } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { createDmNavRow } from "../../../features/direct-messages/dmNavRow";
import { navigationText } from "../../../i18n/navigation";
import { mountDmPhoneHead } from "../../../features/direct-messages/sidebarDmPhoneHead";
import type { SidebarScope } from "./sidebarScope";

/** Destroy the mounted content and everything the previous mode added. */
function teardownSidebarContent(sc: SidebarScope): void {
  if (sc.activeSidebarContent !== null) {
    sc.activeSidebarContent.destroy?.();
    sc.activeSidebarContent = null;
  }
  if (sc.inviteCleanup !== null) {
    sc.inviteCleanup();
    sc.inviteCleanup = null;
  }
  // Clean up channel-mode extras (member list, subscriptions)
  for (const comp of sc.channelModeExtras) {
    comp.destroy?.();
  }
  sc.channelModeExtras = [];
  for (const unsub of sc.channelModeUnsubs) {
    unsub();
  }
  sc.channelModeUnsubs = [];
  sc.destroyMemberSection();
}

/** The People and Message requests rows at the top of DM mode. The badge is
 *  the pending-request count and is never folded into unread. */
function buildDmEntries(sc: SidebarScope): HTMLElement {
  const requests = sc.opts.destinations?.requests;
  const section = createElement("div", { class: "dm-requests-section" });
  const open = (view: "people" | "requests") => (opener: HTMLElement) =>
    sc.opts.onOpenView?.(view, opener);
  if (sc.opts.destinations?.people !== undefined) {
    const people = createDmNavRow(
      {
        testId: "dm-people-entry",
        icon: "users",
        label: navigationText("people.title"),
        view: "people",
        onOpen: open("people"),
      },
      sc.channelModeUnsubs,
    );
    section.appendChild(people);
  }
  if (requests !== undefined) {
    const entry = createDmNavRow(
      {
        testId: "dm-requests-entry",
        icon: "inbox",
        label: navigationText("requests.row"),
        view: "requests",
        onOpen: open("requests"),
        count: requests.pending,
        countLabel: (count) => navigationText("requests.rowWaiting", { count }),
      },
      sc.channelModeUnsubs,
    );
    section.appendChild(entry);
  }
  return section;
}

/**
 * Re-render the DM sidebar from fresh store data.
 *
 * dmStore.channels changes far more often than "the DM list changed" — a
 * DM partner's presence flip or a new message reaches it too. The sidebar
 * updates its rows in place (keyed on the DM channel), so the "Find a
 * conversation" filter text/focus and the list scroll position all
 * survive an unrelated update (replacing a capture/restore
 * of a full destroy+recreate).
 */
function refreshDmSidebar(sc: SidebarScope): void {
  if (sc.activeSidebarContent === null) return;
  const conversations = dmConversations(channelsStore.getState().activeChannelId);
  (sc.activeSidebarContent as DmSidebar).update(conversations);
}

/** Keep the DM sidebar current with the stores and events that change it. */
function mountDmSidebarRefresh(sc: SidebarScope): void {
  const refresh = (): void => refreshDmSidebar(sc);
  sc.refreshDmSidebarRef = refresh;
  sc.channelModeUnsubs.push(() => {
    sc.refreshDmSidebarRef = null;
  });

  // Re-render DM sidebar when DM store changes (new DMs, message updates)
  const unsubDmStore = dmStore.subscribeSelector((s) => s.channels, refresh);
  sc.channelModeUnsubs.push(unsubDmStore);

  // A mute toggled anywhere (context menu, Settings) is not in a store, so
  // the sidebar redraws from the mute store's own event (F16). Owned by a
  // per-mount Disposable so the listener's lifetime matches this mount.
  const muteOwner = new Disposable();
  window.addEventListener(CHANNEL_MUTE_CHANGED, refresh, { signal: muteOwner.signal });
  sc.channelModeUnsubs.push(() => muteOwner.destroy());

  // The live-call glyph follows who is in each DM's voice channel.
  sc.channelModeUnsubs.push(
    voiceStore.subscribeSelector(
      // Occupied channels only: a speaking tick replaces voiceUsers too,
      // and must not re-render the list.
      (s) =>
        [...s.voiceUsers]
          .filter(([, users]) => users.size > 0)
          .map(([id]) => id)
          .join(","),
      refresh,
    ),
  );

  // Re-render DM sidebar when the active conversation changes. Keyed on the
  // active channel rather than activeDmUserId, which a group DM leaves null.
  const unsubDmActive = channelsStore.subscribeSelector((s) => s.activeChannelId, refresh);
  sc.channelModeUnsubs.push(unsubDmActive);
}

export function mountMembersAndMode(sc: SidebarScope): void {
  /** Call a user: open the DM first, then start the call in it. An
   *  existing DM is selected at once; a new one starts the call in
   *  `handleCreateDm`'s onReady, once it is the active channel `startCall`
   *  reads. */
  sc.callUser = function callUser(userId: number): void {
    const existing = findDirectDm(userId);
    if (existing !== undefined) {
      selectDmConversation(existing, sc.dmDeps);
      sc.opts.onStartCall?.();
      return;
    }
    void handleCreateDm(userId, sc.dmDeps, () => sc.opts.onStartCall?.());
  };

  sc.buildMemberPanel = function buildMemberPanel(): MemberPanel {
    return createMemberPanel({
      ui: memberPanelUi,
      api: sc.api,
      getToast: sc.getToast,
      onMessageUser: (userId) => {
        void handleCreateDm(userId, sc.dmDeps);
      },
      onCallUser: sc.callUser,
      onVoiceModerate: createVoiceModerationCallbacks(sc.ws),
    });
  };

  /** Create or destroy the left member section so it matches the mode and the
   *  stored layout. It appends to `contentSlot`, so the channel list above it
   *  keeps its DOM. */
  sc.syncMemberSection = function syncMemberSection(): void {
    const wanted = uiStore.getState().sidebarMode === "channels" && loadMemberLayout() === "left";
    if (wanted && sc.memberSection === null) {
      // The panel comes from the one factory every host shares, so the
      // callback wiring exists once.
      sc.memberSection = createSidebarMemberSection({
        api: sc.api,
        getToast: sc.getToast,
        buildPanel: sc.buildMemberPanel,
      });
      sc.contentSlot.appendChild(sc.memberSection.element);
    } else if (!wanted && sc.memberSection !== null) {
      sc.destroyMemberSection();
    }
  };

  sc.destroyMemberSection = function destroyMemberSection(): void {
    if (sc.memberSection === null) return;
    const section = sc.memberSection;
    sc.memberSection = null;
    section.destroy();
    section.element.remove();
  };

  // ---------------------------------------------------------------------------
  // Mount sidebar content for current mode
  // ---------------------------------------------------------------------------

  sc.mountSidebarContent = function mountSidebarContent(mode: "channels" | "dms"): void {
    const contentHadFocus = sc.contentSlot.contains(document.activeElement);
    teardownSidebarContent(sc);

    clearChildren(sc.contentSlot);

    const innerSlot = createElement("div", { class: "sidebar-content-inner" });

    if (mode === "channels") {
      // --- DM section (above channels, below server header) ---
      // --- DM section (above channels, below server header) ---
      const dmSectionResult = createSidebarDmSection({
        pendingRequests: sc.opts.destinations?.requests?.pending,
        onOpenRequests: (opener) => sc.opts.onOpenView?.("requests", opener),
        onSelectDm: (dm) => {
          selectDmConversation(dm, sc.dmDeps);
        },
        onNewDm: () => {
          sc.showMemberPicker();
        },
        menu: sc.dmMenuActions(),
      });
      sc.channelModeUnsubs.push(() => {
        dmSectionResult.destroy();
      });

      // DM section goes first (above channels)
      sc.contentSlot.appendChild(dmSectionResult.element);

      const channelSidebar = sc.buildChannelSidebar();
      channelSidebar.mount(innerSlot);
      sc.activeSidebarContent = channelSidebar;

      // Inject the channel sidebar content into contentSlot.
      sc.contentSlot.appendChild(innerSlot);

      // --- Member list (below channels), only in the "left" layout ---
      sc.syncMemberSection();
    } else {
      // People and Message requests at the top of DM mode.
      mountDmPhoneHead(sc, sc.channelModeUnsubs);
      const section = buildDmEntries(sc);
      if (section.childElementCount > 0) sc.contentSlot.appendChild(section);

      const dmSidebar = sc.buildDmSidebar();
      dmSidebar.mount(innerSlot);
      sc.activeSidebarContent = dmSidebar;
      sc.contentSlot.appendChild(innerSlot);
      if (contentHadFocus) {
        sc.contentSlot.querySelector<HTMLElement>("button, input, [tabindex='0']")?.focus();
      }

      mountDmSidebarRefresh(sc);
    }
  };

  // Initial mount based on current store state
  sc.initialMode = uiStore.getState().sidebarMode;

  sc.mountSidebarContent(sc.initialMode);

  // Subscribe to sidebar mode changes
  sc.unsubSidebarMode = uiStore.subscribeSelector(
    (s) => s.sidebarMode,
    (mode) => {
      sc.mountSidebarContent(mode);
    },
  );

  sc.unsubscribers.push(sc.unsubSidebarMode);
}
