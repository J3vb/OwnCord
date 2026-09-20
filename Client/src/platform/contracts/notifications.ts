/**
 * No-seam: every capability lives inside private helpers in
 * `lib/notifications.ts` (`fireDesktopNotification`, `flashTaskbar`) — there
 * is no exported function to bind a legacy suite against yet. The suite
 * lands with the seam in B7-5.
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
