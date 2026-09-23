/**
 * The socket capability: it hands out one transport per connection, proxied
 * through the native host so the app never has to trust an unpinned TLS
 * certificate itself.
 *
 * **Amended in B7-4**, which is the milestone that created this seam and may
 * shape it. Two things the first draft could not express:
 *
 *   - The app needs a *fresh* transport per client — a new login, and every
 *     test, must not inherit the previous one's listeners and certificate
 *     registration. A registered singleton would be a second, never-connected
 *     transport sitting next to the one the app runs on, so the capability is
 *     a factory and the thing it returns is the transport.
 *   - The commands settle as promises. `lib/ws.ts` classifies a failed dial
 *     and a failed send, which a `void` return cannot carry.
 *
 * Narrowed to the seam (rule 3): the real `ws.on(type, listener)` dispatches
 * a parsed, protocol-typed `ServerMessage` — a domain type this contract must
 * not take. `onMessage` instead hands the caller the raw frame text exactly
 * as the native transport delivers it; parsing it into `ServerMessage` stays
 * in `lib/ws.ts`, on the app side of this seam.
 */
export interface SocketTransport {
  /** A transport for one connection. Each call is independent — callers that
   *  need isolation (a fresh login, a test) get it by calling again. */
  create(): SocketConnection;
}

/** Re-declared, structurally identical to the endpoint `lib/ws.ts` builds for
 *  a profile host, plus the parts a transport needs to complete a login. */
export interface SocketConnectOptions {
  /** The endpoint to dial, already resolved by the app — bracketing a bare
   *  IPv6 literal is a URL concern, not a transport one. */
  readonly url: string;
  readonly token: string;
  /** Reconnect policy and frame-size ceiling, for an adapter that owns them.
   *  The app-side client owns both today. */
  readonly maxReconnectDelayMs?: number;
  readonly maxMessageSizeBytes?: number;
}

/** Re-declared, structurally identical to `ConnectionState` (`lib/ws.ts`). */
export type SocketConnectionState =
  "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting";

/**
 * TOFU certificate event emitted by the native transport. Re-declared,
 * structurally identical to `CertTofuEvent` (`lib/ws.ts`).
 */
export interface SocketCertEvent {
  readonly host: string;
  readonly fingerprint: string;
  readonly status: "first_use" | "trusted" | "mismatch";
  readonly message?: string;
  readonly storedFingerprint?: string;
}

/** Optional retry metadata for a disconnected state report. */
export interface SocketRetryHint {
  /** Server minimum wait, relative to this disconnect, when the transport can
   * expose it. The app bounds it by maxReconnectDelayMs. The current desktop
   * proxy exposes neither handshake headers nor a structured retry delay. */
  readonly retryAfterMs?: number;
}

/** One connection's transport. */
export interface SocketConnection {
  /** Open the connection. Rejects when the handshake fails, or when there is
   *  no native host at all — the caller tells those apart by the state it has
   *  already seen, not by the error. */
  connect(options: SocketConnectOptions): Promise<void>;
  /** Close the connection and stop delivering frames. */
  disconnect(): Promise<void>;
  /** Rejects when the native send fails, so the caller can classify it. */
  send(text: string): Promise<void>;
  /** Accept a changed certificate fingerprint for a host, then reconnect. */
  acceptCertificate(host: string, fingerprint: string): Promise<void>;
  onStateChange(
    handler: (state: SocketConnectionState, retryHint?: SocketRetryHint) => void,
  ): () => void;
  /** A raw inbound frame, exactly as the native transport delivered it. */
  onMessage(handler: (text: string) => void): () => void;
  onCertFirstUse(handler: (event: SocketCertEvent) => void): () => void;
  onCertMismatch(handler: (event: SocketCertEvent) => void): () => void;
  /** Register the app-lifetime certificate listener, before any connect.
   *  Idempotent. */
  startCertListener(): Promise<void>;
}
