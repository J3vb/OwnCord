/**
 * Opening a thread, or a channel's Threads list, from outside the channel view:
 * a followed thread's sidebar row, or a parent's "N more" row.
 *
 * Both need the parent channel mounted first, and the channel view only exists
 * once navigation lands, so a request waits here until the channel controller
 * says the parent is mounted. A request for a parent that never mounts is
 * dropped by the next channel that does.
 */

import { channelsStore } from "../../stores/channels.store";
import { navigateToChannel } from "../../lib/channel-navigation";

export type ThreadNavigationRequest =
  | { readonly kind: "thread"; readonly threadId: number; readonly parentId: number }
  | { readonly kind: "list"; readonly parentId: number };

/** The channel view's side of the hand-off. */
export interface ThreadNavigationConsumer {
  /** The channel mounted now, or null. */
  readonly currentChannelId: number | null;
  open(request: ThreadNavigationRequest): void;
}

let consumer: ThreadNavigationConsumer | null = null;
let pending: ThreadNavigationRequest | null = null;

/** The channel controller registers itself while it exists. */
export function setThreadNavigationConsumer(next: ThreadNavigationConsumer | null): void {
  consumer = next;
  pending = null;
}

/** The channel controller calls this once `channelId` is mounted. */
export function settleThreadNavigation(channelId: number): void {
  const waiting = pending;
  pending = null;
  if (waiting !== null && waiting.parentId === channelId) consumer?.open(waiting);
}

function submit(next: ThreadNavigationRequest): void {
  // A parent the reader cannot list has no row to come from; do nothing.
  if (!channelsStore.getState().channels.has(next.parentId)) return;
  if (consumer?.currentChannelId === next.parentId) {
    consumer.open(next);
    return;
  }
  pending = next;
  navigateToChannel(next.parentId);
}

/** Open the parent channel and the thread's panel. */
export function requestOpenThread(threadId: number, parentId: number): void {
  submit({ kind: "thread", threadId, parentId });
}

/** Open the parent channel and its Threads list. */
export function requestOpenThreadList(parentId: number): void {
  submit({ kind: "list", parentId });
}
