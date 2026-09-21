// The native notifier: the notification plugin and the window's attention
// request. Lifted verbatim from `lib/notifications.ts` (B7-5), where the Web
// Notification fallback stays — it is the caller's, not the seam's.
//
// Both plugins stay dynamic `import()`s: neither is part of the startup chunk
// today, and this registry is statically reachable from the entry.
import type { Notifier, NotifierShowOptions } from "../contracts/notifications";

export const notifier: Notifier = {
  async permissionGranted(): Promise<boolean> {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return isPermissionGranted();
  },
  async requestPermission(): Promise<boolean> {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    const result = await requestPermission();
    return result === "granted";
  },
  async show(title: string, body: string, options?: NotifierShowOptions): Promise<void> {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification(
      options?.icon === undefined ? { title, body } : { title, body, icon: options.icon },
    );
  },
  async flashTaskbar(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.requestUserAttention(2); // Informational attention
  },
};
