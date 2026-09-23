/**
 * Safety store (B9-15): the signed-in user's own moderation notices and
 * restrictions. Recipient-only: every fact here came from ready.notices, a
 * targeted mod_action frame or GET /users/me/moderation, never a moderator
 * read. main.ts clears it on sign-out and profile switch; never persisted.
 *
 * - `notices` are unacknowledged warnings, oldest first, deduped by action
 *   id. One leaves only when the server confirms the acknowledgement (Q4).
 * - `timeout` is the active timeout's server-supplied expiry. The local
 *   expiry timer is advisory and runs on the server's clock as far as the
 *   client can tell: a live timeout frame measures the offset, and a refused
 *   send (TIMED_OUT) revalidates it against the server.
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
/** The local clock minus the server's. */
let clockSkewMs = 0;
/** The server said a timeout was in force at local time `at`; `id` names a live frame's action. */
let confirmed: { readonly at: number; readonly id: number | null } | null = null;

/** setTimeout's delay is a signed 32-bit int; longer timeouts re-arm. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * How far inside its expiry a server-confirmed timeout that the local clock
 * already reads as expired is assumed to be.
 * ponytail: the server's clock is never read directly, so a badly skewed
 * clock may unlock early and be refused again; each refusal re-pulls the skew.
 */
const REFUSAL_MARGIN_MS = 2_000;

/** The server's clock, as far as the client can tell. */
export function serverNow(): number {
  return Date.now() - clockSkewMs;
}

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
  const delay = serverTime(expiresAt) - serverNow();
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      if (safetyStore.getState().timeout?.expiresAt !== expiresAt) return;
      if (serverTime(expiresAt) > serverNow()) armExpiry(expiresAt);
      else setActiveTimeout(null);
    },
    Math.min(delay, MAX_DELAY_MS),
  );
}

/** Set (expiry from the server) or clear the active timeout. */
export function setActiveTimeout(expiresAt: string | null): void {
  clearExpiryTimer();
  const active = expiresAt !== null && serverTime(expiresAt) > serverNow();
  if (active) armExpiry(expiresAt);
  safetyStore.setState((prev) => ({ ...prev, timeout: active ? { expiresAt } : null }));
}

/** The active timeout in `rows`: an unlifted timeout whose expiry is still ahead. */
export function activeTimeoutIn(rows: readonly OwnModerationAction[]): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (r.kind !== "timeout" || r.lifted_at !== null || r.expires_at === null) continue;
    if (serverTime(r.expires_at) <= serverNow()) continue;
    if (latest === null || serverTime(r.expires_at) > serverTime(latest)) latest = r.expires_at;
  }
  return latest;
}

/** A clock reading past a timeout the server said was in force at `at` is fast: pull it back inside. */
function assumeInForce(at: number, expiresAt: string): void {
  clockSkewMs = Math.max(clockSkewMs, at - serverTime(expiresAt) + REFUSAL_MARGIN_MS);
}

/**
 * The server says a timeout is in force now: a live frame (its action id and
 * expiry) or a TIMED_OUT refusal (null). The next history read measures the
 * clock offset from it.
 */
export function confirmTimeout(id: number | null, expiresAt?: string): void {
  confirmed = { at: Date.now(), id };
  if (expiresAt !== undefined) assumeInForce(confirmed.at, expiresAt);
}

function measureClock(rows: readonly OwnModerationAction[]): void {
  if (confirmed === null) return;
  const { at, id } = confirmed;
  confirmed = null;
  const timeouts = rows.filter((r) => r.kind === "timeout");
  // A live frame is sent as its row is written: the row's issue time is the server's "now".
  const live = timeouts.find((r) => r.id === id);
  if (live !== undefined) {
    clockSkewMs = at - serverTime(live.created_at);
    return;
  }
  const newest = timeouts.reduce<OwnModerationAction | undefined>(
    (a, r) => (a === undefined || serverTime(r.created_at) > serverTime(a.created_at) ? r : a),
    undefined,
  );
  if (newest !== undefined && newest.lifted_at === null && newest.expires_at !== null) {
    assumeInForce(at, newest.expires_at);
  }
}

function applyHistory(rows: readonly OwnModerationAction[]): void {
  measureClock(rows);
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
  clockSkewMs = 0;
  confirmed = null;
  clearExpiryTimer();
  safetyStore.setState(() => INITIAL);
}
