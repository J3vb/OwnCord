// Shared host/host:port validator for server addresses entered anywhere in
// the client (the Add Server modal, the login form's implicit acceptance via
// api.ts's setConfig, and anywhere else that needs to gate a user-supplied
// address before it reaches the Rust HTTP/LiveKit proxies).
//
// Historically this lived as a private closure inside createApiClient
// (api.ts) and ServerPanel's Add Server modal carried its own, narrower
// regex that never grew IPv6 support when api.ts's did (OC-0187) — an IPv6
// server could be logged into via the login form but never saved as a
// profile. Keeping one implementation here means every caller accepts (and
// rejects) the same set of addresses.

/**
 * True if `host` is an acceptable server address: a DNS name or IPv4
 * literal, optionally with a port, a bracketed IPv6 literal ("[::1]" or
 * "[::1]:8443"), or a bare (unbracketed) IPv6 literal ("2001:db8::1", "::1").
 *
 * Mirrors the Rust proxies' `validate_remote_host` / `parse_server_name`
 * (http_proxy.rs / livekit_proxy.rs) and livekitSession.ts's
 * ensureLiveKitProxy: same bracket convention, same "more than one colon
 * means the whole string is an IPv6 address" rule for telling a bare IPv6
 * literal apart from a single "host:port" separator.
 */
export function isValidHost(host: string): boolean {
  if (host.length > 253) return false;
  // Bracketed IPv6 literal ("[::1]" or "[::1]:8443").
  if (/^\[[0-9A-Fa-f:.]+\](:\d+)?$/.test(host)) return true;
  // Bare (unbracketed) IPv6 literal, e.g. "2001:db8::1" or "::1". More than
  // one colon means the whole string is the address — a single colon is
  // reserved for the host:port separator below.
  if ((host.match(/:/g) ?? []).length > 1 && /^[0-9A-Fa-f:.]+$/.test(host)) return true;
  // DNS name or IPv4 literal, optionally with a port.
  return /^[\w.-]+(:\d+)?$/.test(host);
}
