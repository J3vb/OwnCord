/**
 * SidebarArea — sidebar DOM construction and component wiring.
 * Composes ServerStrip, ChannelSidebar (with modal callbacks), invite button,
 * VoiceWidget, and UserBar. Extracted from MainPage to reduce orchestrator size.
 */

import { createElement } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { RateLimiterSet } from "@lib/rate-limiter";
import type { ToastContainer } from "@components/Toast";
import { createServerStrip } from "@components/ServerStrip";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createVoiceWidgetCallbacks, createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { createInviteManagerController } from "./OverlayManagers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarAreaOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly limiters: RateLimiterSet;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
}

export interface SidebarAreaResult {
  /** The server strip slot element (left column). */
  readonly serverStripSlot: HTMLDivElement;
  /** The composed sidebar wrapper element (channel list + voice + user bar). */
  readonly sidebarWrapper: HTMLDivElement;
  /** All child MountableComponents for cleanup. */
  readonly children: readonly MountableComponent[];
  /** Unsubscribe / cleanup functions. */
  readonly unsubscribers: readonly (() => void)[];
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

  // --- Server strip ---
  const serverStripSlot = createElement("div", {}) as HTMLDivElement;
  const serverStrip = createServerStrip();
  serverStrip.mount(serverStripSlot);
  children.push(serverStrip);

  // --- Channel sidebar wrapper ---
  const sidebarWrapper = createElement("div", {
    class: "channel-sidebar",
    "data-testid": "channel-sidebar",
  }) as HTMLDivElement;

  const channelSidebarSlot = createElement("div", {});

  const sidebarVoice = createSidebarVoiceCallbacks(ws);
  const channelSidebar = createChannelSidebar({
    onVoiceJoin: sidebarVoice.onVoiceJoin,
    onVoiceLeave: sidebarVoice.onVoiceLeave,
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
  channelSidebar.mount(channelSidebarSlot);
  children.push(channelSidebar);

  const mountedSidebar = channelSidebarSlot.firstElementChild;
  if (mountedSidebar !== null) {
    while (mountedSidebar.firstChild !== null) {
      sidebarWrapper.appendChild(mountedSidebar.firstChild);
    }
  }

  // --- Invite button in sidebar header ---
  const inviteCtrl = createInviteManagerController({
    api,
    getRoot,
    getToast,
  });
  const sidebarHeader = sidebarWrapper.querySelector(".channel-sidebar-header");
  if (sidebarHeader !== null) {
    const inviteBtn = createElement("button", {
      class: "invite-btn",
      title: "Invite",
    }, "Invite");
    inviteBtn.addEventListener("click", () => {
      void inviteCtrl.open();
    });
    sidebarHeader.appendChild(inviteBtn);
  }
  unsubscribers.push(() => { inviteCtrl.cleanup(); });

  // --- Voice widget ---
  const voiceWidgetSlot = createElement("div", {});
  const voiceWidget = createVoiceWidget(
    createVoiceWidgetCallbacks(ws, limiters),
  );
  voiceWidget.mount(voiceWidgetSlot);
  children.push(voiceWidget);
  sidebarWrapper.appendChild(voiceWidgetSlot);

  // --- User bar ---
  const userBarSlot = createElement("div", {});
  const userBar = createUserBar();
  userBar.mount(userBarSlot);
  children.push(userBar);
  sidebarWrapper.appendChild(userBarSlot);

  // --- Cleanup for active modal ---
  unsubscribers.push(() => {
    if (activeModal !== null) {
      activeModal.destroy?.();
      activeModal = null;
    }
  });

  return {
    serverStripSlot,
    sidebarWrapper,
    children,
    unsubscribers,
  };
}
