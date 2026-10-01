// The native notifier: the notification plugin and the window's attention
// request. Lifted verbatim from `lib/notifications.ts` (B7-5), where the Web
// Notification fallback stays — it is the caller's, not the seam's.
//
// The plugins stay dynamic `import()`s: neither is part of the startup chunk
// today, and this registry is statically reachable from the entry. The event
// API is a static import — `platform/desktop/trayStatus.ts` already brings it
// into the startup closure, so the subscription below costs no new chunk.
import { listen } from "@tauri-apps/api/event";
import type { Notifier, NotifierShowOptions, NotificationTarget } from "../contracts/notifications";

export const notifier: Notifier = {
  // tauri-plugin-notification's desktop backend hard-codes both the
  // permission state and the request answer to "granted".
  readsOsPermission: false,
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
  // The plugin's desktop backend drops the click callback, so a message
  // notification goes through the host's own command (see
  // src-tauri/src/message_notification.rs). On macOS and Linux it waits for the
  // activation and emits `notification-click`; on Windows it shows a
  // protocol-activation toast whose click comes back as an `owncord://message`
  // deep link instead, so this event never fires there.
  async showMessage(title: string, body: string, target: NotificationTarget): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_message", {
      title,
      body,
      host: target.host,
      channelId: target.channelId,
      messageId: target.messageId,
    });
  },
  // A call is the same command with no message id: the host then opens the
  // DM (`owncord://channel/…` on Windows) instead of a message.
  async showCall(title: string, body: string, target): Promise<void> {
    await notifier.showMessage(title, body, { host: target.host, channelId: target.channelId });
  },
  onMessageActivated(handler: (target: NotificationTarget) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<NotificationTarget>("notification-click", (e) => {
      if (active) handler(e.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
  async flashTaskbar(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.requestUserAttention(2); // Informational attention
  },
  async requestAttention(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(1); // Critical: until focused
  },
};
