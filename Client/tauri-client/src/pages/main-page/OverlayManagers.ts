/**
 * Overlay managers — quick switcher, invite manager, and pinned messages panel.
 * Each factory returns an open/toggle + cleanup pair for use in MainPage.
 */

import type { MountableComponent } from "@lib/safe-render";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createInviteManager } from "@components/InviteManager";
import type { InviteItem } from "@components/InviteManager";
import type { InviteResponse } from "@lib/types";
import { createPinnedMessages } from "@components/PinnedMessages";
import type { PinnedMessage } from "@components/PinnedMessages";
import type { ToastContainer } from "@components/Toast";
import { setActiveChannel } from "@stores/channels.store";

const log = createLogger("overlays");

// ---------------------------------------------------------------------------
// Invite response mapping
// ---------------------------------------------------------------------------

export function mapInviteResponse(r: InviteResponse): InviteItem {
  const extra = r as unknown as Record<string, unknown>;
  const createdBy = typeof extra["created_by"] === "object"
    && extra["created_by"] !== null
    ? (extra["created_by"] as { username?: string }).username ?? "unknown"
    : "unknown";
  const uses = r.use_count
    ?? (typeof extra["uses"] === "number" ? (extra["uses"] as number) : 0);
  return {
    code: r.code,
    createdBy,
    createdAt: r.expires_at ?? "",
    uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Pinned message mapping
// ---------------------------------------------------------------------------

export function mapToPinnedMessage(msg: {
  readonly id: number;
  readonly user: { readonly username: string };
  readonly content: string;
  readonly created_at?: string;
  readonly timestamp?: string;
}): PinnedMessage {
  return {
    id: msg.id,
    author: msg.user.username,
    content: msg.content,
    timestamp: msg.created_at ?? msg.timestamp ?? "",
  };
}

// ---------------------------------------------------------------------------
// Quick Switcher Manager
// ---------------------------------------------------------------------------

export interface QuickSwitcherManager {
  /** Attach Ctrl+K handler; returns cleanup function. */
  attach(): () => void;
}

export function createQuickSwitcherManager(
  getRoot: () => HTMLDivElement | null,
): QuickSwitcherManager {
  let instance: MountableComponent | null = null;

  function open(): void {
    const root = getRoot();
    if (instance !== null || root === null) return;
    instance = createQuickSwitcher({
      onSelectChannel: (channelId: number) => {
        setActiveChannel(channelId);
      },
      onSearch: () => {},
      onClose: close,
    });
    instance.mount(root);
  }

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function attach(): () => void {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (instance !== null) {
          close();
        } else {
          open();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      close();
    };
  }

  return { attach };
}

// ---------------------------------------------------------------------------
// Invite Manager Controller
// ---------------------------------------------------------------------------

export interface InviteManagerController {
  open(): Promise<void>;
  cleanup(): void;
}

export function createInviteManagerController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
}): InviteManagerController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function open(): Promise<void> {
    const root = opts.getRoot();
    if (instance !== null || root === null) return;
    try {
      const raw = await opts.api.getInvites();
      const invites = raw.map(mapInviteResponse);
      instance = createInviteManager({
        invites,
        onCreateInvite: async () => {
          const created = await opts.api.createInvite({});
          return mapInviteResponse(created);
        },
        onRevokeInvite: async (code: string) => {
          const raw2 = await opts.api.getInvites();
          const match = raw2.find((i) => i.code === code);
          if (match !== undefined) {
            await opts.api.revokeInvite(match.id);
          }
        },
        onCopyLink: (code: string) => {
          void navigator.clipboard.writeText(code);
        },
        onClose: close,
        onError: (message: string) => {
          log.error(message);
          opts.getToast()?.show(message, "error");
        },
      });
      if (root !== null) {
        instance.mount(root);
      }
    } catch (err) {
      log.error("Failed to open invite manager", { error: String(err) });
      opts.getToast()?.show("Failed to load invites", "error");
    }
  }

  return { open, cleanup: close };
}

// ---------------------------------------------------------------------------
// Pinned Panel Controller
// ---------------------------------------------------------------------------

export interface PinnedPanelController {
  toggle(): Promise<void>;
  cleanup(): void;
}

export function createPinnedPanelController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getToast: () => ToastContainer | null;
  readonly getCurrentChannelId: () => number | null;
}): PinnedPanelController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function toggle(): Promise<void> {
    if (instance !== null) {
      close();
      return;
    }
    const root = opts.getRoot();
    const channelId = opts.getCurrentChannelId();
    if (root === null || channelId === null) return;
    try {
      const resp = await opts.api.getPins(channelId);
      const pins = resp.messages.map(mapToPinnedMessage);
      instance = createPinnedMessages({
        channelId,
        pinnedMessages: pins,
        onJumpToMessage: (_msgId: number) => {
          close();
        },
        onUnpin: (msgId: number) => {
          void opts.api.unpinMessage(channelId, msgId);
          close();
        },
        onClose: close,
      });
      if (root !== null) {
        instance.mount(root);
      }
    } catch (err) {
      log.error("Failed to load pinned messages", { error: String(err) });
      opts.getToast()?.show("Failed to load pinned messages", "error");
    }
  }

  return { toggle, cleanup: close };
}
