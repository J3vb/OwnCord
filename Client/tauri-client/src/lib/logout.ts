/**
 * User-initiated logout.
 *
 * Revokes the session server-side (`POST /auth/logout`) and tears down local
 * auth state. The revocation is strictly best-effort: it is fire-and-forget and
 * its failure is swallowed, so a slow, offline, or rejecting server can never
 * block or delay the local logout — `clearAuth()` always runs synchronously.
 */

import type { ApiClient } from "./api";
import { clearAuth } from "@stores/auth.store";

export function logout(api: Pick<ApiClient, "logout">): void {
  // Best-effort server-side token revocation; never awaited, never allowed to
  // throw. clearAuth() below is the authoritative local teardown.
  void api.logout().catch(() => {});
  clearAuth();
}
