/**
 * The transport `lib/ws.ts` owns today: one WebSocket-shaped connection,
 * proxied through the native host so the app never has to trust an
 * unpinned TLS certificate itself.
 *
 * No-seam: `lib/ws.ts` is a closure returned by `createWsClient()`, not an
 * exported function — there is nothing to bind a legacy suite against yet.
 * The suite lands with the seam in B7-4.
 *
 * Narrowed to the seam (rule 3): the real `ws.on(type, listener)` dispatches
 * a parsed, protocol-typed `ServerMessage` — a domain type this contract must
 * not take. `onMessage` instead hands the caller the raw frame text exactly
 * as the native transport delivers it; parsing it into `ServerMessage` stays
 * in `lib/ws.ts`, on the app side of this seam.
 */

/** Re-declared, structurally identical to `WsClientConfig` (`lib/ws.ts`). */
export interface SocketConnectOptions {
  readonly host: string;
  readonly token: string;
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

export interface SocketTransport {
  connect(options: SocketConnectOptions): void;
  disconnect(): void;
  send(text: string): void;
  /** Accept a changed certificate fingerprint for a host, then reconnect. */
  acceptCertificate(host: string, fingerprint: string): Promise<void>;
  onStateChange(handler: (state: SocketConnectionState) => void): () => void;
  /** A raw inbound frame, exactly as the native transport delivered it. */
  onMessage(handler: (text: string) => void): () => void;
  onCertFirstUse(handler: (event: SocketCertEvent) => void): () => void;
  onCertMismatch(handler: (event: SocketCertEvent) => void): () => void;
}
