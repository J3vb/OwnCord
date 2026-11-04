// The connect page's response-time cut-off, kept apart from profiles.ts so
// the many tests that mock that module still get the real table.

/**
 * The one response-time cut-off the connect page's status dot and its
 * response-time text both read, so a row never pairs a green dot with
 * warning-coloured text. The probe runs through the desktop TLS tunnel (a
 * fresh handshake per request, about three network round trips), so a home
 * server reached over the internet still answers well under it.
 */
const SLOW_RESPONSE_MS = 500;

/** Health status for a server that answered in `latencyMs`. */
export function statusForLatency(latencyMs: number): "online" | "slow" {
  return latencyMs < SLOW_RESPONSE_MS ? "online" : "slow";
}
