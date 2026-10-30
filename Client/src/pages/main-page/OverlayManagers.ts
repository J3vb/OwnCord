/**
 * Overlay managers — quick switcher, invite manager, and pinned messages panel.
 * Each factory returns an open/toggle + cleanup pair for use in MainPage.
 */

import type { MountableComponent } from "@lib/text/safeRender";
import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { appendChildren, createElement, setOwnedTimeout } from "@lib/dom";
import { createModal } from "@lib/ui/modalFactory";
import { canManageInvites } from "@lib/permissions";
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@components/lazyScreen";
import type { InviteItem } from "@components/InviteManager";
import type { ImportedAuthor, InviteResponse } from "@lib/types";
import type { PinnedMessage } from "@components/PinnedMessages";
import { showToast } from "@lib/ui/toast";
import { setActiveChannel, channelsStore } from "@stores/channels.store";
import { messagesStore, setMessagePinned } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { uiStore, setSidebarMode, setActiveDmUser } from "@stores/ui.store";
import { dmStore, addDmToChannelsStore } from "@stores/dm.store";
import { navigateToChannel } from "@lib/nav/channelNavigation";
import { authStore } from "@stores/auth.store";
import { errorText } from "@lib/api";
import { nsfwContentBlocked } from "../../features/content-consent/nsfw";
import { resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { formatInviteLink } from "@lib/nav/deepLink";
import { shellText } from "../../i18n/shell";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { copyThenToast } from "@lib/ui/clipboard";

const log = createLogger("overlays");

// Each screen loads on its first open, so its code stays out of the main-page
// chunk. One loader per screen: it shares an in-flight import and retries a
// failed one on the next open.
const quickSwitcherScreen = createLazyScreen(
  "quick-switcher",
  () => import("@components/QuickSwitcher"),
);
const inviteManagerScreen = createLazyScreen(
  "invite-manager",
  () => import("@components/InviteManager"),
);
const pinnedMessagesScreen = createLazyScreen(
  "pinned-messages",
  () => import("@components/PinnedMessages"),
);
const searchOverlayScreen = createLazyScreen(
  "search-overlay",
  () => import("@components/SearchOverlay"),
);

/** Quiet period before an open pinned panel refetches after a pin change. */
const PIN_REFETCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Invite response mapping
// ---------------------------------------------------------------------------

export function mapInviteResponse(r: InviteResponse): InviteItem {
  const extra = r as unknown as Record<string, unknown>;
  // The server now sends creator_username; the legacy nested created_by object
  // is kept as a fallback for an older server.
  const nested = extra["created_by"];
  const creatorUsername =
    typeof r.creator_username === "string" && r.creator_username !== ""
      ? r.creator_username
      : typeof nested === "object" && nested !== null
        ? ((nested as { username?: string }).username ?? "")
        : "";
  const uses = r.use_count ?? (typeof extra["uses"] === "number" ? extra["uses"] : 0);
  return {
    code: r.code,
    createdBy: creatorUsername !== "" ? creatorUsername : shellText("invite.unknownCreator"),
    // created_at is when the invite was made; expires_at is when it lapses.
    // The old code set createdAt from expires_at, so the two were conflated.
    createdAt: r.created_at ?? "",
    uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at,
  };
}

/**
 * Whether the server marked this invite revoked. The list endpoint
 * deliberately still includes revoked invites, so the client filters them.
 * Without this, a revoked invite renders identically to a live one — Copy and
 * Revoke on a code that redemption always rejects.
 */
function isInviteRevoked(r: InviteResponse): boolean {
  return r.revoked === true;
}

/** Whether an invite's expiry has already passed, so it is not offered as a
 *  live code (F4). A null expiry never expires. */
function isInviteExpired(r: InviteResponse): boolean {
  if (r.expires_at === null) return false;
  const t = Date.parse(r.expires_at);
  return Number.isNaN(t) ? true : t <= Date.now();
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
  readonly user: {
    readonly id: number;
    readonly username: string;
    readonly avatar: string | null;
    readonly display_name?: string | null;
  };
  readonly content: string;
  readonly created_at?: string;
  readonly timestamp?: string;
  readonly mentions?: readonly number[];
  readonly mentions_everyone?: boolean;
  readonly mention_roles?: readonly number[];
  readonly imported_author?: ImportedAuthor;
}): PinnedMessage {
  const author = resolveAuthor(msg.user);
  return {
    ...(msg.imported_author !== undefined ? { importedAuthor: msg.imported_author } : {}),
    id: msg.id,
    author: resolveDisplayName(author),
    avatar: author.avatar,
    content: msg.content,
    timestamp: msg.created_at ?? msg.timestamp ?? "",
    // Hashed from the raw username (not the resolved display name) so the hue
    // stays stable across renames — matches every other avatar-color surface.
    avatarColor: pickPinAvatarColor(msg.user.username),
    ...(msg.mentions !== undefined ? { mentions: msg.mentions } : {}),
    ...(msg.mentions_everyone !== undefined ? { mentionsEveryone: msg.mentions_everyone } : {}),
    ...(msg.mention_roles !== undefined ? { mentionRoles: msg.mention_roles } : {}),
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

  function open(): void {
    const root = getRoot();
    if (instance !== null || pendingOpen !== null || root === null) return;
    const ticket = {};
    pendingOpen = ticket;
    void quickSwitcherScreen
      .load(() => pendingOpen === ticket)
      .then((screen) => {
        if (pendingOpen !== ticket) return;
        pendingOpen = null;
        if (screen === null) return;
        // Re-derive the root: a page teardown during the load nulls it.
        const liveRoot = getRoot();
        if (liveRoot === null || instance !== null) return;
        // The keydown handler's gates held when the key was pressed; Settings or
        // a dialog may have opened since, and the switcher must not stack on it.
        if (isSuspended?.() === true || dialogOpen()) return;
        mountSwitcher(screen, liveRoot);
      });
  }

  function mountSwitcher(
    screen: typeof import("@components/QuickSwitcher"),
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

  return { attach };
}

// ---------------------------------------------------------------------------
// Generic async overlay controller
// ---------------------------------------------------------------------------

/** Inline load-failure dialog: the message, Retry and Close. */
function mountLoadError(
  root: HTMLDivElement,
  copy: { readonly message: string; readonly retryLabel: string },
  onClose: () => void,
  onRetry: () => void,
): MountableComponent {
  const content = createElement("div", { class: "modal-body" });
  content.appendChild(
    createElement("div", { class: "invite-manager__error", role: "alert" }, copy.message),
  );
  const footer = createElement("div", { class: "modal-footer" });
  const closeBtn = createElement(
    "button",
    { class: "btn-modal-cancel" },
    shellText("common.close"),
  );
  const retryBtn = createElement("button", { class: "btn-modal-save" }, copy.retryLabel);
  closeBtn.addEventListener("click", onClose);
  retryBtn.addEventListener("click", onRetry);
  appendChildren(footer, closeBtn, retryBtn);
  const disposable = new Disposable();
  const modal = createModal(
    {
      content,
      closeOnBackdrop: false,
      onClose,
      ariaLabel: copy.message,
      signal: disposable.signal,
    },
    root,
  );
  modal.modal.appendChild(footer);
  return {
    mount: () => undefined,
    destroy: () => {
      disposable.destroy();
      modal.destroy();
    },
  };
}

/**
 * Shared shape behind an overlay that opens by awaiting a fetch: an
 * instance/opening guard against a double-click during the round trip,
 * post-await `getRoot()` re-derivation (a page teardown during the fetch
 * nulls the root MainPage handed out, but the pre-await root still points at
 * the now-detached node — mounting on it would create an instance whose
 * document-level listeners nothing ever tears down), catch -> log -> toast,
 * and `finally opening = false`. A close() during the fetch cancels that
 * open: its result is dropped rather than mounted.
 */
function createAsyncOverlayController<T>(opts: {
  readonly getRoot: () => HTMLDivElement | null;
  /** Extra precondition (besides instance/root/opening) checked before the
   *  fetch starts; open() bails silently (no log, no toast) if it returns
   *  false. Runs before `opening` is set. */
  readonly canOpen?: () => boolean;
  readonly load: () => Promise<T>;
  readonly build: (data: T, root: HTMLDivElement, close: () => void) => MountableComponent;
  readonly errorLog: string;
  readonly errorToast: string;
  /** When set, a failed load also mounts an inline error dialog with a Retry
   *  button (re-runs the load) instead of leaving only the toast. */
  readonly inlineError?: { readonly message: string; readonly retryLabel: string };
}): { open(): Promise<void>; close(): void; isOpen(): boolean } {
  let instance: MountableComponent | null = null;
  let opening = false;
  let generation = 0;

  function close(): void {
    generation++;
    opening = false;
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function open(): Promise<void> {
    const root = opts.getRoot();
    if (instance !== null || root === null || opening) return;
    if (opts.canOpen?.() === false) return;
    opening = true;
    const gen = generation;
    try {
      const data = await opts.load();
      if (gen !== generation) return;
      const liveRoot = opts.getRoot();
      if (liveRoot === null) return;
      instance = opts.build(data, liveRoot, close);
      instance.mount(liveRoot);
    } catch (err) {
      if (gen !== generation) return;
      log.error(opts.errorLog, { error: String(err) });
      // The inline dialog carries the message; other overlays only toast.
      if (opts.inlineError === undefined) showToast(opts.errorToast, "error");
      const liveRoot = opts.getRoot();
      if (opts.inlineError !== undefined && liveRoot !== null) {
        instance = mountLoadError(liveRoot, opts.inlineError, close, () => {
          close();
          void open();
        });
      }
    } finally {
      if (gen === generation) opening = false;
    }
  }

  return { open, close, isOpen: () => instance !== null };
}

// ---------------------------------------------------------------------------
// Invite Manager Controller
// ---------------------------------------------------------------------------

export interface InviteManagerController {
  open(): Promise<void>;
  cleanup(): void;
}

interface InviteLoad {
  readonly invites: InviteResponse[];
  readonly featuredCode: string | null;
  readonly screen: typeof import("@components/InviteManager");
}

const DEFAULT_INVITE_HOURS = 168;
const FRESH_INVITE_MIN_REMAINING_MS = 24 * 3_600_000;

/** Newest invite of the signed-in user that is still worth handing out: it has
 *  no use limit and is either non-expiring or expires more than 24 h from now. */
function newestLiveInvite(list: readonly InviteResponse[]): InviteResponse | null {
  let best: InviteResponse | null = null;
  let bestKey = -Infinity;
  const me = authStore.getState().user?.username ?? null;
  for (const r of list) {
    if (me === null || r.creator_username !== me) continue;
    // A limited invite can run out under the user, so it is never featured.
    if (r.max_uses !== null && r.max_uses > 0) continue;
    if (
      r.expires_at !== null &&
      Date.parse(r.expires_at) - Date.now() <= FRESH_INVITE_MIN_REMAINING_MS
    )
      continue;
    const created = r.created_at !== undefined ? Date.parse(r.created_at) : NaN;
    const key = Number.isNaN(created) ? r.id : created;
    if (best === null || key >= bestKey) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}

export function createInviteManagerController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
}): InviteManagerController {
  const controller = createAsyncOverlayController<InviteLoad>({
    getRoot: opts.getRoot,
    // Only MANAGE_INVITES holders can list or create invites.
    canOpen: () => canManageInvites(),
    load: async () => {
      // Fetch the module alongside the list; a failed import rejects into the
      // controller's own load-failed dialog with Retry.
      const screenPromise = inviteManagerScreen.loadOrThrow();
      // The fetch below may throw first; the import must not go unhandled.
      screenPromise.catch(() => undefined);
      const raw = await opts.api.getInvites();
      const visible = raw.filter((r) => !isInviteRevoked(r) && !isInviteExpired(r));
      let featured = newestLiveInvite(visible);
      if (featured === null) {
        // Never more than one per open; a failure must not block the manager.
        try {
          featured = await opts.api.createInvite({
            expires_in_hours: DEFAULT_INVITE_HOURS,
            max_uses: 0,
          });
          visible.push(featured);
        } catch (err) {
          log.error("Fresh invite create failed", { error: String(err) });
          showToast(errorText(err, shellText("invite.createFailed")), "error");
        }
      }
      return {
        invites: visible,
        featuredCode: featured?.code ?? null,
        screen: await screenPromise,
      };
    },
    build: (data, _root, close) => {
      const invites = data.invites.map(mapInviteResponse);
      return data.screen.createInviteManager({
        invites,
        featuredCode: data.featuredCode,
        formatLink: (code: string) => formatInviteLink(code, opts.api.getConfig().host),
        onCreateInvite: async (params) => {
          const created = await opts.api.createInvite({
            expires_in_hours: params.expiresInHours,
            max_uses: params.maxUses,
          });
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
          const link = formatInviteLink(code, opts.api.getConfig().host);
          copyThenToast(link, shellText("invite.copied"), shellText("invite.copyFailed"));
        },
        onClose: close,
        onError: (message: string) => {
          log.error(message);
          showToast(message, "error");
        },
      });
    },
    errorLog: "Failed to open invite manager", // i18n-exempt: developer log line, never shown
    errorToast: shellText("invite.loadFailed"),
    inlineError: { message: shellText("invite.loadFailed"), retryLabel: shellText("invite.retry") },
  });

  return { open: controller.open, cleanup: controller.close };
}

// ---------------------------------------------------------------------------
// Pinned Panel Controller
// ---------------------------------------------------------------------------

export interface PinnedPanelController {
  toggle(): Promise<void>;
  /** Open the panel if it is closed; a no-op while it is open or opening, so a
   *  link into it can never close it. */
  open(): Promise<void>;
  cleanup(): void;
  /** Close the panel if it was opened for `channelId`. */
  closeFor(channelId: number): void;
}

export function createPinnedPanelController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;

  readonly getCurrentChannelId: () => number | null;
  /**
   * Whether the current channel allows the viewer to pin/unpin. Omitted means
   * no — the panel then renders read-only rather than offering an action the
   * server refuses (F1).
   */
  readonly canPin?: (channelId: number) => boolean;
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
  // Set by canOpen() and read by load()/build() for the same open() attempt —
  // safe because canOpen, load and build all run for one open() call before
  // the next can start (the `opening` guard), same as the original toggle()
  // capturing channelId once at the top and reusing it throughout.
  let channelId: number | null = null;

  const controller = createAsyncOverlayController<{
    readonly resp: Awaited<ReturnType<ApiClient["getPins"]>>;
    readonly screen: typeof import("@components/PinnedMessages");
  }>({
    getRoot: opts.getRoot,
    canOpen: () => {
      channelId = opts.getCurrentChannelId();
      // A gated NSFW channel's pins are its content: the gate already
      // says why nothing is shown, so the panel stays shut.
      return channelId !== null && !nsfwContentBlocked(channelId);
    },
    load: async () => {
      const screenPromise = pinnedMessagesScreen.loadOrThrow();
      screenPromise.catch(() => undefined);
      const resp = await opts.api.getPins(channelId as number);
      return { resp, screen: await screenPromise };
    },
    build: ({ resp, screen }, _liveRoot, close) => {
      const id = channelId as number;
      const live = new Disposable();
      let refetchTicket = 0;
      let mayUnpin = opts.canPin?.(id) === true;

      const unpin = (msgId: number): void => {
        void opts.api
          .unpinMessage(id, msgId)
          .then(() => {
            // Update the row now rather than waiting for the server's
            // chat_pinned broadcast, so it cannot still say "Unpin" after
            // this panel closes; the card leaves the open panel in place.
            setMessagePinned(id, msgId, false);
            if (!live.signal.aborted) panel.removePin(msgId);
          })
          .catch((err: unknown) => {
            log.error("Failed to unpin message", { msgId, error: String(err) });
            showToast(shellText("pins.unpinFailed"), "error");
          });
      };

      const panel = screen.createPinnedMessages({
        channelId: id,
        pinnedMessages: resp.messages.map(mapToPinnedMessage),
        onJumpToMessage: (msgId: number) => {
          opts.onJumpToMessage?.(id, msgId);
          close();
        },
        ...(mayUnpin ? { onUnpin: unpin } : {}),
        onClose: close,
      });

      // The panel is a fetched snapshot, so a chat_pinned for this channel (it
      // names only the message) refetches the list, trailing-debounced. A
      // response landing after the panel closed is dropped.
      const refetch = (): void => {
        const ticket = ++refetchTicket;
        setOwnedTimeout(
          live.signal,
          () => {
            if (ticket !== refetchTicket) return;
            opts.api.getPins(id, live.signal).then(
              (next) => {
                if (live.signal.aborted || ticket !== refetchTicket) return;
                panel.setPins(next.messages.map(mapToPinnedMessage));
              },
              (err: unknown) => {
                if (live.signal.aborted) return;
                log.warn("Failed to refresh pinned messages", { error: String(err) });
              },
            );
          },
          PIN_REFETCH_DEBOUNCE_MS,
        );
      };

      // Unpin follows the viewer's live permission, not the one read at build.
      const syncPermission = (): void => {
        const next = opts.canPin?.(id) === true;
        if (next === mayUnpin) return;
        mayUnpin = next;
        panel.setOnUnpin(next ? unpin : undefined);
      };

      return {
        mount(container: Element): void {
          panel.mount(container);
          live.onStoreChange(messagesStore, (s) => s.pinRevision?.get(id) ?? 0, refetch);
          live.onStoreChange(channelsStore, (s) => s.channels.get(id)?.canPin, syncPermission);
          // Pins changed while the socket was down never sent a chat_pinned.
          live.onStoreChange(
            uiStore,
            (s) => s.connectionStatus,
            (status) => {
              if (status === "connected") refetch();
            },
          );
          live.onStoreChange(membersStore, (s) => s.roleRevision ?? 0, syncPermission);
        },
        destroy(): void {
          live.destroy();
          panel.destroy();
        },
      };
    },
    errorLog: "Failed to load pinned messages", // i18n-exempt: developer log line, never shown
    errorToast: shellText("pins.loadFailed"),
  });

  async function toggle(): Promise<void> {
    if (controller.isOpen()) {
      controller.close();
      return;
    }
    await controller.open();
  }

  return {
    toggle,
    open: controller.open,
    cleanup: controller.close,
    closeFor: (id: number) => {
      if (channelId === id) controller.close();
    },
  };
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
  // Set while the overlay's code loads: a second open() is ignored, and
  // close()/cleanup cancels the pending mount.
  let pendingOpen: object | null = null;

  function close(): void {
    pendingOpen = null;
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function open(): void {
    const root = opts.getRoot();
    if (instance !== null || pendingOpen !== null || root === null) return;
    const ticket = {};
    pendingOpen = ticket;
    void searchOverlayScreen
      .load(() => pendingOpen === ticket)
      .then((screen) => {
        if (pendingOpen !== ticket) return;
        pendingOpen = null;
        if (screen === null) return;
        // Re-derive the root: a page teardown during the load nulls it.
        const liveRoot = opts.getRoot();
        if (liveRoot === null || instance !== null) return;
        mountOverlay(screen, liveRoot);
      });
  }

  function mountOverlay(
    screen: typeof import("@components/SearchOverlay"),
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
  }

  return { open, cleanup: close };
}
