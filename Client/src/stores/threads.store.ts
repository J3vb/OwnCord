/**
 * Threads store (WP 6.9c) — the threads this session has heard of, and which
 * one the side panel has open.
 *
 * A thread is a channel row on the server, but it never enters `channelsStore`:
 * the sidebar, quick switcher, autocomplete and unread badge all list parents
 * only. Threads live here, keyed by id and by the message that started
 * them (a parent's own list comes from the list route).
 *
 * Writers: the dispatcher's thread handlers (`thread_create_ok`,
 * `thread_changed`, `thread_deleted` and the `thread` on a live `chat_message`),
 * the history paths in messages.store (the `thread` on a fetched starter row),
 * and the panel's open/close. Every frame carries the thread's whole state, so
 * a later one simply replaces an earlier one.
 *
 * A `thread_changed` can be sequenced after the `thread_deleted` it raced, so a
 * deleted id is remembered for the session and every later write for it is
 * ignored. Ids are never reused by the server.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/sessionRegistry";
import type { ThreadInfo } from "@lib/types";

export interface ThreadsState {
  readonly byId: ReadonlyMap<number, ThreadInfo>;
  /** starter message id -> thread id. */
  readonly byStarter: ReadonlyMap<number, number>;
  /** Thread ids a `thread_deleted` named; later writes for them are dropped. */
  readonly deleted: ReadonlySet<number>;
  /** The thread the side panel has open (the second focus slot), or null. */
  readonly focusedThreadId: number | null;
}

const INITIAL: ThreadsState = {
  byId: new Map(),
  byStarter: new Map(),
  deleted: new Set(),
  focusedThreadId: null,
};

export const threadsStore = createStore<ThreadsState>(INITIAL);

/** `prev` with `info` written in; `prev` itself when `info` is a deleted thread.
 *  A thread never changes parent, so only the starter pointer can move. */
function withThread(prev: ThreadsState, info: ThreadInfo): ThreadsState {
  if (prev.deleted.has(info.id)) return prev;
  const old = prev.byId.get(info.id)?.starter_message_id ?? null;
  const byId = new Map(prev.byId).set(info.id, info);
  if (old === info.starter_message_id) return { ...prev, byId };
  const byStarter = new Map(prev.byStarter);
  if (old !== null) byStarter.delete(old);
  if (info.starter_message_id !== null) byStarter.set(info.starter_message_id, info.id);
  return { ...prev, byId, byStarter };
}

/** Record a thread's whole state from a live frame (create ack, change frame). */
export function upsertThread(info: ThreadInfo): void {
  threadsStore.setState((prev) => withThread(prev, info));
}

/** Time of a thread's last activity, 0 when it has none. */
function activityAt(t: ThreadInfo): number {
  const at = Date.parse(t.last_message_at ?? "");
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Record REST snapshots (a history page's starter rows, a thread list page).
 * Such a snapshot may have been read before a live frame that has since landed,
 * and the protocol carries no version to tell, so it only fills in what is
 * missing or shows newer activity; it never rewrites flags or names a live
 * frame set. (A live frame always replaces: see `upsertThread`.)
 */
export function adoptThreadSnapshots(infos: readonly ThreadInfo[]): void {
  if (infos.length === 0) return;
  threadsStore.setState((prev) =>
    infos.reduce((state, info) => {
      const known = state.byId.get(info.id);
      return known === undefined || activityAt(info) > activityAt(known)
        ? withThread(state, info)
        : state;
    }, prev),
  );
}

/** A thread was deleted: forget it, close the panel on it, ignore it from now on. */
export function removeThread(threadId: number): void {
  threadsStore.setState((prev) => {
    const old = prev.byId.get(threadId);
    const byId = new Map(prev.byId);
    byId.delete(threadId);
    const byStarter = new Map(prev.byStarter);
    if (old?.starter_message_id != null) byStarter.delete(old.starter_message_id);
    return {
      byId,
      byStarter,
      deleted: new Set(prev.deleted).add(threadId),
      focusedThreadId: prev.focusedThreadId === threadId ? null : prev.focusedThreadId,
    };
  });
}

/** Which thread the side panel has open; null closes it. */
export function setFocusedThread(threadId: number | null): void {
  threadsStore.setState((prev) =>
    prev.focusedThreadId === threadId ? prev : { ...prev, focusedThreadId: threadId },
  );
}

export function getThread(threadId: number): ThreadInfo | undefined {
  return threadsStore.getState().byId.get(threadId);
}

/**
 * The thread a message started, as it stands now: the store's state when it
 * has one (live frames outrank the row's snapshot), else the snapshot on the
 * row. Undefined for a message with no thread, or whose thread was deleted.
 */
export function threadOfMessage(msg: {
  readonly id: number;
  readonly thread?: ThreadInfo;
}): ThreadInfo | undefined {
  const state = threadsStore.getState();
  if (msg.thread !== undefined) {
    if (state.deleted.has(msg.thread.id)) return undefined;
    return state.byId.get(msg.thread.id) ?? msg.thread;
  }
  const id = state.byStarter.get(msg.id);
  return id === undefined ? undefined : state.byId.get(id);
}

/**
 * The channel whose roles and overrides answer for `channelId`: the parent of
 * a known thread, else the id itself. A thread has no permission state of its
 * own, so per-channel verdicts (can pin, can react) are read from the parent.
 */
export function authorityChannelId(channelId: number): number {
  return threadsStore.getState().byId.get(channelId)?.parent_id ?? channelId;
}

/**
 * Whether the reader is watching `channelId`: the open channel, or the thread
 * the side panel has focused. The message list's read-marking gates ask this.
 */
export function isReadSurface(channelId: number, activeChannelId: number | null): boolean {
  return activeChannelId === channelId || threadsStore.getState().focusedThreadId === channelId;
}

export function resetThreadsStore(): void {
  threadsStore.setState(() => INITIAL);
}
void registerSessionReset("threads:store", resetThreadsStore); // app-lifetime
