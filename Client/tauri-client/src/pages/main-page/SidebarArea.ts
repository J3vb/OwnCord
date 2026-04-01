/**
 * SidebarArea — unified sidebar DOM construction and component wiring.
 * Composes a server header, ChannelSidebar or DmSidebar (based on store mode),
 * VoiceWidget, and UserBar. The ServerStrip has been removed in favor of the
 * unified sidebar layout with a quick-switch overlay for server switching.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { RateLimiterSet } from "@lib/rate-limiter";
import type { ToastContainer } from "@components/Toast";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createMemberList } from "@components/MemberList";
import { createDmSidebar } from "@components/DmSidebar";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import type { QuickSwitchProfile } from "@components/QuickSwitchOverlay";
import { createVoiceWidgetCallbacks, createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { createInviteManagerController } from "./OverlayManagers";
import {
  selectDmConversation,
  handleCreateDm,
  buildDmConversations,
  type DmHelperDeps,
} from "./SidebarDmHelpers";
import { createSidebarDmSection } from "./SidebarDmSection";
import { uiStore, setSidebarMode, loadCollapsedCategories } from "@stores/ui.store";
import { authStore, clearAuth } from "@stores/auth.store";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import { channelsStore, setActiveChannel, getRoleIdByName } from "@stores/channels.store";
import { dmStore, removeDmChannel } from "@stores/dm.store";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
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
        const modal = createEditChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          onSave: async (data) => {
            try {
              await api.adminUpdateChannel(channel.id, data);
              modal.destroy?.();
              activeModal = null;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to update channel";
              getToast()?.show(msg, "error");
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
        for (const r of reorders) {
          void api.adminUpdateChannel(r.channelId, { position: r.newPosition });
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

  /** Show a simple member picker modal and call createDm on selection. */
  function showMemberPicker(): void {
    if (activeModal !== null) return;

    const members = membersStore.getState().members;
    const currentUserId = authStore.getState().user?.id ?? 0;

    const overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", {
      class: "modal dm-member-picker-modal",
      style: "padding:20px;",
    });
    const title = createElement("h3", {}, "New Direct Message");
    const subtitle = createElement(
      "p",
      { style: "color:var(--text-secondary);font-size:0.85rem;margin:0 0 8px;" },
      "Select a member to start a conversation",
    );
    const listContainer = createElement("div", {
      class: "dm-member-picker-list",
      style: "max-height:300px;overflow-y:auto;",
    });

    for (const member of members.values()) {
      if (member.id === currentUserId) continue;
      const item = createElement("div", {
        class: "dm-member-picker-item channel-item",
        style: "cursor:pointer;padding:6px 8px;display:flex;align-items:center;gap:8px;",
      });
      const avatar = createElement("div", {
        class: "dm-avatar",
        style:
          "width:28px;height:28px;border-radius:50%;background:#5865F2;display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:white;flex-shrink:0;",
      });
      setText(avatar, member.username.charAt(0).toUpperCase());
      const nameEl = createElement("span", {}, member.username);
      const statusEl = createElement(
        "span",
        {
          style: `font-size:0.75rem;margin-left:auto;color:${member.status === "online" ? "var(--green)" : "var(--text-micro)"};`,
        },
        member.status,
      );
      appendChildren(item, avatar, nameEl, statusEl);

      item.addEventListener("click", () => {
        closePickerModal();
        void handleCreateDm(member.id, dmDeps);
      });
      listContainer.appendChild(item);
    }

    const cancelBtn = createElement(
      "button",
      {
        class: "btn btn-secondary",
        style: "margin-top:12px;width:100%;",
      },
      "Cancel",
    );
    cancelBtn.addEventListener("click", () => closePickerModal());

    appendChildren(modal, title, subtitle, listContainer, cancelBtn);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closePickerModal();
    });

    const pickerComponent: MountableComponent = {
      mount: (container: Element) => {
        container.appendChild(overlay);
      },
      destroy: () => {
        overlay.remove();
      },
    };

    activeModal = pickerComponent;
    pickerComponent.mount(document.body);
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

  function buildDmSidebar(): MountableComponent {
    const serverName = authStore.getState().serverName ?? "Server";
    const activeDmUserId = uiStore.getState().activeDmUserId;
    const dmChannels = dmStore.getState().channels;
    const conversations = buildDmConversations(activeDmUserId);

    return createDmSidebar({
      conversations,
      onSelectConversation: (userId) => {
        const dmChannel = dmChannels.find((c) => c.recipient.id === userId);
        if (dmChannel !== undefined) {
          selectDmConversation(dmChannel, dmDeps);
        }
      },
      onCloseDm: (userId) => {
        const dmChannel = dmChannels.find((c) => c.recipient.id === userId);
        if (dmChannel !== undefined) {
          const wasActive = channelsStore.getState().activeChannelId === dmChannel.channelId;
          removeDmChannel(dmChannel.channelId);
          void api.closeDm(dmChannel.channelId);

          if (wasActive) {
            const remaining = dmStore.getState().channels;
            if (remaining.length > 0) {
              selectDmConversation(remaining[0]!, dmDeps);
            } else {
              setSidebarMode("channels");
              if (channelBeforeDm !== null) {
                setActiveChannel(channelBeforeDm);
              } else {
                const channels = channelsStore.getState().channels;
                for (const ch of channels.values()) {
                  if (ch.type === "text") {
                    setActiveChannel(ch.id);
                    break;
                  }
                }
              }
            }
          }
        }
      },
      onNewDm: () => {
        showMemberPicker();
      },
      onBack: () => {
        setSidebarMode("channels");
        if (channelBeforeDm !== null) {
          setActiveChannel(channelBeforeDm);
          channelBeforeDm = null;
        } else {
          const channels = channelsStore.getState().channels;
          for (const ch of channels.values()) {
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
      const memberListContainer = createElement("div", {
        class: "sidebar-members-section",
        "data-testid": "sidebar-members",
      });

      // Member header (styled like category headers)
      const memberHeader = createElement("div", { class: "category sidebar-members-header" });
      const memberArrow = createElement("span", { class: "category-arrow" }, "\u25BC");
      const memberLabelEl = createElement("span", { class: "category-name" }, "MEMBERS");
      appendChildren(memberHeader, memberArrow, memberLabelEl);
      memberListContainer.appendChild(memberHeader);

      // Resize handle
      const resizeHandle = createElement("div", { class: "sidebar-resize-handle" });
      memberListContainer.appendChild(resizeHandle);

      // Restore saved height
      const savedHeight = localStorage.getItem("owncord:member-list-height");
      if (savedHeight !== null) {
        memberListContainer.style.height = `${savedHeight}px`;
      }

      // Drag-to-resize logic
      const resizeAbort = new AbortController();
      let isDragging = false;
      let startY = 0;
      let startHeight = 0;

      resizeHandle.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          isDragging = true;
          startY = e.clientY;
          startHeight = memberListContainer.offsetHeight;
          e.preventDefault();
        },
        { signal: resizeAbort.signal },
      );

      document.addEventListener(
        "mousemove",
        (e: MouseEvent) => {
          if (!isDragging) return;
          const delta = startY - e.clientY;
          const maxH = window.innerHeight * 0.65;
          const newHeight = Math.max(80, Math.min(startHeight + delta, maxH));
          memberListContainer.style.height = `${newHeight}px`;
        },
        { signal: resizeAbort.signal },
      );

      document.addEventListener(
        "mouseup",
        () => {
          if (!isDragging) return;
          isDragging = false;
          localStorage.setItem(
            "owncord:member-list-height",
            String(memberListContainer.offsetHeight),
          );
        },
        { signal: resizeAbort.signal },
      );

      channelModeUnsubs.push(() => {
        resizeAbort.abort();
      });

      // Restore collapsed state from localStorage
      const savedCollapsed = localStorage.getItem("owncord:member-list-collapsed");
      let membersCollapsed = savedCollapsed === "true";
      const memberContent = createElement("div", { class: "sidebar-members-content" });

      function applyMembersCollapsed(): void {
        memberHeader.classList.toggle("collapsed", membersCollapsed);
        memberArrow.textContent = membersCollapsed ? "\u25B6" : "\u25BC";
        memberContent.style.display = membersCollapsed ? "none" : "";
        resizeHandle.style.display = membersCollapsed ? "none" : "";
        if (membersCollapsed) {
          memberListContainer.style.height = "auto";
        } else {
          const h = localStorage.getItem("owncord:member-list-height");
          if (h !== null) {
            memberListContainer.style.height = `${h}px`;
          } else {
            memberListContainer.style.height = "";
          }
        }
      }

      // Apply initial state
      applyMembersCollapsed();

      memberHeader.addEventListener("click", () => {
        membersCollapsed = !membersCollapsed;
        localStorage.setItem("owncord:member-list-collapsed", String(membersCollapsed));
        applyMembersCollapsed();
      });

      const memberList = createMemberList({
        currentUserRole: authStore.getState().user?.role ?? "member",
        onKick: async (userId, username) => {
          try {
            await api.adminKickMember(userId);
            getToast()?.show(`Kicked ${username}`, "success");
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to kick member";
            getToast()?.show(msg, "error");
          }
        },
        onBan: async (userId, username) => {
          try {
            await api.adminBanMember(userId);
            getToast()?.show(`Banned ${username}`, "success");
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to ban member";
            getToast()?.show(msg, "error");
          }
        },
        onChangeRole: async (userId, username, newRole) => {
          const roleId = getRoleIdByName(newRole);
          if (roleId === undefined) return;
          try {
            await api.adminChangeRole(userId, roleId);
            getToast()?.show(`Changed ${username}'s role to ${newRole}`, "success");
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to change role";
            getToast()?.show(msg, "error");
          }
        },
      });
      memberList.mount(memberContent);
      memberListContainer.appendChild(memberContent);
      contentSlot.appendChild(memberListContainer);
      channelModeExtras.push(memberList);
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

      // Re-render DM sidebar when DM store changes (new DMs, message updates)
      const unsubDmStore = dmStore.subscribeSelector(
        (s) => s.channels,
        () => {
          refreshDmSidebar();
        },
      );
      channelModeUnsubs.push(unsubDmStore);

      // Re-render DM sidebar when active DM user changes
      const unsubDmActive = uiStore.subscribeSelector(
        (s) => s.activeDmUserId,
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
    if (quickSwitchInstance !== null) return;

    const currentHost = api.getConfig().host ?? "";

    // Load profiles asynchronously, then show overlay
    void (async () => {
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
  const userBar = createUserBar({ onDisconnect: openQuickSwitch });
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
