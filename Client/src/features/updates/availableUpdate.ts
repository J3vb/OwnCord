/**
 * The client update the connected server offers right now, as the update
 * notifier last heard it. The banner's "See what's new" and the About tab's
 * update card both read it, so the notes shown are the ones the check returned.
 */

export interface AvailableUpdate {
  readonly version: string;
  /** The release notes the update feed sent (Markdown); may be empty. */
  readonly body: string;
  /** The server that offered it, which the install downloads from. */
  readonly serverUrl: string;
}

type Listener = (update: AvailableUpdate | null) => void;

let current: AvailableUpdate | null = null;
const listeners = new Set<Listener>();

function same(a: AvailableUpdate | null, b: AvailableUpdate | null): boolean {
  if (a === null || b === null) return a === b;
  return a.version === b.version && a.body === b.body && a.serverUrl === b.serverUrl;
}

export function getAvailableUpdate(): AvailableUpdate | null {
  return current;
}

export function setAvailableUpdate(next: AvailableUpdate | null): void {
  if (same(current, next)) return;
  current = next;
  for (const listener of listeners) listener(current);
}

/** Calls `listener` now with the current value, then on every change. */
export function subscribeAvailableUpdate(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
