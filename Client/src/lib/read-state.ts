/**
 * Explicit mark-as-read, for affordances that clear a badge without opening
 * the channel (the channel context menu, "Mark All as Read").
 *
 * Opening a channel already marks it read via `channel_focus`. That message
 * also rebinds the connection's focused channel, so it is the wrong tool here:
 * marking a channel the user is *not* looking at must not move focus off the
 * one on screen. The server has a dedicated `mark_read` for exactly this.
 */

import { channelsStore, clearUnread } from "@stores/channels.store";
import { dmStore, clearDmUnread } from "@stores/dm.store";
import { isWindowDetached } from "@stores/messages.store";

/** Channels whose mounted list is scrolled away from the live tail. */
const liveTailOutOfView = new Set<number>();

/**
 * Record whether the mounted list for a channel shows its live tail. The list
 * calls this from its scroll handler, before the new-message path runs, so the
 * flag describes the position a new arrival lands against.
 */
export function setLiveTailInView(channelId: number, inView: boolean): void {
  if (inView) liveTailOutOfView.delete(channelId);
  else liveTailOutOfView.add(channelId);
}

/**
 * Whether the reader is away from a channel: its loaded window is detached from
 * the live tail, the list is scrolled away from the tail, or the app window is
 * not focused (P4-03). "Active" only means "the reader is watching" when this
 * is false, so a message landing while away counts as unread and a `ready`
 * resync must not mark the channel read. The focus source is
 * `document.hasFocus()`, as in `lib/notifications.ts`.
 */
export function isChannelAway(channelId: number): boolean {
  return !document.hasFocus() || isWindowDetached(channelId) || liveTailOutOfView.has(channelId);
}

/** Sends one `mark_read` over the socket. */
export type MarkReadSender = (channelId: number) => void;

let sender: MarkReadSender | null = null;

/**
 * Register the socket sender. Called once from MainPage with the live WsClient,
 * mirroring how the attachment renderer is given the server host. Until it is
 * set, marking read still clears the local badges — the next `ready` re-asserts
 * the server's view, so a dropped send self-corrects rather than lying forever.
 */
export function setMarkReadSender(next: MarkReadSender | null): void {
  sender = next;
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
  const known =
    channelsStore.getState().channels.has(channelId) ||
    dmStore.getState().channels.some((c) => c.channelId === channelId);
  if (!known) return;

  sender?.(channelId);
  clearUnread(channelId);
  clearDmUnread(channelId);
}

/** Whether a channel currently shows an unread or mention badge — what decides
 *  if "Mark as Read" is offered as an enabled action. */
export function hasUnread(channelId: number): boolean {
  const ch = channelsStore.getState().channels.get(channelId);
  if (ch !== undefined && (ch.unreadCount > 0 || ch.mentionCount > 0)) return true;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm !== undefined && (dm.unreadCount > 0 || dm.mentionCount > 0);
}

/** Ids of every channel and DM that currently shows a badge. */
export function unreadChannelIds(): readonly number[] {
  const ids = new Set<number>();
  for (const ch of channelsStore.getState().channels.values()) {
    if (ch.unreadCount > 0 || ch.mentionCount > 0) ids.add(ch.id);
  }
  for (const dm of dmStore.getState().channels) {
    if (dm.unreadCount > 0 || dm.mentionCount > 0) ids.add(dm.channelId);
  }
  return [...ids];
}

/**
 * The server's `mark_read` handler has its own 5-per-second-per-user budget,
 * separate from `channel_focus` (#1331, Server/ws/handlers_presence.go), and
 * silently drops frames over that budget — no error reaches the client. A
 * burst of `mark_read` sends larger than the budget would still clear every
 * local badge (see `markChannelRead`), so the excess channels' badges would
 * resurrect on the next `ready` once the server re-asserts its own unread
 * counts. Pacing the burst to below the budget keeps every send inside a
 * window the server actually honours.
 */
const MARK_ALL_READ_BURST_SIZE = 4;
const MARK_ALL_READ_BURST_INTERVAL_MS = 1100;

/** Timers for the not-yet-sent tail of the current `markAllRead` burst. Held so
 *  a second mark-all, or a new connection, can drop the stale ones instead of
 *  letting them land against a channel list that has since been replaced. */
let pendingMarkAll: Array<ReturnType<typeof setTimeout>> = [];

function cancelPendingMarkAll(): void {
  for (const t of pendingMarkAll) clearTimeout(t);
  pendingMarkAll = [];
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
 * Mark every unread channel and DM read. Returns how many were marked, so the
 * caller can stay silent when there was nothing to do.
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
export function markAllRead(): number {
  // A second click supersedes the first: its own `unreadChannelIds()` already
  // covers everything the earlier burst had not sent yet, so keeping the old
  // timers would only duplicate sends and spend budget twice.
  cancelPendingMarkAll();
  const ids = unreadChannelIds();
  for (const [i, id] of ids.entries()) {
    const delay = Math.floor(i / MARK_ALL_READ_BURST_SIZE) * MARK_ALL_READ_BURST_INTERVAL_MS;
    if (delay === 0) {
      markChannelRead(id);
    } else {
      const snapshot = unreadTotal(id);
      pendingMarkAll.push(
        setTimeout(() => {
          if (unreadTotal(id) <= snapshot) markChannelRead(id);
        }, delay),
      );
    }
  }
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
    if (!hasUnread(channelId)) markChannelRead(channelId);
  }, LIVE_SEEN_MARK_READ_MS);
  pendingLiveSeen.set(channelId, timer);
  signal.addEventListener("abort", release, { once: true });
}

/**
 * Best-effort `mark_read` as the app closes. The last messages of a session are
 * usually read live and the throttled send above may not have fired yet; a
 * channel switch marks the old channel read but closing the window does not.
 * Same predicate as the live path: the active channel, with the reader not away
 * from it and no unread badge (a badge means something arrived unseen).
 */
export function markActiveChannelReadOnUnload(): void {
  const active = channelsStore.getState().activeChannelId;
  if (active === null || isChannelAway(active) || hasUnread(active)) return;
  cancelPendingLiveSeen();
  markChannelRead(active);
}
