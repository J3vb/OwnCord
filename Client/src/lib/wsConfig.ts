/** WebSocket client types, timing constants and URL helpers, re-exported by ws.ts. */

import type { ServerMessage } from "./types";

export type ConnectionState =
  "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting";

/** The UX-facing 3-state status stored in ui.store.connectionStatus. */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * Collapse the internal 5-state machine into the UX-facing status.
 * "connecting"/"authenticating" map to "reconnecting" because a reconnect
 * cycle passes through them (reconnecting → connecting → authenticating →
 * connected); mapping them to "disconnected" would flap the banner mid-retry.
 */
export function toConnectionStatus(state: ConnectionState): ConnectionStatus {
  switch (state) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    default:
      return "reconnecting";
  }
}

export type WsListener<T extends ServerMessage["type"]> = (
  payload: Extract<ServerMessage, { type: T }>["payload"],
  id?: string,
) => void;

/** TOFU certificate event emitted by the Rust proxies (http / ws).
 *  - "first_use": no pin yet — the proxy REJECTED the connection; the user must
 *    confirm this fingerprint (acceptCertFingerprint) before anything is sent.
 *  - "trusted": pin matches — proceed.
 *  - "mismatch": pin differs — reject (possible MITM or cert rotation). */
export interface CertTofuEvent {
  readonly host: string;
  readonly fingerprint: string;
  readonly status: "first_use" | "trusted" | "mismatch";
  readonly message?: string;
  readonly storedFingerprint?: string;
}

/** Parse the stored fingerprint from the Rust cert-tofu message string. */
export function parseStoredFingerprint(message?: string): string | undefined {
  if (!message) return undefined;
  const match = /Stored:\s+(\S+)/.exec(message);
  return match?.[1];
}

/**
 * The native `accept_cert_fingerprint` command rejects with this when the user
 * declines the OS pin-confirmation dialog (`ws_proxy.rs`). Kept in step with
 * that command the way `TLS_CERT_CODE` mirrors `TLS_CERT_ERROR_CODE`.
 */
// i18n-exempt: native rejection code, mapped to catalog text by the caller
export const CERT_NOT_ACCEPTED = "certificate not accepted";

/** Whether a rejected `acceptCertFingerprint` was the user declining the
 *  native dialog, rather than failing for another reason. */
export function isCertDeclined(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)) === CERT_NOT_ACCEPTED;
}

export type CertMismatchListener = (event: CertTofuEvent) => void;
export type CertFirstUseListener = (event: CertTofuEvent) => void;

export interface WsClientConfig {
  readonly host: string;
  readonly token: string;
  readonly maxReconnectDelayMs?: number;
  readonly maxMessageSizeBytes?: number;
}

/** Longest the auth frame waits for the identity key. A slow keyring must
 *  never hold up connecting; the frame goes without the key past this. */
export const IDENTITY_KEY_WAIT_MS = 1_500;

export const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
export const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576; // 1MB
export const HEARTBEAT_INTERVAL_MS = 30_000;
// A half-open socket delivers nothing inbound while `transport.send`
// still resolves against the local buffer, so the state machine would sit on
// "connected" forever. A server's RFC 6455 control ping is answered inside the
// Rust proxy and never reaches JS, so for every server this app-side deadline
// reconnects when no frame at all arrives for 60 s: one missed app-level
// heartbeat window (30 s) plus margin, under the ~75 s Reconnecting target.
export const SERVER_SILENCE_RECONNECT_MS = 60_000;
// Silence only counts once a heartbeat ping has gone unanswered this long: a
// minimised webview throttles the heartbeat setInterval, so a quiet socket may
// simply not have been asked for a pong yet.
export const PONG_GRACE_MS = 15_000;
// U7d: a heartbeat tick that lands this long after the previous one means the
// process was frozen (sleep, suspend) in between: Chromium's intensive
// throttling of a long-hidden page spaces ticks ~60 s apart, well under this.
export const WAKE_GAP_MS = 3 * HEARTBEAT_INTERVAL_MS;
// How long the login/auto-login handshake may stay in "connecting" before the
// app gives up and returns to the login form. The native proxy already bounds
// one dial at 10 s, but ws.ts's backoff retries a dead server forever, so
// without an app-level deadline a stored-token auto-login to an offline server
// sits on the "Auto-connecting…" screen indefinitely. Two proxy windows, so a
// single slow handshake never trips it. Only the FIRST authentication is
// bounded: once the session is live, an outage keeps the in-app reconnect
// banner and its retry loop instead of bouncing the user out.
export const PREAUTH_CONNECT_TIMEOUT_MS = 20_000;
// P5-S04: a SERVER_BUSY refusal is the server answering, so each one restarts
// the pre-auth deadline, but never past this long after the first attempt: a
// server that stays saturated still ends in an error.
export const PREAUTH_BUSY_CAP_MS = 70_000;
// The least time between two wake-signal redials, so a flapping network
// or a burst of focus changes cannot spin the reconnect loop.
export const WAKE_KICK_FLOOR_MS = 2_000;
// A `cseq` gap means the server lost a frame meant for this socket
// and owes it a full ready. The resume waits a random 1-5 s so that, when one
// server-side fault (a DB outage) marks every client at once, the herd does
// not redial in one instant. Gap resumes close together (losses that keep
// coming) wait longer each time, and the window resets after a quiet minute.
export const GAP_RESUME_WINDOWS_MS: ReadonlyArray<readonly [number, number]> = [
  [1_000, 5_000],
  [5_000, 15_000],
  [15_000, 30_000],
];
export const GAP_RESUME_QUIET_MS = 60_000;
// U4: a wall-clock gap past WAKE_GAP_MS means the process was suspended, so
// the next dial is marked a wake (`auth.wake = true`). The SERVER arbitrates
// whether that wake would displace another device's live session: a lone
// device reconnects silently, while another device holding the account is
// answered with ANOTHER_DEVICE_ACTIVE and the user is asked before taking over.
// Marking every wake (rather than only gaps past ~3 min) closes the 90-180 s
// window where a woken laptop used to displace the desktop silently, and no
// longer prompts a single-device user after a long sleep.

export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Wrap a bare (unbracketed) IPv6 literal in brackets so it can be embedded in
 * a `wss://` authority, mirroring the detection api.ts's `isValidHost` and
 * livekitSession.ts's `ensureLiveKitProxy` already use: more than one colon
 * means the whole string is the address (a single colon is the host:port
 * separator instead), and RFC 3986 gives a bare IPv6 literal no way to carry
 * a port, so this never needs to split one off. A host that is already
 * bracketed (or is a DNS name / IPv4 literal, with or without a port) is
 * returned unchanged.
 */
export function bracketBareIPv6Host(host: string): string {
  if (
    !host.startsWith("[") &&
    (host.match(/:/g) ?? []).length > 1 &&
    /^[0-9A-Fa-f:.]+$/.test(host)
  ) {
    return `[${host}]`;
  }
  return host;
}

/** The `wss://` URL of the server's socket endpoint, for a profile host as
 *  the user typed it. A bare IPv6 literal has to be bracketed or the URL
 *  parser reads its first hextet as the host and the rest as a port. */
export function wsUrlFor(host: string): string {
  return `wss://${bracketBareIPv6Host(host)}/api/v1/ws`;
}
