/**
 * User-initiated logout.
 *
 * Revokes the session server-side (`POST /auth/logout`) and tears down local
 * auth state. The revocation is strictly best-effort: it is fire-and-forget and
 * its failure is swallowed, so a slow, offline, or rejecting server can never
 * block or delay the local logout — `clearAuth()` always runs synchronously.
 *
 * In the Android app the phone first comes off the server's push list, with
 * the session's own token, so the revocation waits for that DELETE (a few
 * seconds at most). Both carry the token taken here, before the teardown
 * drops it.
 */

import type { ApiClient } from "../../lib/api";
import { authStore, clearAuth } from "@stores/auth.store";
import { pushSignOut, type PushSignOutApi } from "../push/signOut";

export function logout(api: Pick<ApiClient, "logout"> & PushSignOutApi): void {
  const { token, user } = authStore.getState();
  const revoke = (): void => void api.logout(undefined, token ?? undefined).catch(() => {});
  const pushGone = pushSignOut(api, user?.id ?? null, token);
  if (pushGone === null) revoke();
  else void pushGone.then(revoke);
  clearAuth();
}
