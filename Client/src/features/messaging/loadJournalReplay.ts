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

function replayEdit(
  state: MessagesState,
  channelId: number,
  payload: ChatEditedPayload,
): MessagesState {
  const row = (state.messagesByChannel.get(channelId) ?? []).find(
    (m) => m.id === payload.message_id,
  );
  // A page that already carries this edit, or a later one, stays as it is.
  const newer = payload.call !== undefined || (payload.edited_at ?? "") > (row?.editedAt ?? "");
  return row !== undefined && newer ? reduceEditMessage(state, payload) : state;
}

/** The live row carries every reaction frame; the page may or may not. */
function replayReaction(
  state: MessagesState,
  channelId: number,
  messageId: number,
  cached: ReadonlyMap<number, Message>,
): MessagesState {
  const reactions = cached.get(messageId)?.reactions;
  if (reactions === undefined) return state;
  const list = (state.messagesByChannel.get(channelId) ?? []).map((m) =>
    m.id === messageId ? { ...m, reactions } : m,
  );
  return { ...state, messagesByChannel: new Map(state.messagesByChannel).set(channelId, list) };
}

function applyEntry(
  state: MessagesState,
  channelId: number,
  entry: JournalEntry,
  cached: ReadonlyMap<number, Message>,
): MessagesState {
  switch (entry.kind) {
    case "edit":
      return replayEdit(state, channelId, entry.payload);
    case "delete":
      return reduceDeleteMessage(state, entry.payload);
    case "bulkDelete":
      return reduceBulkDeleteMessages(state, entry.payload);
    case "pin":
      return reduceSetMessagePinned(state, channelId, entry.messageId, entry.pinned);
    case "reaction":
      return replayReaction(state, channelId, entry.messageId, cached);
    default:
      return state;
  }
}

/** `rows`, a page just fetched for `channelId`, with every journaled change
 *  applied again. `loaded` is the window the page replaces. */
export function replayLoadJournal(
  prev: MessagesState,
  channelId: number,
  rows: readonly Message[],
  loaded: readonly Message[],
): readonly Message[] {
  const journal = prev.loadJournal?.get(channelId);
  if (journal === undefined || journal.length === 0) return rows;
  const cached = new Map(loaded.filter((m) => m.status === "sent").map((m) => [m.id, m]));
  let state: MessagesState = {
    ...prev,
    messagesByChannel: new Map(prev.messagesByChannel).set(channelId, rows),
  };
  for (const entry of journal) state = applyEntry(state, channelId, entry, cached);
  return state.messagesByChannel.get(channelId) ?? rows;
}
