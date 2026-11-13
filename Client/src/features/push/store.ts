/**
 * Push to this phone while the app is closed, as Settings → Notifications
 * shows it for the connected server. Only `pushSubscription.ts` writes it, and
 * its session reset takes it back to "off" at sign-out and a server switch.
 *
 * - off: not the Android app, or nothing tried yet this session
 * - checking: asking the server and the push app
 * - on: this server pushes to this phone
 * - install: no push app (UnifiedPush distributor) is installed
 * - choose: several are installed and none is chosen yet
 * - server-off: this server's owner has push turned off
 * - muted: message notifications are off in Settings, so the push app's
 *   registration is dropped until they are back on
 * - failed: the push app or the server did not answer; tried again when the
 *   app comes back into view
 */

import { createStore } from "@lib/store";
import type { PushDistributor } from "../../platform/contracts/pushRegistration";

export type PushSetting =
  "off" | "checking" | "on" | "install" | "choose" | "server-off" | "muted" | "failed";

export interface PushState {
  readonly setting: PushSetting;
  /** The push apps to choose from, while `setting` is "choose". */
  readonly distributors: readonly PushDistributor[];
}

export const INITIAL_PUSH_STATE: PushState = { setting: "off", distributors: [] };

export const pushStore = createStore<PushState>(INITIAL_PUSH_STATE);

export function setPushSetting(
  setting: PushSetting,
  distributors: readonly PushDistributor[] = [],
): void {
  pushStore.setState(() => ({ setting, distributors }));
}
