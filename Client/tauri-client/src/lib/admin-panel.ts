/**
 * Opening the server's admin panel in the user's browser.
 *
 * The audit log stays admin-panel-only: it is a long, filterable, paginated
 * table over a REST endpoint the desktop client has no other use for, and
 * rebuilding it here would mean maintaining two of them. What the desktop
 * client owes its moderators is a way to *reach* it — hence this, rather than
 * a port of the view.
 *
 * The panel is opened in the real browser at `https://{host}/admin`, NOT
 * through the local TOFU proxy the REST client uses: that proxy exists so the
 * webview can talk to a self-signed server, and its loopback origin means
 * nothing to an external browser. A self-signed deployment therefore shows the
 * browser's certificate warning, which is the honest outcome — the operator is
 * the one who chose the certificate.
 */

import { bracketBareIPv6Host } from "./ws";

/** The admin-panel URL for `host`, deep-linked to `section` when given. */
export function adminPanelUrl(host: string, section?: string): string {
  // A bare (unbracketed) IPv6 host is a valid, accepted server address
  // (hostValidation.ts, livekitSession.ts's ensureLiveKitProxy) but RFC 3986
  // requires brackets around an IPv6 literal authority — without them this
  // isn't a valid absolute URL at all (OC-0190). Reuse the same bracketing
  // convention ws.ts's wss:// URL builder already uses.
  const authority = bracketBareIPv6Host(host);
  const base = `https://${authority}/admin`;
  return section === undefined || section === "" ? base : `${base}#${section}`;
}

/**
 * Open the admin panel in the user's default browser.
 *
 * The opener plugin is imported lazily so this module can be loaded (and the
 * URL builder tested) in an environment with no Tauri runtime.
 */
export async function openAdminPanel(host: string, section?: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(adminPanelUrl(host, section));
}
