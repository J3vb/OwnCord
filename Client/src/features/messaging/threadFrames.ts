// Thread WebSocket handlers — reached through ./wsHandlers by
// lib/dispatcher.ts, which keeps every socket subscription. Threads never
// enter channelsStore; threadsStore is their only home.
import { threadsStoreInUse, withThreadsStore } from "@stores/threadsLoader";
import type { ReadyPayload, ServerMessage } from "@lib/types";

/** thread_create_ok, thread_changed and a live starter `chat_message` all carry
 *  the thread's whole state, which replaces ours. */
export function handleThreadState(payload: { readonly thread?: ThreadPayloadThread }): void {
  const { thread } = payload;
  if (thread !== undefined) withThreadsStore((m) => m.upsertThread(thread));
}

type ThreadPayloadThread = NonNullable<
  Extract<ServerMessage, { type: "thread_changed" }>["payload"]["thread"]
>;

/** thread_deleted. A `thread_changed` read just before the delete can arrive
 *  after it; the store remembers the id and drops it. */
export function handleThreadDeleted(payload: { readonly thread_id: number }): void {
  withThreadsStore((m) => m.removeThread(payload.thread_id));
}

/** thread_follow_update and thread_follow_ok: the last frame for a thread wins. */
export function handleThreadFollow(payload: {
  readonly thread_id: number;
  readonly following: boolean;
  readonly thread?: ThreadPayloadThread;
}): void {
  withThreadsStore((m) =>
    m.applyFollowUpdate(payload.thread_id, payload.following, payload.thread),
  );
}

/**
 * `ready.threads`: the authoritative followed set. A server that sends none
 * (older, or one without the capability) leaves a session that never met a
 * thread alone, and empties the map of one that did.
 */
export function applyReadyThreads(payload: Pick<ReadyPayload, "threads">): void {
  const entries = payload.threads ?? [];
  if (entries.length === 0 && !threadsStoreInUse()) return;
  withThreadsStore((m) => m.adoptReadyThreads(entries));
}
