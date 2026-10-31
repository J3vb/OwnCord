/**
 * SidebarArea — unified sidebar DOM construction and component wiring.
 * Composes a server header, ChannelSidebar or DmSidebar (based on store mode),
 * VoiceWidget, and UserBar. The ServerStrip has been removed in favor of the
 * unified sidebar layout with a quick-switch overlay for server switching.
 */

import { createElement } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import type { WsClient } from "@lib/ws";
import { type ApiClient } from "@lib/api";
import type { RateLimiterSet } from "@lib/net/rateLimiter";
import type { PresenceSender } from "@lib/presence/presence";
import type { ToastContainer } from "@components/Toast";
import { createCategoryDialogs } from "./categoryDialogs";
import { logout } from "@lib/net/logout";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidgetCallbacks } from "./VoiceCallbacks";
import { type MemberPanel } from "../../features/members/memberPanel";
import { selectDmConversation, handleCreateDm } from "./SidebarDmHelpers";
import { type DmChannel } from "@stores/dm.store";
import type { ContentViewId, NavigationDestinations } from "../../features/navigation/destinations";
import { mountServerHeader } from "./sidebar-area/sidebarHeader";
import { mountChannelSidebar } from "./sidebar-area/sidebarChannels";
import { mountDmSidebar } from "./sidebar-area/sidebarDms";
import { mountMembersAndMode } from "./sidebar-area/sidebarContent";
import { mountVoiceAndSwitcher } from "./sidebar-area/sidebarVoiceSwitch";
import type { SidebarScope } from "./sidebar-area/sidebarScope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarAreaOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly limiters: RateLimiterSet;
  /** MainPage's single shared presence sender — threaded to UserBar so its
   *  status picker shares the same limiter budget and retry as auto-idle
   *  and the settings Account tab instead of sending straight through `ws`
   *  (see @lib/presence/presence). */
  readonly presenceSender: PresenceSender;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
  readonly onWatchStream?: (userId: number) => void;
  /** Open the call view for the voice channel the user is in. */
  readonly onOpenCall?: () => void;
  /** The destinations this build ships. An absent one gets no entry. */
  readonly destinations?: NavigationDestinations;
  /** Open a content view; `opener` gets focus back when it closes. */
  readonly onOpenView?: (id: ContentViewId, opener: HTMLElement) => void;
  /** Start a call in the currently active DM (MainPage's `startCall`). Used by
   *  the member list's profile popup Call action, which first opens the DM. */
  readonly onStartCall?: () => void;
  /** Open the profile panel for the active 1:1 DM (the DM row menu's Profile,
   *  after it has selected that DM). */
  readonly onOpenDmProfile?: () => void;
}

export interface SidebarAreaResult {
  /** The composed sidebar wrapper element. */
  readonly sidebarWrapper: HTMLDivElement;
  /** All child MountableComponents for cleanup. */
  readonly children: readonly MountableComponent[];
  /** Unsubscribe / cleanup functions. */
  readonly unsubscribers: readonly (() => void)[];
  /** Open the quick-switch overlay (used for disconnect flow). */
  readonly openQuickSwitch: () => void;
  /** Remember the channel on screen as the one a content view returns to. */
  readonly rememberChannel: () => void;
  /** Drop the remembered channel. */
  readonly forgetChannel: () => void;
  /** The back path: leave DM mode for the channel the user came from. */
  readonly returnToChannel: () => void;
  /** Open (or start) the 1:1 DM with a user, as the member list's Message. */
  readonly messageUser: (userId: number) => void;
  /** Open an existing DM, as a click on its row does. */
  readonly openDm: (dm: DmChannel) => void;
  /** Build one member panel with the shared callback wiring (Message, Call and
   *  voice moderation). The one factory every host uses; the caller owns the
   *  result and must destroy it before another host builds one. */
  readonly buildMemberPanel: () => MemberPanel;
  /** Add or remove the left member section to match the stored layout, in
   *  place: the channel list is not remounted. Idempotent. */
  readonly syncMemberSection: () => void;
  /** Rename a group DM through the sidebar's prompt (the header's name click). */
  readonly renameGroup: (channelId: number) => void;
  /** Open the call in a channel, as the voice widget's channel name does. */
  readonly openCall: (channelId: number) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarArea(opts: SidebarAreaOptions): SidebarAreaResult {
  const sc = {} as SidebarScope;
  sc.opts = opts;

  ({
    ws: sc.ws,
    api: sc.api,
    limiters: sc.limiters,
    presenceSender: sc.presenceSender,
    getRoot: sc.getRoot,
    getToast: sc.getToast,
  } = sc.opts);

  sc.children = [];
  sc.unsubscribers = [];

  // Track active modal for channel create/edit/delete
  sc.activeModal = null;
  // Create / rename / delete category share the one modal slot with the channel dialogs.
  sc.categoryDialogs = createCategoryDialogs({
    api: sc.api,
    getToast: sc.getToast,
    slot: {
      current: () => sc.activeModal,
      set: (modal) => {
        sc.activeModal = modal;
      },
    },
  });

  // Remember the channel the user was on before entering DM mode
  sc.channelBeforeDm = null;

  // Track the currently mounted sidebar content component
  sc.activeSidebarContent = null;

  // Track invite controller cleanup (recreated on each channels mount)
  sc.inviteCleanup = null;

  // Track extra channel-mode components (member list) for cleanup on mode switch
  sc.channelModeExtras = [];
  sc.channelModeUnsubs = [];
  // The left member section: present only in channels mode with the "left"
  // layout. Owned by syncMemberSection, never by channelModeUnsubs.
  sc.memberSection = null;

  // Profile manager for quick-switch overlay
  sc.profileManager = null;

  // Quick-switch overlay instance
  sc.quickSwitchInstance = null;
  // Set for the duration of the profile-load round trip. `quickSwitchInstance`
  // is only assigned after that await, so the synchronous
  // `quickSwitchInstance !== null` guard alone lets a double-click during the
  // load mount two overlays — the second assignment orphans the first, which
  // is then unreachable by its own close affordances. Same pattern as
  // InviteManagerController / PinnedPanelController in OverlayManagers.ts.
  sc.openingQuickSwitch = false;

  // Set once this SidebarArea's own teardown unsubscriber has run.
  // `sidebarWrapper.parentElement` can NOT be used for this: MainPage.destroy()
  // removes an ancestor (`root`) and never detaches sidebarWrapper from its
  // own parent, so that check is never true and a profile load that resolves
  // after teardown mounts an orphaned overlay onto document.body.
  sc.tornDown = false;

  // Track the rename-group prompt so page teardown removes it — every other
  // modal in this file assigns `activeModal` for the same reason.
  sc.activePrompt = null;

  // Re-render hook for the DM sidebar, set while DM mode is mounted. Mute state
  // lives in localStorage rather than a store, so toggling it has no subscriber
  // to wake — this is how the row redraws dimmed.
  sc.refreshDmSidebarRef = null;
  mountServerHeader(sc);
  mountChannelSidebar(sc);
  mountDmSidebar(sc);
  mountMembersAndMode(sc);
  mountVoiceAndSwitcher(sc);

  // ---------------------------------------------------------------------------
  // User bar (always visible, with disconnect wired)
  // ---------------------------------------------------------------------------

  sc.userBarSlot = createElement("div", {});
  sc.selfVoiceCallbacks = createVoiceWidgetCallbacks(sc.ws, sc.limiters);
  sc.userBar = createUserBar({
    // The portal serves one server: the button signs out, nothing to switch to.
    onDisconnect: __OWNCORD_WEB__ ? () => logout(sc.api) : sc.openQuickSwitch,
    ws: sc.ws,
    presenceSender: sc.presenceSender,
    onMuteToggle: sc.selfVoiceCallbacks.onMuteToggle,
    onDeafenToggle: sc.selfVoiceCallbacks.onDeafenToggle,
  });
  sc.userBar.mount(sc.userBarSlot);
  sc.children.push(sc.userBar);
  sc.sidebarWrapper.appendChild(sc.userBarSlot);

  // ---------------------------------------------------------------------------
  // Cleanup for active modal
  // ---------------------------------------------------------------------------

  sc.unsubscribers.push(() => {
    if (sc.activeModal !== null) {
      sc.activeModal.destroy?.();
      sc.activeModal = null;
    }
  });

  sc.unsubscribers.push(() => {
    if (sc.activePrompt !== null) {
      sc.activePrompt.destroy();
      sc.activePrompt = null;
    }
  });

  sc.unsubscribers.push(() => {
    if (sc.activeSidebarContent !== null) {
      sc.activeSidebarContent.destroy?.();
      sc.activeSidebarContent = null;
    }
    if (sc.inviteCleanup !== null) {
      sc.inviteCleanup();
      sc.inviteCleanup = null;
    }
    for (const comp of sc.channelModeExtras) {
      comp.destroy?.();
    }
    sc.channelModeExtras = [];
    for (const unsub of sc.channelModeUnsubs) {
      unsub();
    }
    sc.channelModeUnsubs = [];
    sc.destroyMemberSection();
  });

  sc.unsubscribers.push(() => {
    sc.tornDown = true;
    sc.switchConfirmOwner.destroy();
    sc.voiceWidget?.destroy?.();
    sc.voiceWidget = null;
    sc.closeQuickSwitch();
  });

  return {
    sidebarWrapper: sc.sidebarWrapper,
    children: sc.children,
    unsubscribers: sc.unsubscribers,
    openQuickSwitch: sc.openQuickSwitch,
    rememberChannel: sc.rememberChannel,
    forgetChannel: () => {
      sc.channelBeforeDm = null;
    },
    returnToChannel: sc.returnToChannel,
    messageUser: (userId) => void handleCreateDm(userId, sc.dmDeps),
    openDm: (dm) => selectDmConversation(dm, sc.dmDeps),
    buildMemberPanel: sc.buildMemberPanel,
    syncMemberSection: sc.syncMemberSection,
    renameGroup: sc.renameGroup,
    openCall: sc.openCall,
  };
}
