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
import { createSearchOverlay } from "@components/SearchOverlay";
import { showToast } from "@lib/toast";
import { setActiveChannel } from "@stores/channels.store";
import { setMessagePinned } from "@stores/messages.store";

const log = createLogger("overlays");

// ---------------------------------------------------------------------------
// Invite response mapping
// ---------------------------------------------------------------------------

export function mapInviteResponse(r: InviteResponse): InviteItem {
  const extra = r as unknown as Record<string, unknown>;
  const createdBy =
    typeof extra["created_by"] === "object" && extra["created_by"] !== null
      ? ((extra["created_by"] as { username?: string }).username ?? "unknown")
      : "unknown";
  const uses = r.use_count ?? (typeof extra["uses"] === "number" ? extra["uses"] : 0);
  return {
    code: r.code,
    createdBy,
    createdAt: r.expires_at ?? "",
    uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at,
  };
}

/**
 * Whether the server marked this invite revoked. `InviteResponse` does not
 * declare the field (redemption enforces it server-side; the list endpoint
 * deliberately still includes revoked invites), so this reaches into the raw
 * payload the same way `mapInviteResponse` already does for `created_by`.
 * Without this, a revoked invite renders identically to a live one — Copy and
 * Revoke on a code that redemption always rejects.
 */
function isInviteRevoked(r: InviteResponse): boolean {
  return (r as unknown as Record<string, unknown>)["revoked"] === true;
}

// ---------------------------------------------------------------------------
// Pinned message mapping
// ---------------------------------------------------------------------------

function pickPinAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

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
    avatarColor: pickPinAvatarColor(msg.user.username),
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
  /** Optional: suppress the shortcut while another overlay owns input (e.g. Settings). */
  isSuspended?: () => boolean,
): QuickSwitcherManager {
  let instance: MountableComponent | null = null;

  function open(): void {
    const root = getRoot();
    if (instance !== null || root === null) return;
    instance = createQuickSwitcher({
      onSelectChannel: (channelId: number) => {
        setActiveChannel(channelId);
      },
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
      // Mirrors GlobalKeybinds.ts's guard: `e.key` is layout-dependent and
      // uppercases under CapsLock/Shift, so compare case-insensitively;
      // exclude altKey so AltGr (reported as ctrlKey+altKey on Windows)
      // doesn't swallow a non-US character; and honour the same suspension
      // every other app-wide shortcut respects.
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "k") return;
      if (isSuspended?.() === true) return;
      e.preventDefault();
      if (instance !== null) {
        close();
      } else {
        open();
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
}): InviteManagerController {
  let instance: MountableComponent | null = null;
  // Set for the duration of the getInvites() round trip. `instance` is only
  // assigned after the await, so the synchronous `instance !== null` guard
  // alone lets a double-click during the fetch mount two overlays — the
  // second assignment orphans the first, which is then unreachable by its own
  // close affordances. This flag closes that window.
  let opening = false;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function open(): Promise<void> {
    const root = opts.getRoot();
    if (instance !== null || root === null || opening) return;
    opening = true;
    try {
      const raw = await opts.api.getInvites();
      // Re-derive liveness: a page teardown during the fetch nulls the root
      // MainPage handed out, but the pre-await `root` const above still
      // points at the now-detached node. Mounting on it anyway would create
      // an instance whose document-level listeners nothing ever tears down.
      const liveRoot = opts.getRoot();
      if (liveRoot === null) return;
      const invites = raw.filter((r) => !isInviteRevoked(r)).map(mapInviteResponse);
      instance = createInviteManager({
        invites,
        onCreateInvite: async () => {
          const created = await opts.api.createInvite({});
          return mapInviteResponse(created);
        },
        onRevokeInvite: async (code: string) => {
          try {
            await opts.api.revokeInvite(code);
          } catch (err) {
            log.error("Invite revoke failed", { code, error: String(err) });
            throw err;
          }
        },
        onCopyLink: (code: string) => {
          // No silent success: a copy the user can't see is indistinguishable
          // from a clipboard permission failure.
          void navigator.clipboard.writeText(code).then(
            () => showToast("Invite code copied", "success"),
            () => showToast("Couldn't copy the invite code", "error"),
          );
        },
        onClose: close,
        onError: (message: string) => {
          log.error(message);
          showToast(message, "error");
        },
      });
      instance.mount(liveRoot);
    } catch (err) {
      log.error("Failed to open invite manager", { error: String(err) });
      showToast("Failed to load invites", "error");
    } finally {
      opening = false;
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

  readonly getCurrentChannelId: () => number | null;
  /**
   * Jump to a pinned message, in the channel the panel was opened for (the
   * panel does not re-derive "current channel" live — a channel switch while
   * it is open must not silently retarget the jump). Fire-and-forget: the
   * jumper fetches the around-window when the message is not loaded and
   * reports its own failures, so the panel simply closes and gets out of the
   * way.
   */
  readonly onJumpToMessage?: (channelId: number, messageId: number) => void;
}): PinnedPanelController {
  let instance: MountableComponent | null = null;
  // Same guard as InviteManagerController.open: `instance` is only assigned
  // after the getPins() await, so a double-click during the fetch would
  // otherwise mount two panels and orphan the first one permanently.
  let opening = false;

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
    if (opening) return;
    const root = opts.getRoot();
    const channelId = opts.getCurrentChannelId();
    if (root === null || channelId === null) return;
    opening = true;
    try {
      const resp = await opts.api.getPins(channelId);
      // Re-derive liveness: a page teardown during the fetch nulls the root
      // MainPage handed out, but the pre-await `root` const above still
      // points at the now-detached node — see InviteManagerController.open.
      const liveRoot = opts.getRoot();
      if (liveRoot === null) return;
      const pins = resp.messages.map(mapToPinnedMessage);
      instance = createPinnedMessages({
        channelId,
        pinnedMessages: pins,
        onJumpToMessage: (msgId: number) => {
          opts.onJumpToMessage?.(channelId, msgId);
          close();
        },
        onUnpin: (msgId: number) => {
          void opts.api
            .unpinMessage(channelId, msgId)
            .then(() => {
              // The server has no pin/unpin broadcast — this store write is
              // the row's only local authority for `pinned`. Without it the
              // row still says "Unpin" after this panel closes.
              setMessagePinned(channelId, msgId, false);
              close();
            })
            .catch((err: unknown) => {
              log.error("Failed to unpin message", { msgId, error: String(err) });
              showToast("Failed to unpin message", "error");
            });
        },
        onClose: close,
      });
      instance.mount(liveRoot);
    } catch (err) {
      log.error("Failed to load pinned messages", { error: String(err) });
      showToast("Failed to load pinned messages", "error");
    } finally {
      opening = false;
    }
  }

  return { toggle, cleanup: close };
}

// ---------------------------------------------------------------------------
// Search Overlay Controller
// ---------------------------------------------------------------------------

export interface SearchOverlayController {
  open(): void;
  cleanup(): void;
}

export function createSearchOverlayController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;

  readonly getCurrentChannelId: () => number | null;
  /**
   * Jump to a search hit, in whichever channel it lives. Fire-and-forget — the
   * jumper opens the channel, fetches the around-window when needed, and
   * surfaces its own failures.
   */
  readonly onJumpToMessage?: (channelId: number, messageId: number) => void;
}): SearchOverlayController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function open(): void {
    const root = opts.getRoot();
    if (instance !== null || root === null) return;

    const channelId = opts.getCurrentChannelId();

    instance = createSearchOverlay({
      currentChannelId: channelId ?? undefined,
      onSearch: async (query, chId, signal) => {
        try {
          const resp = await opts.api.search(query, { channelId: chId }, signal);
          return resp.results;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          log.error("Search failed", { query, error: String(err) });
          showToast("Search failed", "error");
          throw err;
        }
      },
      onSelectResult: (result) => {
        if (opts.onJumpToMessage === undefined) {
          setActiveChannel(result.channel_id);
          return;
        }
        // The jumper owns the channel switch too, so the fetch it may need to
        // do is sequenced after the switch rather than racing it.
        opts.onJumpToMessage(result.channel_id, result.message_id);
      },
      onClose: close,
    });
    instance.mount(root);
  }

  return { open, cleanup: close };
}
