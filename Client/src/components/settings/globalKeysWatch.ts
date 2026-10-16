/**
 * One host subscription per Settings signal, fanned out to every control that
 * follows the global-keys status (the Push to Talk control and the Keybinds
 * tab). A control can be rebuilt under the same signal (the Voice tab
 * replaces its Push to Talk box in place), so a control must not add its own
 * abort listener: the hub adds one per signal, and a control's handler drops
 * itself by returning `false` once its element has left the document.
 */

import type { GlobalKeysStatus } from "../../platform/contracts/globalShortcuts";
import { desktop } from "../../platform/desktop";

type Handler = (status: GlobalKeysStatus) => boolean | void;

const hubs = new WeakMap<AbortSignal, Set<Handler>>();

export function watchGlobalKeys(signal: AbortSignal, handler: Handler): void {
  if (signal.aborted) return;
  let handlers = hubs.get(signal);
  if (handlers === undefined) {
    const set = new Set<Handler>();
    handlers = set;
    hubs.set(signal, set);
    const stop = desktop.globalShortcuts.onStatusChange((status) => {
      for (const h of set) if (h(status) === false) set.delete(h);
    });
    signal.addEventListener(
      "abort",
      () => {
        stop();
        set.clear();
      },
      { once: true },
    );
  }
  handlers.add(handler);
}

/** A handler guard: false once `el` was in the document and has been removed. */
export function staysAttached(el: Element): () => boolean {
  let seen = false;
  return () => {
    seen ||= el.isConnected;
    return !seen || el.isConnected;
  };
}
