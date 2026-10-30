/**
 * The envelope ids of in-flight Forward frames, and of a Create
 * Thread request, whose dialog shows its own refusal. The dispatcher's error
 * handler asks `isForwardRequest` so a refused forward is reported once, in the
 * picker's own per-target result (or the dialog's own line), and not again by the generic error toast.
 * A leaf with no imports of its own: the dispatcher reaches it at startup,
 * while the sender that fills it (forwardSend.ts) loads with the picker.
 */

import { registerSessionReset } from "../../lib/net/sessionRegistry";

const claimed = new Set<string>();

void registerSessionReset("messaging:forwardRequests", () => claimed.clear()); // app-lifetime

export function claimForwardRequest(id: string): void {
  claimed.add(id);
}

/** Dropped a microtask later, so every listener of the same frame still sees the claim. */
export function releaseForwardRequest(id: string): void {
  queueMicrotask(() => claimed.delete(id));
}

export function isForwardRequest(id: string | undefined): boolean {
  return id !== undefined && claimed.has(id);
}
