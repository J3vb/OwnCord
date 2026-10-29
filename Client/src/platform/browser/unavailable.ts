// Shared refusals for the inert browser platform. Real browser adapters
// replace these members one capability at a time.
import type { GlobalKeysError, GlobalKeysErrorCode } from "../contracts/globalShortcuts";

/** Thrown by a capability the browser does not provide. */
export class UnavailableError extends Error {
  constructor() {
    // i18n-exempt: internal diagnostic, logged by callers, never rendered
    super("not available in the browser platform");
    this.name = "UnavailableError";
  }
}

/** A rejected promise, for a method whose contract lets it refuse. */
export function refuse<T>(): Promise<T> {
  return Promise.reject(new UnavailableError());
}

/** The rejection `bindPortal` and `configurePortal` use for "no such backend". */
export class UnsupportedKeysError extends UnavailableError implements GlobalKeysError {
  readonly code: GlobalKeysErrorCode = "unsupported";
}

/** An unsubscribe that has nothing to release. */
export function inertUnsubscribe(): () => void {
  return () => undefined;
}
