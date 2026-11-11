// The ready deadline behind the connected overlay, split out of session.ts.

import { createLogger } from "@lib/logger";
import type { SessionScope } from "@lib/net/sessionScope";

const log = createLogger("main");

/**
 * How long the connected overlay waits for `ready` after auth_ok (restarted
 * on every reconnect) before it gives up and returns to the connect page.
 */
export const READY_TIMEOUT_MS = 30_000;

/**
 * The connected overlay has no Cancel, and the main page cannot mount without
 * `ready`: a server that signs the user in but stalls building `ready` (or a
 * proxy that drops the large frame) would hold it forever. Give up after
 * READY_TIMEOUT_MS, restarted on each reconnect while it is still waiting,
 * and tear the session down the way the invite link does, keeping the stored
 * sign-in for the next try.
 */
export function startReadyDeadline(
  owner: SessionScope,
  host: string,
  onGiveUp: () => void,
): { restart(): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const giveUp = (): void => {
    timer = null;
    if (!owner.isCurrent()) return;
    log.warn("Server did not send ready in time", { host, timeoutMs: READY_TIMEOUT_MS });
    onGiveUp();
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(giveUp, READY_TIMEOUT_MS);
  };
  arm();
  return {
    restart: () => {
      if (timer !== null) arm();
    },
    clear,
  };
}
