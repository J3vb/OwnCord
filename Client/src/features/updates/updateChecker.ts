// updateChecker — keeps asking the connected server whether a newer client is
// on offer while the app runs, instead of only once at startup. A server that
// updated is noticed through the same question (the client feed it serves is
// what changed), so a reconnect and a slow interval both route here. UI policy (banner, dismiss) stays in components/UpdateNotifier.

import { Disposable } from "../../lib/disposable";
import { createLogger } from "../../lib/logger";
import { checkForUpdate } from "../../lib/net/updater";

const log = createLogger("update-checker");

/** Gap between background checks. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
/** Floor between fresh background checks, so a flapping socket cannot hammer the feed. A check inside the floor is postponed to its end, not dropped; a scheduled retry is exempt because it already waits RETRY_MIN_MS. */
export const MIN_BACKGROUND_GAP_MS = 60_000;

/** A reconnect check waits a random 0..this, so clients behind one IP that all
 *  reconnect after a server restart do not burst the update endpoint's per-IP
 *  rate limit. Only the reconnect check is spread; the interval stays fixed. */
export const RECONNECT_SPREAD_MS = 60_000;
/** A failed background check is retried after RETRY_MIN_MS plus a random
 *  0..RETRY_SPREAD_MS, up to MAX_RETRIES times. The updater plugin does not
 *  expose the HTTP status, so a 429 cannot be told from any other failure:
 *  all of them are "try later" rather than a four-hour wait. */
export const RETRY_MIN_MS = 2 * 60_000;
export const RETRY_SPREAD_MS = 3 * 60_000;
export const MAX_RETRIES = 3;

export type UpdateCheckReason = "startup" | "interval" | "reconnect" | "manual";

export type UpdateOutcome =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "available"; readonly version: string; readonly body: string }
  | { readonly kind: "manual-upgrade"; readonly unconfirmed?: boolean }
  | { readonly kind: "failed" };

export interface UpdateChecker {
  readonly serverUrl: string;
  /** Begin the periodic checks and become the active checker. */
  start(): void;
  stop(): void;
  /** Run a check now. `manual` always runs; any other reason is postponed to the end of the gap floor, except a scheduled retry. */
  checkNow(reason: UpdateCheckReason): Promise<UpdateOutcome>;
  /** The socket came back (possibly to an updated server): check again. */
  notifyReconnected(): void;
  onOutcome(listener: (outcome: UpdateOutcome, reason: UpdateCheckReason) => void): () => void;
}

export interface UpdateCheckerOptions {
  readonly serverUrl: string;
  readonly random?: () => number;
}

let active: UpdateChecker | null = null;

/** The checker of the mounted main page, or null (connect page, signed out). */
export function getActiveUpdateChecker(): UpdateChecker | null {
  return active;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const { serverUrl, random = Math.random } = options;
  const listeners = new Set<(outcome: UpdateOutcome, reason: UpdateCheckReason) => void>();
  let lifetime: Disposable | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<UpdateOutcome> | null = null;
  let lastCheckAt: number | null = null;
  let inFlightReason: UpdateCheckReason = "interval";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let deferTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let retrying = false;

  function scheduleNext(): void {
    timer = setTimeout(() => {
      timer = null;
      void checkNow("interval").finally(() => {
        if (lifetime !== null && timer === null) scheduleNext();
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  function scheduleRetry(reason: UpdateCheckReason): void {
    if (lifetime === null || retries >= MAX_RETRIES || retryTimer !== null) return;
    retries += 1;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        retrying = true;
        void checkNow(reason);
      },
      RETRY_MIN_MS + random() * RETRY_SPREAD_MS,
    );
  }

  async function run(reason: UpdateCheckReason, owner: Disposable | null): Promise<UpdateOutcome> {
    let outcome: UpdateOutcome;
    try {
      const result = await checkForUpdate(serverUrl);
      if (result.failed === true) outcome = { kind: "failed" };
      else if (result.manual_upgrade) {
        outcome = { kind: "manual-upgrade", unconfirmed: result.unconfirmed };
      } else if (result.available && result.version !== null) {
        outcome = { kind: "available", version: result.version, body: result.body ?? "" };
      } else outcome = { kind: "up-to-date" };
    } catch (err) {
      log.error("Update check failed", { reason, error: String(err) });
      outcome = { kind: "failed" };
    }
    if (reason !== "manual" && owner === lifetime && owner !== null) {
      if (outcome.kind !== "failed") retries = 0;
      else scheduleRetry(reason);
    }
    // A check that outlives stop() reports to nobody: its page is gone.
    if (owner === lifetime) {
      for (const listener of listeners) listener(outcome, inFlightReason);
    }
    return outcome;
  }

  function checkNow(reason: UpdateCheckReason): Promise<UpdateOutcome> {
    const isRetry = retrying;
    retrying = false;
    if (inFlight !== null) {
      if (reason === "manual") inFlightReason = reason;
      if (isRetry) {
        void inFlight.then((outcome) => {
          if (outcome.kind === "failed") scheduleRetry(reason);
        });
      }
      return inFlight;
    }
    const now = Date.now();
    if (
      reason !== "manual" &&
      !isRetry &&
      lastCheckAt !== null &&
      now - lastCheckAt < MIN_BACKGROUND_GAP_MS
    ) {
      deferTimer ??= setTimeout(
        () => {
          deferTimer = null;
          void checkNow(reason);
        },
        lastCheckAt + MIN_BACKGROUND_GAP_MS - now,
      );
      return Promise.resolve({ kind: "up-to-date" });
    }
    if (reason !== "manual" && !isRetry) retries = 0;
    lastCheckAt = now;
    inFlightReason = reason;
    const pending = run(reason, lifetime).finally(() => {
      inFlight = null;
    });
    inFlight = pending;
    return pending;
  }

  function start(): void {
    if (lifetime !== null) return;
    const owned = new Disposable();
    lifetime = owned;
    active = checker;
    scheduleNext();
  }

  function stop(): void {
    lifetime?.destroy();
    lifetime = null;
    for (const pending of [timer, reconnectTimer, retryTimer, deferTimer]) {
      if (pending !== null) clearTimeout(pending);
    }
    timer = reconnectTimer = retryTimer = deferTimer = null;
    retries = 0;
    if (active === checker) active = null;
  }

  const checker: UpdateChecker = {
    serverUrl,
    start,
    stop,
    checkNow,
    notifyReconnected() {
      if (lifetime === null || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void checkNow("reconnect");
      }, random() * RECONNECT_SPREAD_MS);
    },
    onOutcome(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return checker;
}
