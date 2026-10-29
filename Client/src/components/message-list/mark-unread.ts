/**
 * Mark Unread, the page's half: the socket sender, and the scan for
 * the message before the one clicked. The shared state (pending request, hold,
 * pointer) lives in lib/read-state.ts, which the startup chunk needs for
 * `read_state` and the refusal; this half is only needed by the main page.
 */

import { beginMarkUnread, setMarkUnreadNotice } from "@lib/read-state";
import { showToast } from "@lib/toast";
import { getChannelMessages } from "@stores/messages.store";
import { messagingText } from "../../i18n/messaging";

/** Sends one `mark_unread` and returns the frame id the server's reply will echo. */
export type MarkUnreadSender = (channelId: number, messageId: number) => string;

let send: MarkUnreadSender | null = null;

/**
 * Register the socket sender, and the toast that says a Mark Unread did not
 * happen. Called from MainPage with the live WsClient, and with null when the
 * connection is abandoned.
 */
export function setMarkUnreadSender(next: MarkUnreadSender | null): void {
  send = next;
  setMarkUnreadNotice(
    next === null
      ? null
      : (notice) =>
          showToast(
            notice === "rateLimited"
              ? messagingText("markUnread.rateLimited")
              : notice === "notFound"
                ? messagingText("markUnread.notFound")
                : messagingText("markUnread.failed"),
            "error",
          ),
  );
}

/**
 * Ask for `messageId` and everything after it to be unread again: sends
 * `mark_unread` and moves the local pointer to the previous loaded message (0
 * when there is none). Returns that pointer, or null when nothing was sent:
 * no capability, no sender or an unknown channel.
 */
export function markMessageUnread(channelId: number, messageId: number): number | null {
  const sender = send;
  if (sender === null) return null;
  let before = 0;
  for (const m of getChannelMessages(channelId)) {
    if (m.id > before && m.id < messageId) before = m.id;
  }
  return beginMarkUnread(channelId, messageId, before, () => sender(channelId, messageId))
    ? before
    : null;
}
