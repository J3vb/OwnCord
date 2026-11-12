// Re-applies the changes journaled while a history page was in flight (see
// loadJournal.ts) to the rows that page brought in.
import type { ChatEditedPayload } from "../../lib/types";
import type { Message, MessagesState } from "./messageModel";
import type { JournalEntry } from "./loadJournal";
import {
  reduceBulkDeleteMessages,
  reduceDeleteMessage,
  reduceEditMessage,
  reduceSetMessagePinned,
} from "./messageEdits";

/** True when the page's row still lacks what the edit frame carried. */
function editIsNewer(row: Message, payload: ChatEditedPayload): boolean {
  if (payload.call !== undefined) return true;
  // A removed file arrives as an edit with the remaining list and no new time.
  if (payload.attachments !== undefined) return true;
  const at = payload.edited_at ?? "";
  if (at > (row.editedAt ?? "")) return true;
  // Times have one-second resolution: a second edit within the same second as
  // the page's carries the same time and only its text tells them apart.
  return at !== "" && at === row.editedAt && payload.content !== row.content;
}

function replayEdit(
  state: MessagesState,
  channelId: number,
  payload: ChatEditedPayload,
): MessagesState {
  const row = (state.messagesByChannel.get(channelId) ?? []).find(
    (m) => m.id === payload.message_id,
  );
  return row !== undefined && editIsNewer(row, payload) ? reduceEditMessage(state, payload) : state;
}

function applyEntry(state: MessagesState, channelId: number, entry: JournalEntry): MessagesState {
  switch (entry.kind) {
    case "edit":
      return replayEdit(state, channelId, entry.payload);
    case "delete":
      return reduceDeleteMessage(state, entry.payload);
    case "bulkDelete":
      return reduceBulkDeleteMessages(state, entry.payload);
    case "pin":
      return reduceSetMessagePinned(state, channelId, entry.messageId, entry.pinned);
    default:
      return state;
  }
}

/** `rows`, a page just fetched for `channelId`, with every journaled change
 *  applied again. */
export function replayLoadJournal(
  prev: MessagesState,
  channelId: number,
  rows: readonly Message[],
): readonly Message[] {
  const journal = prev.loadJournal?.get(channelId);
  if (journal === undefined || journal.length === 0) return rows;
  let state: MessagesState = {
    ...prev,
    messagesByChannel: new Map(prev.messagesByChannel).set(channelId, rows),
  };
  for (const entry of journal) state = applyEntry(state, channelId, entry);
  return state.messagesByChannel.get(channelId) ?? rows;
}
