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
import { updatePresence } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { loadUserStatus } from "./userStatus";

export interface PresenceSender {
  /**
   * Send (or, if the shared limiter's window is closed, queue) a presence
   * change. Omit `customStatus` to leave whatever custom-status text the
   * server already has standing — that is what every caller except an
   * explicit custom-status commit wants.
   */
  send(status: UserStatus, customStatus?: string): void;
  /** Cancel any pending retry. Call on teardown of the owning session. */
  destroy(): void;
}

/**
 * Build a `PresenceSender` bound to one `ws` and one `RateLimiter`. Callers
 * that want to share a budget (which is every real caller — see module
 * doc) must construct this once and pass the same instance to each
 * producer, rather than calling this factory once per producer.
 */
export function createPresenceSender(ws: WsClient, limiter: RateLimiter): PresenceSender {
  let retry: ReturnType<typeof setTimeout> | null = null;

  function send(status: UserStatus, customStatus?: string): void {
    const userId = authStore.getState().user?.id ?? 0;
    if (userId !== 0) {
      updatePresence(userId, status, customStatus);
    }
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    if (limiter.tryConsume()) {
      if (customStatus === undefined) {
        ws.send({ type: "presence_update", payload: { status } });
      } else {
        ws.send({ type: "presence_update", payload: { status, custom_status: customStatus } });
      }
    } else {
      // The window is still closed from an earlier send (any producer's) —
      // retry once it reopens instead of dropping this one silently.
      // Re-reads loadUserStatus() at fire time so a burst of calls in
      // between coalesces onto a single retry carrying the latest value.
      retry = setTimeout(() => {
        retry = null;
        send(loadUserStatus(), customStatus);
      }, limiter.getRemainingMs());
    }
  }

  function destroy(): void {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
  }

  return { send, destroy };
}
