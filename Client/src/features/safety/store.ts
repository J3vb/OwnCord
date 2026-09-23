/**
 * Safety store (B9-15): the signed-in user's own moderation notices and
 * restrictions. Recipient-only: every fact here came from ready.notices, a
 * targeted mod_action frame or GET /users/me/moderation, never a moderator
 * read. main.ts clears it on sign-out and profile switch; never persisted.
 *
 * - `notices` are unacknowledged warnings, oldest first, deduped by action
 *   id. One leaves only when the server confirms the acknowledgement (Q4).
 * - `timeout` is the active timeout's server-supplied expiry. The local
 *   expiry timer is advisory: a refused send (TIMED_OUT) revalidates it
 *   against the server.
 * - `history` is the latest GET /users/me/moderation answer; null until one
 *   lands.
 */

import type { ApiClient, OwnModerationAction } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createStore } from "@lib/store";
import type { ReadyNotice } from "@lib/types";

const log = createLogger("safety");

/**
 * A server timestamp in epoch ms. The ledger's SQLite datetime('now')
 * ("2026-09-23 12:56:05") is UTC with no zone; the wire's RFC 3339 has one.
 */
export function serverTime(raw: string): number {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
}

export type AckState = "idle" | "pending" | "failed";

export interface ModerationNotice {
  readonly id: number;
  readonly reason: string;
  readonly createdAt: string;
  readonly ack: AckState;
}

export interface SafetyState {
  readonly notices: readonly ModerationNotice[];
  /** The active timeout's expiry (ISO, from the server), or null. */
  readonly timeout: { readonly expiresAt: string } | null;
  readonly history: readonly OwnModerationAction[] | null;
  readonly historyFailed: boolean;
}

const INITIAL: SafetyState = { notices: [], timeout: null, history: null, historyFailed: false };

export const safetyStore = createStore<SafetyState>(INITIAL);

type HistorySource = Pick<ApiClient, "getOwnModeration">;

let source: HistorySource | null = null;
let refreshSeq = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** setTimeout's delay is a signed 32-bit int; longer timeouts re-arm. */
const MAX_DELAY_MS = 2 ** 31 - 1;

function byCreated(a: ModerationNotice, b: ModerationNotice): number {
  return serverTime(a.createdAt) - serverTime(b.createdAt) || a.id - b.id;
}

/** Ready's notices are the whole unacknowledged set; an in-flight ack keeps its state. */
export function setReadyNotices(notices: readonly ReadyNotice[]): void {
  safetyStore.setState((prev) => {
    const ack = new Map(prev.notices.map((n) => [n.id, n.ack]));
    const next = notices.map((n) => ({
      id: n.id,
      reason: n.reason,
      createdAt: n.created_at,
      ack: ack.get(n.id) ?? "idle",
    }));
    return { ...prev, notices: next.toSorted(byCreated) };
  });
}

/** A live warning. Returns false when it was already shown (a duplicate frame). */
export function addNotice(id: number, reason: string, createdAt: string): boolean {
  if (safetyStore.getState().notices.some((n) => n.id === id)) return false;
  safetyStore.setState((prev) => ({
    ...prev,
    notices: [...prev.notices, { id, reason, createdAt, ack: "idle" as const }].toSorted(byCreated),
  }));
  return true;
}

export function setNoticeAck(id: number, ack: AckState): void {
  safetyStore.setState((prev) => ({
    ...prev,
    notices: prev.notices.map((n) => (n.id === id ? { ...n, ack } : n)),
  }));
}

/** The server confirmed the acknowledgement: the notice leaves. */
export function removeNotice(id: number): void {
  safetyStore.setState((prev) => ({
    ...prev,
    notices: prev.notices.filter((n) => n.id !== id),
  }));
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function armExpiry(expiresAt: string): void {
  const delay = serverTime(expiresAt) - Date.now();
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      if (safetyStore.getState().timeout?.expiresAt !== expiresAt) return;
      if (serverTime(expiresAt) > Date.now()) armExpiry(expiresAt);
      else setActiveTimeout(null);
    },
    Math.min(delay, MAX_DELAY_MS),
  );
}

/**
 * Set (expiry from the server) or clear the active timeout.
 * ponytail: the expiry check uses the local clock, so a skewed clock can end
 * the notice early; the next refused send revalidates it against the server.
 */
export function setActiveTimeout(expiresAt: string | null): void {
  clearExpiryTimer();
  const active = expiresAt !== null && serverTime(expiresAt) > Date.now();
  if (active) armExpiry(expiresAt);
  safetyStore.setState((prev) => ({ ...prev, timeout: active ? { expiresAt } : null }));
}

/** The active timeout in `rows`: an unlifted timeout whose expiry is still ahead. */
export function activeTimeoutIn(rows: readonly OwnModerationAction[]): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (r.kind !== "timeout" || r.lifted_at !== null || r.expires_at === null) continue;
    if (serverTime(r.expires_at) <= Date.now()) continue;
    if (latest === null || serverTime(r.expires_at) > serverTime(latest)) latest = r.expires_at;
  }
  return latest;
}

function applyHistory(rows: readonly OwnModerationAction[]): void {
  const acknowledged = new Set(rows.filter((r) => r.acknowledged_at !== null).map((r) => r.id));
  const created = new Map(rows.map((r) => [r.id, r.created_at]));
  safetyStore.setState((prev) => {
    const known = new Set(prev.notices.map((n) => n.id));
    // A warning whose live frame was missed on a resumed connection (no ready).
    const missed = rows
      .filter((r) => r.kind === "warning" && r.acknowledged_at === null && !known.has(r.id))
      .map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, ack: "idle" as const }));
    return {
      ...prev,
      history: rows,
      historyFailed: false,
      // Acknowledged elsewhere (another device): the server already has it.
      // The server's issue time replaces a live notice's local receipt time.
      notices: [
        ...prev.notices
          .filter((n) => !acknowledged.has(n.id))
          .map((n) => ({ ...n, createdAt: created.get(n.id) ?? n.createdAt })),
        ...missed,
      ].toSorted(byCreated),
    };
  });
  setActiveTimeout(activeTimeoutIn(rows));
}

/**
 * Re-read the caller's own moderation history, the authority for timeout
 * expiry and lifted/removed state after a restart or a missed live frame.
 * `api` is remembered for later refreshes (the Safety tab, a retry). Only
 * the latest request's answer applies.
 */
export function refreshOwnModeration(api?: HistorySource): void {
  if (api !== undefined) source = api;
  const from = source;
  if (from === null) return;
  const seq = ++refreshSeq;
  from
    .getOwnModeration()
    .then((rows) => {
      if (seq === refreshSeq && from === source) applyHistory(rows);
    })
    .catch((err: unknown) => {
      if (seq !== refreshSeq || from !== source) return;
      log.warn("Failed to load own moderation history", { error: String(err) });
      safetyStore.setState((prev) => ({ ...prev, historyFailed: true }));
    });
}

export function resetSafetyStore(): void {
  source = null;
  refreshSeq++;
  clearExpiryTimer();
  safetyStore.setState(() => INITIAL);
}
