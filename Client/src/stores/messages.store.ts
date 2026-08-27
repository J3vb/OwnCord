/**
 * Messages store — holds chat messages per channel, pending send tracking,
 * and load state for infinite scroll.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ChatBulkDeletedPayload,
  ReactionUpdatePayload,
  MessageUser,
  Attachment,
  ReactionSummary,
  MessageResponse,
} from "@lib/types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Delivery status of a message row.
 * - "sent": confirmed by the server (the default for every server-sourced row).
 * - "pending": optimistic local row awaiting the chat_send_ok ack.
 * - "failed": the send was rejected or dropped; the row offers retry.
 */
export type MessageStatus = "sent" | "pending" | "failed";

export interface Message {
  readonly id: number;
  readonly channelId: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly replyTo: number | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
  /** Delivery status. Server-sourced rows are always "sent". */
  readonly status: MessageStatus;
  /**
   * Correlation id for an optimistic row, matching the id echoed on
   * chat_send_ok / error. Null once reconciled or for server-sourced rows.
   */
  readonly correlationId: string | null;
  /** Error code when status === "failed" (e.g. "SLOW_MODE", "FORBIDDEN"). */
  readonly errorCode: string | null;
  /**
   * Server-resolved mentioned user IDs. Optional so the many inline Message
   * fixtures need not restate it; undefined means "the server didn't say",
   * which sends rendering down the local @token resolution path.
   */
  readonly mentions?: readonly number[];
  /** Whether an honoured @everyone/@here is present. Optional, as above. */
  readonly mentionsEveryone?: boolean;
}

/** A reaction toggle applied optimistically, awaiting its server echo. Keyed
 *  by the WS envelope id so an error reply (or local transport failure) can
 *  roll back exactly this toggle — the same correlation scheme pendingSends
 *  uses for optimistic message rows. */
export interface PendingReaction {
  readonly channelId: number;
  readonly messageId: number;
  readonly emoji: string;
  readonly action: "add" | "remove";
}

export interface MessagesState {
  /** Messages per channel: channelId -> ordered array of Message */
  readonly messagesByChannel: ReadonlyMap<number, readonly Message[]>;
  /** Pending send confirmations: correlationId -> channelId */
  readonly pendingSends: ReadonlyMap<string, number>;
  /** Optimistic reaction toggles awaiting their echo: correlationId -> toggle.
   *  The store always sets it; optional only so the many inline MessagesState
   *  test fixtures need not restate it. */
  readonly pendingReactions?: ReadonlyMap<string, PendingReaction>;
  /** Whether we've loaded initial messages for a channel */
  readonly loadedChannels: ReadonlySet<number>;
  /** Whether more messages exist above for a channel */
  readonly hasMore: ReadonlyMap<number, boolean>;
  /**
   * First-page history fetch state per channel. Absent entry = idle (loaded or
   * never requested) — the message region then renders normally/empty.
   */
  readonly historyLoadState: ReadonlyMap<number, "loading" | "error">;
  /**
   * Channels whose loaded window is an around-window detached from the live
   * tail: newer messages exist on the server below what is rendered. While a
   * channel is here the list shows a "Jump to Present" pill and incoming
   * broadcasts are *not* appended — they belong below the window, and
   * appending them would fake continuity across a gap.
   */
  readonly detachedChannels: ReadonlySet<number>;
  /**
   * channelId -> highest message id present the moment a history fetch was
   * started (setChannelLoading), consumed and cleared by the matching
   * setMessages. Lets setMessages tell "no messages arrived after the
   * snapshot was taken" apart from "the snapshot itself was empty" — an
   * empty page's own maxSnapshotId is 0, which without this watermark floor
   * would make every pre-existing "sent" row look newer than the snapshot and
   * survive forever, even when the channel was genuinely emptied by a purge.
   * The store always sets it; optional only so the many inline MessagesState
   * test fixtures need not restate it.
   */
  readonly loadWatermark?: ReadonlyMap<number, number>;
}

// -----------------------------------------------------------------------------
// Helpers: convert wire types to store types
// -----------------------------------------------------------------------------

function chatPayloadToMessage(payload: ChatMessagePayload): Message {
  return {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user,
    content: payload.content,
    replyTo: payload.reply_to,
    attachments: payload.attachments,
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: payload.timestamp,
    status: "sent",
    correlationId: null,
    errorCode: null,
    mentions: payload.mentions,
    mentionsEveryone: payload.mentions_everyone,
  };
}

function messageResponseToMessage(response: MessageResponse): Message {
  return {
    id: response.id,
    channelId: response.channel_id,
    user: response.user,
    content: response.content,
    replyTo: response.reply_to,
    attachments: response.attachments,
    reactions: response.reactions,
    pinned: response.pinned,
    editedAt: response.edited_at,
    deleted: response.deleted,
    timestamp: response.timestamp,
    status: "sent",
    correlationId: null,
    errorCode: null,
    mentions: response.mentions,
    mentionsEveryone: response.mentions_everyone,
  };
}

/** Maximum messages retained per channel. Oldest messages are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 500;

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const INITIAL_STATE: MessagesState = {
  messagesByChannel: new Map(),
  pendingSends: new Map(),
  pendingReactions: new Map(),
  loadedChannels: new Set(),
  hasMore: new Map(),
  historyLoadState: new Map(),
  detachedChannels: new Set(),
  loadWatermark: new Map(),
};

// -----------------------------------------------------------------------------
// Store instance
// -----------------------------------------------------------------------------

export const messagesStore = createStore<MessagesState>(INITIAL_STATE);

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * Approximates one round of the server's `sanitizePass`
 * (Server/service/message.go): unescape HTML entities, strip tags (bluemonday's
 * StrictPolicy keeps only surviving text), then unescape once more. Not a
 * byte-exact port — bluemonday additionally re-escapes special characters left
 * in the surviving text on write, which this skips — but it recognizes the
 * two shapes that actually break naive byte-equality against our own echo:
 * stripped tags and unescaped entities. Only used by echoNormalize below, to
 * decide whether a replayed server echo is *our* sanitized send.
 */
function sanitizePassApprox(s: string): string {
  const unescapeOnce = (input: string): string =>
    input
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  // Repeated rather than a single pass: a lone `replace` can in principle
  // splice a fresh `<...>` out of the text either side of what it removed.
  // echoNormalize's own fixpoint loop already absorbed that, so this is
  // output-identical -- it just puts the repetition where a reader (and
  // CodeQL's js/incomplete-multi-character-sanitization) can see it.
  const stripTags = (input: string): string => {
    let out = input;
    for (let next = out.replace(/<[^>]*>/g, ""); next !== out; next = out.replace(/<[^>]*>/g, "")) {
      out = next;
    }
    return out;
  };
  return unescapeOnce(stripTags(unescapeOnce(s)));
}

/**
 * Approximates the server's `sanitizeToFixpoint`: repeats sanitizePassApprox
 * until it stops changing (bounded, since real message content is short and
 * each pass only ever shrinks or holds steady). Used to normalize what the
 * user typed before comparing it against a server echo, since the server
 * sanitizes content before storing/broadcasting it — see isUnreconciledEcho.
 */
function echoNormalize(s: string): string {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const next = sanitizePassApprox(cur);
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

/**
 * Whether `optimistic` is an unreconciled local row for the same send that
 * `candidate` (a fresh server-sourced "sent" row) represents — i.e. the
 * server did persist the send but the local row never learned that, because
 * its chat_send_ok ack was lost. Shared by addMessage's live-broadcast path
 * and setMessages' resync merge so the two never grow divergent notions of
 * "same message".
 *
 * Bounded to avoid collapsing two genuinely distinct sends that happen to
 * share text: only rows still actually awaiting reconciliation qualify —
 * "pending", or "failed" for a reason (OFFLINE) that means the send may
 * still have gone through despite the local failure. A server-rejected send
 * (SLOW_MODE/FORBIDDEN/...) is never broadcast or replayed, so no echo can
 * legitimately arrive for it; matching those would silently eat a row the
 * user still needs to retry. Beyond that, callers must consume each
 * candidate at most once (findIndex + a seen-set) so N identical pending
 * sends match N identical real messages one-to-one instead of collapsing
 * onto a single row.
 */
function isUnreconciledEcho(optimistic: Message, candidate: Message): boolean {
  return (
    (optimistic.status === "pending" ||
      (optimistic.status === "failed" && optimistic.errorCode === "OFFLINE")) &&
    optimistic.correlationId !== null &&
    optimistic.user.id === candidate.user.id &&
    (optimistic.content === candidate.content ||
      echoNormalize(optimistic.content) === candidate.content)
  );
}

/**
 * Append a new message from a chat_message WS event, reconciling with any
 * optimistic row it corresponds to.
 *
 * Reconciliation (the server sends chat_send_ok before the broadcast, so by the
 * time our own echo arrives the optimistic row already carries its real id):
 *   1. If a row with the same real id exists, replace it in place — this turns
 *      an optimistic "sent" row into the full server message (attachments,
 *      sanitized content, server timestamp) and is idempotent against replay.
 *   2. Otherwise, defensively reconcile the oldest still-pending (or
 *      OFFLINE-failed) row from the same author (covers a broadcast that
 *      raced ahead of its ack, or one the offline sweep gave up on before
 *      learning the server had already stored it).
 *   3. Otherwise, append as a new message.
 */
export function addMessage(payload: ChatMessagePayload): void {
  const message = chatPayloadToMessage(payload);
  messagesStore.setState((prev) => {
    const channelId = message.channelId;
    const existing = prev.messagesByChannel.get(channelId) ?? [];

    // 1. Replace an existing row with the same real id (reconcile / idempotent).
    const idIdx = existing.findIndex((m) => m.id !== 0 && m.id === message.id);
    if (idIdx !== -1) {
      const replaced = existing.map((m, i) => (i === idIdx ? message : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(channelId, replaced);
      return { ...prev, messagesByChannel: updated };
    }

    // 2. Defensive: reconcile the oldest pending (or transport-failed) optimistic
    //    row from this author (a broadcast that arrived before its chat_send_ok
    //    ack, or arrived after the dispatcher's offline sweep gave up on a send
    //    that had actually gone through). Scoped to OFFLINE — a server-rejected
    //    send (SLOW_MODE/FORBIDDEN/...) is never broadcast, so no echo can ever
    //    arrive for it, and eating that row here would silently drop the retry
    //    the user still needs. Content must match too (allowing for the
    //    server's sanitization — see echoNormalize) — a same-author message
    //    from another session of this account carries genuinely different
    //    content, and consuming the pending row for it would orphan the real
    //    send.
    const pendingIdx = existing.findIndex((m) => isUnreconciledEcho(m, message));
    if (pendingIdx !== -1) {
      const replaced = existing.map((m, i) => (i === pendingIdx ? message : m));
      const updated = new Map(prev.messagesByChannel);
      updated.set(channelId, replaced);
      return { ...prev, messagesByChannel: updated };
    }

    // 3. Append as a new message — unless the channel is showing a detached
    //    around-window, in which case the new message belongs to the live tail
    //    below the gap and must wait for "Jump to Present".
    if (prev.detachedChannels.has(channelId)) return prev;

    // Insert before any trailing unreconciled optimistic row(s) rather than
    // blindly appending at the tail. An optimistic row (status !== "sent")
    // has no real server id/timestamp yet — confirmSend will stamp it in
    // place once its ack arrives — so a message that commits and broadcasts
    // *while our own send is still in flight* must land ahead of it, or the
    // eventually-stamped row (a later server id/timestamp) ends up rendered
    // above an older message it should follow. Rows before the trailing
    // unreconciled run are already "sent" and keep their position.
    let insertAt = existing.length;
    while (insertAt > 0 && existing[insertAt - 1]!.status !== "sent") {
      insertAt--;
    }
    let updatedMsgs = [...existing.slice(0, insertAt), message, ...existing.slice(insertAt)];
    // Evict oldest messages if over the cap
    if (updatedMsgs.length > MAX_MESSAGES_PER_CHANNEL) {
      updatedMsgs = updatedMsgs.slice(updatedMsgs.length - MAX_MESSAGES_PER_CHANNEL);
    }
    const updated = new Map(prev.messagesByChannel);
    updated.set(channelId, updatedMsgs);
    // If we evicted, there are now more messages on the server above
    const updatedHasMore = new Map(prev.hasMore);
    if (existing.length + 1 > MAX_MESSAGES_PER_CHANNEL) {
      updatedHasMore.set(channelId, true);
    }
    return { ...prev, messagesByChannel: updated, hasMore: updatedHasMore };
  });
}

/**
 * Insert an optimistic pending row for a message the user just sent. The row
 * carries the correlationId returned by ws.send and renders immediately as
 * "sending"; confirmSend / markSendFailed reconcile it against the server.
 */
export function addOptimisticMessage(params: {
  correlationId: string;
  channelId: number;
  user: MessageUser;
  content: string;
  replyTo: number | null;
  attachments?: readonly Attachment[];
  timestamp: string;
}): void {
  const optimistic: Message = {
    id: 0,
    channelId: params.channelId,
    user: params.user,
    content: params.content,
    replyTo: params.replyTo,
    attachments: params.attachments ?? [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: params.timestamp,
    status: "pending",
    correlationId: params.correlationId,
    errorCode: null,
  };
  messagesStore.setState((prev) => {
    const existing = prev.messagesByChannel.get(params.channelId) ?? [];
    const updated = new Map(prev.messagesByChannel);
    updated.set(params.channelId, [...existing, optimistic]);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.set(params.correlationId, params.channelId);
    return { ...prev, messagesByChannel: updated, pendingSends: updatedPending };
  });
}

/** Mark an optimistic row as failed so the UI can offer retry. */
export function markSendFailed(correlationId: string, errorCode: string | null): void {
  messagesStore.setState((prev) => {
    const channelId = prev.pendingSends.get(correlationId);
    if (channelId === undefined) return prev;
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) return prev;
    const updatedList = existing.map((m) =>
      m.correlationId === correlationId ? { ...m, status: "failed" as const, errorCode } : m,
    );
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  });
}

/** Remove an optimistic row (retry discards the old row; delete-draft dismisses it). */
export function removeOptimistic(correlationId: string): void {
  messagesStore.setState((prev) => {
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);

    // A "failed" row has already been dropped from pendingSends by
    // markSendFailed, so pendingSends can't tell us its channel — scan for
    // the row itself instead. This is the common case: Retry/Delete only
    // render for status==="failed" rows (renderers.ts), so a pendingSends
    // hit here would mean removeOptimistic raced ahead of the row ever
    // failing.
    const channelId = prev.pendingSends.get(correlationId);
    if (channelId !== undefined) {
      const existing = prev.messagesByChannel.get(channelId);
      if (existing === undefined) {
        return { ...prev, pendingSends: updatedPending };
      }
      const filtered = existing.filter((m) => m.correlationId !== correlationId);
      const updatedMessages = new Map(prev.messagesByChannel);
      updatedMessages.set(channelId, filtered);
      return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
    }

    for (const [cid, list] of prev.messagesByChannel) {
      if (!list.some((m) => m.correlationId === correlationId)) continue;
      const filtered = list.filter((m) => m.correlationId !== correlationId);
      const updatedMessages = new Map(prev.messagesByChannel);
      updatedMessages.set(cid, filtered);
      return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
    }

    return { ...prev, pendingSends: updatedPending };
  });
}

/**
 * Mark a channel's first-page history fetch as in flight. Also records a
 * watermark of the highest message id present right now, consumed by the
 * matching setMessages call to tell "nothing arrived after this snapshot" (an
 * empty result really means empty) apart from "no snapshot was taken" — see
 * MessagesState.loadWatermark.
 */
export function setChannelLoading(channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.historyLoadState);
    updated.set(channelId, "loading");
    const existing = prev.messagesByChannel.get(channelId) ?? [];
    const currentMaxId = existing.reduce((max, m) => Math.max(max, m.id), 0);
    const updatedWatermark = new Map(prev.loadWatermark ?? []);
    updatedWatermark.set(channelId, currentMaxId);
    return { ...prev, historyLoadState: updated, loadWatermark: updatedWatermark };
  });
}

/** Mark a channel's first-page history fetch as failed (the region offers Retry). */
export function setChannelLoadError(channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.historyLoadState);
    updated.set(channelId, "error");
    return { ...prev, historyLoadState: updated };
  });
}

/** Bulk set messages from a REST response. Marks channel as loaded.
 *  The server returns messages newest-first; we reverse to chronological order.
 *
 *  Merges rather than clobbers: a live broadcast or an optimistic send can
 *  land while the fetch is in flight, and the snapshot predates those rows —
 *  replacing wholesale would silently discard them (and loadedChannels then
 *  blocks any refetch until a full reload). Rows from the previous array are
 *  carried over when they are pending/failed, or "sent" but newer than
 *  anything in the snapshot. */
export function setMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).toReversed();
  const trimmed =
    converted.length > MAX_MESSAGES_PER_CHANNEL
      ? converted.slice(converted.length - MAX_MESSAGES_PER_CHANNEL)
      : converted;
  messagesStore.setState((prev) => {
    const previous = prev.messagesByChannel.get(channelId) ?? [];
    const snapshotIds = new Set(trimmed.map((m) => m.id));
    const maxSnapshotId = trimmed.reduce((max, m) => Math.max(max, m.id), 0);
    // A "sent" row survives only if it arrived after the fetch actually
    // started — maxSnapshotId alone can't tell that apart from "the snapshot
    // was empty" (id > 0 is vacuously true for a purged/empty page's own
    // default of 0). The watermark setChannelLoading recorded at fetch start
    // is the floor: a row already present then is stale once an empty/smaller
    // page comes back, while a live broadcast that landed mid-fetch (id above
    // the watermark) is still newer than either bound and survives either way.
    const carryFloor = Math.max(maxSnapshotId, prev.loadWatermark?.get(channelId) ?? 0);
    // A pending/OFFLINE-failed row whose chat_send_ok ack was lost to the same
    // disconnect that forced this resync would otherwise survive forever
    // (its id stays 0, so it can never collide with the real id above) while
    // the fresh snapshot already carries its persisted echo — drop it rather
    // than show both. Each snapshot row is consumed by at most one carried
    // row so two genuinely distinct sends with identical text each keep a row.
    const consumedEchoes = new Set<number>();
    const carried = previous.filter((m) => {
      if (snapshotIds.has(m.id)) return false;
      if (m.status === "sent") return m.id > carryFloor;
      const echoIdx = trimmed.findIndex(
        (s, i) => !consumedEchoes.has(i) && isUnreconciledEcho(m, s),
      );
      if (echoIdx === -1) return true;
      consumedEchoes.add(echoIdx);
      return false;
    });
    let merged = carried.length > 0 ? [...trimmed, ...carried] : trimmed;
    const mergeTrimmed = merged.length > MAX_MESSAGES_PER_CHANNEL;
    if (mergeTrimmed) {
      merged = merged.slice(merged.length - MAX_MESSAGES_PER_CHANNEL);
    }

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, merged);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.add(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.set(
      channelId,
      hasMore || converted.length > MAX_MESSAGES_PER_CHANNEL || mergeTrimmed,
    );

    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);

    // Loading the plain tail always reattaches: this *is* the live end.
    const updatedDetached = new Set(prev.detachedChannels);
    updatedDetached.delete(channelId);

    // The watermark's job ends here — it was consumed as carryFloor above.
    const updatedWatermark = new Map(prev.loadWatermark ?? []);
    updatedWatermark.delete(channelId);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
      detachedChannels: updatedDetached,
      loadWatermark: updatedWatermark,
    };
  });
}

/**
 * Replace a channel's loaded window with an around-window centred on a jump
 * target. Unlike setMessages the payload is already oldest-first, so it is not
 * reversed.
 *
 * `hasMoreAfter` marks the window as detached from the live tail: the list
 * offers "Jump to Present" and live broadcasts stop being appended until
 * reattachToPresent (or a fresh setMessages) lands.
 *
 * Carries unreconciled (pending/failed) rows across the replacement exactly
 * like setMessages does — they are the only copy of the user's composed
 * text, and a jump elsewhere must not silently destroy an in-flight send or
 * orphan its Retry draft. When the window reattaches to the live tail it also
 * carries any "sent" row newer than the window, for the same reason
 * setMessages protects a live broadcast that landed mid-fetch: a reattached
 * window claims to BE the live tail, and dropping such a row here would
 * delete it with no badge, no "Jump to Present" pill, and no recovery path.
 */
export function setAroundMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): void {
  const converted = messages.map(messageResponseToMessage);
  // Defensive: the server caps a window at 100, so this never fires today.
  // If it ever does, keep the older head — dropping the newest end is what the
  // detached flag below already describes, whereas dropping the head would
  // silently move the window past the jump target.
  const trimmed =
    converted.length > MAX_MESSAGES_PER_CHANNEL
      ? converted.slice(0, MAX_MESSAGES_PER_CHANNEL)
      : converted;
  messagesStore.setState((prev) => {
    const previous = prev.messagesByChannel.get(channelId) ?? [];
    // Reattaches iff the window reaches the live tail with nothing stranded —
    // the exact negation of the detached condition below. Only then does the
    // window claim to BE "now", so only then may a live "sent" row newer than
    // it survive; a window that stays detached makes no such claim, and that
    // message is instead represented by the "Jump to Present" pill (plus the
    // unread bump) once it lands for real.
    const attached = !hasMoreAfter && trimmed.length === converted.length;
    const maxWindowId = trimmed.reduce((max, m) => Math.max(max, m.id), 0);
    const carried = previous.filter((m) => m.status !== "sent" || (attached && m.id > maxWindowId));
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, carried.length > 0 ? [...trimmed, ...carried] : trimmed);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.add(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.set(channelId, hasMoreBefore);

    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);

    const updatedDetached = new Set(prev.detachedChannels);
    if (attached) {
      updatedDetached.delete(channelId);
    } else {
      updatedDetached.add(channelId);
    }

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
      detachedChannels: updatedDetached,
    };
  });
}

/**
 * Invalidate every channel's loaded window after a full-ready resync (see
 * dispatcher.ts's `ready` handler). That tier never replays missed
 * chat_message frames — only a fresh connect and a full resync send `ready`
 * at all, and a successful seq-based replay reconnect doesn't — so a channel
 * loaded before the drop would otherwise keep a permanent hole in its
 * history for the rest of the session.
 *
 * Carries pending/failed optimistic rows exactly like setMessages' merge —
 * they are the only copy of an unsent message — but drops "sent" rows so the
 * next fetch rebuilds a contiguous window instead of leaving stale rows
 * above a gap the fetch has no way to detect.
 */
export function invalidateLoadedMessageWindows(): void {
  messagesStore.setState((prev) => {
    if (prev.loadedChannels.size === 0) return prev;
    const updatedMessages = new Map(prev.messagesByChannel);
    for (const channelId of prev.loadedChannels) {
      const existing = updatedMessages.get(channelId);
      if (existing === undefined) continue;
      const carried = existing.filter((m) => m.status !== "sent");
      if (carried.length > 0) {
        updatedMessages.set(channelId, carried);
      } else {
        updatedMessages.delete(channelId);
      }
    }
    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: new Set(),
      hasMore: new Map(),
      detachedChannels: new Set(),
    };
  });
}

/**
 * Drop one channel's loaded flag so the next history fetch reloads the live
 * tail. The server only delivers live broadcasts for the focused channel, so
 * a window left behind on a channel switch stops updating the moment focus
 * moves away — the next visit must refetch instead of short-circuiting on
 * "already loaded". The rows themselves are kept (the old window stays
 * rendered until the refetch lands) and setMessages' merge carries
 * pending/failed rows across that refetch. Like reattachToPresent, this
 * leaves detachedChannels alone: setMessages clears it once the tail has
 * actually landed, and until then a detached window must keep refusing live
 * broadcasts.
 */
export function invalidateChannelMessageWindow(channelId: number): void {
  messagesStore.setState((prev) => {
    if (!prev.loadedChannels.has(channelId)) return prev;
    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);
    return { ...prev, loadedChannels: updatedLoaded };
  });
}

/**
 * Drop a channel's loaded flag so the next history fetch reloads the live
 * tail — otherwise MessageController short-circuits on "already loaded" and
 * the stale window stays on screen.
 *
 * Deliberately does NOT clear detachedChannels itself: that flag is what
 * keeps the "Jump to Present" pill visible and blocks addMessage from
 * appending a live broadcast onto the stale around-window. setMessages
 * clears it on success, once the tail has actually landed — if that refetch
 * fails instead, the channel must stay detached so a live broadcast can't
 * splice onto history with a silent gap.
 */
export function reattachToPresent(channelId: number): void {
  messagesStore.setState((prev) => {
    if (!prev.detachedChannels.has(channelId)) return prev;
    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);
    return { ...prev, loadedChannels: updatedLoaded };
  });
}

/** Prepend older messages for infinite scroll.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function prependMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).toReversed();
  messagesStore.setState((prev) => {
    const existing = prev.messagesByChannel.get(channelId) ?? [];
    let combined = [...converted, ...existing];
    // Keep the OLDEST rows (start of array) when the cap is exceeded: the
    // user is scrolling up, so the fetched page must survive — trimming it
    // would make every cap-hit prepend a content-identical no-op that
    // refetches the same page forever. Dropped "sent" rows are restored via
    // the detached-window machinery ("Jump to Present"), mirroring
    // setAroundMessages' window semantics — but pending/failed rows in the
    // tail are the only copy of the user's composed text, so they are carried
    // across the trim exactly as every other window-replacing writer does.
    const wasTrimmed = combined.length > MAX_MESSAGES_PER_CHANNEL;
    if (wasTrimmed) {
      const kept = combined.slice(0, MAX_MESSAGES_PER_CHANNEL);
      const carried = combined.slice(MAX_MESSAGES_PER_CHANNEL).filter((m) => m.status !== "sent");
      combined = carried.length > 0 ? [...kept, ...carried] : kept;
    }
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, combined);

    const updatedHasMore = new Map(prev.hasMore);
    // Trimming drops rows below the window, never above it, so "more above"
    // is exactly what the server said.
    updatedHasMore.set(channelId, hasMore);

    const updatedDetached = new Set(prev.detachedChannels);
    if (wasTrimmed) {
      updatedDetached.add(channelId);
    }

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      hasMore: updatedHasMore,
      detachedChannels: updatedDetached,
    };
  });
}

/** Update message content and editedAt from a chat_edited WS event. */
export function editMessage(payload: ChatEditedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id
        ? {
            ...msg,
            content: payload.content,
            editedAt: payload.edited_at,
            mentions: payload.mentions,
            mentionsEveryone: payload.mentions_everyone,
          }
        : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Soft-delete: mark message as deleted but keep in array. */
export function deleteMessage(payload: ChatDeletedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id ? { ...msg, deleted: true } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/**
 * Soft-delete every id in one purge. Renders exactly like a single delete —
 * the rows stay as tombstones — but touches the channel's list once instead of
 * once per message.
 */
export function bulkDeleteMessages(payload: ChatBulkDeletedPayload): void {
  if (payload.ids.length === 0) return;
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const purged = new Set(payload.ids);
    if (!channelMessages.some((msg) => purged.has(msg.id) && !msg.deleted)) return prev;

    const updatedList = channelMessages.map((msg) =>
      purged.has(msg.id) ? { ...msg, deleted: true } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Toggle the pinned state of a message (optimistic update after API call). */
export function setMessagePinned(channelId: number, messageId: number, pinned: boolean): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(channelId);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === messageId ? { ...msg, pinned } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Track a pending outbound message send. */
export function addPendingSend(correlationId: string, channelId: number): void {
  messagesStore.setState((prev) => {
    const updated = new Map(prev.pendingSends);
    updated.set(correlationId, channelId);
    return { ...prev, pendingSends: updated };
  });
}

/**
 * Confirm a pending send from a chat_send_ok ack: stamp the optimistic row with
 * its real server id + timestamp and mark it "sent". The subsequent
 * chat_message broadcast then reconciles by real id (addMessage step 1),
 * upgrading the row to the full server message. Removing it from pendingSends
 * makes a late error a no-op.
 */
export function confirmSend(correlationId: string, messageId: number, timestamp: string): void {
  messagesStore.setState((prev) => {
    const channelId = prev.pendingSends.get(correlationId);
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.delete(correlationId);
    if (channelId === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const existing = prev.messagesByChannel.get(channelId);
    if (existing === undefined) {
      return { ...prev, pendingSends: updatedPending };
    }
    const updatedList = existing.map((m) =>
      m.correlationId === correlationId
        ? { ...m, id: messageId, timestamp, status: "sent" as const, errorCode: null }
        : m,
    );
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    return { ...prev, messagesByChannel: updatedMessages, pendingSends: updatedPending };
  });
}

/** Clear all messages for a channel. */
export function clearChannelMessages(channelId: number): void {
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.delete(channelId);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.delete(channelId);

    const updatedLoadState = new Map(prev.historyLoadState);
    updatedLoadState.delete(channelId);

    const updatedDetached = new Set(prev.detachedChannels);
    updatedDetached.delete(channelId);

    const updatedWatermark = new Map(prev.loadWatermark ?? []);
    updatedWatermark.delete(channelId);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      historyLoadState: updatedLoadState,
      detachedChannels: updatedDetached,
      loadWatermark: updatedWatermark,
    };
  });
}

/**
 * Apply a single reaction count/me delta to a channel's message list, or null
 * when the message is not loaded (nothing to update). Shared by the
 * server-echo path, the optimistic apply, and its rollback (which applies the
 * inverse action) so the three can never disagree about the arithmetic.
 */
function applyReactionDelta(
  prev: MessagesState,
  { channelId, messageId, emoji, action }: PendingReaction,
  isMe: boolean,
): ReadonlyMap<number, readonly Message[]> | null {
  const channelMessages = prev.messagesByChannel.get(channelId);
  if (!channelMessages) return null;

  const updatedList = channelMessages.map((msg) => {
    if (msg.id !== messageId) return msg;

    const existing = msg.reactions;
    if (action === "add") {
      const found = existing.find((r) => r.emoji === emoji);
      if (found !== undefined) {
        const updatedReactions = existing.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, me: r.me || isMe } : r,
        );
        return { ...msg, reactions: updatedReactions };
      }
      return { ...msg, reactions: [...existing, { emoji, count: 1, me: isMe }] };
    }

    // action === "remove"
    const updatedReactions = existing
      .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, me: isMe ? false : r.me } : r))
      .filter((r) => r.count > 0);
    return { ...msg, reactions: updatedReactions };
  });

  const updatedMessages = new Map(prev.messagesByChannel);
  updatedMessages.set(channelId, updatedList);
  return updatedMessages;
}

/**
 * Apply the user's own reaction toggle locally before the server confirms it —
 * the pill reacts to the click, not to the round-trip (ux/messaging §5) — and
 * register it under the send's correlation id. updateReaction consumes the
 * matching self-echo (instead of re-applying it), and rollbackReaction
 * reverts the toggle when the send errors.
 */
export function addOptimisticReaction(correlationId: string, toggle: PendingReaction): void {
  messagesStore.setState((prev) => {
    const updatedMessages = applyReactionDelta(prev, toggle, true);
    if (updatedMessages === null) return prev;
    const updatedPending = new Map(prev.pendingReactions ?? []);
    updatedPending.set(correlationId, toggle);
    return { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending };
  });
}

/**
 * Roll back an optimistic reaction toggle whose send failed (server error
 * reply or local transport failure) by applying the inverse delta. Returns
 * whether the correlation id matched a pending toggle, so the dispatcher's
 * error handler knows the failed envelope was a reaction's.
 */
export function rollbackReaction(correlationId: string): boolean {
  let found = false;
  messagesStore.setState((prev) => {
    const toggle = prev.pendingReactions?.get(correlationId);
    if (toggle === undefined) return prev;
    found = true;
    const updatedPending = new Map(prev.pendingReactions);
    updatedPending.delete(correlationId);
    const inverse: PendingReaction = {
      ...toggle,
      action: toggle.action === "add" ? "remove" : "add",
    };
    const updatedMessages = applyReactionDelta(prev, inverse, true);
    if (updatedMessages === null) {
      return { ...prev, pendingReactions: updatedPending };
    }
    return { ...prev, messagesByChannel: updatedMessages, pendingReactions: updatedPending };
  });
  return found;
}

/** Update reactions on a message from a reaction_update WS event. */
export function updateReaction(payload: ReactionUpdatePayload, currentUserId: number): void {
  messagesStore.setState((prev) => {
    const isMe = payload.user_id === currentUserId;

    // The echo of an optimistic toggle: consume it instead of re-applying —
    // the delta arithmetic above would double-count otherwise. Matched by
    // content, not envelope id (broadcasts carry no request correlation).
    if (isMe) {
      for (const [cid, t] of prev.pendingReactions ?? []) {
        if (
          t.channelId === payload.channel_id &&
          t.messageId === payload.message_id &&
          t.emoji === payload.emoji &&
          t.action === payload.action
        ) {
          const updatedPending = new Map(prev.pendingReactions);
          updatedPending.delete(cid);
          return { ...prev, pendingReactions: updatedPending };
        }
      }
    }

    const updatedMessages = applyReactionDelta(
      prev,
      {
        channelId: payload.channel_id,
        messageId: payload.message_id,
        emoji: payload.emoji,
        action: payload.action,
      },
      isMe,
    );
    if (updatedMessages === null) return prev;
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Reset the entire store to its initial (empty) state — e.g. on logout. */
export function resetMessagesStore(): void {
  messagesStore.setState(() => INITIAL_STATE);
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/** Get messages for a channel, or empty array if none loaded. */
export function getChannelMessages(channelId: number): readonly Message[] {
  return messagesStore.select((s) => s.messagesByChannel.get(channelId) ?? []);
}

/** Check whether initial messages have been loaded for a channel. */
export function isChannelLoaded(channelId: number): boolean {
  return messagesStore.select((s) => s.loadedChannels.has(channelId));
}

/** Check whether a channel has more older messages to fetch. */
export function hasMoreMessages(channelId: number): boolean {
  return messagesStore.select((s) => s.hasMore.get(channelId) ?? false);
}

/** First-page history fetch state for a channel; null when idle/loaded. */
export function getHistoryLoadState(channelId: number): "loading" | "error" | null {
  return messagesStore.select((s) => s.historyLoadState.get(channelId) ?? null);
}

/**
 * Whether the channel's loaded window is an around-window detached from the
 * live tail — newer messages exist below what is rendered.
 */
export function isWindowDetached(channelId: number): boolean {
  return messagesStore.select((s) => s.detachedChannels.has(channelId));
}

/** Whether a message id is present in a channel's loaded window. */
export function hasMessageLoaded(channelId: number, messageId: number): boolean {
  return messagesStore.select(
    (s) => s.messagesByChannel.get(channelId)?.some((m) => m.id === messageId) ?? false,
  );
}
