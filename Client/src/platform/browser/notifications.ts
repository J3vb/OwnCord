// The browser notifier: the Web Notification API and, for the unread
// count, the Badging API with the tab title as the fallback. There is no
// window to flash from a page, so `flashTaskbar` and `requestAttention` do
// nothing. Used only in a secure context (index.ts): the API needs one.
import type { Notifier, NotifierShowOptions, NotificationTarget } from "../contracts/notifications";
import { UnavailableError } from "./unavailable";

/** The largest count the tab title spells out. */
const TITLE_COUNT_CAP = 99;

const activationHandlers = new Set<(target: NotificationTarget) => void>();
/** The notification of each ringing call, by channel, so `clearCall` can close it. */
const ringing = new Map<number, Notification>();

/** The page's `Notification`, or a rejection when it has none. */
function api(): typeof Notification {
  if (typeof Notification === "undefined") throw new UnavailableError();
  return Notification;
}

function granted(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/** Show one notification, or null where the page may not construct one
 *  (Android Chrome allows them only from a service worker). */
function present(title: string, options: NotificationOptions): Notification | null {
  try {
    return new Notification(title, options);
  } catch {
    return null;
  }
}

/** Raise one notification; a click brings the tab forward and reports `target`. */
function raise(
  title: string,
  options: NotificationOptions,
  target: NotificationTarget,
): Notification | null {
  const shown = present(title, { ...options, data: target });
  if (shown === null) return null;
  const forget = (): void => {
    if (ringing.get(target.channelId) === shown) ringing.delete(target.channelId);
  };
  shown.addEventListener("close", forget);
  shown.addEventListener("click", () => {
    forget();
    shown.close();
    try {
      window.focus();
    } catch {
      // A page that may not take focus still reports the click.
    }
    for (const handler of activationHandlers) {
      try {
        handler(target);
      } catch {
        // One failing handler must not keep the others from the click.
      }
    }
  });
  return shown;
}

// ---- Unread count --------------------------------------------------------

/** The title as the page set it, and the title this module last wrote over it. */
let baseTitle = "";
let writtenTitle: string | null = null;

function renderTitle(count: number): void {
  if (count === 0) {
    // A title the page changed since is the page's now; leave it.
    if (writtenTitle !== null && document.title === writtenTitle) document.title = baseTitle;
    writtenTitle = null;
    return;
  }
  if (writtenTitle === null || document.title !== writtenTitle) baseTitle = document.title;
  writtenTitle = `(${count > TITLE_COUNT_CAP ? `${TITLE_COUNT_CAP}+` : count}) ${baseTitle}`;
  document.title = writtenTitle;
}

/** True when the Badging API took the count. */
async function badge(count: number): Promise<boolean> {
  const nav: Partial<Pick<Navigator, "setAppBadge" | "clearAppBadge">> = navigator;
  try {
    if (count === 0 && nav.clearAppBadge !== undefined) await nav.clearAppBadge();
    else if (nav.setAppBadge !== undefined) await nav.setAppBadge(count);
    else return false;
    return true;
  } catch {
    return false;
  }
}

export const notifier: Notifier = {
  // `Notification.permission` is the browser's own record of the user's choice.
  readsOsPermission: true,
  async permissionGranted(): Promise<boolean> {
    return api().permission === "granted";
  },
  async requestPermission(): Promise<boolean> {
    return (await api().requestPermission()) === "granted";
  },
  // Every show below is a no-op without permission: the caller asks first, and
  // a page may not prompt from here.
  async show(title: string, body: string, options?: NotifierShowOptions): Promise<void> {
    if (!granted()) return;
    present(title, options?.icon === undefined ? { body } : { body, icon: options.icon });
  },
  async showMessage(title: string, body: string, target: NotificationTarget): Promise<void> {
    if (granted()) raise(title, { body }, target);
  },
  async showCall(title, body, target, isRinging = false): Promise<void> {
    if (!granted()) return;
    if (!isRinging) {
      raise(title, { body }, target);
      return;
    }
    // One ring per channel: the tag replaces a ring still showing, and the
    // notification stays up until the user answers it or `clearCall`.
    ringing.get(target.channelId)?.close();
    ringing.delete(target.channelId);
    const ring = raise(
      title,
      { body, tag: `owncord-call-${target.channelId}`, requireInteraction: true },
      target,
    );
    if (ring !== null) ringing.set(target.channelId, ring);
  },
  async clearCall(channelId: number): Promise<void> {
    ringing.get(channelId)?.close();
    ringing.delete(channelId);
  },
  onMessageActivated(handler: (target: NotificationTarget) => void): () => void {
    activationHandlers.add(handler);
    return () => {
      activationHandlers.delete(handler);
    };
  },
  async flashTaskbar(): Promise<void> {},
  async requestAttention(): Promise<void> {},
  async setUnreadBadge(count: number): Promise<void> {
    const shown = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (await badge(shown)) renderTitle(0);
    else renderTitle(shown);
  },
};
