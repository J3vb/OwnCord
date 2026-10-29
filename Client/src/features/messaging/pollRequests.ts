/**
 * The envelope ids of in-flight poll frames. The dispatcher's error
 * handler asks `isPollRequest` so a refused create, vote or end is reported
 * once, on the dialog or card that sent it, and not again by the generic error
 * toast. A leaf with no imports of its own beyond the session registry: the
 * dispatcher reaches it at startup, while the sender that fills it
 * (pollSend.ts) loads with the message list.
 */

import { registerSessionReset } from "../../lib/sessionRegistry";

const claimed = new Set<string>();

void registerSessionReset("messaging:pollRequests", () => claimed.clear()); // app-lifetime

export function claimPollRequest(id: string): void {
  claimed.add(id);
}

/** Dropped a microtask later, so every listener of the same frame still sees the claim. */
export function releasePollRequest(id: string): void {
  queueMicrotask(() => claimed.delete(id));
}

export function isPollRequest(id: string | undefined): boolean {
  return id !== undefined && claimed.has(id);
}
