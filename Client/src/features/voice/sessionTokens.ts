// Voice token refresh and LiveKit URL resolution for the session.
import { VoiceTokenManager } from "@lib/voice/voiceTokenManager";
import { LiveKitUrlResolver } from "@lib/voice/livekitUrlResolver";
import { SessionE2ee } from "./sessionE2ee";

/** P2-T5: how long a reconnect attempt waits for its voice_token_refresh
 *  reply before trying with the token it has. */
const RECONNECT_TOKEN_WAIT_MS = 10_000;

export abstract class SessionTokens extends SessionE2ee {
  protected _tokenManager = new VoiceTokenManager({
    getWs: () => this.ws,
    // P2-T5: a long auto-reconnect refreshes its token too.
    hasVoiceSession: () => this._room !== null || this._state.type === "reconnecting",
    // Retry at the rate-limit cadence, not the full periodic one —
    // see VoiceTokenManager.startRetryTimer.
    onRefreshTimeout: () => this._tokenManager.startRetryTimer(),
  });

  protected _urlResolver = new LiveKitUrlResolver();

  // --- URL resolution (delegated to LiveKitUrlResolver) ---

  protected async resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
    return this._urlResolver.resolve(proxyPath, directUrl);
  }

  // --- Token refresh (delegated to VoiceTokenManager) ---

  protected startTokenRefreshTimer(): void {
    this._tokenManager.startRefreshTimer();
  }

  protected clearTokenRefreshTimer(): void {
    this._tokenManager.clearTimers();
  }

  protected requestTokenRefresh(): void {
    this._tokenManager.requestRefresh();
  }

  /** Request a refresh and resolve once a token lands, or after
   *  RECONNECT_TOKEN_WAIT_MS (rate-limited or unanswered). */
  protected refreshTokenAndWait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, RECONNECT_TOKEN_WAIT_MS);
      this._tokenWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.requestTokenRefresh();
    });
  }

  handleVoiceTokenRefresh(token?: string): void {
    // KNOWN LIMITATION: The livekit-client SDK does not expose a method to
    // rotate the token on an active connection. We store the fresh token so
    // that reconnection (auto-reconnect or manual rejoin) uses it, but the
    // live session continues with the original token. This means:
    //   - Sessions longer than the server's 5-minute TTL remain connected
    //     (LiveKit keeps active connections alive) but lose the ability to
    //     reconnect after a network blip once the original token expires.
    //   - The 4-minute refresh timer ensures a fresh token is always ready
    //     *before* the original expires, so reconnects within the window work.
    // See also: Server/ws/livekit.go tokenTTL constant (5 * time.Minute).
    if (token && this._state.type === "connected") {
      this.setState({ ...this._state, latestToken: token });
    } else if (token && this._state.type === "reconnecting") {
      this.setState({ ...this._state, latestToken: token });
    }
    this._tokenWaiter?.();
    this._tokenWaiter = null;
    this._tokenManager.handleRefreshResponse();
  }
}
