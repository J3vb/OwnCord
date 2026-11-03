// The Android notifier, loaded on first use: the registry is in the startup
// chunk of every build, and only the Android app needs the notifier itself.
import { createLogger } from "@lib/logger";
import type { Notifier } from "../contracts/notifications";

const log = createLogger("notifications");
const load = (): Promise<Notifier> =>
  import("./androidNotifications").then((m) => m.androidNotifier);

export const androidNotifier: Notifier = {
  readsOsPermission: true,
  permissionGranted: async () => (await load()).permissionGranted(),
  requestPermission: async () => (await load()).requestPermission(),
  show: async (title, body, options) => (await load()).show(title, body, options),
  showMessage: async (title, body, target) => (await load()).showMessage(title, body, target),
  showCall: async (title, body, target, ringing) =>
    (await load()).showCall(title, body, target, ringing),
  clearCall: async (channelId) => (await load()).clearCall(channelId),
  clearMessages: async (channelId) => (await load()).clearMessages(channelId),
  onMessageActivated(handler) {
    let active = true;
    let stop: (() => void) | null = null;
    load()
      .then((notifier) => {
        if (active) stop = notifier.onMessageActivated(handler);
      })
      .catch((err: unknown) => log.warn("Notification tap listener failed", err));
    return () => {
      active = false;
      stop?.();
    };
  },
  flashTaskbar: async () => undefined,
  requestAttention: async () => undefined,
  setUnreadBadge: async () => undefined,
};
