/** The controller that opens the channel's thread list in the channel side panel. */

import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import type { ThreadInfo } from "@lib/types";
import { createAsyncOverlayController } from "@lib/ui/asyncOverlay";
import { createLazyScreen } from "@lib/ui/lazyScreen";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import { closeWhenChannelLeft, sidePanelStale } from "../messaging/sidePanelScope";
import { messagingText } from "../../i18n/messaging";

const threadListScreen = createLazyScreen("thread-list", () => import("./ThreadList"));

export interface ThreadListPanelController {
  open(): Promise<void>;
  isOpen(): boolean;
  isPending(): boolean;
  cleanup(): void;
}

export function createThreadListPanelController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly getCurrentChannelId: () => number | null;
  /** Whether the channel offers threads now (its header shows the button). */
  readonly available: () => boolean;
  /** Open a picked thread beside the chat; the list closes first. */
  readonly onOpenThread: (thread: ThreadInfo) => void;
}): ThreadListPanelController {
  // canOpen sets it and build reads it within one open(), as the pins panel does.
  let channelId: number | null = null;

  const controller = createAsyncOverlayController<{
    readonly screen: typeof import("./ThreadList");
  }>({
    getRoot: opts.getRoot,
    canOpen: () => {
      channelId = opts.getCurrentChannelId();
      return channelId !== null && opts.available() && !nsfwContentBlocked(channelId);
    },
    load: async () => ({ screen: await threadListScreen.loadOrThrow() }),
    build: ({ screen }, _liveRoot, close) => {
      const id = channelId as number;
      const live = new Disposable();
      const panel = screen.createThreadList({
        api: opts.api,
        channelId: id,
        onOpenThread: (thread) => {
          close();
          opts.onOpenThread(thread);
        },
        onClose: close,
      });
      return {
        mount(container: Element): void {
          panel.mount(container);
          closeWhenChannelLeft(live, id, close);
        },
        destroy(): void {
          live.destroy();
          panel.destroy?.();
        },
      };
    },
    errorLog: "Failed to open the thread list", // i18n-exempt: developer log line, never shown
    errorToast: messagingText("thread.panelLoadFailed"),
    isStale: () => sidePanelStale(channelId, opts.getCurrentChannelId()),
    sidePanel: { panel: ".thread-list-panel", toggle: ".threads-btn" },
  });

  return {
    open: controller.open,
    isOpen: controller.isOpen,
    isPending: controller.isPending,
    cleanup: controller.close,
  };
}
