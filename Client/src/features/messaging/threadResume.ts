// Re-focusing the open thread after a reconnect. The thread panel's
// host registers this with the dispatcher's hook (stores/threadsLoader) while
// it is mounted, so none of it weighs on startup.
import { removeThread, setFocusedThread, threadsStore } from "@stores/threads.store";
import { setMessages } from "@stores/messages.store";
import { ApiClientError, type ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import type { WsClient } from "@lib/ws";

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
 * that is gone (404) or no longer readable (403) closes the panel.
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
  getMessages(threadId, { limit: 50 }).then(
    (resp) => {
      if (current()) setMessages(threadId, resp.messages, resp.has_more, true);
    },
    (err: unknown) => {
      if (!current()) return;
      if (err instanceof ApiClientError && err.status === 404) {
        removeThread(threadId);
        return;
      }
      if (err instanceof ApiClientError && err.status === 403) {
        setFocusedThread(null);
        return;
      }
      log.warn("Thread history refetch after reconnect failed", { threadId, error: String(err) });
    },
  );
}
