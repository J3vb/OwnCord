/**
 * "Open on first use" loader for a screen that stays out of the main-page
 * chunk. One loader per site: it caches the module promise, so two triggers
 * during the load share one import; a failed import is logged, shown once as
 * the generic error toast, and forgotten so the next trigger loads again.
 *
 * `load()` never rejects. It resolves `null` on failure, and the caller must
 * also check that it still owns the attempt (its signal, disposed flag or
 * pending marker) before it mounts what it got.
 */

import { createLogger } from "@lib/logger";
import { showToast } from "@lib/toast";
import { shellText } from "../i18n/shell";

const log = createLogger("lazy-screen");

export interface LazyScreen<M> {
  /** The module, or `null` after a failure that was logged and toasted. */
  load(): Promise<M | null>;
  /** The module, rejecting on failure with no toast: for a caller (an overlay
   *  controller) that already reports a failed open itself. */
  loadOrThrow(): Promise<M>;
}

export function createLazyScreen<M>(name: string, importer: () => Promise<M>): LazyScreen<M> {
  let cached: Promise<M> | null = null;

  function loadOrThrow(): Promise<M> {
    if (cached !== null) return cached;
    let attempt: Promise<M>;
    try {
      attempt = importer();
    } catch (err) {
      attempt = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    cached = attempt;
    // A failed import is forgotten so the next open loads again; only the
    // attempt that failed clears the cache, so a retry already started stays.
    attempt.catch(() => {
      if (cached === attempt) cached = null;
    });
    return attempt;
  }

  return {
    loadOrThrow,
    load(): Promise<M | null> {
      return loadOrThrow().catch((err: unknown) => {
        log.error(`Failed to load ${name}`, { error: String(err) });
        showToast(shellText("common.openFailed"), "error");
        return null;
      });
    },
  };
}
