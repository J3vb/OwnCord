/**
 * Which push registration belongs to which account, and the server's id for
 * it. Small and free of the push flow, so sign-out can use it at once: the
 * subscription goes before the session's token is revoked.
 */

import { readStored, removeStored, writeStored } from "@lib/prefs/preferences";

const SUBSCRIPTION_KEY = "owncord:push:subscription:";

/** One registration per account on a server: two accounts on one server never
 *  share an endpoint, so one never sees the other's pushes. */
export function pushInstance(host: string, userId: number): string {
  return `${host}#${userId}`;
}

export function saveSubscriptionId(instance: string, id: number): void {
  writeStored(SUBSCRIPTION_KEY + instance, String(id));
}

export function subscriptionId(instance: string): number | null {
  const raw = readStored(SUBSCRIPTION_KEY + instance);
  const id = raw === null ? Number.NaN : Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function forgetSubscriptionId(instance: string): void {
  removeStored(SUBSCRIPTION_KEY + instance);
}

/** The label the server keeps for this device: `android:` and the phone's
 *  model when the WebView still reports it (a reduced user agent says "K"). */
export function deviceLabel(userAgent: string): string {
  const model = /Android [^;)]*; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent)?.[1]?.trim();
  const name = model === undefined || model === "K" || model === "" ? "phone" : model;
  // The server refuses control characters and anything over 64 characters.
  return `android:${name}`.replace(/\p{Cc}/gu, "").slice(0, 64);
}
