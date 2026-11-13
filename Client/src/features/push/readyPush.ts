/**
 * The push step of `ready`: in the Android app, register this phone for push
 * with the server once the session is up. The work loads on first use, so no
 * other host carries it.
 */

import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import type { DispatchApi } from "../connection/dispatchContext";
import type { PushApi } from "./pushSubscription";

const log = createLogger("push");

export function applyReadyPush(api: DispatchApi | undefined): void {
  if (!isAndroidHost()) return;
  const { getPushVapid, subscribePush, getSession } = api ?? {};
  if (getPushVapid === undefined || subscribePush === undefined || getSession === undefined) return;
  const pushApi: PushApi = { getPushVapid, subscribePush, getSession };
  void import("./pushSubscription")
    .then((m) => m.onReady(pushApi))
    .catch((err: unknown) => log.warn("Push setup failed to load", err));
}
