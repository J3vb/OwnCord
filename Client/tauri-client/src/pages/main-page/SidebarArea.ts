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
import { createDmSidebar, type DmConversation } from "@components/DmSidebar";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import type { QuickSwitchProfile } from "@components/QuickSwitchOverlay";
import { createVoiceWidgetCallbacks, createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { createInviteManagerController } from "./OverlayManagers";
import { uiStore, setSidebarMode, setActiveDmUser, loadCollapsedCategories } from "@stores/ui.store";
import { authStore, clearAuth } from "@stores/auth.store";
import { membersStore, getOnlineMembers } from "@stores/members.store";
import {
  createProfileManager,
  createTauriBackend,
} from "@lib/profiles";
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
  }) as HTMLDivElement;

  // ---------------------------------------------------------------------------
  // Server header
  // ---------------------------------------------------------------------------

  const serverHeader = createElement("div", { class: "unified-sidebar-header" });
  const serverIcon = createElement("div", { class: "server-icon-sm" }, "OC");
  const serverInfoCol = createElement("div", { style: "display:flex;flex-direction:column;overflow:hidden;" });
  const serverNameEl = createElement("span", { class: "server-name" },
    authStore.getState().serverName ?? "Server",
  );
  const onlineCount = getOnlineMembers().length;
  const serverOnlineEl = createElement("span", { class: "server-online" },
    `${onlineCount} online`,
  );
  serverInfoCol.appendChild(serverNameEl);
  serverInfoCol.appendChild(serverOnlineEl);
  serverHeader.appendChild(serverIcon);
  serverHeader.appendChild(serverInfoCol);
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
  // DM sidebar builder (dms mode)
  // ---------------------------------------------------------------------------

  function buildDmSidebar(): MountableComponent {
    const serverName = authStore.getState().serverName ?? "Server";
    const currentUserId = authStore.getState().user?.id ?? null;
    const activeDmUserId = uiStore.getState().activeDmUserId;

    // Build DM conversations from online members (excluding the current user).
    // Since the channel data model doesn't have a distinct DM channel type yet,
    // we list online members as potential DM targets.
    const onlineMembers = getOnlineMembers();
    const conversations: readonly DmConversation[] = onlineMembers
      .filter((m) => m.id !== currentUserId)
      .map((m) => ({
        userId: m.id,
        username: m.username,
        avatar: m.avatar,
        status: m.status,
        lastMessage: "No messages yet",
        timestamp: "",
        unread: false,
        active: m.id === activeDmUserId,
      }));

    return createDmSidebar({
      conversations,
      onSelectConversation: (userId) => {
        setActiveDmUser(userId);
        setSidebarMode("dms");
      },
      onNewDm: () => {
        // Placeholder — DM creation flow comes later
      },
      onBack: () => {
        setSidebarMode("channels");
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

    const innerSlot = createElement("div", { style: "flex:1;overflow:hidden;display:flex;flex-direction:column;" });

    if (mode === "channels") {
      const channelSidebar = buildChannelSidebar();
      channelSidebar.mount(innerSlot);
      activeSidebarContent = channelSidebar;

      // Inject the channel sidebar content into contentSlot.
      // createChannelSidebar mounts a .channel-sidebar root inside innerSlot.
      // We want that root's children to live inside our content area, but
      // the ChannelSidebar owns its own root element so we keep it nested.
      contentSlot.appendChild(innerSlot);

      // Wire up the invite button into the channel sidebar header
      const sidebarHeader = innerSlot.querySelector(".channel-sidebar-header");
      if (sidebarHeader !== null) {
        const inviteCtrl = createInviteManagerController({
          api,
          getRoot,
          getToast,
        });
        const inviteBtn = createElement("button", {
          class: "invite-btn",
          title: "Invite",
        }, "Invite");
        inviteBtn.addEventListener("click", () => {
          void inviteCtrl.open();
        });
        sidebarHeader.appendChild(inviteBtn);
        inviteCleanup = () => { inviteCtrl.cleanup(); };
      }

      // --- DM section (between channels and members) ---
      const dmSection = createElement("div", { class: "sidebar-dm-section" });
      const dmHeader = createElement("div", { class: "category" });
      const dmArrow = createElement("span", { class: "category-arrow" }, "\u25BC");
      const dmLabelEl = createElement("span", { class: "category-name" }, "DIRECT MESSAGES");
      const dmAddBtn = createElement("button", { class: "category-add-btn", title: "New DM" }, "+");
      dmAddBtn.style.opacity = "1";
      appendChildren(dmHeader, dmArrow, dmLabelEl, dmAddBtn);
      dmSection.appendChild(dmHeader);

      let dmCollapsed = false;
      const dmList = createElement("div", { class: "category-channels sidebar-dm-list" });

      const currentUserId = authStore.getState().user?.id ?? 0;
      const onlineMembers = getOnlineMembers().filter((m) => m.id !== currentUserId);
      for (const member of onlineMembers.slice(0, 5)) {
        const dmItem = createElement("div", {
          class: "channel-item",
          "data-testid": "dm-entry",
        });
        const avatar = createElement("span", { class: "ch-icon" }, "\uD83D\uDCAC");
        const name = createElement("span", { class: "ch-name" }, member.username);
        appendChildren(dmItem, avatar, name);
        dmItem.addEventListener("click", () => {
          setActiveDmUser(member.id);
          setSidebarMode("dms");
        });
        dmList.appendChild(dmItem);
      }
      dmSection.appendChild(dmList);

      dmHeader.addEventListener("click", () => {
        dmCollapsed = !dmCollapsed;
        dmHeader.classList.toggle("collapsed", dmCollapsed);
        dmArrow.textContent = dmCollapsed ? "\u25B6" : "\u25BC";
      });

      dmAddBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setSidebarMode("dms");
      });

      contentSlot.appendChild(dmSection);

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

      resizeHandle.addEventListener("mousedown", (e: MouseEvent) => {
        isDragging = true;
        startY = e.clientY;
        startHeight = memberListContainer.offsetHeight;
        e.preventDefault();
      }, { signal: resizeAbort.signal });

      document.addEventListener("mousemove", (e: MouseEvent) => {
        if (!isDragging) return;
        const delta = startY - e.clientY;
        const maxH = window.innerHeight * 0.65;
        const newHeight = Math.max(80, Math.min(startHeight + delta, maxH));
        memberListContainer.style.height = `${newHeight}px`;
      }, { signal: resizeAbort.signal });

      document.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        localStorage.setItem("owncord:member-list-height", String(memberListContainer.offsetHeight));
      }, { signal: resizeAbort.signal });

      channelModeUnsubs.push(() => { resizeAbort.abort(); });

      // Collapse toggle for member list
      let membersCollapsed = false;
      const memberContent = createElement("div", { class: "sidebar-members-content" });

      memberHeader.addEventListener("click", () => {
        membersCollapsed = !membersCollapsed;
        memberHeader.classList.toggle("collapsed", membersCollapsed);
        memberArrow.textContent = membersCollapsed ? "\u25B6" : "\u25BC";
        memberContent.style.display = membersCollapsed ? "none" : "";
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
          const roleNameToId: Record<string, number> = { owner: 1, admin: 2, moderator: 3, member: 4 };
          const roleId = roleNameToId[newRole];
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

      // Re-render DM sidebar when members change (online/offline transitions)
      const unsubDmMembers = membersStore.subscribeSelector(
        (s) => s.members,
        () => {
          if (activeSidebarContent !== null) {
            activeSidebarContent.destroy?.();
          }
          clearChildren(contentSlot);
          const freshSlot = createElement("div", { style: "flex:1;overflow:hidden;display:flex;flex-direction:column;" });
          const freshDm = buildDmSidebar();
          freshDm.mount(freshSlot);
          activeSidebarContent = freshDm;
          contentSlot.appendChild(freshSlot);
        },
      );
      channelModeUnsubs.push(unsubDmMembers);

      // Re-render DM sidebar when active DM user changes
      const unsubDmActive = uiStore.subscribeSelector(
        (s) => s.activeDmUserId,
        () => {
          if (activeSidebarContent !== null) {
            activeSidebarContent.destroy?.();
          }
          clearChildren(contentSlot);
          const freshSlot = createElement("div", { style: "flex:1;overflow:hidden;display:flex;flex-direction:column;" });
          const freshDm = buildDmSidebar();
          freshDm.mount(freshSlot);
          activeSidebarContent = freshDm;
          contentSlot.appendChild(freshSlot);
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
  const voiceWidget = createVoiceWidget(
    createVoiceWidgetCallbacks(ws, limiters),
  );
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
      let profiles: readonly QuickSwitchProfile[] = [];

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
