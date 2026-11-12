// Re-focusing the open thread after a reconnect. The thread panel's
// host registers this with the dispatcher's hook (stores/threadsLoader) while
// it is mounted, so none of it weighs on startup.
import { recoverAfterReattach } from "./historyFetch";
import { removeThread, setFocusedThread, threadsStore } from "@stores/threads.store";
import {
  getChannelMessages,
  isWindowDetached,
  setChannelLoadError,
  setChannelLoading,
  setMessages,
} from "@stores/messages.store";
import { ApiClientError, type ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { RestErrorCode } from "@lib/protocolTypes";
import { showToast } from "@lib/ui/toast";
import type { WsClient } from "@lib/ws";
import { connectText } from "../../i18n/connect";

const log = createLogger("dispatcher");

/**
 * Bumped by every resume. A history fetch started by one resume applies only
 * while it is still the newest attempt for the same thread: a second reconnect,
 * a close, or a switch to another thread leaves the older answer to be dropped.
 * The same tag-and-compare idea as the connect generation in lib/ws.ts.
 */
let resumeGeneration = 0;

/**
 * `thread_focus` is not carried across a connection: after every authenticated
 * (re)connect, if a panel is open, say so again and refetch its history, because
 * the thread's frames were not delivered while the socket was down. A thread
 * that is gone (404 NOT_FOUND) or no longer readable (403) closes the panel.
 */
export function resumeThreadFocus(
  ws: Pick<WsClient, "send">,
  api: Pick<Partial<ApiClient>, "getMessages"> | undefined,
): void {
  const threadId = threadsStore.getState().focusedThreadId;
  const attempt = ++resumeGeneration;
  if (threadId === null) return;
  ws.send({ type: "thread_focus", payload: { thread_id: threadId } });
  const getMessages = api?.getMessages;
  if (getMessages === undefined) return;
  const current = (): boolean =>
    attempt === resumeGeneration && threadsStore.getState().focusedThreadId === threadId;
  // Marks the fetch so a change that lands while it is in flight is kept when
  // the page is installed.
  const wasDetached = isWindowDetached(threadId);
  setChannelLoading(threadId);
  getMessages(threadId, { limit: 50 }).then(
    (resp) => {
      if (!current()) return;
      setMessages(threadId, resp.messages, resp.has_more, true);
      recoverAfterReattach({ getMessages }, threadId, wasDetached, new AbortController().signal);
    },
    (err: unknown) => {
      if (!current()) return;
      // Ends the fetch's journal on every failure, including a gone thread.
      setChannelLoadError(threadId);
      // Only the server's own NOT_FOUND means the thread is gone; any other
      // 404 (a proxy, a stray route) is a transient fault and keeps it.
      if (
        err instanceof ApiClientError &&
        err.status === 404 &&
        err.code === RestErrorCode.NOT_FOUND
      ) {
        removeThread(threadId);
        return;
      }
      if (err instanceof ApiClientError && err.status === 403) {
        setFocusedThread(null);
        return;
      }
      log.warn("Thread history refetch after reconnect failed", { threadId, error: String(err) });
      // Rows that were on screen may now end short of the live tail: detach the
      // window so no live reply lands across the gap, and let "Jump to present"
      // refetch it. The rows hide the inline error, so say it with a toast.
      if (getChannelMessages(threadId).length > 0) {
        showToast(connectText("app.loadHistoryFailed"), "error");
      }
    },
  );
}
