/**
 * Opens a URL in the user's default browser. Both call sites
 * (`lib/admin-panel.ts`'s `openAdminPanel`, the external-link listener in
 * `main.ts`) opened the native shell-open plugin inline; B7-5 lifted it in
 * place, pinned it with `opener.suite.ts`, then moved it to
 * `platform/desktop/urlOpener.ts`.
 */
export interface UrlOpener {
  open(url: string): Promise<void>;
}
