/**
 * "Open on first use" loader for a screen that stays out of the main-page
 * chunk. One loader per site: it caches the module promise, so two triggers
 * during the load share one import. A failed import is forgotten, so the next
 * trigger tries the import again (a browser may serve the same failed fetch
 * until a reload, so a retry can fail again).
 *
 * A failed attempt is logged and toasted at most once, however many callers
 * shared it, and only if some caller still wanted it: `load(wanted)` skips the
 * toast for a caller whose `wanted()` is already false (it cancelled).
 *
 * `load()` never rejects. It resolves `null` on failure, and the caller must
 * also check that it still owns the attempt (its signal, disposed flag or
 * pending marker) before it mounts what it got.
 */

import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { shellText } from "../i18n/shell";

const log = createLogger("lazy-screen");

export interface LazyScreen<M> {
  /** The module, or `null` after a failed attempt (logged, and toasted once
   *  unless `wanted` says this caller has already cancelled). */
  load(wanted?: () => boolean): Promise<M | null>;
  /** The module, rejecting on failure with no toast: for a caller (an overlay
   *  controller) that already reports a failed open itself. */
  loadOrThrow(): Promise<M>;
}

export function createLazyScreen<M>(name: string, importer: () => Promise<M>): LazyScreen<M> {
  interface Attempt {
    readonly promise: Promise<M>;
    reported: boolean;
  }
  let cached: Attempt | null = null;

  function start(): Attempt {
    if (cached !== null) return cached;
    let promise: Promise<M>;
    try {
      promise = importer();
    } catch (err) {
      promise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const attempt: Attempt = { promise, reported: false };
    cached = attempt;
    // A failed import is forgotten so the next open tries again; only the
    // attempt that failed clears the cache, so a retry already started stays.
    promise.catch(() => {
      if (cached === attempt) cached = null;
    });
    return attempt;
  }

  return {
    loadOrThrow: () => start().promise,
    load(wanted?: () => boolean): Promise<M | null> {
      const attempt = start();
      return attempt.promise.catch((err: unknown) => {
        if (!attempt.reported && wanted?.() !== false) {
          attempt.reported = true;
          log.error(`Failed to load ${name}`, { error: String(err) });
          showToast(shellText("common.openFailed"), "error");
        }
        return null;
      });
    },
  };
}
