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
 * The server's `mark_read` handler shares a 5-per-second-per-user budget with
 * `channel_focus` (Server/ws/handlers_presence.go) and silently drops frames
 * over that budget — no error reaches the client. A burst of `mark_read`
 * sends larger than the budget would still clear every local badge (see
 * `markChannelRead`), so the excess channels' badges would resurrect on the
 * next `ready` once the server re-asserts its own unread counts. Pacing the
 * burst to below the budget, with headroom for a `channel_focus` that may
 * have already spent a slot, keeps every send inside a window the server
 * actually honours.
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

/**
 * Mark every unread channel and DM read. Returns how many were marked, so the
 * caller can stay silent when there was nothing to do.
 *
 * Sent in bursts of `MARK_ALL_READ_BURST_SIZE` spaced `MARK_ALL_READ_BURST_INTERVAL_MS`
 * apart — see the budget note above. Each channel's local badge is cleared at
 * the moment its own frame actually goes out, not up front, so a channel
 * whose send hasn't fired yet still shows unread rather than lying about it.
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
      pendingMarkAll.push(setTimeout(() => markChannelRead(id), delay));
    }
  }
  return ids.length;
}
