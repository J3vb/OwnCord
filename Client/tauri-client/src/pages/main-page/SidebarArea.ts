/**
 * SidebarArea — unified sidebar DOM construction and component wiring.
 * Composes a server header, ChannelSidebar or DmSidebar (based on store mode),
 * VoiceWidget, and UserBar. The ServerStrip has been removed in favor of the
 * unified sidebar layout with a quick-switch overlay for server switching.
 */

import { createElement, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { RateLimiterSet } from "@lib/rate-limiter";
import type { ToastContainer } from "@components/Toast";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import type { QuickSwitchProfile } from "@components/QuickSwitchOverlay";
import {
  createVoiceWidgetCallbacks,
  createSidebarVoiceCallbacks,
  createVoiceModerationCallbacks,
} from "./VoiceCallbacks";
import { createSidebarMemberSection } from "./SidebarMemberSection";
import { createInviteManagerController } from "./OverlayManagers";
import {
  selectDmConversation,
  handleCreateDm,
  handleCreateGroupDm,
  buildDmConversations,
  type DmHelperDeps,
} from "./SidebarDmHelpers";
import { createMemberPickerModal } from "./MemberPickerModal";
import { createPromptModal } from "@lib/modalFactory";
import type { ModalInstance } from "@lib/modalFactory";
import { toggleChannelMute } from "@lib/channel-mutes";
import { createSidebarDmSection } from "./SidebarDmSection";
import { uiStore, setSidebarMode, loadCollapsedCategories } from "@stores/ui.store";
import { authStore, clearAuth } from "@stores/auth.store";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { dmStore, closeDmLocally } from "@stores/dm.store";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
import { openAdminPanel } from "@lib/admin-panel";
import { canViewAuditLog } from "@lib/permissions";
import type { ProfileManager } from "@lib/profiles";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarAreaOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly limiters: RateLimiterSet;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
  readonly onWatchStream?: (userId: number) => void;
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarArea(opts: SidebarAreaOptions): SidebarAreaResult {
  const { ws, api, limiters, getRoot, getToast } = opts;

  const children: MountableComponent[] = [];
  const unsubscribers: Array<() => void> = [];

  // Track active modal for channel create/edit/delete
  let activeModal: MountableComponent | null = null;

  // Remember the channel the user was on before entering DM mode
  let channelBeforeDm: number | null = null;

  // Track the currently mounted sidebar content component
  let activeSidebarContent: MountableComponent | null = null;

  // Track invite controller cleanup (recreated on each channels mount)
  let inviteCleanup: (() => void) | null = null;

  // Track extra channel-mode components (member list) for cleanup on mode switch
  let channelModeExtras: MountableComponent[] = [];
  let channelModeUnsubs: Array<() => void> = [];

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
    "data-testid": "unified-sidebar",
  });

  // ---------------------------------------------------------------------------
  // Server header
  // ---------------------------------------------------------------------------

  const serverHeader = createElement("div", { class: "unified-sidebar-header" });
  const serverIcon = createElement("div", { class: "server-icon-sm" }, "OC");
  const serverInfoCol = createElement("div", {
    style: "display:flex;flex-direction:column;overflow:hidden;",
  });
  const serverNameEl = createElement(
    "span",
    { class: "server-name" },
    authStore.getState().serverName ?? "Server",
  );
  const onlineCount = getOnlineMembers().length;
  const serverOnlineEl = createElement("span", { class: "server-online" }, `${onlineCount} online`);
  serverInfoCol.appendChild(serverNameEl);
  serverInfoCol.appendChild(serverOnlineEl);
  serverHeader.appendChild(serverIcon);
  serverHeader.appendChild(serverInfoCol);

  // Invite button in the server header (proper styled button)
  const headerInviteCtrl = createInviteManagerController({ api, getRoot });
  const headerInviteBtn = createElement(
    "button",
    {
      class: "sidebar-invite-btn",
      title: "Invite people",
      "data-testid": "invite-btn",
    },
    "Invite",
  );
  headerInviteBtn.addEventListener("click", () => {
    void headerInviteCtrl.open();
  });
  serverHeader.appendChild(headerInviteBtn);
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
  const auditBtn = createElement(
    "button",
    {
      class: "sidebar-audit-btn",
      title: "Open the audit log in the admin panel (opens in your browser)",
      "data-testid": "audit-log-btn",
    },
    "Audit Log",
  );
  auditBtn.addEventListener("click", () => {
    const host = api.getConfig().host ?? "";
    if (host === "") {
      getToast()?.show("Not connected to a server", "error");
      return;
    }
    void openAdminPanel(host, "audit").catch(() => {
      getToast()?.show("Could not open the admin panel", "error");
    });
  });

  const syncAuditBtn = (): void => {
    auditBtn.style.display = canViewAuditLog() ? "" : "none";
  };
  syncAuditBtn();
  serverHeader.appendChild(auditBtn);
  // The permission is derived from the signed-in user's role plus the role
  // list, so both have to be watched.
  unsubscribers.push(
    authStore.subscribeSelector(
      (s) => s.user?.role ?? null,
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

  // Load per-server collapsed category state from localStorage
  const initialServerName = authStore.getState().serverName ?? "Server";
  loadCollapsedCategories(initialServerName);

  // Keep server name in sync with auth store
  const unsubServerName = authStore.subscribeSelector(
    (s) => s.serverName,
    (name) => {
      setText(serverNameEl, name ?? "Server");
    },
  );
  unsubscribers.push(unsubServerName);

  // Keep online count in sync with members store
  const unsubOnlineCount = membersStore.subscribeSelector(
    (s) => s.members,
    () => {
      const count = getOnlineMembers().length;
      setText(serverOnlineEl, `${count} online`);
    },
  );
  unsubscribers.push(unsubOnlineCount);

  // ---------------------------------------------------------------------------
  // Switchable content slot
  // ---------------------------------------------------------------------------

  const contentSlot = createElement("div", {
    style: "flex:1;display:flex;flex-direction:column;overflow:hidden;",
  });
  sidebarWrapper.appendChild(contentSlot);

  // ---------------------------------------------------------------------------
  // Channel sidebar builder (channels mode)
  // ---------------------------------------------------------------------------

  function buildChannelSidebar(): MountableComponent {
    const sidebarVoice = createSidebarVoiceCallbacks(ws);
    return createChannelSidebar({
      onVoiceJoin: sidebarVoice.onVoiceJoin,
      onVoiceLeave: sidebarVoice.onVoiceLeave,
      onVoiceModerate: createVoiceModerationCallbacks(ws),
      onWatchStream: opts.onWatchStream,
      onCreateChannel: (category) => {
        if (activeModal !== null) return;
        const modal = createCreateChannelModal({
          category,
          onCreate: async (data) => {
            try {
              await api.adminCreateChannel(data);
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to create channel";
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
      },
      onEditChannel: (channel) => {
        if (activeModal !== null) return;
        // Pre-fill from the store rather than from the sidebar's row: the store
        // is what channel_update writes into, so the modal opens on the current
        // values even if the row was rendered before the last edit landed.
        const stored = channelsStore.getState().channels.get(channel.id);
        const modal = createEditChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          channelTopic: stored?.topic ?? "",
          channelCategory: stored?.category ?? "",
          channelSlowMode: stored?.slowMode ?? 0,
          channelNsfw: stored?.nsfw ?? false,
          channelVoiceMaxUsers: stored?.voiceMaxUsers ?? 0,
          channelVoiceMaxVideo: stored?.voiceMaxVideo ?? 0,
          onSave: async (data) => {
            try {
              await api.adminUpdateChannel(channel.id, data);
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to update channel";
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
              const msg = err instanceof Error ? err.message : "Failed to delete channel";
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
      onReorderChannel: (reorders) => {
        // The store already applied the optimistic order (drag-reorder.ts,
        // on mouseup). Aggregate the per-channel PATCHes and surface a single
        // failure toast — same try/catch+toast contract as onSave/onDelete
        // above — instead of a bare `void` per call, which left a rejected or
        // failed write unreported and the sidebar showing an order the
        // server never accepted.
        void Promise.allSettled(
          reorders.map((r) => api.adminUpdateChannel(r.channelId, { position: r.newPosition })),
        ).then((results) => {
          if (results.some((r) => r.status === "rejected")) {
            getToast()?.show("Failed to save channel order", "error");
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
              ? `No messages to purge in #${channel.name}`
              : `Purged ${result.count} message${result.count === 1 ? "" : "s"} from #${channel.name}`,
            result.count === 0 ? "info" : "success",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to purge messages";
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

    const picker = createMemberPickerModal({
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
    if (channelBeforeDm !== null) {
      setActiveChannel(channelBeforeDm);
      return;
    }
    for (const ch of channelsStore.getState().channels.values()) {
      if (ch.type === "text") {
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
   * list" — the row is removed optimistically because the request is a
   * fire-and-forget one whose failure the sidebar cannot usefully recover from
   * (the next `ready` restores the truth either way).
   */
  function closeOrLeaveDm(channelId: number): void {
    closeDmLocally(channelId, fallBackFromDm);
    void api.closeDm(channelId).catch(() => {
      getToast()?.show("Could not leave that conversation", "error");
    });
  }

  /** Rename a group DM (participants only; the server refuses a 1:1). */
  function renameGroup(channelId: number): void {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm === undefined || !dm.isGroup) return;
    const prompt = createPromptModal({
      title: "Rename Group",
      label: "Leave it empty to go back to listing the members.",
      initialValue: dm.name,
      placeholder: "Group name",
      maxLength: 100,
      testId: "dm-rename-input",
      onSubmit: (name) => {
        // The store is updated by the dm_channel_open the server fans out to
        // every participant, so the response is only used for the error path.
        void api.renameGroupDm(channelId, name).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "Failed to rename group";
          getToast()?.show(msg, "error");
        });
      },
      onClose: () => {
        activePrompt = null;
      },
    });
    activePrompt = prompt;
  }

  function buildDmSidebar(): MountableComponent {
    const serverName = authStore.getState().serverName ?? "Server";
    const activeChannelId = channelsStore.getState().activeChannelId;
    const dmChannels = dmStore.getState().channels;
    const conversations = buildDmConversations(activeChannelId);

    return createDmSidebar({
      conversations,
      onSelectConversation: (channelId) => {
        const dmChannel = dmChannels.find((c) => c.channelId === channelId);
        if (dmChannel !== undefined) {
          selectDmConversation(dmChannel, dmDeps);
        }
      },
      onCloseDm: (channelId) => closeOrLeaveDm(channelId),
      onToggleMute: (channelId) => {
        toggleChannelMute(channelId);
        // Mute state is not in a store, so nothing re-renders on its own.
        refreshDmSidebarRef?.();
      },
      onRenameGroup: (channelId) => renameGroup(channelId),
      onNewDm: () => {
        showMemberPicker();
      },
      onBack: () => {
        setSidebarMode("channels");
        if (channelBeforeDm !== null) {
          setActiveChannel(channelBeforeDm);
          channelBeforeDm = null;
        } else {
          for (const ch of channelsStore.getState().channels.values()) {
            if (ch.type === "text") {
              setActiveChannel(ch.id);
              break;
            }
          }
        }
      },
      serverName,
    });
  }

  // ---------------------------------------------------------------------------
  // Mount sidebar content for current mode
  // ---------------------------------------------------------------------------

  function mountSidebarContent(mode: "channels" | "dms"): void {
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

    clearChildren(contentSlot);

    const innerSlot = createElement("div", {
      style: "flex:1;overflow:hidden;display:flex;flex-direction:column;",
    });

    if (mode === "channels") {
      // --- DM section (above channels, below server header) ---
      // --- DM section (above channels, below server header) ---
      const dmSectionResult = createSidebarDmSection({
        onSelectDm: (dm) => {
          selectDmConversation(dm, dmDeps);
        },
        onNewDm: () => {
          showMemberPicker();
        },
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

      // Hide the redundant channel-sidebar-header (server name + invite are now in the unified header)
      const oldSidebarHeader = innerSlot.querySelector(".channel-sidebar-header");
      if (oldSidebarHeader !== null) {
        (oldSidebarHeader as HTMLElement).style.display = "none";
      }

      // --- Member list (below DM section) ---
      // Same wiring lives in SidebarMemberSection; this used to be a private
      // copy of it, and a fix to one silently missed the other.
      const memberSection = createSidebarMemberSection({
        api,
        getToast,
        onMessageUser: (userId) => {
          void handleCreateDm(userId, dmDeps);
        },
      });
      contentSlot.appendChild(memberSection.element);
      channelModeExtras.push(memberSection.memberListComponent);
      channelModeUnsubs.push(memberSection.destroy);
    } else {
      const dmSidebar = buildDmSidebar();
      dmSidebar.mount(innerSlot);
      activeSidebarContent = dmSidebar;
      contentSlot.appendChild(innerSlot);

      /**
       * Re-render the DM sidebar from fresh store data.
       *
       * TODO(H16): This is an O(n) DOM thrash — it destroys and recreates the
       * entire DM sidebar on every store change. For a small number of DMs this
       * is acceptable, but should be optimized to diff/patch individual DM items
       * once the DM list grows or store updates become more frequent.
       */
      function refreshDmSidebar(): void {
        if (activeSidebarContent !== null) {
          activeSidebarContent.destroy?.();
        }
        clearChildren(contentSlot);
        const freshSlot = createElement("div", {
          style: "flex:1;overflow:hidden;display:flex;flex-direction:column;",
        });
        const freshDm = buildDmSidebar();
        freshDm.mount(freshSlot);
        activeSidebarContent = freshDm;
        contentSlot.appendChild(freshSlot);
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
  const voiceWidget = createVoiceWidget(createVoiceWidgetCallbacks(ws, limiters));
  voiceWidget.mount(voiceWidgetSlot);
  children.push(voiceWidget);
  sidebarWrapper.appendChild(voiceWidgetSlot);

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
        } catch {
          // If profiles fail to load (e.g., outside Tauri), show empty list
          profiles = [];
        }

        // Ensure we haven't been cleaned up while awaiting
        if (sidebarWrapper.parentElement === null) return;

        quickSwitchInstance = createQuickSwitchOverlay({
          profiles,
          currentHost,
          onSwitch: (host, _name) => {
            closeQuickSwitch();
            // Store target for ConnectPage to auto-select after navigation
            sessionStorage.setItem("owncord:quick-switch-target", host);
            // Trigger normal logout flow (clears auth -> ws disconnect -> navigate to connect)
            clearAuth();
          },
          onAddServer: () => {
            closeQuickSwitch();
            // Navigate to ConnectPage so the user can add a new server
            clearAuth();
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
  const userBar = createUserBar({ onDisconnect: openQuickSwitch, ws });
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
  });

  unsubscribers.push(() => {
    closeQuickSwitch();
  });

  return {
    sidebarWrapper,
    children,
    unsubscribers,
    openQuickSwitch,
  };
}
