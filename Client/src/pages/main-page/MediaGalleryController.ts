/**
 * The channel media gallery panel's controller: opens the lazy panel for the
 * current channel, feeds it the API's pages, drops the items of deleted
 * messages while it is open, and closes it when the viewer leaves the
 * channel, loses read access or the channel becomes gated.
 */

import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { resolveDisplayName } from "@lib/avatar";
import { createLazyScreen } from "@components/lazyScreen";
import type { MediaUploader } from "@components/ChannelMediaGallery";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { nsfwContentBlocked } from "../../features/content-consent/nsfw";
import { shellText } from "../../i18n/shell";
import { createAsyncOverlayController } from "./OverlayManagers";

const mediaGalleryScreen = createLazyScreen(
  "media-gallery",
  () => import("@components/ChannelMediaGallery"),
);

/** Deleted messages, as the socket reports them: one id or a purge's ids. */
export type MessageDeleteSubscriber = (
  listener: (channelId: number, messageIds: readonly number[]) => void,
) => () => void;

export interface MediaGalleryController {
  toggle(): Promise<void>;
  cleanup(): void;
}

function uploaders(): readonly MediaUploader[] {
  const out: MediaUploader[] = [];
  for (const m of membersStore.getState().members.values()) {
    out.push({ id: m.id, name: resolveDisplayName(m) });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function createMediaGalleryController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getCurrentChannelId: () => number | null;
  readonly subscribeDeletes: MessageDeleteSubscriber;
  /** Jump in the channel the panel was opened for, never a later one. */
  readonly onJumpToMessage: (channelId: number, messageId: number) => void;
}): MediaGalleryController {
  // canOpen sets it and build reads it within one open(), as the pins panel does.
  let channelId: number | null = null;

  const controller = createAsyncOverlayController<{
    readonly screen: typeof import("@components/ChannelMediaGallery");
  }>({
    getRoot: opts.getRoot,
    canOpen: () => {
      channelId = opts.getCurrentChannelId();
      return channelId !== null && !nsfwContentBlocked(channelId);
    },
    load: async () => ({ screen: await mediaGalleryScreen.loadOrThrow() }),
    build: ({ screen }, _liveRoot, close) => {
      const id = channelId as number;
      const live = new Disposable();
      const panel = screen.createChannelMediaGallery({
        channelName: channelsStore.getState().channels.get(id)?.name ?? "",
        loadPage: (query, signal) => opts.api.listChannelMedia(id, query, signal),
        loadMonths: (query, signal) => opts.api.getChannelMediaMonths(id, query, signal),
        uploaders,
        onJumpToMessage: (messageId) => {
          opts.onJumpToMessage(id, messageId);
          close();
        },
        onClose: close,
      });
      return {
        mount(container: Element): void {
          panel.mount(container);
          live.addCleanup(
            opts.subscribeDeletes((ch, ids) => {
              if (ch === id) panel.removeMessages(ids);
            }),
          );
          // Leaving the channel, losing it (deleted or no longer readable,
          // which removes it from the store) or it becoming gated closes the
          // panel; the server would refuse its next page anyway.
          live.onStoreChange(
            channelsStore,
            (s) => s.activeChannelId === id && s.channels.has(id) && !nsfwContentBlocked(id),
            (stillOpen) => {
              if (!stillOpen) close();
            },
          );
        },
        destroy(): void {
          live.destroy();
          panel.destroy();
        },
      };
    },
    errorLog: "Failed to open the media gallery", // i18n-exempt: developer log line, never shown
    errorToast: shellText("media.openFailed"),
  });

  async function toggle(): Promise<void> {
    if (controller.isOpen()) {
      controller.close();
      return;
    }
    await controller.open();
  }

  return { toggle, cleanup: controller.close };
}
