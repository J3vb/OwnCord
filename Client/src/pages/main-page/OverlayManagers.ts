/**
 * Overlay managers — quick switcher and search overlay. The invite manager,
 * pinned panel and the shared async overlay live in their own modules and are
 * re-exported here for the page.
 */

import type { MountableComponent } from "@lib/text/safeRender";
import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@lib/ui/lazyScreen";
import { claimBackOnPhone } from "@lib/ui/bottomSheet";
import { showToast } from "@lib/ui/toast";
import { setActiveChannel, channelsStore } from "@stores/channels.store";
import { uiStore, setSidebarMode, setActiveDmUser } from "@stores/ui.store";
import { dmStore, addDmToChannelsStore } from "@stores/dm.store";
import { navigateToChannel } from "@lib/nav/channelNavigation";
import { nsfwContentBlocked } from "../../features/content-consent/nsfw";
import { shellText } from "../../i18n/shell";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { holdTypeAhead } from "@lib/ui/typeAhead";

export { createAsyncOverlayController } from "@lib/ui/asyncOverlay";
export {
  createInviteManagerController,
  mapInviteResponse,
  type InviteManagerController,
} from "../../features/invites/inviteManagerController";
export {
  createPinnedPanelController,
  mapToPinnedMessage,
} from "../../features/messaging/pinnedPanel";

const log = createLogger("overlays");

// Each screen loads on its first open, so its code stays out of the main-page
// chunk. One loader per screen: it shares an in-flight import and retries a
// failed one on the next open.
const quickSwitcherScreen = createLazyScreen(
  "quick-switcher",
  () => import("../../features/navigation/QuickSwitcher"),
);
const searchOverlayScreen = createLazyScreen(
  "search-overlay",
  () => import("../../features/navigation/SearchOverlay"),
);

// ---------------------------------------------------------------------------
// Quick Switcher Manager
// ---------------------------------------------------------------------------

export interface QuickSwitcherManager {
  /** Attach Ctrl+K handler; returns cleanup function. */
  attach(): () => void;
  /** Open the switcher, as Ctrl+K does when nothing else is in the way (the
   *  phone drawer's search button). A no-op while one is open or loading. */
  open(): void;
}

export function createQuickSwitcherManager(
  getRoot: () => HTMLDivElement | null,
  /** Optional: suppress the shortcut while another overlay owns input (e.g. Settings). */
  isSuspended?: () => boolean,
  /** Optional: join a voice channel selected in the switcher, matching the sidebar. */
  onJoinVoice?: (channelId: number) => void,
  /** Optional: runs before a pick leaves a channel for a DM, so "back" returns to it. */
  onBeforeDm?: () => void,
  /** Optional: runs when a channel pick leaves DM mode, to drop the saved channel. */
  onLeaveDm?: () => void,
): QuickSwitcherManager {
  let instance: MountableComponent | null = null;
  // Set while the switcher's code loads. A second Ctrl+K in that window is
  // swallowed (it opens once), and close()/detach cancels the pending open.
  let pendingOpen: object | null = null;
  // Keys typed before the switcher's input has focus wait here for it.
  let releaseTypeAhead: (() => void) | null = null;

  function dropTypeAhead(): void {
    releaseTypeAhead?.();
    releaseTypeAhead = null;
  }

  function open(): void {
    const root = getRoot();
    if (instance !== null || pendingOpen !== null || root === null) return;
    const ticket = {};
    pendingOpen = ticket;
    dropTypeAhead();
    releaseTypeAhead = holdTypeAhead();
    void quickSwitcherScreen
      .load(() => pendingOpen === ticket)
      .then((screen) => {
        if (pendingOpen !== ticket) return;
        pendingOpen = null;
        // Re-derive the root: a page teardown during the load nulls it.
        const liveRoot = getRoot();
        // The keydown handler's gates held when the key was pressed; Settings or
        // a dialog may have opened since, and the switcher must not stack on it.
        if (
          screen === null ||
          liveRoot === null ||
          instance !== null ||
          isSuspended?.() === true ||
          dialogOpen()
        ) {
          dropTypeAhead();
          return;
        }
        mountSwitcher(screen, liveRoot);
      });
  }

  function mountSwitcher(
    screen: typeof import("../../features/navigation/QuickSwitcher"),
    root: HTMLDivElement,
  ): void {
    instance = screen.createQuickSwitcher({
      onSelectChannel: (channelId: number) => {
        const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
        if (dm !== undefined) {
          // The state the DM list sets on a click (selectDmConversation):
          // remember the channel being left (a no-op when a DM is already
          // open), refresh the mirror row so a renamed group shows its new
          // name, then enter DM mode.
          onBeforeDm?.();
          addDmToChannelsStore(dm);
          navigateToChannel(channelId);
          setActiveDmUser(dm.isGroup ? null : dm.recipient.id);
          setSidebarMode("dms");
          return;
        }
        // A voice channel selected here must go through the same join path the
        // sidebar row uses: a pick joins, it does not just open the chat.
        const channel = channelsStore.getState().channels.get(channelId);
        if (channel?.type === "voice" && onJoinVoice !== undefined) {
          onJoinVoice(channelId);
          return;
        }
        // A channel pick from DM mode returns the sidebar to the channel list
        // and drops the saved "channel before the DM", so Back later cannot
        // jump to an older channel.
        if (uiStore.getState().sidebarMode === "dms") {
          setSidebarMode("channels");
          onLeaveDm?.();
        }
        navigateToChannel(channelId);
      },
      onClose: close,
    });
    instance.mount(root);
  }

  function close(): void {
    pendingOpen = null;
    dropTypeAhead();
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  const handler = (e: KeyboardEvent): void => {
    // Mirrors GlobalKeybinds.ts's guard: `e.key` is layout-dependent and
    // uppercases under CapsLock/Shift, so compare case-insensitively;
    // exclude altKey so AltGr (reported as ctrlKey+altKey on Windows)
    // doesn't swallow a non-US character; and honour the same suspension
    // every other app-wide shortcut respects.
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "k") return;
    if (isSuspended?.() === true) return;
    // A held Ctrl+K acts once: auto-repeat must not close what the press opened.
    if (e.repeat) {
      if (pendingOpen !== null || instance !== null || !dialogOpen()) e.preventDefault();
      return;
    }
    if (pendingOpen !== null) {
      // Still loading: the first press already asked to open, so a second one
      // must not open twice nor cancel it.
      e.preventDefault();
      return;
    }
    if (instance !== null) {
      // Always let Ctrl+K close our own overlay.
      e.preventDefault();
      close();
      return;
    }
    // Do not open behind another modal (#17).
    if (dialogOpen()) return;
    e.preventDefault();
    open();
  };

  function attach(): () => void {
    const owner = new Disposable();
    document.addEventListener("keydown", handler, { signal: owner.signal });
    return () => {
      owner.destroy();
      close();
    };
  }

  return {
    attach,
    open: () => {
      if (isSuspended?.() === true || dialogOpen()) return;
      open();
    },
  };
}

// ---------------------------------------------------------------------------
// Search Overlay Controller
// ---------------------------------------------------------------------------

export interface SearchOverlayController {
  /** Open the overlay; `typed` is text the user already typed to open it. */
  open(typed?: string): void;
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
  // Set while the overlay's code loads: a second open() is ignored, and
  // close()/cleanup cancels the pending mount.
  let pendingOpen: object | null = null;
  /** The mounted overlay's lifetime: its Back claim on a phone. */
  let mounted: Disposable | null = null;
  // Keys typed before the overlay's input has focus wait here for it.
  let releaseTypeAhead: (() => void) | null = null;

  function dropTypeAhead(): void {
    releaseTypeAhead?.();
    releaseTypeAhead = null;
  }

  function close(): void {
    pendingOpen = null;
    dropTypeAhead();
    mounted?.destroy();
    mounted = null;
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function open(typed = ""): void {
    const root = opts.getRoot();
    if (instance !== null || pendingOpen !== null || root === null) return;
    const ticket = {};
    pendingOpen = ticket;
    dropTypeAhead();
    releaseTypeAhead = holdTypeAhead(typed);
    void searchOverlayScreen
      .load(() => pendingOpen === ticket)
      .then((screen) => {
        if (pendingOpen !== ticket) return;
        pendingOpen = null;
        // Re-derive the root: a page teardown during the load nulls it.
        const liveRoot = opts.getRoot();
        if (screen === null || liveRoot === null || instance !== null) {
          dropTypeAhead();
          return;
        }
        mountOverlay(screen, liveRoot);
      });
  }

  function mountOverlay(
    screen: typeof import("../../features/navigation/SearchOverlay"),
    root: HTMLDivElement,
  ): void {
    const current = opts.getCurrentChannelId();
    // Behind the NSFW gate only a server-wide search is offered.
    const channelId = current !== null && nsfwContentBlocked(current) ? null : current;

    instance = screen.createSearchOverlay({
      currentChannelId: channelId ?? undefined,
      onSearch: async (query, chId, signal, before) => {
        try {
          return await opts.api.search(query, { channelId: chId, sort: "recent", before }, signal);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          log.error("Search failed", { query, error: String(err) });
          showToast(shellText("search.failed"), "error");
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
    mounted = new Disposable();
    claimBackOnPhone(close, mounted.signal);
  }

  return { open, cleanup: close };
}
