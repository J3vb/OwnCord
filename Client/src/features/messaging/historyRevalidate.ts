// Revalidation of the loaded rows a spliced refetch kept above its page. The
// splice keeps them so the reader's place survives, but nothing refetched them:
// the server's copy of each replaces the loaded one, and a row the server no
// longer returns inside the checked id range was deleted while away.
import type { MessageResponse } from "../../lib/types";
import { messageResponseToMessage } from "./messageModel";
import type { Message, MessagesState } from "./messageModel";
import { mergeHeldState } from "../../lib/linkPreviewState";
import { sameValue } from "./sameValue";
import { replayLoadJournal } from "./loadJournalReplay";

/** revalidateRows' reducer: the channel's sent rows with ids in [from, below)
 *  replaced by the server's newest-first `messages`, or dropped when absent.
 *  Rows outside the range, and pending or failed rows, are left alone. Returns
 *  `prev` itself when nothing changed. */
export function reduceRevalidateRows(
  prev: MessagesState,
  channelId: number,
  messages: readonly MessageResponse[],
  from: number,
  below: number,
): MessagesState {
  const existing = prev.messagesByChannel.get(channelId);
  const inRange = (m: Message): boolean => m.status === "sent" && m.id >= from && m.id < below;
  if (existing === undefined || !existing.some(inRange)) return prev;
  // An edit or delete that arrived while the pages were in flight is newer
  // than they are.
  const page = messages.map(messageResponseToMessage).toReversed();
  const byId = new Map(replayLoadJournal(prev, channelId, page).map((m) => [m.id, m]));
  let changed = false;
  const next = existing.flatMap((m) => {
    if (!inRange(m)) return [m];
    const server = byId.get(m.id);
    if (server === undefined) {
      changed = true;
      return [];
    }
    const merged = mergeHeldState(m, server);
    if (sameValue(m, merged)) return [m];
    changed = true;
    return [merged];
  });
  if (!changed) return prev;
  const updated = new Map(prev.messagesByChannel);
  updated.set(channelId, next);
  return { ...prev, messagesByChannel: updated };
}
