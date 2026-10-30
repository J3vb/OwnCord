/**
 * Threads store — the threads this session has heard of, and which
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
 * `followed` is the follow map: the threads this member follows and
 * their unread and mention counts. `ready.threads` replaces it, a
 * `thread_follow_update` keeps it current, and `channel_activity`,
 * `mention_count` and `read_state` frames for a followed thread id feed the
 * counts (only through the dispatcher). Every change is published to
 * `followedThreads.store`, which the sidebar and the badge read.
 *
 * A `thread_changed` can be sequenced after the `thread_deleted` it raced, so a
 * deleted id is remembered for the session and every later write for it is
 * ignored. Ids are never reused by the server.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { setKnownThreadCheck, setThreadReadPointer } from "@lib/read-state";
import type { ReadyThread, ThreadInfo } from "@lib/types";
import { publishFollowedThreads, type FollowedThreadRow } from "./followedThreads.store";

/** One followed thread's counts; the thread itself is in `byId`. */
export interface FollowedThread {
  readonly unread: number;
  readonly mentions: number;
  /** Newest message id counted or seen; later hints at or below it are not new. */
  readonly lastMessageId: number;
  readonly lastReadId: number;
}

export interface ThreadsState {
  readonly byId: ReadonlyMap<number, ThreadInfo>;
  /** starter message id -> thread id. */
  readonly byStarter: ReadonlyMap<number, number>;
  /** Thread ids a `thread_deleted` named; later writes for them are dropped. */
  readonly deleted: ReadonlySet<number>;
  /** The thread the side panel has open (the second focus slot), or null. */
  readonly focusedThreadId: number | null;
  /** Threads this member follows, by thread id. */
  readonly followed: ReadonlyMap<number, FollowedThread>;
}

const INITIAL: ThreadsState = {
  byId: new Map(),
  byStarter: new Map(),
  deleted: new Set(),
  focusedThreadId: null,
  followed: new Map(),
};

export const threadsStore = createStore<ThreadsState>(INITIAL);

/** The sidebar's view of `state`: open followed threads by parent, newest activity first. */
export function followedRows(
  state: ThreadsState,
): ReadonlyMap<number, readonly FollowedThreadRow[]> {
  const byParent = new Map<number, FollowedThreadRow[]>();
  for (const [id, f] of state.followed) {
    const t = state.byId.get(id);
    if (t === undefined || t.archived) continue;
    const row: FollowedThreadRow = {
      id,
      parentId: t.parent_id,
      name: t.name,
      unread: f.unread,
      mentions: f.mentions,
      activityAt: activityAt(t),
    };
    const rows = byParent.get(t.parent_id);
    if (rows === undefined) byParent.set(t.parent_id, [row]);
    else rows.push(row);
  }
  for (const rows of byParent.values()) {
    rows.sort((a, b) => b.activityAt - a.activityAt || b.id - a.id);
  }
  return byParent;
}

/** Apply `updater` and publish the follow view at once (not on the store's microtask). */
function commit(updater: (prev: ThreadsState) => ThreadsState): void {
  threadsStore.setState(updater);
  const s = threadsStore.getState();
  publishFollowedThreads({ byParent: followedRows(s), focusedId: s.focusedThreadId });
}

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
  commit((prev) => withThread(prev, info));
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
  commit((prev) =>
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
  commit((prev) => {
    const old = prev.byId.get(threadId);
    const byId = new Map(prev.byId);
    byId.delete(threadId);
    const byStarter = new Map(prev.byStarter);
    if (old?.starter_message_id != null) byStarter.delete(old.starter_message_id);
    const followed = new Map(prev.followed);
    followed.delete(threadId);
    return {
      byId,
      byStarter,
      deleted: new Set(prev.deleted).add(threadId),
      focusedThreadId: prev.focusedThreadId === threadId ? null : prev.focusedThreadId,
      followed,
    };
  });
}

/**
 * Which thread the side panel has open; null closes it. Opening a followed
 * thread reads it: the server marks it read on `thread_focus`, so its counts
 * clear here.
 */
export function setFocusedThread(threadId: number | null): void {
  commit((prev) => {
    if (prev.focusedThreadId === threadId) return prev;
    const next = { ...prev, focusedThreadId: threadId };
    return threadId === null ? next : withCountsCleared(next, threadId);
  });
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
  commit(() => INITIAL);
}

// ── Follow map ────────────────────────────────────────────────────

const NO_COUNTS: FollowedThread = { unread: 0, mentions: 0, lastMessageId: 0, lastReadId: 0 };

/** `prev` with the thread's counts at zero; `prev` itself when it is not followed or already clear. */
function withCountsCleared(prev: ThreadsState, threadId: number): ThreadsState {
  const f = prev.followed.get(threadId);
  if (f === undefined || (f.unread === 0 && f.mentions === 0)) return prev;
  return {
    ...prev,
    followed: new Map(prev.followed).set(threadId, {
      ...f,
      unread: 0,
      mentions: 0,
      lastReadId: f.lastMessageId,
    }),
  };
}

/**
 * `ready.threads`: the authoritative followed set, replacing whatever was held.
 * A thread deleted this session is skipped (ids are never reused). The panel's
 * own thread reads as zero: the reader is looking at it.
 */
export function adoptReadyThreads(entries: readonly ReadyThread[]): void {
  commit((prev) => {
    let state: ThreadsState = prev;
    const followed = new Map<number, FollowedThread>();
    for (const e of entries) {
      if (prev.deleted.has(e.thread.id)) continue;
      state = withThread(state, e.thread);
      const watching = prev.focusedThreadId === e.thread.id;
      setThreadReadPointer(e.thread.id, e.last_read_message_id);
      followed.set(e.thread.id, {
        unread: watching ? 0 : e.unread_count,
        mentions: watching ? 0 : e.mention_count,
        lastMessageId: e.last_message_id,
        lastReadId: e.last_read_message_id,
      });
    }
    return { ...state, followed };
  });
}

/**
 * `thread_follow_update` / `thread_follow_ok`: the last frame for a thread
 * wins. A follow needs the thread's state (the frame's, else one already held),
 * and is dropped for a thread deleted this session, so a late `following: true`
 * cannot bring a row back. An unfollow always removes.
 */
export function applyFollowUpdate(threadId: number, following: boolean, thread?: ThreadInfo): void {
  commit((prev) => {
    if (!following) {
      if (!prev.followed.has(threadId)) return prev;
      const followed = new Map(prev.followed);
      followed.delete(threadId);
      return { ...prev, followed };
    }
    if (prev.deleted.has(threadId)) return prev;
    const state = thread === undefined ? prev : withThread(prev, thread);
    if (!state.byId.has(threadId) || state.followed.has(threadId)) return state;
    return { ...state, followed: new Map(state.followed).set(threadId, NO_COUNTS) };
  });
}

export function isFollowed(threadId: number): boolean {
  return threadsStore.getState().followed.has(threadId);
}

/**
 * A `channel_activity` hint for a followed thread: one more unread message,
 * unless it is not newer than what is already counted or read, or the reader
 * has the thread open. Returns whether it counted.
 */
export function noteFollowedActivity(threadId: number, messageId: number): boolean {
  let counted = false;
  commit((prev) => {
    const f = prev.followed.get(threadId);
    if (f === undefined || prev.focusedThreadId === threadId) return prev;
    if (messageId <= f.lastMessageId || messageId <= f.lastReadId) return prev;
    counted = true;
    return {
      ...prev,
      followed: new Map(prev.followed).set(threadId, {
        ...f,
        unread: f.unread + 1,
        lastMessageId: messageId,
      }),
    };
  });
  return counted;
}

/**
 * A `mention_count` frame for a followed thread: the absolute total. Returns
 * the total held before, or undefined for a thread that is not followed or is
 * open (its mentions stay at zero).
 */
export function setFollowedMentions(threadId: number, count: number): number | undefined {
  const f = threadsStore.getState().followed.get(threadId);
  if (f === undefined || threadsStore.getState().focusedThreadId === threadId) return undefined;
  if (f.mentions !== count) {
    commit((prev) => ({
      ...prev,
      followed: new Map(prev.followed).set(threadId, { ...f, mentions: count }),
    }));
  }
  return f.mentions;
}

/** A `read_state` frame for a followed thread: its pointer and counts, replaced. */
export function applyFollowedReadState(
  threadId: number,
  state: { readonly lastReadId: number; readonly unread: number; readonly mentions: number },
): void {
  commit((prev) => {
    const f = prev.followed.get(threadId);
    if (f === undefined) return prev;
    setThreadReadPointer(threadId, state.lastReadId);
    const watching = prev.focusedThreadId === threadId;
    return {
      ...prev,
      followed: new Map(prev.followed).set(threadId, {
        ...f,
        lastReadId: state.lastReadId,
        unread: watching ? 0 : state.unread,
        mentions: watching ? 0 : state.mentions,
      }),
    };
  });
}

/**
 * A live message in the thread the panel has open: it is seen as it lands, so
 * a later activity hint for it (the server coalesces them) must not count it.
 */
export function noteOpenThreadMessage(threadId: number, messageId: number): void {
  const prev = threadsStore.getState();
  const f = prev.followed.get(threadId);
  if (f === undefined || prev.focusedThreadId !== threadId) return;
  if (messageId <= f.lastMessageId && messageId <= f.lastReadId) return;
  commit((p) => ({
    ...p,
    followed: new Map(p.followed).set(threadId, {
      ...f,
      lastMessageId: Math.max(f.lastMessageId, messageId),
      lastReadId: Math.max(f.lastReadId, messageId),
    }),
  }));
}

/** Read a followed thread without opening it (the row's Mark as Read). */
export function clearFollowedCounts(threadId: number): void {
  commit((prev) => withCountsCleared(prev, threadId));
}
void registerSessionReset("threads:store", resetThreadsStore); // app-lifetime
// A thread id is a valid target for mark_read (the read-state helpers ask).
setKnownThreadCheck((id) => threadsStore.getState().byId.has(id)); // app-lifetime
