/**
 * Sign-out takes this phone off the server's push list, then lets the session
 * go: the DELETE carries the session's own token, so it must reach the server
 * before that token is revoked. The push app's registration goes too, so a
 * push already on its way shows nothing.
 */

import type { ApiClient } from "@lib/api";
import { isAndroidHost } from "@lib/hostPlatform";
import { desktop } from "../../platform/desktop";
import { forgetSubscriptionId, pushInstance, subscriptionId } from "./pushInstance";

export type PushSignOutApi = Pick<ApiClient, "revokePushSubscription" | "getSession">;

/** Settles when the server has answered (or given up) and never rejects;
 *  null when there was nothing to remove, so the caller need not wait. */
export function pushSignOut(
  api: PushSignOutApi,
  userId: number | null,
  token: string | null,
): Promise<void> | null {
  if (!isAndroidHost() || userId === null) return null;
  const instance = pushInstance(api.getSession().identity.host, userId);
  void desktop.pushRegistration.unregister(instance);
  const id = subscriptionId(instance);
  forgetSubscriptionId(instance);
  if (id === null || token === null) return null;
  return api.revokePushSubscription(id, token).catch(() => undefined);
}
