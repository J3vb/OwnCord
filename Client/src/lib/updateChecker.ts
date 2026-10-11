// updateChecker — keeps asking the connected server whether a newer client is
// on offer while the app runs, instead of only once at startup. A server that
// updated is noticed through the same question (the client feed it serves is
// what changed), so a reconnect and a slow interval both route here. UI policy (banner, dismiss) stays in components/UpdateNotifier.

import { Disposable } from "./disposable";
import { createLogger } from "./logger";
import { checkForUpdate } from "./updater";

const log = createLogger("update-checker");

/** Mean gap between background checks; each gap is jittered by ±JITTER. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;
export const UPDATE_CHECK_JITTER = 0.25;
/** Floor between background checks, so a flapping socket cannot hammer the feed. */
export const MIN_BACKGROUND_GAP_MS = 60_000;

export type UpdateCheckReason = "startup" | "interval" | "reconnect" | "manual";

export type UpdateOutcome =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "available"; readonly version: string; readonly body: string }
  | { readonly kind: "manual-upgrade" }
  | { readonly kind: "failed" };

export interface UpdateChecker {
  readonly serverUrl: string;
  /** Begin the periodic checks and become the active checker. */
  start(): void;
  stop(): void;
  /** Run a check now. `manual` always runs; any other reason respects the gap floor. */
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

  function scheduleNext(): void {
    const jitter = 1 + (random() * 2 - 1) * UPDATE_CHECK_JITTER;
    timer = setTimeout(() => {
      timer = null;
      void checkNow("interval").finally(() => {
        if (lifetime !== null && timer === null) scheduleNext();
      });
    }, UPDATE_CHECK_INTERVAL_MS * jitter);
  }

  async function run(reason: UpdateCheckReason, owner: Disposable | null): Promise<UpdateOutcome> {
    let outcome: UpdateOutcome;
    try {
      const result = await checkForUpdate(serverUrl);
      if (result.failed === true) outcome = { kind: "failed" };
      else if (result.manual_upgrade) outcome = { kind: "manual-upgrade" };
      else if (result.available && result.version !== null) {
        outcome = { kind: "available", version: result.version, body: result.body ?? "" };
      } else outcome = { kind: "up-to-date" };
    } catch (err) {
      log.error("Update check failed", { reason, error: String(err) });
      outcome = { kind: "failed" };
    }
    // A check that outlives stop() reports to nobody: its page is gone.
    if (owner === lifetime) {
      for (const listener of listeners) listener(outcome, inFlightReason);
    }
    return outcome;
  }

  function checkNow(reason: UpdateCheckReason): Promise<UpdateOutcome> {
    if (inFlight !== null) {
      if (reason === "manual") inFlightReason = reason;
      return inFlight;
    }
    const now = Date.now();
    if (reason !== "manual" && lastCheckAt !== null && now - lastCheckAt < MIN_BACKGROUND_GAP_MS) {
      return Promise.resolve({ kind: "up-to-date" });
    }
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
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (active === checker) active = null;
  }

  const checker: UpdateChecker = {
    serverUrl,
    start,
    stop,
    checkNow,
    notifyReconnected() {
      if (lifetime !== null) void checkNow("reconnect");
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
