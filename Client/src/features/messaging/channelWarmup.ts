/**
 * One page of a channel's first load, started when the mouse button goes down
 * on its sidebar row. The click still decides: the press only asks the server,
 * and `loadMessages` takes the answer when the channel really opens.
 */

import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import type { MessagesResponse } from "@lib/types";

/** A press older than this was not the start of a click. */
export const WARM_MAX_AGE_MS = 2000;

interface Slot {
  readonly channelId: number;
  readonly startedAt: number;
  readonly session: { isCurrent(): boolean } | undefined;
  readonly owner: Disposable;
  readonly page: Promise<MessagesResponse>;
}

export interface ChannelWarmup {
  /** Start the first-page request for `channelId`, replacing any earlier one. */
  warm(channelId: number): void;
  /** Drop the request for `channelId` (a drag, a pointer that left the row). */
  cancel(channelId: number): void;
  /**
   * Hand over the waiting page for `channelId`, or null when there is none
   * (never started, too old, other session, refused). A page that fails
   * resolves to null so the caller falls back to its own request. The request
   * is cancelled if `signal` aborts while it is still in flight.
   */
  take(channelId: number, signal: AbortSignal): Promise<MessagesResponse | null> | null;
  destroy(): void;
}

export function createChannelWarmup(
  api: ApiClient,
  pageSize: number,
  now: () => number = Date.now,
): ChannelWarmup {
  let slot: Slot | null = null;

  function drop(): void {
    slot?.owner.destroy();
    slot = null;
  }

  function warm(channelId: number): void {
    if (slot?.channelId === channelId && now() - slot.startedAt <= WARM_MAX_AGE_MS) return;
    drop();
    const owner = new Disposable();
    // channelContent refuses age-gated channels before any request leaves.
    const page = api.getMessages(channelId, { limit: pageSize }, owner.signal);
    // The rejection is read in take(); nobody may be waiting yet.
    page.catch(() => undefined);
    slot = { channelId, startedAt: now(), session: api.getSession?.(), owner, page };
  }

  function cancel(channelId: number): void {
    if (slot?.channelId === channelId) drop();
  }

  function take(channelId: number, signal: AbortSignal): Promise<MessagesResponse | null> | null {
    const held = slot;
    if (held === null || held.channelId !== channelId) return null;
    slot = null;
    if (now() - held.startedAt > WARM_MAX_AGE_MS || held.session?.isCurrent() === false) {
      held.owner.destroy();
      return null;
    }
    signal.addEventListener("abort", () => held.owner.destroy(), { once: true });
    return held.page.then(
      (page) => page,
      () => null,
    );
  }

  return { warm, cancel, take, destroy: drop };
}
