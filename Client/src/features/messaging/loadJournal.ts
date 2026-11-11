// Changes that reached the client while a channel's history page was in
// flight. The page is read on the server before those frames were sent, so
// installing it as it is would undo them; the install re-applies them
// (loadJournalReplay.ts). Recording only happens between setChannelLoading and
// the matching install, so an idle channel keeps no journal.
import type {
  ChatBulkDeletedPayload,
  ChatDeletedPayload,
  ChatEditedPayload,
} from "../../lib/types";
import type { MessagesState } from "./messageModel";

const MAX_JOURNAL_ENTRIES = 1000;

/** One change received during the fetch. A reaction names only the message:
 *  its count has no version, so it is replayed from the live row, not as a delta. */
export type JournalEntry =
  | { readonly kind: "edit"; readonly payload: ChatEditedPayload }
  | { readonly kind: "delete"; readonly payload: ChatDeletedPayload }
  | { readonly kind: "bulkDelete"; readonly payload: ChatBulkDeletedPayload }
  | {
      readonly kind: "pin";
      readonly messageId: number;
      readonly pinned: boolean;
    }
  | { readonly kind: "reaction"; readonly messageId: number };

/** `next` with `entry` appended to the channel's journal, when a fetch for the
 *  channel is in flight; `next` itself otherwise. */
export function recordLoadJournal(
  next: MessagesState,
  channelId: number,
  entry: JournalEntry,
): MessagesState {
  const journal = next.loadJournal?.get(channelId);
  if (journal === undefined) return next;
  const updated = new Map(next.loadJournal);
  // A fetch that never lands must not grow this without bound.
  updated.set(channelId, [...journal, entry].slice(-MAX_JOURNAL_ENTRIES));
  return { ...next, loadJournal: updated };
}

/** The journal of `channelId` started empty. */
export function startLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  const updated = new Map(prev.loadJournal ?? []);
  updated.set(channelId, []);
  return { ...prev, loadJournal: updated };
}

/** The journal of `channelId` dropped (the page landed or the fetch failed). */
export function endLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  if (prev.loadJournal?.has(channelId) !== true) return prev;
  const updated = new Map(prev.loadJournal);
  updated.delete(channelId);
  return { ...prev, loadJournal: updated };
}
