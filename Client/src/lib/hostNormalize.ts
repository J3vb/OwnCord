/**
 * Pure host-string normalisation shared by the transport (lib/ws.ts) and the
 * chat invite chip, which must not import the WebSocket client.
 */

/** Normalise a connect host to the key the TOFU proxies emit; see lib/ws.ts. */
export function normalizeHostForCertCompare(host: string): string {
  let stripped = host;
  if (host.endsWith(":443")) {
    const rest = host.slice(0, -":443".length);
    if (!rest.includes(":") || rest.endsWith("]")) stripped = rest;
  }
  return stripped.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}
