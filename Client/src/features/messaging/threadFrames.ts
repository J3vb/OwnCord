// Thread WebSocket handlers (WP 6.9c) — reached through ./wsHandlers by
// lib/dispatcher.ts, which keeps every socket subscription. Threads never
// enter channelsStore; threadsStore is their only home.
import { withThreadsStore } from "@stores/threadsLoader";
import type { ServerMessage } from "@lib/types";

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
