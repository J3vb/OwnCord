/**
 * Explicit mark-as-read, for affordances that clear a badge without opening
 * the channel (the channel context menu, "Mark Server as Read").
 *
 * Opening a channel already marks it read via `channel_focus`. That message
 * also rebinds the connection's focused channel, so it is the wrong tool here:
 * marking a channel the user is *not* looking at must not move focus off the
 * one on screen. The server has a dedicated `mark_read` for exactly this.
 */

import { channelsStore, clearUnread, setReadPointer } from "@stores/channels.store";
import { dmStore, clearDmUnread, setDmReadPointer } from "@stores/dm.store";
import { isWindowDetached } from "@stores/messages.store";
import { uiStore } from "@stores/ui.store";
import { dialogOpen } from "./ui/dialogOpen";
import { readPointerEnabled } from "./net/serverCapabilities";

/** Channels whose mounted list is scrolled away from the live tail. */
const liveTailOutOfView = new Set<number>();

/**
 * Record whether the mounted list for a channel shows its live tail. The list
 * calls this from its scroll handler, before the new-message path runs, so the
 * flag describes the position a new arrival lands against.
 */
export function setLiveTailInView(channelId: number, inView: boolean): void {
  if (inView) {
    liveTailOutOfView.delete(channelId);
  } else {
    liveTailOutOfView.add(channelId);
    // The reader scrolled off the tail since Mark Unread: see `unreadHold`.
    noteAwayUnread(channelId);
  }
}

/**
 * The reader has been away from a held channel (scrolled off the tail, or the
 * window blurred or the list detached when a message was counted unread): a
 * live arrival may now release the hold. See `unreadHold`.
 */
export function noteAwayUnread(channelId: number): void {
  if (unreadHold.has(channelId)) unreadHold.set(channelId, true);
}

/**
 * Whether the reader is away from a channel: its loaded window is detached from
 * the live tail, the list is scrolled away from the tail, or the app window is
 * not focused. "Active" only means "the reader is watching" when this
 * is false, so a message landing while away counts as unread and a `ready`
 * resync must not mark the channel read. The focus source is
 * `document.hasFocus()`, as in `lib/notifications.ts`.
 */
export function isChannelAway(channelId: number): boolean {
  return !document.hasFocus() || isWindowDetached(channelId) || liveTailOutOfView.has(channelId);
}

/**
 * Whether something full-screen sits over the chat although the channel is
 * still active: the Settings overlay (the list stays mounted and the window
 * stays focused behind it), a content view, or an open modal dialog such as the
 * Quick Switcher. `isChannelAway` cannot see
 * either, and must not change (it decides unread counting), so the paths that
 * mark a channel read for messages "seen live" ask this as well.
 */
export function isChannelCovered(): boolean {
  const { settingsOpen, activeView } = uiStore.getState();
  return settingsOpen || activeView !== null || dialogOpen();
}

/** Sends one `mark_read` over the socket, up to `messageId` when given. */
export type MarkReadSender = (channelId: number, messageId?: number) => void;

let sender: MarkReadSender | null = null;

/**
 * Register the socket sender. Called once from MainPage with the live WsClient,
 * mirroring how the attachment renderer is given the server host. Until it is
 * set, marking read still clears the local badges — the next `ready` re-asserts
 * the server's view, so a dropped send self-corrects rather than lying forever.
 */
export function setMarkReadSender(next: MarkReadSender | null): void {
  sender = next;
  resetReadPointerState();
  cancelPendingLiveSeen();
  // A re-registration means a new connection (MainPage mounts once per
  // session), so anything `markAllRead` still had queued belongs to the
  // previous server. Channel ids are per-server, so letting those fire would
  // mark the *new* server's same-numbered channel read.
  cancelPendingMarkAll();
}

/**
 * Mark one channel read: advance the server read state and drop the local
 * unread/mention badges. Works for DMs too — the badge lives in dm.store for
 * those, and clearing the other store is a no-op.
 *
 * No-op for a channel this client does not know, so a stale menu cannot ask the
 * server to advance a read state for something that is not in the user's list.
 */
export function markChannelRead(channelId: number): void {
  // Asked for "read" outright (Mark as Read, jump to present): a Mark Unread
  // hold has been overruled.
  unreadHold.delete(channelId);
  if (!isKnownChannel(channelId)) return;

  sender?.(channelId);
  clearUnread(channelId);
  clearDmUnread(channelId);
}

/** Whether a channel's row shows a badge. A voice row draws only the mention
 *  badge, so its plain unread count never counts. */
function showsBadge(ch: { type: string; unreadCount: number; mentionCount: number }): boolean {
  return ch.mentionCount > 0 || (ch.type !== "voice" && ch.unreadCount > 0);
}

/** Whether a channel has anything unread, badge or not. The mark-read paths
 *  use it, so a voice chat's plain unread is still marked read when seen. */
export function hasUnread(channelId: number): boolean {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined && (ch.unreadCount > 0 || ch.mentionCount > 0)) return true;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm !== undefined && (dm.unreadCount > 0 || dm.mentionCount > 0);
}

/** Whether a channel currently shows an unread or mention badge — what decides
 *  if "Mark as Read" is offered as an enabled action. */
export function showsUnreadBadge(channelId: number): boolean {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined && showsBadge(ch)) return true;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm !== undefined && (dm.unreadCount > 0 || dm.mentionCount > 0);
}

export interface UnreadScope {
  /** Whether direct messages are included. Default true. The server header's
   *  "Mark Server as Read" passes false: DMs are not part of the server. */
  readonly includeDms?: boolean;
}

/** Ids of every channel and DM that currently shows a badge (DMs left out when
 *  `includeDms` is false — their channels-store mirror rows too). */
export function unreadChannelIds(opts: UnreadScope = {}): readonly number[] {
  const includeDms = opts.includeDms ?? true;
  const ids = new Set<number>();
  for (const ch of channelsStore.getState().channels.values()) {
    if (!includeDms && ch.type === "dm") continue;
    if (showsBadge(ch)) ids.add(ch.id);
  }
  if (includeDms) {
    for (const dm of dmStore.getState().channels) {
      if (dm.unreadCount > 0 || dm.mentionCount > 0) ids.add(dm.channelId);
    }
  }
  return [...ids];
}

/**
 * The server's `mark_read` handler has its own 5-per-second-per-user budget,
 * separate from `channel_focus` (Server/ws/handlers_presence.go), and
 * silently drops frames over that budget — no error reaches the client. A
 * burst of `mark_read` sends larger than the budget would still clear every
 * local badge (see `markChannelRead`), so the excess channels' badges would
 * resurrect on the next `ready` once the server re-asserts its own unread
 * counts. Pacing the burst to below the budget keeps every send inside a
 * window the server actually honours.
 */
const MARK_ALL_READ_BURST_SIZE = 4;
const MARK_ALL_READ_BURST_INTERVAL_MS = 1100;

/** Channels still waiting for their `mark_read` frame, each with its
 *  unread+mention total at click time. One queue is shared by every caller of
 *  `markChannelsRead`, so overlapping calls merge instead of dropping each
 *  other's unsent tail. A re-registered sender (new connection) empties it. */
let markQueue: Array<{ readonly id: number; readonly snapshot: number }> = [];
/** When each frame sent inside the current pacing window went out. */
let markSentAt: number[] = [];
let markTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingMarkAll(): void {
  if (markTimer !== null) clearTimeout(markTimer);
  markTimer = null;
  markQueue = [];
  markSentAt = [];
}

/** Send as many queued channels as the window allows, then re-arm for the rest. */
function drainMarkQueue(): void {
  markTimer = null;
  const now = Date.now();
  markSentAt = markSentAt.filter((t) => now - t < MARK_ALL_READ_BURST_INTERVAL_MS);
  while (markQueue.length > 0 && markSentAt.length < MARK_ALL_READ_BURST_SIZE) {
    const next = markQueue.shift()!;
    // A message that arrived after the click was never seen: skip its send,
    // and spend no budget on it.
    if (unreadTotal(next.id) > next.snapshot) continue;
    markChannelRead(next.id);
    markSentAt.push(now);
  }
  if (markQueue.length > 0) {
    const wait = Math.max(0, markSentAt[0]! + MARK_ALL_READ_BURST_INTERVAL_MS - now);
    markTimer = setTimeout(drainMarkQueue, wait);
  }
}

/** Sum of a channel or DM's unread + mention counts, from whichever store
 *  knows it. 0 for a channel this client does not (or no longer) know. */
function unreadTotal(channelId: number): number {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined) return ch.unreadCount + ch.mentionCount;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm !== undefined ? dm.unreadCount + dm.mentionCount : 0;
}

/**
 * Mark every unread channel and DM read (DMs skipped with `{ includeDms: false }`,
 * for the server-scoped action). Returns how many were marked, so the caller can
 * stay silent when there was nothing to do.
 *
 * Sent in bursts of `MARK_ALL_READ_BURST_SIZE` spaced `MARK_ALL_READ_BURST_INTERVAL_MS`
 * apart — see the budget note above. Each channel's local badge is cleared at
 * the moment its own frame actually goes out, not up front, so a channel
 * whose send hasn't fired yet still shows unread rather than lying about it.
 *
 * The deferred tail snapshots each channel's unread+mention total at click
 * time and skips its send if that total has grown by the time the timer
 * fires: a message that arrives during the pacing window postdates the click
 * and was never seen, so marking it read would silently wipe a genuinely-new
 * badge (and tell the server the user has read a message they never saw).
 * The synchronous first burst has no such window — nothing can arrive between
 * scheduling and firing in the same tick — so it stays unconditional, as does
 * every other caller of `markChannelRead`.
 */
export function markAllRead(opts: UnreadScope = {}): number {
  return markChannelsRead(unreadChannelIds(opts));
}

/**
 * Mark the given channels read with `markAllRead`'s pacing and click-time
 * snapshot (see its note). A call made while an earlier burst is still pacing
 * merges its ids (deduplicated) into the same queue, so nothing already queued
 * is dropped and the server's per-second budget is never exceeded by two
 * overlapping bursts. Returns how many ids were passed.
 */
export function markChannelsRead(ids: readonly number[]): number {
  const queued = new Set(markQueue.map((q) => q.id));
  for (const id of ids) {
    if (queued.has(id)) continue;
    // Already read (an earlier burst got there first): nothing to send.
    const snapshot = unreadTotal(id);
    if (snapshot === 0) continue;
    queued.add(id);
    markQueue.push({ id, snapshot });
  }
  if (markTimer !== null) clearTimeout(markTimer);
  drainMarkQueue();
  return ids.length;
}

/**
 * How long a live-seen `mark_read` waits for further arrivals. Well inside the
 * server's budget (see above) for any one channel, and short enough that
 * closing the app a moment after a message lands has already advanced the
 * read state.
 */
const LIVE_SEEN_MARK_READ_MS = 1000;

/** One trailing timer per channel whose live arrivals are waiting to be sent. */
const pendingLiveSeen = new Map<number, ReturnType<typeof setTimeout>>();

function cancelPendingLiveSeen(): void {
  for (const t of pendingLiveSeen.values()) clearTimeout(t);
  pendingLiveSeen.clear();
}

/**
 * A message landed at the bottom of a channel the reader is watching (the
 * active channel, window focused, live tail in view), so it is read. The
 * dispatcher deliberately does not count such a message unread, which means no
 * other path tells the server: the next `ready` would bring the channel back
 * as "N new" after a restart. Send `mark_read` for it.
 *
 * Trailing-edge and per channel: the first arrival arms one timer and later
 * ones ride it, so a burst costs one send, the send covers the last message,
 * and sends for one channel stay at least `LIVE_SEEN_MARK_READ_MS` apart.
 * `signal` is the mounted list's lifetime; its abort drops the pending send
 * (leaving the channel is covered by the channel switch, which marks it read).
 *
 * The send is skipped if the channel shows an unread badge by the time it
 * fires: something arrived while the reader was away, and only the reader
 * getting back to the bottom (`MessageList`'s `markReadIfSeen`) may mark that.
 */
export function noteLiveMessageSeen(channelId: number, signal: AbortSignal): void {
  if (signal.aborted || pendingLiveSeen.has(channelId)) return;
  const release = (): void => {
    clearTimeout(timer);
    if (pendingLiveSeen.get(channelId) === timer) pendingLiveSeen.delete(channelId);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", release);
    if (pendingLiveSeen.get(channelId) === timer) pendingLiveSeen.delete(channelId);
    // Settings or a dialog may have opened since the arrival that armed this.
    if (isChannelCovered()) return;
    if (readPointerEnabled()) {
      // What gates the send is the pointer, not a badge: a channel just
      // released from Mark Unread still shows one.
      markChannelReadSeen(channelId);
    } else if (!hasUnread(channelId)) {
      markChannelRead(channelId);
    }
  }, LIVE_SEEN_MARK_READ_MS);
  pendingLiveSeen.set(channelId, timer);
  signal.addEventListener("abort", release, { once: true });
}

/**
 * Best-effort `mark_read` as the app closes. The last messages of a session are
 * usually read live and the throttled send above may not have fired yet; a
 * channel switch marks the old channel read but closing the window does not.
 * Same predicate as the live path: the active channel, with the reader not away
 * from it, nothing covering the chat, and no unread badge (a badge means
 * something arrived unseen).
 */
export function markActiveChannelReadOnUnload(): void {
  const active = channelsStore.getState().activeChannelId;
  if (active === null || isChannelAway(active) || isChannelCovered()) return;
  if (readPointerEnabled()) {
    // The pointer only moves to what was seen, so no unread-badge gate: a
    // message that arrived unseen is simply above the highest seen id.
    cancelPendingLiveSeen();
    sendSeen(active);
    return;
  }
  if (hasUnread(active)) return;
  cancelPendingLiveSeen();
  markChannelRead(active);
}

// -- Read pointer --------------------------------------------------
//
// With the server's `read_pointer` capability, leaving a channel no longer
// marks it read: only what the reader saw does. The mark is a `mark_read` with
// the highest message id that was on screen while they were not away.

/** Highest message id the reader saw per channel while not away. */
const highestSeen = new Map<number, number>();

/**
 * Channels the reader just marked unread (Mark Unread). While a channel is
 * here nothing it shows counts as seen, or the next scroll or live arrival
 * would mark the message read again straight away. The value is whether the
 * reader has been away from the live tail since: only then may a live arrival
 * release the hold. Leaving the channel releases it too.
 */
const unreadHold = new Map<number, boolean>();

interface PendingMarkUnread {
  readonly channelId: number;
  /** The message marked unread: a pointer at or above it is not this request's answer. */
  readonly messageId: number;
  /** The pointer before the optimistic move, to put back on a refusal. */
  readonly previous: number | undefined;
}

/** Mark Unread requests waiting for an answer, by frame id. */
const pendingMarkUnread = new Map<string, PendingMarkUnread>();

/**
 * Drop everything the read pointer tracks: a new session or connection owns
 * the state now. Called when the sender is re-registered and when the
 * dispatcher is torn down.
 */
export function resetReadPointerState(): void {
  threadPointers.clear();
  highestSeen.clear();
  unreadHold.clear();
  pendingMarkUnread.clear();
}

/** A new full `ready` restates every pointer, so a pending Mark Unread (sent on
 *  the old connection) must neither be restored nor toasted against it. */
export function forgetPendingMarkUnread(): void {
  pendingMarkUnread.clear();
}

/**
 * Whether an id is a thread the reader has heard of: `mark_read`
 * accepts a thread id, but a thread is in neither channel store. Set by the
 * threads store when it loads.
 */
let threadKnown: ((id: number) => boolean) | null = null;
export function setKnownThreadCheck(next: ((id: number) => boolean) | null): void {
  threadKnown = next;
}
/** The pointer last sent for a thread; threads live in no channel store. */
const threadPointers = new Map<number, number>();

/** Restate a thread's pointer from the server (ready.threads, read_state): it may move back. */
export function setThreadReadPointer(threadId: number, pointer: number): void {
  threadPointers.set(threadId, pointer);
}

function isKnownChannel(channelId: number): boolean {
  return (
    threadKnown?.(channelId) === true ||
    channelsStore.getState().channels.has(channelId) ||
    dmStore.getState().channels.some((c) => c.channelId === channelId)
  );
}

/** The reader's pointer for a channel or DM; undefined when none was sent. */
function rawPointer(channelId: number): number | undefined {
  return (
    channelsStore.getState().channels.get(channelId)?.lastReadMessageId ??
    threadPointers.get(channelId) ??
    dmStore.getState().channels.find((c) => c.channelId === channelId)?.lastReadMessageId
  );
}

/** The pointer, 0 when none is known. */
const pointerOf = (channelId: number): number => rawPointer(channelId) ?? 0;

/**
 * Write a pointer (and optionally counts) to whichever stores know the id: a
 * DM lives in dmStore and, once opened, in channelsStore as well. With
 * `forwardOnly` a pointer behind the stored one is ignored (the optimistic
 * "read up to here" of a mark_read); without it the pointer may move back
 * (Mark Unread, the server's `read_state`).
 */
export function writeReadPointer(
  channelId: number,
  pointer: number,
  counts?: { readonly unread: number; readonly mention: number },
  forwardOnly = false,
): void {
  const next = forwardOnly ? Math.max(pointer, pointerOf(channelId)) : pointer;
  if (threadKnown?.(channelId) === true) threadPointers.set(channelId, next);
  setReadPointer(channelId, next, counts);
  setDmReadPointer(channelId, next, counts);
}

/**
 * Record that the reader saw `messageId` (the newest message of the window) in
 * a channel. Ignored without the capability, while the reader is away, and
 * while the channel is held after Mark Unread. `live` marks an arrival that
 * landed with the tail in view, the one thing that may release the hold.
 */
export function noteMessageSeen(channelId: number, messageId: number, live = false): void {
  if (!readPointerEnabled() || messageId <= 0 || isChannelAway(channelId)) return;
  if (unreadHold.has(channelId)) {
    if (!live || unreadHold.get(channelId) !== true) return;
    unreadHold.delete(channelId);
  }
  raiseHighestSeen(channelId, messageId);
}

function raiseHighestSeen(channelId: number, messageId: number): void {
  if (messageId > (highestSeen.get(channelId) ?? 0)) highestSeen.set(channelId, messageId);
}

/**
 * Record the newest message a reader scrolling through the list has on screen,
 * short of the live tail. `noteMessageSeen` turns away for a list scrolled off
 * the tail (that is what "away" means for unread counting), which would drop
 * exactly this case: a reader who opens an unread channel and scrolls part way
 * has seen those rows, and leaving must mark them. Here only a blurred window
 * or a detached window counts as away, and a Mark Unread hold still blocks it.
 * Like `noteMessageSeen` it only raises the value, and only records: the send
 * happens on leaving.
 */
export function noteVisibleMessageSeen(channelId: number, messageId: number): void {
  if (!readPointerEnabled() || messageId <= 0) return;
  if (!document.hasFocus() || isWindowDetached(channelId)) return;
  if (unreadHold.has(channelId)) return;
  raiseHighestSeen(channelId, messageId);
}

/**
 * Send `mark_read` up to the highest message seen, when that is above the
 * pointer, and move the local pointer forward to match. Nothing else is
 * recomputed here: the server answers with `read_state`.
 */
function sendSeen(channelId: number): void {
  const seen = highestSeen.get(channelId);
  if (sender === null || seen === undefined || seen <= pointerOf(channelId)) return;
  if (!isKnownChannel(channelId)) return;
  sender(channelId, seen);
  writeReadPointer(channelId, seen, undefined, true);
}

/**
 * The reader reached the bottom, or the channel must be settled (Escape, a
 * ready resync, sending from a detached window): mark read what was seen and
 * clear the local badges. Without the capability this is `markChannelRead`.
 */
export function markChannelReadSeen(channelId: number): void {
  if (!readPointerEnabled()) {
    markChannelRead(channelId);
    return;
  }
  sendSeen(channelId);
  // A channel just marked unread keeps its badge: nothing was seen since.
  if (!unreadHold.has(channelId) && hasUnread(channelId)) {
    clearUnread(channelId);
    clearDmUnread(channelId);
  }
}

/**
 * Leaving a channel. Without the capability that marks it read, as it always
 * has. With it, only what was seen is marked — a channel left with messages
 * unseen keeps its badge — and the channel's seen state is dropped.
 */
export function leaveChannel(channelId: number): void {
  if (!readPointerEnabled()) {
    markChannelRead(channelId);
    return;
  }
  sendSeen(channelId);
  highestSeen.delete(channelId);
  unreadHold.delete(channelId);
}

/** Whether the channel was just marked unread and has not been read since. */
export function isHeldUnread(channelId: number): boolean {
  return unreadHold.has(channelId);
}

/**
 * Mark Unread, the shared half (the click logic is in
 * components/message-list/markUnread.ts): `send` puts the `mark_unread` frame
 * on the wire and returns its id; the local pointer moves to `pointer`, what
 * was seen is forgotten, and the channel is held so nothing on screen marks it
 * read straight away. False, and nothing sent, without the capability or for an
 * unknown channel.
 */
export function beginMarkUnread(
  channelId: number,
  messageId: number,
  pointer: number,
  send: () => string,
): boolean {
  if (!readPointerEnabled() || !isKnownChannel(channelId)) return false;
  const requestId = send();
  pendingMarkUnread.set(requestId, {
    channelId,
    messageId,
    previous: rawPointer(channelId),
  });
  highestSeen.delete(channelId);
  unreadHold.set(channelId, isChannelAway(channelId));
  writeReadPointer(channelId, pointer);
  return true;
}

/**
 * Whether a `read_state` may be applied. While this channel's Mark Unread is
 * waiting for its answer, a pointer at or above the message is an older
 * frame (an earlier mark_read) and would flicker the line back: it is dropped.
 * Any other frame is the answer, and ends the wait.
 */
export function acceptReadState(channelId: number, pointer: number): boolean {
  const waiting = [...pendingMarkUnread].filter(([, p]) => p.channelId === channelId);
  if (waiting.some(([, p]) => pointer >= p.messageId)) return false;
  for (const [id] of waiting) pendingMarkUnread.delete(id);
  return true;
}

const markUnreadFailListeners = new Set<(channelId: number) => void>();

/**
 * Be told when a Mark Unread for any channel failed and its pointer was put
 * back (see `failMarkUnread`), so a mounted list can drop the NEW line the
 * mark drew. Returns the unsubscribe. A `read_state` that answers the mark
 * never notifies: the line stays.
 */
export function onMarkUnreadFailed(listener: (channelId: number) => void): () => void {
  markUnreadFailListeners.add(listener);
  return () => {
    markUnreadFailListeners.delete(listener);
  };
}

/** What to tell the user when a Mark Unread did not happen. */
export type MarkUnreadNotice = "rateLimited" | "notFound" | "failed";

let unreadNotice: ((notice: MarkUnreadNotice) => void) | null = null;

/** Register how a failed Mark Unread is shown (the page's, like the sender). */
export function setMarkUnreadNotice(next: ((notice: MarkUnreadNotice) => void) | null): void {
  unreadNotice = next;
}

/**
 * The Mark Unread whose frame id is `requestId` did not happen (the server
 * refused it, or it never left): put the pointer back, release the hold and
 * say so. False when no such request is pending (another frame, or one from a
 * connection a `ready` has since replaced), so nothing is restored.
 */
export function failMarkUnread(requestId: string | undefined, notice: MarkUnreadNotice): boolean {
  const pending = requestId === undefined ? undefined : pendingMarkUnread.get(requestId);
  if (pending === undefined || requestId === undefined) return false;
  pendingMarkUnread.delete(requestId);
  unreadHold.delete(pending.channelId);
  if (pending.previous !== undefined) writeReadPointer(pending.channelId, pending.previous);
  for (const listener of markUnreadFailListeners) listener(pending.channelId);
  unreadNotice?.(notice);
  return true;
}
