/**
 * The eager half of send-while-uploading: one cached dynamic import,
 * so the queue logic, its upload strip and its copy stay out of the main-page
 * chunk until the first upload (the preload) or the first queued send.
 */

import { createLogger } from "../../lib/logger";

const log = createLogger("send-queue");

export type SendQueueModule = typeof import("./sendQueue");

let loading: Promise<SendQueueModule> | null = null;

/** The module, loaded once. A failed load is forgotten, so Retry imports again. */
export function loadSendQueue(): Promise<SendQueueModule> {
  loading ??= import("./sendQueue").catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Start fetching the module on the first upload, so a send queued meanwhile finds it loaded. */
export function preloadSendQueue(): void {
  loadSendQueue().catch((err: unknown) =>
    log.warn("Send queue preload failed", { error: String(err) }),
  );
}
