/**
 * The Message Requests store (B9-5): the pending inbox of the signed-in
 * account on the connected server. The dispatcher's handlers and the inbox's
 * own decisions (decisions.ts) are its only writers; sign-out and profile
 * switch empty it.
 *
 * Two sources feed it. Each `ready`, and each resume (which gets no `ready`),
 * fetches GET /api/v1/dm-requests, the authoritative snapshot, and dm_request
 * frames change it live; a decision's 200 is applied as a frame. A frame that lands while a snapshot is in flight is
 * newer than that snapshot for its id, so the snapshot keeps the frame's word
 * for it. Only the latest snapshot applies, and none crosses a sign-out.
 *
 * Nothing here adds to unread or mention counts (Q2): the count is its own.
 */

import { createStore } from "@lib/store";
import { onAuthCleared } from "@stores/auth.store";
import type { MessageRequest } from "./api";

export type RequestsStatus = "loading" | "ready" | "unavailable";

export interface MessageRequestsState {
  /** "loading" until the first snapshot of this session lands. */
  readonly status: RequestsStatus;
  /** Pending requests, newest first. */
  readonly pending: readonly MessageRequest[];
  /** Bumped by every frame. */
  readonly rev: number;
  /** The rev at which a frame last changed each request id. */
  readonly touched: ReadonlyMap<number, number>;
  /** Bumped by every snapshot start and every reset; only the latest applies. */
  readonly snapshotSeq: number;
}

/** What a snapshot saw when it started; hand it back with the result. */
export interface SnapshotToken {
  readonly seq: number;
  readonly rev: number;
}

const INITIAL: MessageRequestsState = {
  status: "loading",
  pending: [],
  rev: 0,
  touched: new Map(),
  snapshotSeq: 0,
};

export const messageRequestsStore = createStore<MessageRequestsState>(INITIAL);

/** Request ids only grow, so id order is creation order. */
const newestFirst = (a: MessageRequest, b: MessageRequest): number => b.id - a.id;

export function beginSnapshot(): SnapshotToken {
  const prev = messageRequestsStore.getState();
  const token = { seq: prev.snapshotSeq + 1, rev: prev.rev };
  messageRequestsStore.setState((s) => ({ ...s, snapshotSeq: token.seq }));
  return token;
}

/** Apply a GET snapshot. A stale one (superseded, or from before a sign-out) is dropped. */
export function applySnapshot(requests: readonly MessageRequest[], token: SnapshotToken): void {
  messageRequestsStore.setState((prev) => {
    if (token.seq !== prev.snapshotSeq) return prev;
    const newer = (id: number): boolean => (prev.touched.get(id) ?? -1) > token.rev;
    const pending = [
      ...prev.pending.filter((r) => newer(r.id)),
      ...requests.filter((r) => !newer(r.id)),
    ].toSorted(newestFirst);
    return { ...prev, status: "ready", pending };
  });
}

/** The snapshot failed: say so, and keep what the frames told us. */
export function failSnapshot(token: SnapshotToken): void {
  messageRequestsStore.setState((prev) =>
    token.seq === prev.snapshotSeq ? { ...prev, status: "unavailable" } : prev,
  );
}

/** A dm_request frame: `pending` adds or refreshes the request, any other state removes it. */
export function applyFrame(request: MessageRequest, pending: boolean): void {
  messageRequestsStore.setState((prev) => {
    const rev = prev.rev + 1;
    const touched = new Map(prev.touched).set(request.id, rev);
    const rest = prev.pending.filter((r) => r.id !== request.id);
    return {
      ...prev,
      rev,
      touched,
      pending: pending ? [...rest, request].toSorted(newestFirst) : rest,
    };
  });
}

/** Empty the inbox for the next account; a snapshot still in flight can no longer apply. */
export function resetMessageRequests(): void {
  messageRequestsStore.setState((prev) => ({ ...INITIAL, snapshotSeq: prev.snapshotSeq + 1 }));
}

onAuthCleared(resetMessageRequests);

/** N for "Message Requests (N)" and the DM header badge (a navigation CountSource). */
export const pendingRequestCount = {
  get: () => messageRequestsStore.getState().pending.length,
  subscribe: (onChange: () => void): (() => void) =>
    messageRequestsStore.subscribeSelector((s) => s.pending.length, onChange),
};
