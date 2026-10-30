/**
 * Host-string normalisation shared by the transport (lib/ws.ts), the chat
 * invite chip, which must not import the WebSocket client, and the address
 * boxes on the connect page.
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

/**
 * The form of a typed server address the client saves and compares: trimmed,
 * and lowercased because host names are case-insensitive. A saved host that
 * differs only in case keeps its own spelling, since its stored sign-in is
 * keyed by that exact string.
 */
export function canonicalServerHost(typed: string, savedHosts: Iterable<string> = []): string {
  const lower = typed.trim().toLowerCase();
  if (lower === "") return lower;
  for (const saved of savedHosts) {
    if (saved.toLowerCase() === lower) return saved;
  }
  return lower;
}

/** Stop phone keyboards capitalising, correcting or spell-checking a server address box. */
export function setAddressInputHints(input: HTMLInputElement): void {
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("inputmode", "url");
}
