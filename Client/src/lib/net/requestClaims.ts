/**
 * Request claims: envelope ids whose refusal a dialog reports itself.
 *
 * A sender claims the id of a frame before it goes out: the Forward picker
 * (one per target), the Create Thread dialog and the forum New Post dialog.
 * When the server refuses that frame, the dispatcher's error route
 * (features/messaging/sendErrors.ts) asks `isClaimedRequest` and skips the
 * generic error toast, so the refusal is shown once, by its owner. An id that
 * was never claimed still reaches the toast.
 *
 * The owner releases its claim when the reply settles or the dialog closes.
 * The release lands a microtask later, so every listener of the same frame
 * still sees the claim. A session reset (sign-out, server switch) clears all
 * claims, so a late reply from the old session is not swallowed.
 *
 * Imports only the session registry: the dispatcher reaches this at startup,
 * while the senders load with their dialogs.
 */

import { registerSessionReset } from "./sessionRegistry";

const claimed = new Set<string>();

void registerSessionReset("net:requestClaims", () => claimed.clear()); // app-lifetime

export function claimRequest(id: string): void {
  claimed.add(id);
}

/** Dropped a microtask later, so every listener of the same frame still sees the claim. */
export function releaseRequest(id: string): void {
  queueMicrotask(() => claimed.delete(id));
}

export function isClaimedRequest(id: string | undefined): boolean {
  return id !== undefined && claimed.has(id);
}
