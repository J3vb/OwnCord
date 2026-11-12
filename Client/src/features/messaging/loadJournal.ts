// Changes that reached the client while a channel's history page was in
// flight. The page is read on the server before those frames were sent, so
// installing it as it is would undo them; the install re-applies them
// (loadJournalReplay.ts). Recording only happens while a page fetch is in
// flight: from setChannelLoading to its install, or while an older, newer,
// tail or around fetch holds the journal open, so an idle channel keeps none.
// A first-page load replays only what was recorded after it started
// (loadJournalStart); the other pages replay the whole journal.
import type {
  ChatBulkDeletedPayload,
  ChatDeletedPayload,
  ChatEditedPayload,
} from "../../lib/types";
import type { MessagesState } from "./messageModel";

const MAX_JOURNAL_ENTRIES = 1000;

/** One change received during the fetch. Reactions are not journaled: their
 *  counts carry no version, and a frame that arrived mid-fetch is usually
 *  already in the page. */
export type JournalEntry =
  | { readonly kind: "edit"; readonly payload: ChatEditedPayload }
  | { readonly kind: "delete"; readonly payload: ChatDeletedPayload }
  | { readonly kind: "bulkDelete"; readonly payload: ChatBulkDeletedPayload }
  | {
      readonly kind: "pin";
      readonly messageId: number;
      readonly pinned: boolean;
    };

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

/** The journal of `channelId` started empty (entries a page fetch that is
 *  still in flight recorded are kept: replaying them twice is harmless). */
export function startLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  const updated = new Map(prev.loadJournal ?? []);
  const starts = new Map(prev.loadJournalStart ?? []);
  if (heldByFetch(prev, channelId)) {
    // Entries from before this load began are older than its page: they stay
    // for the fetch that holds them, and this page replays only what follows.
    const kept = updated.get(channelId) ?? [];
    updated.set(channelId, kept);
    starts.set(channelId, kept.length);
  } else {
    updated.set(channelId, []);
    starts.delete(channelId);
  }
  return { ...prev, loadJournal: updated, loadJournalStart: starts };
}

/** The journal of `channelId` dropped (the page landed or the fetch failed). A
 *  journal an older, newer, tail or around fetch still holds stays open. */
export function endLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  if (prev.loadJournal?.has(channelId) !== true || heldByFetch(prev, channelId)) return prev;
  const updated = new Map(prev.loadJournal);
  updated.delete(channelId);
  const starts = new Map(prev.loadJournalStart ?? []);
  starts.delete(channelId);
  return { ...prev, loadJournal: updated, loadJournalStart: starts };
}

/** Where a first-page install starts replaying: past the entries recorded
 *  before its load began. */
export function firstPageReplayStart(prev: MessagesState, channelId: number): number {
  return prev.historyLoadState.get(channelId) === "loading"
    ? (prev.loadJournalStart?.get(channelId) ?? 0)
    : 0;
}

function heldByFetch(prev: MessagesState, channelId: number): boolean {
  return (prev.loadJournalHolds?.get(channelId) ?? 0) > 0;
}

/** One more page fetch (older, newer, tail or around) holds the channel's
 *  journal open. Overlapping fetches share it; it closes with the last one. */
export function holdLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  const holds = new Map(prev.loadJournalHolds ?? []);
  holds.set(channelId, (holds.get(channelId) ?? 0) + 1);
  const journal = new Map(prev.loadJournal ?? []);
  journal.set(channelId, journal.get(channelId) ?? []);
  return { ...prev, loadJournalHolds: holds, loadJournal: journal };
}

/** A page fetch let go of the journal: it lands, fails or goes stale. The
 *  journal is dropped with the last hold unless a first-page load is running. */
export function releaseLoadJournal(prev: MessagesState, channelId: number): MessagesState {
  const held = prev.loadJournalHolds?.get(channelId) ?? 0;
  if (held === 0) return prev;
  const holds = new Map(prev.loadJournalHolds);
  if (held > 1) {
    holds.set(channelId, held - 1);
    return { ...prev, loadJournalHolds: holds };
  }
  holds.delete(channelId);
  const next = { ...prev, loadJournalHolds: holds };
  return prev.historyLoadState.get(channelId) === "loading"
    ? next
    : endLoadJournal(next, channelId);
}
