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

/** The admin-panel URL for `host`, deep-linked to `section` when given. */
export function adminPanelUrl(host: string, section?: string): string {
  const base = `https://${host}/admin`;
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
