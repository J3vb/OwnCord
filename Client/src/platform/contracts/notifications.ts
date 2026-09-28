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

/**
 * Where a clicked notification should take the reader: the message it was
 * raised for. The native host reports the same pair back when the user
 * activates the notification, and the app opens it.
 */
export interface NotificationTarget {
  readonly channelId: number;
  readonly messageId: number;
}

export interface Notifier {
  /**
   * Whether `permissionGranted()` observes the OS setting. The Tauri desktop
   * plugin answers "granted" without asking the OS, so its reading proves
   * nothing and a settings surface must not present it as the system's state.
   */
  readonly readsOsPermission: boolean;
  permissionGranted(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  show(title: string, body: string, options?: NotifierShowOptions): Promise<void>;
  /**
   * Show a notification that opens `target` when the user activates it. The
   * desktop notifier cannot deliver activation through the Tauri plugin (its
   * desktop backend drops clicks), so this routes through the native host's
   * own command; `onMessageActivated` receives the click.
   */
  showMessage(title: string, body: string, target: NotificationTarget): Promise<void>;
  /**
   * Subscribe to activations of message notifications. `handler` gets the
   * target the user clicked; the return value unsubscribes. Delivered once per
   * click, and never for a dismissal.
   */
  onMessageActivated(handler: (target: NotificationTarget) => void): () => void;
  /** Draw attention to the app window (taskbar flash / dock bounce). */
  flashTaskbar(): Promise<void>;
}
