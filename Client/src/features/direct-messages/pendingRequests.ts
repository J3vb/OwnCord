/**
 * 1:1 DMs whose message request, sent by this user, the other person may not
 * have accepted yet. A hint for the UI, never a gate: calls always go to the
 * server, which has the last word.
 *
 * The server tells only the recipient about a request, so the sender learns
 * it the one way the server does say it: a refused call_ring
 * (CALL_REQUIRES_ACCEPTANCE). A message from the other person in that DM, or
 * them in its call, clears the mark; another refusal sets it again. The
 * dispatcher's handlers are the only writers, so a state the server sends
 * later can feed the same mark/clear calls.
 *
 * Session scoped: cleared on sign-out and server switch.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/net/sessionRegistry";

export interface PendingRequestsState {
  readonly channels: ReadonlySet<number>;
}

export const pendingRequestsStore = createStore<PendingRequestsState>({ channels: new Set() });

/** The DM each recent call_ring went to, by envelope id. */
const ringChannels = new Map<string, number>();
const RING_MEMORY = 8;

/** Remember where a call_ring went, so its refusal can name the DM. */
export function noteRingSent(envelopeId: string, channelId: number): void {
  ringChannels.set(envelopeId, channelId);
  if (ringChannels.size > RING_MEMORY) {
    const oldest = ringChannels.keys().next().value;
    if (oldest !== undefined) ringChannels.delete(oldest);
  }
}

/** The DM a refused ring went to, or null when `envelopeId` names no ring. */
export function takeRingChannel(envelopeId: string | undefined): number | null {
  if (envelopeId === undefined) return null;
  const channelId = ringChannels.get(envelopeId);
  if (channelId === undefined) return null;
  ringChannels.delete(envelopeId);
  return channelId;
}

export function isRequestPending(channelId: number): boolean {
  return pendingRequestsStore.getState().channels.has(channelId);
}

// Both return early when nothing changes, so the frames that call them for
// every channel (voice_state, chat_message) schedule no notify.
export function markRequestPending(channelId: number): void {
  if (isRequestPending(channelId)) return;
  pendingRequestsStore.setState((prev) => ({ channels: new Set([...prev.channels, channelId]) }));
}

export function clearRequestPending(channelId: number): void {
  if (!isRequestPending(channelId)) return;
  pendingRequestsStore.setState((prev) => {
    const channels = new Set(prev.channels);
    channels.delete(channelId);
    return { channels };
  });
}

/** Forget everything (sign-out, server switch, tests). */
export function resetPendingRequests(): void {
  ringChannels.clear();
  pendingRequestsStore.setState((prev) =>
    prev.channels.size === 0 ? prev : { channels: new Set() },
  );
}

void registerSessionReset("dm:pending-requests", resetPendingRequests, { phase: "session" }); // app-lifetime reset hook, registered at module load
