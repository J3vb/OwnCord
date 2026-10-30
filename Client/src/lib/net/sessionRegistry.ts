/**
 * Session registry — the one place per-server state registers its reset.
 *
 * Every store or module cache that holds data belonging to the signed-in
 * server registers a reset here at load; `clearAuth` runs them all. Without a
 * registry, each new cache had to be remembered at several teardown sites, and
 * the ones that were forgotten kept the previous server's data alive.
 *
 * Leaf module: it imports only the logger, so stores and lib modules can
 * import it without a cycle.
 */

import { createLogger } from "../logger";

const log = createLogger("sessionRegistry");

/** Why the session ended; see `LogoutReason` in auth.store for each meaning. */
export type SessionResetReason = "user" | "protocol_epoch" | "server_switch";

/**
 * When an entry runs. `session` cancels in-flight work before any store is
 * emptied, `voice` runs before every domain reset, `domain` empties stores,
 * `cache` drops derived module caches.
 */
export type SessionResetPhase = "session" | "voice" | "domain" | "cache";

const PHASE_ORDER: readonly SessionResetPhase[] = ["session", "voice", "domain", "cache"];

interface Entry {
  readonly phase: SessionResetPhase;
  readonly reset: (reason: SessionResetReason) => void;
}

// Map order is registration order, which is the order within a phase.
const entries = new Map<string, Entry>();

/**
 * Register `reset` under `name` ("<module>:<what>"). Registering a name again
 * replaces the old entry (HMR, a remounted page). Resets must be synchronous.
 * The returned disposer removes this registration only, never a later one that
 * replaced it.
 */
export function registerSessionReset(
  name: string,
  reset: (reason: SessionResetReason) => void,
  opts?: { readonly phase?: SessionResetPhase },
): () => void {
  const entry: Entry = { phase: opts?.phase ?? "domain", reset };
  const previous = entries.get(name);
  if (previous !== undefined && previous.reset !== reset) {
    log.debug("Session reset re-registered with a different function", { name });
  }
  entries.set(name, entry);
  return () => {
    if (entries.get(name) === entry) entries.delete(name);
  };
}

/**
 * Run every registered reset in phase order, each isolated: a throw is logged
 * and the rest still run. Returns the names that threw.
 */
export function runSessionResets(reason: SessionResetReason): readonly string[] {
  const failed: string[] = [];
  const snapshot = [...entries];
  for (const phase of PHASE_ORDER) {
    for (const [name, entry] of snapshot) {
      if (entry.phase !== phase) continue;
      try {
        entry.reset(reason);
      } catch (err) {
        failed.push(name);
        log.warn("Session reset failed", { name, error: String(err) });
      }
    }
  }
  return failed;
}

/** Registered names in run order. For tests. */
export function listSessionResets(): readonly string[] {
  const names: string[] = [];
  for (const phase of PHASE_ORDER) {
    for (const [name, entry] of entries) {
      if (entry.phase === phase) names.push(name);
    }
  }
  return names;
}
