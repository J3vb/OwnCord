/**
 * SidebarArea — unified sidebar DOM construction and component wiring.
 * Composes a server header, ChannelSidebar or DmSidebar (based on store mode),
 * VoiceWidget, and UserBar. The ServerStrip has been removed in favor of the
 * unified sidebar layout with a quick-switch overlay for server switching.
 */

import { createElement, setText, clearChildren } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon, type IconName } from "@lib/icons";
import { isTextLikeChannel, type ChannelType } from "@lib/types";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import { type ApiClient, errorText } from "@lib/api";
import type { RateLimiterSet } from "@lib/rate-limiter";
import type { PresenceSender } from "@lib/presence";
import type { ToastContainer } from "@components/Toast";
import { createLogger } from "@lib/logger";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { withThreadsStore } from "@stores/threadsLoader";
import { requestOpenThread, requestOpenThreadList } from "../../features/threads/threadNavigation";
import { createDmSidebar } from "@components/DmSidebar";
import type { DmConversation, DmSidebar } from "@components/DmSidebar";
import type { DmMenuActions } from "@components/dmContextMenu";
import { createLazyScreen } from "@components/lazyScreen";
import { createCategoryDialogs } from "./categoryDialogs";
import { migrateCollapsedToCategoryIds } from "../../features/channels/collapsedMigration";
import type { VoiceWidgetOptions } from "@components/VoiceWidget";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { logout } from "@lib/logout";
import { createUserBar } from "@components/UserBar";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import type { QuickSwitchProfile } from "@components/QuickSwitchOverlay";
import {
  createVoiceWidgetCallbacks,
  createSidebarVoiceCallbacks,
  createVoiceModerationCallbacks,
} from "./VoiceCallbacks";
import {
  createSidebarMemberSection,
  memberPanelUi,
  type SidebarMemberSectionResult,
} from "./SidebarMemberSection";
import { loadMemberLayout } from "../../features/members/memberLayout";
import { createMemberPanel, type MemberPanel } from "../../features/members/memberPanel";
import { attachServerMenu } from "./ServerMenu";
import { createInviteManagerController } from "./OverlayManagers";
import {
  selectDmConversation,
  handleCreateDm,
  handleCreateGroupDm,
  buildDmConversations,
  isDmInCall,
  findDirectDm,
  type DmHelperDeps,
} from "./SidebarDmHelpers";
import { createPromptModal } from "@lib/modalFactory";
import type { ModalInstance } from "@lib/modalFactory";
import {
  CHANNEL_MUTE_CHANGED,
  muteChannel,
  toggleChannelMute,
  unmuteChannel,
} from "@lib/channel-mutes";
import { markAllRead, markChannelRead, unreadChannelIds } from "@lib/read-state";
import { createSidebarDmSection } from "./SidebarDmSection";
import { uiStore, setSidebarMode, loadCollapsedCategories, openSettings } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { addServer, switchToServer } from "../../features/server-rail/switchServer";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import {
  channelsStore,
  setActiveChannel,
  updateChannel,
  updateChannelPosition,
  NO_CATEGORY,
  type CategoryRef,
} from "@stores/channels.store";
import { keepDmForCall, releaseKeptDm } from "../../features/direct-messages/keptCallDms";
import { dmStore, closeDmLocally, restoreDmChannel, type DmChannel } from "@stores/dm.store";
import { clearChannelVoiceUsers, voiceStore } from "@stores/voice.store";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
import { openAdminPanel } from "@lib/admin-panel";
import { canManageInvites, canModerateMembers, canViewAuditLog } from "@lib/permissions";
import type { ProfileManager } from "@lib/profiles";
import type { ContentViewId, NavigationDestinations } from "../../features/navigation/destinations";
import { trackCurrentView } from "../../features/navigation/contentView";
import { navigationText } from "../../i18n/navigation";
import { shellText } from "../../i18n/shell";
import { connectText } from "../../i18n/connect";
import {
  collapseSpaces,
  lineHintText,
  visibleLength,
  MAX_GROUP_DM_NAME_LEN,
} from "@lib/nameLimits";

const log = createLogger("SidebarArea");

/** A server-header icon button: named by its aria-label, the title is its
 *  hover tooltip. */
function headerAction(
  label: string,
  hint: string,
  icon: IconName,
  testId: string,
): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: "sidebar-header-action",
    title: hint,
    "aria-label": label,
    "data-testid": testId,
  });
  btn.appendChild(createIcon(icon, 16));
  return btn;
}

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
   *  (see @lib/presence). */
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

// Both modals load on first use, so their code stays out of the main-page chunk.
const createChannelModalScreen = createLazyScreen(
  "create-channel-modal",
  () => import("@components/CreateChannelModal"),
);
const memberPickerScreen = createLazyScreen("member-picker", () => import("./MemberPickerModal"));

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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The DM rows, each marked when someone is in that DM's call. */
function dmConversations(activeChannelId: number | null): DmConversation[] {
  return buildDmConversations(activeChannelId).map((c) => ({
    ...c,
    inCall: isDmInCall(c.channelId),
  }));
}

export function createSidebarArea(opts: SidebarAreaOptions): SidebarAreaResult {
  const { ws, api, limiters, presenceSender, getRoot, getToast } = opts;

  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // Track active modal for channel create/edit/delete
  let activeModal: MountableComponent | null = null;
  // Create / rename / delete category share the one modal slot with the channel dialogs.
  const categoryDialogs = createCategoryDialogs({
    api,
    getToast,
    slot: {
      current: () => activeModal,
      set: (modal) => {
        activeModal = modal;
      },
    },
  });

  // Remember the channel the user was on before entering DM mode
  let channelBeforeDm: number | null = null;

  // Track the currently mounted sidebar content component
  let activeSidebarContent: MountableComponent | null = null;

  // Track invite controller cleanup (recreated on each channels mount)
  let inviteCleanup: (() => void) | null = null;

  // Track extra channel-mode components (member list) for cleanup on mode switch
  let channelModeExtras: MountableComponent[] = [];
  let channelModeUnsubs: Array<() => void> = [];
  // The left member section: present only in channels mode with the "left"
  // layout. Owned by syncMemberSection, never by channelModeUnsubs.
  let memberSection: SidebarMemberSectionResult | null = null;

  // Profile manager for quick-switch overlay
  let profileManager: ProfileManager | null = null;

  // Quick-switch overlay instance
  let quickSwitchInstance: MountableComponent | null = null;
  // Set for the duration of the profile-load round trip. `quickSwitchInstance`
  // is only assigned after that await, so the synchronous
  // `quickSwitchInstance !== null` guard alone lets a double-click during the
  // load mount two overlays — the second assignment orphans the first, which
  // is then unreachable by its own close affordances. Same pattern as
  // InviteManagerController / PinnedPanelController in OverlayManagers.ts.
  let openingQuickSwitch = false;

  // Set once this SidebarArea's own teardown unsubscriber has run.
  // `sidebarWrapper.parentElement` can NOT be used for this: MainPage.destroy()
  // removes an ancestor (`root`) and never detaches sidebarWrapper from its
  // own parent, so that check is never true and a profile load that resolves
  // after teardown mounts an orphaned overlay onto document.body.
  let tornDown = false;

  // Track the rename-group prompt so page teardown removes it — every other
  // modal in this file assigns `activeModal` for the same reason.
  let activePrompt: ModalInstance | null = null;

  // Re-render hook for the DM sidebar, set while DM mode is mounted. Mute state
  // lives in localStorage rather than a store, so toggling it has no subscriber
  // to wake — this is how the row redraws dimmed.
  let refreshDmSidebarRef: (() => void) | null = null;

  // ---------------------------------------------------------------------------
  // Sidebar wrapper (replaces old channel-sidebar root)
  // ---------------------------------------------------------------------------

  const sidebarWrapper = createElement("div", {
    class: "unified-sidebar",
    id: "unified-sidebar",
    "data-testid": "unified-sidebar",
  });

  // ---------------------------------------------------------------------------
  // Server header
  // ---------------------------------------------------------------------------

  const serverHeader = createElement("div", { class: "unified-sidebar-header" });
  const serverIcon = createElement("div", { class: "server-icon-sm" }, "OC"); // i18n-exempt: logo monogram, not copy
  const serverInfoCol = createElement("div", { class: "server-info" });
  // The server name is the menu's button (Discord's server menu). The text sits
  // in its own span so a rename replaces only the text, never the chevron.
  const serverNameEl = createElement("button", {
    type: "button",
    class: "server-name",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "data-testid": "server-name",
  });
  const serverNameText = createElement(
    "span",
    { class: "server-name-text" },
    authStore.getState().serverName ?? shellText("common.serverFallback"),
  );
  const serverNameChevron = createIcon("chevron-down", 14);
  serverNameChevron.classList.add("server-name-chevron");
  serverNameEl.appendChild(serverNameText);
  serverNameEl.appendChild(serverNameChevron);
  const onlineCount = getOnlineMembers().length;
  const serverOnlineEl = createElement(
    "span",
    { class: "server-online" },
    shellText("common.online", { count: onlineCount }),
  );
  serverInfoCol.appendChild(serverNameEl);
  serverInfoCol.appendChild(serverOnlineEl);
  serverHeader.appendChild(serverIcon);
  serverHeader.appendChild(serverInfoCol);

  // Invite, Audit Log and Moderation: one row of quiet icon buttons.
  const headerActions = createElement("div", { class: "sidebar-header-actions" });

  // Mark Server as Read: a server-wide action, so it lives in this header rather
  // than in ChannelSidebar's own header (hidden here, see sidebar.css). First in
  // the row so it appearing and disappearing does not move Invite. Shown only
  // while a server channel is unread (DMs are not part of the server and are
  // left alone); those badges live in channels.store.
  const markAllBtn = headerAction(
    shellText("channel.markAllRead"),
    shellText("channel.markAllRead"),
    "check",
    "mark-all-read",
  );
  markAllBtn.addEventListener("click", () => {
    // A server-wide action: DMs are not part of the server, so they stay as they are.
    markAllRead({ includeDms: false });
  });
  const syncMarkAllBtn = (): void => {
    const show = unreadChannelIds({ includeDms: false }).length > 0;
    // Hiding the focused button would drop focus to <body>; hand it to the
    // next header action still shown (Invite, Audit Log, Moderation are each
    // permission-gated), else to the channel list's roving row, so the next
    // Tab starts nearby.
    if (!show && document.activeElement === markAllBtn) {
      const next =
        [...headerActions.querySelectorAll<HTMLElement>(".sidebar-header-action")].find(
          (btn) => btn !== markAllBtn && btn.style.display !== "none",
        ) ??
        headerActions
          .closest(".unified-sidebar")
          ?.querySelector<HTMLElement>('[data-channel-id][tabindex="0"]');
      next?.focus();
    }
    markAllBtn.style.display = show ? "" : "none";
  };
  syncMarkAllBtn();
  headerActions.appendChild(markAllBtn);
  unsubscribers.push(
    channelsStore.subscribeSelector((s) => s.channels, syncMarkAllBtn),
    dmStore.subscribeSelector((s) => s.channels, syncMarkAllBtn),
  );

  const headerInviteCtrl = createInviteManagerController({ api, getRoot });
  const headerInviteBtn = headerAction(
    shellText("invite.invite"),
    shellText("invite.invitePeople"),
    "user-plus",
    "invite-btn",
  );
  headerInviteBtn.addEventListener("click", () => {
    void headerInviteCtrl.open();
  });
  headerActions.appendChild(headerInviteBtn);
  unsubscribers.push(() => {
    headerInviteCtrl.cleanup();
  });

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
  const auditBtn = headerAction(
    shellText("audit.label"),
    shellText("audit.hint"),
    "scroll-text",
    "audit-log-btn",
  );
  // The Audit Log button and the server menu's Server Settings share this.
  const openAdmin = (section?: string): void => {
    const host = api.getConfig().host ?? "";
    if (host === "") {
      getToast()?.show(shellText("audit.notConnected"), "error");
      return;
    }
    void openAdminPanel(host, section).catch(() => {
      getToast()?.show(shellText("audit.openFailed"), "error");
    });
  };
  auditBtn.addEventListener("click", () => openAdmin("audit"));

  // The Moderation Center entry: beside Audit Log, only with
  // MODERATE_MEMBERS, and only once the Moderation Center ships.
  let moderationBtn: HTMLButtonElement | null = null;
  if (opts.destinations?.moderation !== undefined) {
    const btn = headerAction(
      navigationText("moderation.title"),
      navigationText("moderation.entryHint"),
      "shield",
      "moderation-btn",
    );
    btn.addEventListener("click", () => opts.onOpenView?.("moderation", btn));
    unsubscribers.push(trackCurrentView(btn, "moderation"));
    moderationBtn = btn;
  }

  const syncAuditBtn = (): void => {
    headerInviteBtn.style.display = canManageInvites() ? "" : "none";
    auditBtn.style.display = canViewAuditLog() ? "" : "none";
    if (moderationBtn !== null) {
      moderationBtn.style.display = canModerateMembers() ? "" : "none";
    }
  };
  syncAuditBtn();
  headerActions.appendChild(auditBtn);
  if (moderationBtn !== null) headerActions.appendChild(moderationBtn);
  serverHeader.appendChild(headerActions);
  // The permission is derived from the signed-in user's role plus the role
  // list, so both have to be watched.
  unsubscribers.push(
    authStore.subscribeSelector(
      (s) => `${s.user?.role ?? ""}|${s.user?.role_ids?.join(",") ?? ""}`,
      () => syncAuditBtn(),
    ),
  );
  unsubscribers.push(
    channelsStore.subscribeSelector(
      (s) => s.roles,
      () => syncAuditBtn(),
    ),
  );

  sidebarWrapper.appendChild(serverHeader);

  // The server menu. Its rows are decided each time it opens (ServerMenu.ts).
  const serverMenuOwner = new Disposable();
  unsubscribers.push(() => serverMenuOwner.destroy());
  attachServerMenu(
    serverNameEl,
    {
      onInvite: () => {
        void headerInviteCtrl.open();
      },
      onMarkRead: () => markAllRead({ includeDms: false }),
      onNotificationSettings: () => openSettings("Notifications"), // i18n-exempt: settings tab id, not copy
      onCreateChannel: () => openCreateChannelModal(NO_CATEGORY),
      onCreateCategory: () => categoryDialogs.create(),
      onServerSettings: () => openAdmin(),
    },
    serverMenuOwner.signal,
  );

  // Load per-server collapsed category state from localStorage, scoped to
  // the connected host (not the display name) — the same convention as
  // setChannelMutesHost/setAudioVolumeHost. The display name
  // defaults to "OwnCord Server" on every unmodified install, so keying on
  // it would collapse two different servers' saved state onto one entry.
  loadCollapsedCategories(api.getConfig().host);
  // Collapsed state saved under a category NAME (the older key) moves to the id
  // key once the channel list says which name is which id. Done at once when
  // the list is already here, else on the first channels write that fills it.
  if (!migrateCollapsedToCategoryIds()) {
    const unsubscribeTranslate = channelsStore.subscribeSelector(
      (s) => s.channels,
      () => {
        if (migrateCollapsedToCategoryIds()) unsubscribeTranslate();
      },
    );
    unsubscribers.push(unsubscribeTranslate);
  }

  // Keep server name in sync with auth store
  const unsubServerName = authStore.subscribeSelector(
    (s) => s.serverName,
    (name) => {
      setText(serverNameText, name ?? shellText("common.serverFallback"));
    },
  );
  unsubscribers.push(unsubServerName);

  // Keep online count in sync with members store
  const unsubOnlineCount = membersStore.subscribeSelector(
    (s) => s.members,
    () => {
      const count = getOnlineMembers().length;
      setText(serverOnlineEl, shellText("common.online", { count }));
    },
  );
  unsubscribers.push(unsubOnlineCount);

  // ---------------------------------------------------------------------------
  // Switchable content slot
  // ---------------------------------------------------------------------------

  const contentSlot = createElement("div", { class: "sidebar-content" });
  sidebarWrapper.appendChild(contentSlot);

  // The category "+", the empty-state button and the server menu share this.
  function openCreateChannelModal(category: CategoryRef, type?: ChannelType): void {
    if (activeModal !== null) return;
    // The placeholder holds the modal slot while the dialog loads: a second
    // click is refused, and a teardown or another modal in between drops the
    // late one (the same shape as the edit dialog below).
    const pending: MountableComponent = { mount: () => {} };
    activeModal = pending;
    void createChannelModalScreen
      .load(() => activeModal === pending)
      .then((screen) => {
        if (screen === null) {
          if (activeModal === pending) activeModal = null;
          return;
        }
        if (activeModal !== pending) return;
        const modal = screen.createCreateChannelModal({
          category,
          type,
          onCreate: async (data) => {
            try {
              await api.adminCreateChannel(data);
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = errorText(err, shellText("channel.createFailed"));
              getToast()?.show(msg, "error");
              // The modal's own catch re-enables its submit button and renders
              // the inline error, so the failure must propagate to it.
              throw err;
            }
          },
          onClose: () => {
            modal.destroy?.();
            activeModal = null;
          },
        });
        activeModal = modal;
        modal.mount(document.body);
      });
  }

  // ---------------------------------------------------------------------------
  // Channel sidebar builder (channels mode)
  // ---------------------------------------------------------------------------

  function buildChannelSidebar(): MountableComponent {
    const sidebarVoice = createSidebarVoiceCallbacks(ws);
    return createChannelSidebar({
      onVoiceJoin: sidebarVoice.onVoiceJoin,
      onOpenCall: () => opts.onOpenCall?.(),
      onVoiceModerate: createVoiceModerationCallbacks(ws),
      onWatchStream: opts.onWatchStream,
      onOpenThread: requestOpenThread,
      onOpenThreadList: requestOpenThreadList,
      onUnfollowThread: (threadId) => {
        // Dropped while the socket is down: a lost frame would leave the row until the next ready.
        if (uiStore.getState().connectionStatus !== "connected") return;
        ws.send({ type: "thread_follow", payload: { thread_id: threadId, follow: false } });
      },
      onMarkThreadRead: (threadId) => {
        // Dropped while the socket is down, like Unfollow: a lost mark_read would clear the row for nothing.
        if (uiStore.getState().connectionStatus !== "connected") return;
        // mark_read accepts a thread id; the same path as a channel's Mark as Read.
        markChannelRead(threadId);
        withThreadsStore((m) => m.clearFollowedCounts(threadId));
      },
      onInviteFromChannel: () => {
        void headerInviteCtrl.open();
      },
      onCreateChannel: openCreateChannelModal,
      onCreateCategory: categoryDialogs.create,
      onRenameCategory: categoryDialogs.rename,
      onDeleteCategory: categoryDialogs.remove,
      onMoveCategory: categoryDialogs.move,
      onEditChannel: (channel) => {
        if (activeModal !== null) return;
        // The editor is admin-only and never on first paint, so it loads on
        // demand. The placeholder holds the modal slot while it loads: a second
        // click is refused, and a teardown in between drops the late modal.
        const pending: MountableComponent = { mount: () => {} };
        activeModal = pending;
        void import("@components/EditChannelModal").then(
          ({ createEditChannelModal }) => {
            if (activeModal !== pending) return;
            // Pre-fill from the store rather than from the sidebar's row: the store
            // is what channel_update writes into, so the modal opens on the current
            // values even if the row was rendered before the last edit landed.
            const stored = channelsStore.getState().channels.get(channel.id);
            const modal = createEditChannelModal({
              channelId: channel.id,
              channelName: stored?.name ?? channel.name,
              channelType: channel.type,
              channelTopic: stored?.topic ?? "",
              channelCategory: stored?.category ?? "",
              channelCategoryId: stored?.categoryId ?? 0,
              channelSlowMode: stored?.slowMode ?? 0,
              channelNsfw: stored?.nsfw ?? false,
              channelVoiceMaxUsers: stored?.voiceMaxUsers ?? 0,
              channelVoiceMaxVideo: stored?.voiceMaxVideo ?? 0,
              channelPasswordProtected: stored?.passwordProtected ?? false,
              // The editor's own write: the live channel_update reaches the store.
              onSaveForum: async (body) => {
                await api.adminUpdateForumSettings(channel.id, body);
              },
              onSave: async (data) => {
                try {
                  await api.adminUpdateChannel(channel.id, data);
                  modal.destroy?.();
                  activeModal = null;
                } catch (err) {
                  const msg = errorText(err, shellText("channel.updateFailed"));
                  getToast()?.show(msg, "error");
                  // Propagate so the modal re-enables its save button and shows
                  // the inline error.
                  throw err;
                }
              },
              onClose: () => {
                modal.destroy?.();
                activeModal = null;
              },
            });
            activeModal = modal;
            modal.mount(document.body);
          },
          () => {
            if (activeModal === pending) activeModal = null;
          },
        );
      },
      onDeleteChannel: (channel) => {
        if (activeModal !== null) return;
        const modal = createDeleteChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          onConfirm: async () => {
            try {
              await api.adminDeleteChannel(channel.id);
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = errorText(err, shellText("channel.deleteFailed"));
              getToast()?.show(msg, "error");
              // Propagate so the modal re-enables its confirm button and shows
              // the inline error.
              throw err;
            }
          },
          onClose: () => {
            modal.destroy?.();
            activeModal = null;
          },
        });
        activeModal = modal;
        modal.mount(document.body);
      },
      onReorderCategory: categoryDialogs.place,
      onReorderChannel: (reorders) => {
        // The store already applied the optimistic order (drag-reorder.ts,
        // on mouseup). Aggregate the per-channel PATCHes and surface a single
        // failure toast — same try/catch+toast contract as onSave/onDelete
        // above. A drop into another category sends the moved channel's
        // `category_id` with its position. A rejected PATCH is rolled
        // back to its previous position, and previous category, only
        // if no channel_update broadcast arrived for that channel since the
        // request started (the server broadcasts before it answers, so a
        // broadcast means the write landed) and it still shows the optimistic
        // value. Only the broadcast counts: unread/mention badge mutations also
        // replace the channel object but confirm nothing. A request that failed
        // only because its response was lost is covered by the reconnect
        // resync, so it needs no reconciliation here.
        // The moved channel's category PATCH and its peers' position PATCHes run
        // concurrently. That is safe only because the server does not enforce
        // unique positions: no ordering between them can make one collide.
        const touched = new Set<number>();
        const unsubscribe = ws.on("channel_update", (payload) => {
          touched.add(payload.id);
        });
        void Promise.allSettled(
          reorders.map((r) =>
            api.adminUpdateChannel(
              r.channelId,
              r.category === undefined
                ? { position: r.newPosition }
                : { category_id: r.category.next.categoryId ?? 0, position: r.newPosition },
            ),
          ),
        ).then((results) => {
          unsubscribe();
          let failure: unknown;
          let movedFailed = false;
          let failed = false;
          results.forEach((result, i) => {
            const entry = reorders[i];
            if (result.status !== "rejected" || entry === undefined) return;
            if (!failed) failure = result.reason;
            failed = true;
            movedFailed = movedFailed || entry.category !== undefined;
            const stored = channelsStore.getState().channels.get(entry.channelId);
            if (
              touched.has(entry.channelId) ||
              stored === undefined ||
              stored.position !== entry.newPosition ||
              (entry.category !== undefined &&
                (stored.categoryId ?? 0) !== (entry.category.next.categoryId ?? 0))
            ) {
              return;
            }
            if (entry.category === undefined) {
              updateChannelPosition(entry.channelId, entry.previousPosition);
              return;
            }
            const prev = entry.category.previous;
            updateChannel({
              id: entry.channelId,
              position: entry.previousPosition,
              category_id: prev.categoryId ?? 0,
              category: prev.category ?? "",
              category_position: prev.categoryPosition ?? 0,
            });
          });
          if (failed) {
            getToast()?.show(
              movedFailed
                ? errorText(failure, shellText("channel.moveFailed"))
                : shellText("channel.reorderFailed"),
              "error",
            );
          }
        });
      },
      onPurgeChannel: async (channel, count) => {
        try {
          // The store is updated by the chat_bulk_deleted broadcast, so the
          // response is only used for the toast's honest count.
          const result = await api.purgeMessages(channel.id, count);
          getToast()?.show(
            result.count === 0
              ? shellText("purge.none", { channel: channel.name })
              : shellText("purge.done", { count: result.count, channel: channel.name }),
            result.count === 0 ? "info" : "success",
          );
        } catch (err) {
          const msg = errorText(err, shellText("purge.failed"));
          getToast()?.show(msg, "error");
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // DM helper dependencies (shared by DM section and DM sidebar)
  // ---------------------------------------------------------------------------

  const dmDeps: DmHelperDeps = {
    api,
    getToast,
    getChannelBeforeDm: () => channelBeforeDm,
    setChannelBeforeDm: (id) => {
      channelBeforeDm = id;
    },
  };

  /**
   * Show the member picker. One selection opens a 1:1 DM; two or more create a
   * group — the picker itself decides which, so the sidebar does not need two
   * entry points for what the user experiences as one action.
   */
  function showMemberPicker(): void {
    if (activeModal !== null) return;
    const pending: MountableComponent = { mount: () => {} };
    activeModal = pending;
    void memberPickerScreen
      .load(() => activeModal === pending)
      .then((screen) => {
        if (screen === null) {
          if (activeModal === pending) activeModal = null;
          return;
        }
        if (activeModal !== pending) return;
        const picker = screen.createMemberPickerModal({
          onSelect: (userId) => {
            closePickerModal();
            void handleCreateDm(userId, dmDeps);
          },
          onSelectGroup: (userIds, name) => {
            closePickerModal();
            void handleCreateGroupDm(userIds, name, dmDeps);
          },
          onClose: () => {
            activeModal = null;
          },
        });
        activeModal = picker;
        picker.mount(document.body);
      });
  }

  function closePickerModal(): void {
    if (activeModal !== null) {
      activeModal.destroy?.();
      activeModal = null;
    }
  }

  // ---------------------------------------------------------------------------
  // DM sidebar builder (dms mode)
  // ---------------------------------------------------------------------------

  /**
   * Leave the DM list gracefully after a conversation goes away: fall back to
   * another DM if there is one, otherwise to the channel the user came from.
   */
  function fallBackFromDm(): void {
    const remaining = dmStore.getState().channels;
    if (remaining.length > 0) {
      selectDmConversation(remaining[0]!, dmDeps);
      return;
    }
    setSidebarMode("channels");
    if (channelBeforeDm !== null && channelsStore.getState().channels.has(channelBeforeDm)) {
      setActiveChannel(channelBeforeDm);
      return;
    }
    for (const ch of channelsStore.getState().channels.values()) {
      if (isTextLikeChannel(ch)) {
        setActiveChannel(ch.id);
        break;
      }
    }
  }

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
  function closeOrLeaveDm(channelId: number): void {
    const channels = dmStore.getState().channels;
    const index = channels.findIndex((c) => c.channelId === channelId);
    const removed = channels[index];
    // A closed 1:1 keeps its live call through a network blip; a group leave
    // does not (the server removes the leaver from the call).
    if (removed !== undefined && !removed.isGroup) keepDmForCall(channelId);
    closeDmLocally(channelId, fallBackFromDm);
    void api.closeDm(channelId).then(
      () => {
        // The leave committed: the server stops sending this room's voice
        // events, so drop the roster rather than let it go stale.
        if (removed?.isGroup === true) clearChannelVoiceUsers(channelId);
      },
      () => {
        releaseKeptDm(channelId);
        if (removed !== undefined) restoreDmChannel(removed, index);
        getToast()?.show(shellText("dm.leaveFailed"), "error");
      },
    );
  }

  /** Rename a group DM (participants only; the server refuses a 1:1). */
  function renameGroup(channelId: number): void {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm === undefined || !dm.isGroup) return;
    const prompt = createPromptModal({
      title: shellText("dm.renameGroup"),
      label: shellText("dm.renameGroupHint"),
      initialValue: dm.name,
      placeholder: shellText("dm.groupNamePlaceholder"),
      maxLength: MAX_GROUP_DM_NAME_LEN,
      hint: lineHintText(MAX_GROUP_DM_NAME_LEN),
      testId: "dm-rename-input",
      validate: (name) =>
        visibleLength(name) > MAX_GROUP_DM_NAME_LEN
          ? connectText("limits.groupNameTooLong", { max: MAX_GROUP_DM_NAME_LEN })
          : null,
      // The store is updated by the dm_channel_open the server fans out to
      // every participant, so the response is only used for the error path:
      // the server's refusal shows under the field and the typed name stays.
      onSubmit: (name) =>
        api
          .renameGroupDm(channelId, collapseSpaces(name))
          .then(() => null)
          .catch((err: unknown) => errorText(err, shellText("dm.renameFailed"))),
      onClose: () => {
        activePrompt = null;
      },
    });
    activePrompt = prompt;
  }

  /** Show a group icon failure; null means it worked and the dm_channel_open does the rest. */
  function showGroupIconResult(error: string | null): void {
    if (error !== null) getToast()?.show(error, "error");
  }

  /**
   * Pick, crop and upload a group's icon. The picker opens synchronously from
   * the menu click (WebKit refuses one opened after an await), on an input
   * that is attached to the page and removed on change or cancel; the crop and
   * upload code is imported only once a file is chosen. The store updates from
   * the dm_channel_open that follows.
   */
  function changeGroupIcon(channelId: number): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        input.remove();
        if (file === undefined) return;
        void import("../../features/direct-messages/groupIcon").then(
          async (icon) => showGroupIconResult(await icon.uploadGroupIcon(api, channelId, file)),
          () => showGroupIconResult(shellText("dm.iconFailed")),
        );
      },
      { once: true },
    );
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.click();
  }

  function removeGroupIconFor(channelId: number): void {
    void import("../../features/direct-messages/groupIcon").then(
      async (icon) => showGroupIconResult(await icon.removeGroupIcon(api, channelId)),
      () => showGroupIconResult(shellText("dm.iconFailed")),
    );
  }

  /**
   * Leave DM mode for the channel the user came from. The DM sidebar's back
   * arrow and a content view's Close/Escape both take this path.
   */
  function returnToChannel(): void {
    setSidebarMode("channels");
    const saved = channelBeforeDm;
    channelBeforeDm = null;
    if (saved !== null && channelsStore.getState().channels.has(saved)) {
      setActiveChannel(saved);
      return;
    }
    // No saved channel, or it was deleted. The former happens when DM mode
    // was entered without going through selectDmConversation (e.g.
    // SidebarDmSection's "View all messages" button, which does a bare
    // setSidebarMode). If a real
    // non-DM channel is already active, leave it alone instead of
    // silently jumping to the first text channel in Map order.
    const st = channelsStore.getState();
    const current = st.activeChannelId !== null ? st.channels.get(st.activeChannelId) : undefined;
    if (current !== undefined && current.type !== "dm") return;
    for (const ch of channelsStore.getState().channels.values()) {
      if (isTextLikeChannel(ch)) {
        setActiveChannel(ch.id);
        break;
      }
    }
  }

  /** Remember the channel on screen as the one returnToChannel goes back to. */
  function rememberChannel(): void {
    const st = channelsStore.getState();
    const current = st.activeChannelId !== null ? st.channels.get(st.activeChannelId) : undefined;
    if (current !== undefined && current.type !== "dm") channelBeforeDm = current.id;
  }

  /** Make `channelId` the active DM; false when it is no longer in the list. */
  function selectDm(channelId: number): boolean {
    const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dmChannel === undefined) return false;
    selectDmConversation(dmChannel, dmDeps);
    return true;
  }

  /** The DM row menu's actions, shared by the full list and the compact preview. */
  function dmMenuActions(): DmMenuActions {
    return {
      onCloseDm: (channelId) => closeOrLeaveDm(channelId),
      onToggleMute: (channelId) => {
        toggleChannelMute(channelId);
        // Mute state is not in a store, so nothing re-renders on its own.
        refreshDmSidebarRef?.();
      },
      onSetMute: (channelId, muted) => {
        if (muted) muteChannel(channelId);
        else unmuteChannel(channelId);
        refreshDmSidebarRef?.();
      },
      onMuteFor: (channelId, durationMs) => {
        muteChannel(channelId, durationMs);
        refreshDmSidebarRef?.();
      },
      onMarkRead: markChannelRead,
      onOpenProfile: (channelId) => {
        if (selectDm(channelId)) opts.onOpenDmProfile?.();
      },
      onCall: (channelId) => {
        if (selectDm(channelId)) opts.onStartCall?.();
      },
      onToggleBlock: (userId, username, block) => {
        void import("../../features/blocks/blockActions").then(
          ({ confirmAndToggleBlock }) =>
            confirmAndToggleBlock(
              { api, notify: (msg, type) => getToast()?.show(msg, type) },
              userId,
              username,
              block,
            ),
          () =>
            getToast()?.show(
              shellText(block ? "members.blockFailed" : "members.unblockFailed"),
              "error",
            ),
        );
      },
      onRenameGroup: (channelId) => renameGroup(channelId),
      onChangeGroupIcon: (channelId) => changeGroupIcon(channelId),
      onRemoveGroupIcon: (channelId) => removeGroupIconFor(channelId),
    };
  }

  function buildDmSidebar(): DmSidebar {
    const serverName = authStore.getState().serverName ?? shellText("common.serverFallback");
    const activeChannelId = channelsStore.getState().activeChannelId;
    const conversations = dmConversations(activeChannelId);

    return createDmSidebar({
      conversations,
      onSelectConversation: (channelId) => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        if (dmChannel !== undefined) {
          selectDmConversation(dmChannel, dmDeps);
        }
      },
      ...dmMenuActions(),
      onNewDm: () => {
        showMemberPicker();
      },
      onBack: returnToChannel,
      serverName,
    });
  }

  /** Call a user: open the DM first, then start the call in it. An
   *  existing DM is selected at once; a new one starts the call in
   *  `handleCreateDm`'s onReady, once it is the active channel `startCall`
   *  reads. */
  function callUser(userId: number): void {
    const existing = findDirectDm(userId);
    if (existing !== undefined) {
      selectDmConversation(existing, dmDeps);
      opts.onStartCall?.();
      return;
    }
    void handleCreateDm(userId, dmDeps, () => opts.onStartCall?.());
  }

  function buildMemberPanel(): MemberPanel {
    return createMemberPanel({
      ui: memberPanelUi,
      api,
      getToast,
      onMessageUser: (userId) => {
        void handleCreateDm(userId, dmDeps);
      },
      onCallUser: callUser,
      onVoiceModerate: createVoiceModerationCallbacks(ws),
    });
  }

  /** Create or destroy the left member section so it matches the mode and the
   *  stored layout. It appends to `contentSlot`, so the channel list above it
   *  keeps its DOM. */
  function syncMemberSection(): void {
    const wanted = uiStore.getState().sidebarMode === "channels" && loadMemberLayout() === "left";
    if (wanted && memberSection === null) {
      // The panel comes from the one factory every host shares, so the
      // callback wiring exists once.
      memberSection = createSidebarMemberSection({
        api,
        getToast,
        buildPanel: buildMemberPanel,
      });
      contentSlot.appendChild(memberSection.element);
    } else if (!wanted && memberSection !== null) {
      destroyMemberSection();
    }
  }

  function destroyMemberSection(): void {
    if (memberSection === null) return;
    const section = memberSection;
    memberSection = null;
    section.destroy();
    section.element.remove();
  }

  // ---------------------------------------------------------------------------
  // Mount sidebar content for current mode
  // ---------------------------------------------------------------------------

  function mountSidebarContent(mode: "channels" | "dms"): void {
    const contentHadFocus = contentSlot.contains(document.activeElement);
    // Tear down the existing content
    if (activeSidebarContent !== null) {
      activeSidebarContent.destroy?.();
      activeSidebarContent = null;
    }
    if (inviteCleanup !== null) {
      inviteCleanup();
      inviteCleanup = null;
    }
    // Clean up channel-mode extras (member list, subscriptions)
    for (const comp of channelModeExtras) {
      comp.destroy?.();
    }
    channelModeExtras = [];
    for (const unsub of channelModeUnsubs) {
      unsub();
    }
    channelModeUnsubs = [];
    destroyMemberSection();

    clearChildren(contentSlot);

    const innerSlot = createElement("div", { class: "sidebar-content-inner" });

    if (mode === "channels") {
      // --- DM section (above channels, below server header) ---
      // --- DM section (above channels, below server header) ---
      const dmSectionResult = createSidebarDmSection({
        pendingRequests: opts.destinations?.requests?.pending,
        onOpenRequests: (opener) => opts.onOpenView?.("requests", opener),
        onSelectDm: (dm) => {
          selectDmConversation(dm, dmDeps);
        },
        onNewDm: () => {
          showMemberPicker();
        },
        menu: dmMenuActions(),
      });
      channelModeUnsubs.push(() => {
        dmSectionResult.destroy();
      });

      // DM section goes first (above channels)
      contentSlot.appendChild(dmSectionResult.element);

      const channelSidebar = buildChannelSidebar();
      channelSidebar.mount(innerSlot);
      activeSidebarContent = channelSidebar;

      // Inject the channel sidebar content into contentSlot.
      contentSlot.appendChild(innerSlot);

      // --- Member list (below channels), only in the "left" layout ---
      syncMemberSection();
    } else {
      // "Message Requests (N)" at the top of DM mode. N is the
      // pending-request count and is never folded into unread.
      const requests = opts.destinations?.requests;
      if (requests !== undefined) {
        const section = createElement("div", { class: "dm-requests-section" });
        const entry = createElement("button", {
          type: "button",
          class: "sidebar-dm-view-all dm-requests-entry",
          "data-testid": "dm-requests-entry",
        });
        const renderEntry = (): void => {
          const count = requests.pending.get();
          setText(
            entry,
            count > 0
              ? navigationText("requests.entry", { count })
              : navigationText("requests.title"),
          );
        };
        renderEntry();
        entry.addEventListener("click", () => opts.onOpenView?.("requests", entry));
        channelModeUnsubs.push(requests.pending.subscribe(renderEntry));
        channelModeUnsubs.push(trackCurrentView(entry, "requests"));
        section.appendChild(entry);
        contentSlot.appendChild(section);
      }

      const dmSidebar = buildDmSidebar();
      dmSidebar.mount(innerSlot);
      activeSidebarContent = dmSidebar;
      contentSlot.appendChild(innerSlot);
      if (contentHadFocus) {
        contentSlot.querySelector<HTMLElement>("button, input, [tabindex='0']")?.focus();
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
      function refreshDmSidebar(): void {
        if (activeSidebarContent === null) return;
        const conversations = dmConversations(channelsStore.getState().activeChannelId);
        (activeSidebarContent as DmSidebar).update(conversations);
      }

      refreshDmSidebarRef = refreshDmSidebar;
      channelModeUnsubs.push(() => {
        refreshDmSidebarRef = null;
      });

      // Re-render DM sidebar when DM store changes (new DMs, message updates)
      const unsubDmStore = dmStore.subscribeSelector(
        (s) => s.channels,
        () => {
          refreshDmSidebar();
        },
      );
      channelModeUnsubs.push(unsubDmStore);

      // A mute toggled anywhere (context menu, Settings) is not in a store, so
      // the sidebar redraws from the mute store's own event (F16). Owned by a
      // per-mount Disposable so the listener's lifetime matches this mount.
      const muteOwner = new Disposable();
      window.addEventListener(CHANNEL_MUTE_CHANGED, () => refreshDmSidebar(), {
        signal: muteOwner.signal,
      });
      channelModeUnsubs.push(() => muteOwner.destroy());

      // The live-call glyph follows who is in each DM's voice channel.
      channelModeUnsubs.push(
        voiceStore.subscribeSelector(
          // Occupied channels only: a speaking tick replaces voiceUsers too,
          // and must not re-render the list.
          (s) =>
            [...s.voiceUsers]
              .filter(([, users]) => users.size > 0)
              .map(([id]) => id)
              .join(","),
          () => {
            refreshDmSidebar();
          },
        ),
      );

      // Re-render DM sidebar when the active conversation changes. Keyed on the
      // active channel rather than activeDmUserId, which a group DM leaves null.
      const unsubDmActive = channelsStore.subscribeSelector(
        (s) => s.activeChannelId,
        () => {
          refreshDmSidebar();
        },
      );
      channelModeUnsubs.push(unsubDmActive);
    }
  }

  // Initial mount based on current store state
  const initialMode = uiStore.getState().sidebarMode;
  mountSidebarContent(initialMode);

  // Subscribe to sidebar mode changes
  const unsubSidebarMode = uiStore.subscribeSelector(
    (s) => s.sidebarMode,
    (mode) => {
      mountSidebarContent(mode);
    },
  );
  unsubscribers.push(unsubSidebarMode);

  // ---------------------------------------------------------------------------
  // Voice widget (always visible)
  // ---------------------------------------------------------------------------

  const voiceWidgetSlot = createElement("div", {});
  const { onDisconnect, onCameraToggle, onScreenshareToggle } = createVoiceWidgetCallbacks(
    ws,
    limiters,
  );
  const voiceWidgetOptions: VoiceWidgetOptions = {
    onDisconnect,
    onCameraToggle,
    onScreenshareToggle,
    onOpenCall: (channelId) => {
      const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
      if (dm !== undefined) {
        selectDmConversation(dm, dmDeps);
        return;
      }
      // A guild voice channel: back to the server view, then its call, the
      // same as clicking the joined channel in the sidebar.
      if (uiStore.getState().sidebarMode === "channels") {
        opts.onOpenCall?.();
        return;
      }
      returnToChannel();
      // After the channel switch's store notification, which shows that
      // channel's chat and would close a call view opened before it.
      queueMicrotask(() => opts.onOpenCall?.());
    },
  };
  sidebarWrapper.appendChild(voiceWidgetSlot);

  // The widget subscribes to the store when it mounts and renders the current
  // state, so a late mount shows a session that is already under way. It stays
  // mounted once loaded: it hides itself when the user is not in voice.
  // One loader per sidebar; the browser's module cache shares the code itself.
  const voiceWidgetScreen = createLazyScreen(
    "voice-widget",
    () => import("@components/VoiceWidget"),
  );
  let voiceWidgetRequested = false;
  // Not in `children`: the page copies that list at build, before this loads.
  let voiceWidget: MountableComponent | null = null;
  function loadVoiceWidget(): void {
    if (voiceWidgetRequested || tornDown) return;
    voiceWidgetRequested = true;
    void voiceWidgetScreen
      .load(() => !tornDown)
      .then((mod) => {
        if (mod === null) {
          // Failed (toasted once by the loader): the next voice change retries.
          voiceWidgetRequested = false;
          return;
        }
        if (tornDown) return;
        voiceWidget = mod.createVoiceWidget(voiceWidgetOptions);
        voiceWidget.mount(voiceWidgetSlot);
        return;
      });
  }
  unsubscribers.push(
    voiceStore.subscribeSelector(
      (state) => state.currentChannelId,
      (channelId) => {
        // A channel switch retries a failed load too.
        if (channelId !== null) loadVoiceWidget();
      },
    ),
  );
  // autoJoin can set the channel before this sidebar is built.
  if (voiceStore.getState().currentChannelId !== null) loadVoiceWidget();

  // ---------------------------------------------------------------------------
  // Quick-switch overlay
  // ---------------------------------------------------------------------------

  function openQuickSwitch(): void {
    if (quickSwitchInstance !== null || openingQuickSwitch) return;
    openingQuickSwitch = true;

    const currentHost = api.getConfig().host ?? "";

    // Load profiles asynchronously, then show overlay
    void (async () => {
      try {
        let profiles: readonly QuickSwitchProfile[];

        try {
          if (profileManager === null) {
            profileManager = createProfileManager(createTauriBackend());
          }
          await profileManager.loadProfiles();
          profiles = profileManager.getAll().map((p) => ({
            name: p.name,
            host: p.host,
          }));
        } catch (err) {
          log.warn("Failed to load profiles for quick-switch", err);
          profiles = [];
        }

        // Ensure we haven't been cleaned up while awaiting
        if (tornDown) return;

        quickSwitchInstance = createQuickSwitchOverlay({
          profiles,
          currentHost,
          onSwitch: (host, _name) => {
            closeQuickSwitch();
            switchToServer(host);
          },
          onAddServer: () => {
            closeQuickSwitch();
            addServer();
          },
          onClose: closeQuickSwitch,
        });
        quickSwitchInstance.mount(document.body);
      } finally {
        openingQuickSwitch = false;
      }
    })();
  }

  function closeQuickSwitch(): void {
    if (quickSwitchInstance !== null) {
      quickSwitchInstance.destroy?.();
      quickSwitchInstance = null;
    }
  }

  // ---------------------------------------------------------------------------
  // User bar (always visible, with disconnect wired)
  // ---------------------------------------------------------------------------

  const userBarSlot = createElement("div", {});
  const selfVoiceCallbacks = createVoiceWidgetCallbacks(ws, limiters);
  const userBar = createUserBar({
    // The portal serves one server: the button signs out, nothing to switch to.
    onDisconnect: __OWNCORD_WEB__ ? () => logout(api) : openQuickSwitch,
    ws,
    presenceSender,
    onMuteToggle: selfVoiceCallbacks.onMuteToggle,
    onDeafenToggle: selfVoiceCallbacks.onDeafenToggle,
  });
  userBar.mount(userBarSlot);
  children.push(userBar);
  sidebarWrapper.appendChild(userBarSlot);

  // ---------------------------------------------------------------------------
  // Cleanup for active modal
  // ---------------------------------------------------------------------------

  unsubscribers.push(() => {
    if (activeModal !== null) {
      activeModal.destroy?.();
      activeModal = null;
    }
  });

  unsubscribers.push(() => {
    if (activePrompt !== null) {
      activePrompt.destroy();
      activePrompt = null;
    }
  });

  unsubscribers.push(() => {
    if (activeSidebarContent !== null) {
      activeSidebarContent.destroy?.();
      activeSidebarContent = null;
    }
    if (inviteCleanup !== null) {
      inviteCleanup();
      inviteCleanup = null;
    }
    for (const comp of channelModeExtras) {
      comp.destroy?.();
    }
    channelModeExtras = [];
    for (const unsub of channelModeUnsubs) {
      unsub();
    }
    channelModeUnsubs = [];
    destroyMemberSection();
  });

  unsubscribers.push(() => {
    tornDown = true;
    voiceWidget?.destroy?.();
    voiceWidget = null;
    closeQuickSwitch();
  });

  return {
    sidebarWrapper,
    children,
    unsubscribers,
    openQuickSwitch,
    rememberChannel,
    forgetChannel: () => {
      channelBeforeDm = null;
    },
    returnToChannel,
    messageUser: (userId) => void handleCreateDm(userId, dmDeps),
    openDm: (dm) => selectDmConversation(dm, dmDeps),
    buildMemberPanel,
    syncMemberSection,
    renameGroup,
  };
}
