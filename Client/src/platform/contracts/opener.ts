/**
 * No-seam: both call sites (`lib/admin-panel.ts`'s `openAdminPanel`, the
 * click listener in `main.ts`) open the native shell-open plugin inline —
 * neither is itself the seam function. The suite lands with the seam in
 * B7-5 (proposed).
 */
export interface UrlOpener {
  open(url: string): Promise<void>;
}
