/**
 * Jump to a message inside a thread's own list (a reply quote's click): scroll
 * when it is loaded, otherwise swap in the thread's around-window first.
 */
import { ApiClientError, type ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import {
  getChannelMessages,
  hasMessageLoaded,
  isChannelLoaded,
  setAroundMessages,
} from "@stores/messages.store";
import { messagingText } from "../../i18n/messaging";
import type { MessageListComponent } from "../messaging/MessageList";

const log = createLogger("thread-jump");

/** Window size requested when the target is not in the loaded page. */
const AROUND_WINDOW = 50;

export interface ThreadJumpOptions {
  readonly api: Pick<ApiClient, "getMessagesAround">;
  readonly threadId: number;
  /** Aborts when the panel closes or moves to another thread. */
  readonly signal: AbortSignal;
  readonly getList: () => MessageListComponent | null;
  readonly showToast: (msg: string, type: "success" | "error" | "info") => void;
  /** Waits for the store update to reach the DOM; tests inject a resolved promise. */
  readonly nextFrame?: () => Promise<void>;
}

function defaultNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function createThreadJump(opts: ThreadJumpOptions): (messageId: number) => Promise<void> {
  const { api, threadId, signal, getList, showToast } = opts;
  const nextFrame = opts.nextFrame ?? defaultNextFrame;
  // The latest jump wins: an older fetch landing late must not replace the
  // window a newer one installed.
  let jumpGen = 0;

  function fetchFailed(err: unknown, messageId: number): void {
    if (err instanceof ApiClientError && err.status === 404) {
      showToast(messagingText("jump.gone"), "info");
      return;
    }
    log.error("Failed to fetch the message window", { threadId, messageId, error: String(err) });
    showToast(messagingText("jump.failed"), "error");
  }

  return async function jump(messageId: number): Promise<void> {
    const gen = ++jumpGen;
    if (getChannelMessages(threadId).some((m) => m.id === messageId && m.deleted === true)) {
      showToast(messagingText("jump.gone"), "info");
      return;
    }
    // Only a loaded window is stable: the mount-time fetch would otherwise
    // re-render the list at the tail and lose the target.
    if (isChannelLoaded(threadId) && getList()?.scrollToMessage(messageId) === true) return;

    let resp: Awaited<ReturnType<ApiClient["getMessagesAround"]>>;
    try {
      resp = await api.getMessagesAround(threadId, messageId, { limit: AROUND_WINDOW });
    } catch (err) {
      if (!signal.aborted && gen === jumpGen) fetchFailed(err, messageId);
      return;
    }
    // The panel closed or a newer jump started while the fetch was in flight:
    // installing now would write a window into a thread nobody is looking at.
    if (signal.aborted || gen !== jumpGen) return;
    setAroundMessages(threadId, resp.messages, resp.has_more_before, resp.has_more_after);
    if (!hasMessageLoaded(threadId, messageId)) {
      showToast(messagingText("jump.failed"), "error");
      return;
    }
    await nextFrame();
    if (signal.aborted || gen !== jumpGen) return;
    getList()?.scrollToMessage(messageId);
  };
}
