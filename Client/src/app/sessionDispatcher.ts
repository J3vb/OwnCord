// The signed-in event wiring (lib/dispatcher.ts and every feature's socket
// handlers) and the frame shape table are their own chunks, so the connect
// screen does not load them.
// configureSession starts the download at boot; startSession waits for it
// before it dials, so no server event can arrive before its handler exists.

import { createLogger } from "@lib/logger";
import { installFrameShapes } from "@lib/net/wireCheck";

const log = createLogger("sessionDispatcher");

export type DispatcherModule = typeof import("@lib/dispatcher");

let pending: Promise<DispatcherModule> | null = null;
let loaded: DispatcherModule | null = null;

/** The dispatcher module when it has finished loading, else null. */
export function loadedDispatcher(): DispatcherModule | null {
  return loaded;
}

/**
 * The dispatcher module, loaded once, with the frame shape table installed.
 * A failed load is forgotten, so the next sign-in tries again.
 */
export function loadDispatcher(): Promise<DispatcherModule> {
  if (pending === null) {
    const attempt = Promise.all([import("@lib/dispatcher"), import("@lib/net/wireShapes")]).then(
      ([dispatcher, shapes]) => {
        installFrameShapes(shapes);
        loaded = dispatcher;
        return dispatcher;
      },
    );
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
  }
  return pending;
}

/** Starts the download early. A failure here is only logged: the sign-in that needs it tries again and reports it. */
export function prefetchDispatcher(): void {
  loadDispatcher().catch((err: unknown) => {
    log.warn("Session code prefetch failed; sign-in will retry", { error: String(err) });
  });
}
