// The signed-in event wiring (lib/dispatcher.ts and every feature's socket
// handlers) is its own chunk, so the connect screen does not load it.
// configureSession starts the download at boot; startSession waits for it
// before it dials, so no server event can arrive before its handler exists.

import { createLogger } from "@lib/logger";

const log = createLogger("sessionDispatcher");

type DispatcherModule = typeof import("@lib/dispatcher");

let pending: Promise<DispatcherModule> | null = null;

/** The dispatcher module, loaded once. A failed load is forgotten, so the next sign-in retries it. */
export function loadDispatcher(): Promise<DispatcherModule> {
  if (pending === null) {
    const attempt = import("@lib/dispatcher");
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
  }
  return pending;
}

/** Starts the download early. A failure here is only logged: the sign-in that needs it retries and reports it. */
export function prefetchDispatcher(): void {
  loadDispatcher().catch((err: unknown) => {
    log.warn("Session code prefetch failed; sign-in will retry", { error: String(err) });
  });
}
