// Voice token refresh manager — extracted from livekitSession.ts.
// Owns the refresh timer, response timeout, and budget-guarded send logic.

import type { WsClient } from "@lib/ws";
import { createLogger } from "@lib/logger";

const log = createLogger("voiceTokenManager");

export interface TokenManagerDeps {
  getWs: () => WsClient | null;
  isRoomConnected: () => boolean;
  onRefreshTimeout: () => void;
}

/**
 * Token refresh interval: 4 minutes (refresh 1 min before the server's
 * 5-minute TTL expiry — see Server/ws/livekit.go tokenTTL). Must stay
 * below that TTL or a network blip after minute 5 hands attemptAutoReconnect
 * an already-expired token and every reconnect attempt fails (OC-0014).
 */
const TOKEN_REFRESH_MS = 4 * 60 * 1000;

/** Server-side rate limit: 1 voice_token_refresh per 60s per user. */
const RATE_LIMIT_MS = 60_000;

/** BUG-146: Response deadline — if the server doesn't reply within this window,
 *  the token is stale but the session stays alive (LiveKit keeps active
 *  connections beyond token expiry). We reschedule instead of disconnecting. */
const REFRESH_TIMEOUT_MS = 60_000;

export class VoiceTokenManager {
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSentAt = 0;

  constructor(private deps: TokenManagerDeps) {}

  /** Start the periodic refresh timer. */
  startRefreshTimer(): void {
    this.clearTimers();
    this._refreshTimer = setTimeout(() => {
      this.requestRefresh();
    }, TOKEN_REFRESH_MS);
    log.debug("Token refresh timer started", { refreshInMs: TOKEN_REFRESH_MS });
  }

  /** OC-0429: re-arm at the retry cadence (RATE_LIMIT_MS) instead of the full
   *  periodic interval. Used after an unanswered voice_token_refresh (see
   *  onRefreshTimeout below) — re-arming at TOKEN_REFRESH_MS there would leave
   *  the stored token expired for up to another full cycle, since the server's
   *  token TTL is only 1 minute above TOKEN_REFRESH_MS. RATE_LIMIT_MS is safe
   *  against the server's 1-per-60s budget: requestRefresh() stamps
   *  _lastSentAt at the same moment this retry's predecessor deadline was
   *  armed, 60s before it fires. */
  startRetryTimer(): void {
    this.clearTimers();
    this._refreshTimer = setTimeout(() => {
      this.requestRefresh();
    }, RATE_LIMIT_MS);
    log.debug("Token refresh retry timer started", { retryInMs: RATE_LIMIT_MS });
  }

  /** Clear all timers. Called on leave, cleanup, and before restarting. */
  clearTimers(): void {
    if (this._refreshTimer !== null) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._timeoutTimer !== null) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  /** Send a token refresh request, respecting the server's rate limit.
   *  Arms a BUG-146 response-deadline timer. */
  requestRefresh(): void {
    if (!this.deps.getWs() || !this.deps.isRoomConnected()) {
      log.debug("Skipping token refresh — no active session");
      return;
    }
    // OC-0029: the server refuses more than 1 voice_token_refresh per 60s
    // per user (ErrCodeRateLimited). requestTokenRefresh() is called both by
    // the routine 4-minute timer and by attemptAutoReconnect's unconditional
    // post-recovery refresh, which can land only seconds after the timer's
    // own refresh — without this guard the second request is rejected and
    // surfaces as a bare "token refresh rate limited" error toast right as
    // the user's call recovers.
    if (Date.now() - this._lastSentAt < RATE_LIMIT_MS) {
      log.debug("Skipping token refresh — one was already sent within the last 60s");
      return;
    }
    log.info("Requesting voice token refresh");
    this._lastSentAt = Date.now();
    this.deps.getWs()?.send({ type: "voice_token_refresh", payload: {} });
    // NOTE: startRefreshTimer is called from handleRefreshResponse(), not here,
    // to avoid scheduling two competing timers per cycle.

    // BUG-146: Arm a 60-second response deadline. If the server never replies,
    // the token stalls silently. On timeout we log a warning and reschedule the
    // next refresh attempt rather than disconnecting — the current live session
    // is unaffected (LiveKit keeps active connections alive beyond token expiry);
    // the risk is only that a network blip during the stale window would fail to
    // reconnect. Reconnecting for a refresh timeout is intentionally NOT done here
    // because the WS connection itself may be degraded; a forced disconnect would
    // make the UX worse than leaving the existing (still-valid) token in place.
    if (this._timeoutTimer !== null) {
      clearTimeout(this._timeoutTimer);
    }
    this._timeoutTimer = setTimeout(() => {
      this._timeoutTimer = null;
      log.warn(
        "Voice token refresh timed out — server did not respond within 60 s. " +
          "Rescheduling refresh; existing token remains in use.",
      );
      // Re-arm the next scheduled refresh so the client keeps trying.
      this.deps.onRefreshTimeout();
    }, REFRESH_TIMEOUT_MS);
  }

  /** Called when the server responds with a fresh token. */
  handleRefreshResponse(): void {
    // BUG-146: Cancel the response-deadline timer — the server replied in time.
    if (this._timeoutTimer !== null) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    this.startRefreshTimer();
    log.info("Voice token refreshed, timer restarted");
  }

  /** Reset the rate-limit budget (called on leave). */
  resetBudget(): void {
    this._lastSentAt = 0;
  }
}
