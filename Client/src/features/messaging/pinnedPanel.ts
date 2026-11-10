/** The pinned messages panel: its data mapping and the controller that opens it. */

import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@lib/ui/lazyScreen";
import { createAsyncOverlayController } from "@lib/ui/asyncOverlay";
import type { ImportedAuthor } from "@lib/types";
import type { PinnedMessage } from "@components/PinnedMessages";
import { showToast } from "@lib/ui/toast";
import { channelsStore } from "@stores/channels.store";
import { messagesStore, setMessagePinned } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { uiStore } from "@stores/ui.store";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import { resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { shellText } from "../../i18n/shell";

const log = createLogger("overlays");

const pinnedMessagesScreen = createLazyScreen(
  "pinned-messages",
  () => import("@components/PinnedMessages"),
);

/** Quiet period before an open pinned panel refetches after a pin change. */
const PIN_REFETCH_DEBOUNCE_MS = 250;

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
    readonly avatar?: string | null;
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
   * server refuses.
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
    outsidePress: { panel: ".pinned-panel", toggle: ".pins-btn" },
    backOnPhone: true,
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
