/**
 * Shared sender for `presence_update` — the token bucket, the coalescing
 * retry, and the local optimistic update all live here exactly once so that
 * every producer (auto-idle, the settings Account tab, the UserBar status
 * picker) agrees with the server's own limiter instead of each guessing
 * independently.
 *
 * The server enforces a single per-user budget (1 update / 10s, keyed by
 * user id — service/channel.go) regardless of which client surface sent the
 * frame. A `RateLimiter` created fresh per call site cannot predict that
 * shared budget: two producers each starting from a full bucket can both
 * believe they have a free token when the server has exactly one, so the
 * second frame the server actually receives gets silently dropped
 * (ErrRateLimited, no DB write, no broadcast) with nothing left to correct
 * it (OC-0210). Callers MUST share one `PresenceSender` — built from one
 * `RateLimiter` instance — for the lifetime of a session, the same way
 * MainPage.ts's `limiters` are already shared across its chat/typing/
 * reaction/voice producers.
 */

import type { WsClient } from "./ws";
import type { RateLimiter } from "./rate-limiter";
import type { UserStatus } from "./types";
import { updatePresence, membersStore } from "@stores/members.store";
import { authStore, updateUser } from "@stores/auth.store";
import {
  loadUserStatus,
  loadUserStatusOrigin,
  saveCustomStatus,
  saveUserStatus,
  type StatusOrigin,
} from "./userStatus";
import { ServerMessageType as S } from "./protocolTypes";

export interface PresenceSender {
  /**
   * Send (or, if the shared limiter's window is closed, queue) a presence
   * change. Omit `customStatus` to leave whatever custom-status text the
   * server already has standing — that is what every caller except an
   * explicit custom-status commit wants.
   */
  send(status: UserStatus, customStatus?: string): void;
  /**
   * A TIMED_OUT refusal of the frame with this envelope id: put the status
   * that was in effect before that frame's optimistic apply back, in the
   * members store and in the saved prefs. Called by the dispatcher's error
   * chain (the one writer for server events), never by this module's own
   * `ws.on` — a presence sender may read store state there, not write it.
   * A no-op when the id is not the frame this sender last put on the wire.
   */
  rollbackTimedOut(id: string | undefined): void;
  /** Cancel any pending retry. Call on teardown of the owning session. */
  destroy(): void;
}

/**
 * Slack added past the client limiter's own remaining time before a queued
 * presence_update is retried. The server's one-update-per-10s budget is
 * measured from *receipt* (service/channel.go), milliseconds after this
 * client's send, while the client limiter measures from its own send — so a
 * retry scheduled at exactly `getRemainingMs()` lands just before the
 * server's window reopens, is answered RATE_LIMITED and, without the
 * rejection handler below, is never retried (OC-0451): the client shows and
 * saves the new status while users.status and every other member keep the
 * old one.
 */
const RETRY_MARGIN_MS = 1_000;

/**
 * Build a `PresenceSender` bound to one `ws` and one `RateLimiter`. Callers
 * that want to share a budget (which is every real caller — see module
 * doc) must construct this once and pass the same instance to each
 * producer, rather than calling this factory once per producer.
 */
export function createPresenceSender(ws: WsClient, limiter: RateLimiter): PresenceSender {
  let retry: ReturnType<typeof setTimeout> | null = null;
  // The custom_status a still-queued retry carries. A plain status change
  // (customStatus === undefined) landing while that retry is pending does
  // not mean "clear the custom status" — it means the caller simply didn't
  // mention it — so send() below falls back to this instead of dropping it
  // (OC-0156).
  let pendingCustom: string | undefined;
  // The envelope id and custom_status of the frame most recently handed to
  // the transport, so a RATE_LIMITED reply can be correlated back to *this*
  // sender's presence_update — never another producer's rate limit.
  let lastSentId: string | null = null;
  let lastSentCustom: string | undefined;
  // The status/text in effect just before the optimistic apply of a change,
  // so a TIMED_OUT reply can put it back. The server refuses a timed-out custom
  // status without writing or broadcasting anything (service/channel.go's
  // requireNotTimedOut), so leaving the optimistic value in place shows the user
  // a status nobody else has. `pendingBaseline` belongs to the change(s) still
  // queued behind the limiter: captured once, by the first apply that really
  // changes the store, so a later edit or a coalescing retry re-entering with the
  // value already applied never replaces it with a value the server has not
  // accepted. `sentBaseline` is the one the frame on the wire carries.
  type Baseline = {
    readonly userId: number;
    readonly status: UserStatus;
    readonly origin: StatusOrigin;
    readonly custom: string | null;
  };
  let pendingBaseline: Baseline | null = null;
  let sentBaseline: Baseline | null = null;

  /** Put a baseline back — both the store other members are rendered from and
   *  the prefs the picker and auto-idle read. `customOnly` leaves the status
   *  the user has since picked alone. Defined outside the ws.on callback below
   *  so its store writes are not lexically inside a socket handler
   *  (local/no-store-write-in-ws-on). */
  function restoreBaseline(b: Baseline, customOnly: boolean): void {
    const status = customOnly ? loadUserStatus() : b.status;
    const origin = customOnly ? loadUserStatusOrigin() : b.origin;
    if (b.userId !== 0) {
      updatePresence(b.userId, status, b.custom);
      // authStore.user is the picker's seed (serverCustomStatus) on a remount;
      // an already-mounted picker re-seeds from the members store write above.
      updateUser({ status, custom_status: b.custom });
    }
    saveUserStatus(status, origin);
    saveCustomStatus(b.custom ?? "");
  }

  /** Arm (or replace) the single coalescing retry the window can have. */
  function armRetry(delayMs: number, custom: string | undefined): void {
    if (retry !== null) {
      clearTimeout(retry);
    }
    pendingCustom = custom;
    retry = setTimeout(() => {
      retry = null;
      send(loadUserStatus(), pendingCustom);
    }, delayMs);
  }

  function send(status: UserStatus, customStatus?: string): void {
    // A plain call inherits whatever custom_status is still queued behind
    // the limiter; an explicit call always wins outright.
    const effectiveCustom =
      customStatus !== undefined ? customStatus : retry !== null ? pendingCustom : undefined;
    const userId = authStore.getState().user?.id ?? 0;
    const existing = userId !== 0 ? membersStore.getState().members.get(userId) : undefined;
    if (
      pendingBaseline === null &&
      existing !== undefined &&
      (existing.status !== status ||
        (effectiveCustom !== undefined && (existing.customStatus ?? null) !== effectiveCustom))
    ) {
      pendingBaseline = {
        userId,
        status: existing.status,
        origin: loadUserStatusOrigin(),
        custom: existing.customStatus ?? null,
      };
    }
    if (userId !== 0) {
      updatePresence(userId, status, effectiveCustom);
    }
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    if (limiter.tryConsume()) {
      sentBaseline = pendingBaseline;
      pendingBaseline = null;
      pendingCustom = undefined;
      lastSentCustom = effectiveCustom;
      lastSentId =
        effectiveCustom === undefined
          ? ws.send({ type: "presence_update", payload: { status } })
          : ws.send({
              type: "presence_update",
              payload: { status, custom_status: effectiveCustom },
            });
    } else {
      // The window is still closed from an earlier send (any producer's) —
      // retry once it reopens instead of dropping this one silently, with a
      // margin past the end so the server's receipt-measured window has
      // reopened too. Re-reads loadUserStatus() at fire time so a burst of
      // calls in between coalesces onto a single retry carrying the latest
      // value.
      armRetry(limiter.getRemainingMs() + RETRY_MARGIN_MS, effectiveCustom);
    }
  }

  // Backstop for the receipt-vs-send skew the margin above only estimates: the
  // server refused the frame we just sent as RATE_LIMITED. Re-arm one more
  // retry a full server window out — never a busy loop — coalescing onto
  // whatever status the user has chosen by then, so the last requested status
  // always reaches the server. Registered here (a fire-and-forget frame owned
  // by this sender), so the write it eventually causes stays out of the
  // ws.on callback itself (local/no-store-write-in-ws-on).
  const unsubError = ws.on(S.ERROR, (payload, id) => {
    if (payload.code !== "RATE_LIMITED") return;
    // A newer change already queued its own retry, which carries the latest
    // status — do not clobber it, and do not double-send.
    if (retry !== null) return;
    if (id === undefined || id !== lastSentId) return; // not our frame
    pendingBaseline = sentBaseline;
    armRetry(limiter.getRemainingMs() + RETRY_MARGIN_MS, lastSentCustom);
  });

  /**
   * The dispatcher's TIMED_OUT branch for this sender. A timeout refuses a
   * non-empty custom_status without writing or broadcasting anything
   * (service/channel.go's requireNotTimedOut), so the optimistic apply in
   * send() would otherwise leave the user seeing and saving a status nobody
   * else has. A no-op unless the id is the frame this sender last put on the
   * wire.
   */
  function rollbackTimedOut(id: string | undefined): void {
    if (id === undefined || id !== lastSentId) return;
    lastSentId = null;
    const baseline = sentBaseline;
    sentBaseline = null;
    if (baseline === null) return;
    if (retry === null) {
      restoreBaseline(baseline, false);
      return;
    }
    // A newer change is queued behind the limiter and is the user's current
    // intent, so this refusal must not roll back over the status they picked.
    // The value this frame applied was never accepted, though: the queued
    // frame inherits this frame's baseline, and unless it carries a custom
    // status of its own the refused text goes now. TIMED_OUT never arms a
    // retry, so no loop.
    pendingBaseline = baseline;
    if (pendingCustom === undefined) restoreBaseline(baseline, true);
  }

  function destroy(): void {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    pendingCustom = undefined;
    unsubError();
  }

  return { send, rollbackTimedOut, destroy };
}

// ---------------------------------------------------------------------------
// Active-session registry
// ---------------------------------------------------------------------------

let activeSender: PresenceSender | null = null;

/**
 * Register the session's one `PresenceSender` so producers that are wired up
 * before any session exists — main.ts's tray "status-change" listener, which
 * is registered at module load, long before a login — can still route
 * through the same shared limiter/retry/optimistic-update instead of
 * sending `presence_update` raw and opening a second budget the server does
 * not know about (OC-0176). MainPage.ts calls this right after constructing
 * its `PresenceSender`, and again with `null` in its teardown.
 */
export function setActivePresenceSender(sender: PresenceSender | null): void {
  activeSender = sender;
}

/** The current session's `PresenceSender`, or `null` when no session is
 *  mounted (before login, or after logout/disconnect). */
export function getActivePresenceSender(): PresenceSender | null {
  return activeSender;
}
