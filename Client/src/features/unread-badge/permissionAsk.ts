/**
 * Ask Android for the notification permission once, after the first sign-in,
 * so the first DM does not arrive to a blocked shade. Never again: "Don't
 * allow" is the user's answer, and Settings > Notifications shows the state
 * with its own Allow button. Elsewhere a no-op: the desktop needs no ask, and
 * a browser page may only ask from a click.
 */

import { isAndroidHost } from "../../lib/hostPlatform";
import { createLogger } from "../../lib/logger";
import { loadPref, savePref } from "../../lib/prefs/preferences";
import type { Notifier } from "../../platform/contracts/notifications";

const log = createLogger("notifications");

/** Set once the Android app has asked. */
const ASKED_KEY = "notificationPermissionAsked";

export async function askNotificationPermissionOnce(
  notifier: Pick<Notifier, "permissionGranted" | "requestPermission">,
): Promise<void> {
  if (!isAndroidHost() || loadPref<boolean>(ASKED_KEY, false)) return;
  try {
    if (await notifier.permissionGranted()) return;
    savePref(ASKED_KEY, true);
    await notifier.requestPermission();
  } catch (err) {
    log.warn("Notification permission not asked", err);
  }
}
