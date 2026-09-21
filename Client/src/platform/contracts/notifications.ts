/**
 * Desktop notifications and the taskbar flash. Which notification fires, and
 * the Web Notification fallback when this seam rejects, are the caller's
 * (`lib/notifications.ts`). B7-5 lifted the native calls out of its private
 * helpers in place, pinned them with `notifier.suite.ts`, then moved them to
 * `platform/desktop/notifications.ts`.
 */
export interface NotifierShowOptions {
  readonly icon?: string;
}

export interface Notifier {
  permissionGranted(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  show(title: string, body: string, options?: NotifierShowOptions): Promise<void>;
  /** Draw attention to the app window (taskbar flash / dock bounce). */
  flashTaskbar(): Promise<void>;
}
