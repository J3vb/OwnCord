/** The shared scope of one sidebar build. */
import type { SidebarAreaOptions } from "../SidebarArea";
import type { Disposable } from "@lib/disposable";
import type { ChannelType } from "@lib/types";
import type { MountableComponent } from "@lib/text/safeRender";
import type { DmSidebar } from "@components/DmSidebar";
import type { DmMenuActions } from "@components/dmContextMenu";
import type { VoiceWidgetOptions } from "@components/VoiceWidget";
import type { SidebarMemberSectionResult } from "../SidebarMemberSection";
import type { MemberPanel } from "../../../features/members/memberPanel";
import type { DmHelperDeps } from "../SidebarDmHelpers";
import type { ModalInstance } from "@lib/ui/modalFactory";
import type { CategoryRef } from "@stores/channels.store";
import type { ProfileManager } from "@lib/presence/profiles";
import type { CategoryDialogs } from "../categoryDialogs";
import type { InviteManagerController } from "../OverlayManagers";
import type { LazyScreen } from "../../../components/lazyScreen";
import type { VoiceWidgetCallbacks } from "../VoiceCallbacks";

/** The values one sidebar builds, shared by its build steps. */
export interface SidebarScope {
  opts: SidebarAreaOptions;
  ws: SidebarAreaOptions["ws"];
  api: SidebarAreaOptions["api"];
  limiters: SidebarAreaOptions["limiters"];
  presenceSender: SidebarAreaOptions["presenceSender"];
  getRoot: SidebarAreaOptions["getRoot"];
  getToast: SidebarAreaOptions["getToast"];
  children: MountableComponent[];
  unsubscribers: Array<() => void>;
  // Track active modal for channel create/edit/delete
  activeModal: MountableComponent | null;
  // Create / rename / delete category share the one modal slot with the channel dialogs.
  categoryDialogs: CategoryDialogs;
  // Remember the channel the user was on before entering DM mode
  channelBeforeDm: number | null;
  // Track the currently mounted sidebar content component
  activeSidebarContent: MountableComponent | null;
  // Track invite controller cleanup (recreated on each channels mount)
  inviteCleanup: (() => void) | null;
  // Track extra channel-mode components (member list) for cleanup on mode switch
  channelModeExtras: MountableComponent[];
  channelModeUnsubs: Array<() => void>;
  // The left member section: present only in channels mode with the "left"
  // layout. Owned by syncMemberSection, never by channelModeUnsubs.
  memberSection: SidebarMemberSectionResult | null;
  // Profile manager for quick-switch overlay
  profileManager: ProfileManager | null;
  // Quick-switch overlay instance
  quickSwitchInstance: MountableComponent | null;
  // Set for the duration of the profile-load round trip. `quickSwitchInstance`
  // is only assigned after that await, so the synchronous
  // `quickSwitchInstance !== null` guard alone lets a double-click during the
  // load mount two overlays — the second assignment orphans the first, which
  // is then unreachable by its own close affordances. Same pattern as
  // InviteManagerController / PinnedPanelController in OverlayManagers.ts.
  openingQuickSwitch: boolean;
  // Set once this SidebarArea's own teardown unsubscriber has run.
  // `sidebarWrapper.parentElement` can NOT be used for this: MainPage.destroy()
  // removes an ancestor (`root`) and never detaches sidebarWrapper from its
  // own parent, so that check is never true and a profile load that resolves
  // after teardown mounts an orphaned overlay onto document.body.
  tornDown: boolean;
  // Track the rename-group prompt so page teardown removes it — every other
  // modal in this file assigns `activeModal` for the same reason.
  activePrompt: ModalInstance | null;
  // Re-render hook for the DM sidebar, set while DM mode is mounted. Mute state
  // lives in localStorage rather than a store, so toggling it has no subscriber
  // to wake — this is how the row redraws dimmed.
  refreshDmSidebarRef: (() => void) | null;
  // ---------------------------------------------------------------------------
  // Sidebar wrapper (replaces old channel-sidebar root)
  // ---------------------------------------------------------------------------
  sidebarWrapper: HTMLDivElement;
  // ---------------------------------------------------------------------------
  // Server header
  // ---------------------------------------------------------------------------
  serverHeader: HTMLDivElement;
  serverIcon: HTMLDivElement;
  // i18n-exempt: logo monogram, not copy
  serverInfoCol: HTMLDivElement;
  // The server name is the menu's button (Discord's server menu). The text sits
  // in its own span so a rename replaces only the text, never the chevron.
  serverNameEl: HTMLButtonElement;
  serverNameText: HTMLSpanElement;
  serverNameChevron: SVGSVGElement;
  onlineCount: number;
  serverOnlineEl: HTMLSpanElement;
  // Invite, Audit Log and Moderation: one row of quiet icon buttons.
  headerActions: HTMLDivElement;
  // Mark Server as Read: a server-wide action, so it lives in this header rather
  // than in ChannelSidebar's own header (hidden here, see sidebar.css). First in
  // the row so it appearing and disappearing does not move Invite. Shown only
  // while a server channel is unread (DMs are not part of the server and are
  // left alone); those badges live in channels.store.
  markAllBtn: HTMLButtonElement;
  syncMarkAllBtn: () => void;
  headerInviteCtrl: InviteManagerController;
  headerInviteBtn: HTMLButtonElement;
  // ---------------------------------------------------------------------------
  // Audit log entry point
  // ---------------------------------------------------------------------------
  //
  // The audit log itself stays in the admin panel — it is a paginated,
  // filterable table over an endpoint this client otherwise never calls, and a
  // second implementation would be a second thing to keep correct. What belongs
  // here is the way in, for the moderators who hold VIEW_AUDIT_LOG and would
  // otherwise have to know the panel's URL by heart.
  //
  // Rendered once per mount and kept in sync with the role list: `ready` may
  // land after this header is built, and a moderator whose role only becomes
  // known then would never see the entry otherwise.
  auditBtn: HTMLButtonElement;
  // The Audit Log button and the server menu's Server Settings share this.
  openAdmin: (section?: string) => void;
  // The Moderation Center entry: beside Audit Log, only with
  // MODERATE_MEMBERS, and only once the Moderation Center ships.
  moderationBtn: HTMLButtonElement | null;
  syncAuditBtn: () => void;
  // The server menu. Its rows are decided each time it opens (ServerMenu.ts).
  serverMenuOwner: Disposable;
  // Keep server name in sync with auth store
  unsubServerName: () => void;
  // Keep online count in sync with members store
  unsubOnlineCount: () => void;
  // ---------------------------------------------------------------------------
  // Switchable content slot
  // ---------------------------------------------------------------------------
  contentSlot: HTMLDivElement;
  // The category "+", the empty-state button and the server menu share this.
  openCreateChannelModal: (category: CategoryRef, type?: ChannelType) => void;
  // ---------------------------------------------------------------------------
  // Channel sidebar builder (channels mode)
  // ---------------------------------------------------------------------------
  buildChannelSidebar: () => MountableComponent;
  // ---------------------------------------------------------------------------
  // DM helper dependencies (shared by DM section and DM sidebar)
  // ---------------------------------------------------------------------------
  dmDeps: DmHelperDeps;
  /**
   * Show the member picker. One selection opens a 1:1 DM; two or more create a
   * group — the picker itself decides which, so the sidebar does not need two
   * entry points for what the user experiences as one action.
   */
  showMemberPicker: () => void;
  closePickerModal: () => void;
  // ---------------------------------------------------------------------------
  // DM sidebar builder (dms mode)
  // ---------------------------------------------------------------------------
  /**
   * Leave the DM list gracefully after a conversation goes away: fall back to
   * another DM if there is one, otherwise to the channel the user came from.
   */
  fallBackFromDm: () => void;
  /**
   * Close a 1:1 DM or leave a group.
   *
   * The client does not decide which: the server's DELETE /dms/{id} is a hide
   * for a 1:1 and a leave for a group, and duplicating that branch here would
   * be a second place to get it wrong. Locally, both mean "drop it from the
   * list" — the row is removed optimistically so the sidebar reacts at once.
   *
   * If the server refuses, the row comes back: the DmChannel and its
   * index are kept from just before the removal and it is re-inserted at that
   * index, so the list's recency order is unchanged. The failure toast still
   * fires so the user knows why.
   */
  closeOrLeaveDm: (channelId: number) => void;
  /** Rename a group DM (participants only; the server refuses a 1:1). */
  renameGroup: (channelId: number) => void;
  /** Show a group icon failure; null means it worked and the dm_channel_open does the rest. */
  showGroupIconResult: (error: string | null) => void;
  /**
   * Pick, crop and upload a group's icon. The picker opens synchronously from
   * the menu click (WebKit refuses one opened after an await), on an input
   * that is attached to the page and removed on change or cancel; the crop and
   * upload code is imported only once a file is chosen. The store updates from
   * the dm_channel_open that follows.
   */
  changeGroupIcon: (channelId: number) => void;
  removeGroupIconFor: (channelId: number) => void;
  /**
   * Leave DM mode for the channel the user came from. The DM sidebar's back
   * arrow and a content view's Close/Escape both take this path.
   */
  returnToChannel: () => void;
  /** Remember the channel on screen as the one returnToChannel goes back to. */
  rememberChannel: () => void;
  /** Make `channelId` the active DM; false when it is no longer in the list. */
  selectDm: (channelId: number) => boolean;
  /** The DM row menu's actions, shared by the full list and the compact preview. */
  dmMenuActions: () => DmMenuActions;
  buildDmSidebar: () => DmSidebar;
  /** Call a user: open the DM first, then start the call in it. An
   *  existing DM is selected at once; a new one starts the call in
   *  `handleCreateDm`'s onReady, once it is the active channel `startCall`
   *  reads. */
  callUser: (userId: number) => void;
  buildMemberPanel: () => MemberPanel;
  /** Create or destroy the left member section so it matches the mode and the
   *  stored layout. It appends to `contentSlot`, so the channel list above it
   *  keeps its DOM. */
  syncMemberSection: () => void;
  destroyMemberSection: () => void;
  // ---------------------------------------------------------------------------
  // Mount sidebar content for current mode
  // ---------------------------------------------------------------------------
  mountSidebarContent: (mode: "channels" | "dms") => void;
  // Initial mount based on current store state
  initialMode: "channels" | "dms";
  // Subscribe to sidebar mode changes
  unsubSidebarMode: () => void;
  // ---------------------------------------------------------------------------
  // Voice widget (always visible)
  // ---------------------------------------------------------------------------
  voiceWidgetSlot: HTMLDivElement;
  onDisconnect: () => void;
  onCameraToggle: () => void;
  onScreenshareToggle: () => void;
  /** Open the call in `channelId`: its DM, or a guild voice channel's call view. */
  openCall: (channelId: number) => void;
  voiceWidgetOptions: VoiceWidgetOptions;
  // The widget subscribes to the store when it mounts and renders the current
  // state, so a late mount shows a session that is already under way. It stays
  // mounted once loaded: it hides itself when the user is not in voice.
  // One loader per sidebar; the browser's module cache shares the code itself.
  voiceWidgetScreen: LazyScreen<typeof import("@components/VoiceWidget")>;
  voiceWidgetRequested: boolean;
  // Not in `children`: the page copies that list at build, before this loads.
  voiceWidget: MountableComponent | null;
  loadVoiceWidget: () => void;
  // ---------------------------------------------------------------------------
  // Quick-switch overlay
  // ---------------------------------------------------------------------------
  openQuickSwitch: () => void;
  // The question loads on demand; this owner closes it with the page.
  switchConfirmOwner: Disposable;
  confirmingSwitch: boolean;
  requestServerSwitch: (host: string, name: string) => void;
  closeQuickSwitch: () => void;
  // ---------------------------------------------------------------------------
  // User bar (always visible, with disconnect wired)
  // ---------------------------------------------------------------------------
  userBarSlot: HTMLDivElement;
  selfVoiceCallbacks: VoiceWidgetCallbacks;
  userBar: MountableComponent;
}
