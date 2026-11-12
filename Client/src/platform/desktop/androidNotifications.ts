// The Android app's notifier. The desktop host's own command
// (`notify_message`) is not built for Android; `src-tauri/src/android_notifications.rs`
// shows notifications through tauri-plugin-notification's mobile side, on a
// channel Android lists under the app's settings, and a tap opens what the
// notification was for.
//
// The plugin reports that a notification was tapped but not which one, so
// `NotificationTapPlugin.kt` keeps the tapped notification's id and
// `take_notification_tap` hands it over; the target is looked up here.
//
// A call that rings is not one of these: it is the call service's own
// notification (`./callServiceHost.ts`, `CallRing.kt`), with Accept and
// Decline, which rings with the phone's ringtone. Its buttons and its tap
// come back through `callService.onAction`.
//
// A phone has no taskbar to flash and draws its own launcher badge from the
// notifications, so those members do nothing.
import { createLogger } from "@lib/logger";
import { connectText } from "../../i18n/connect";
import { clearRing, showRing, type CallRing } from "./callServiceHost";
import { invokeOrThrow, tryInvoke } from "./nativeInvoke";
import type { Notifier, NotificationTarget } from "../contracts/notifications";

const log = createLogger("notifications");

// The id of the call service's own "in a call" notification (CallService.kt);
// a message must never replace it.
const CALL_SERVICE_NOTIFICATION_ID = 4101;

/** How long Android keeps a ringing call's notification up when nothing takes
 *  it down: a little longer than a ring lasts (`RING_TIMEOUT_MS`), so it never
 *  outlasts a page that is gone. Showing it again starts the time over. */
const RING_NOTIFICATION_MS = 35_000;

/** Android lets an app alert once a second and mutes what comes sooner. A
 *  ring it mutes as it goes up makes no sound for as long as it rings, and one
 *  it mutes when it is shown again stops ringing. So a ring that makes a sound
 *  goes out only when the app's last alert is this old, and a notification
 *  asked for meanwhile goes out after the ring. */
const ALERT_GAP_MS = 1_200;

/** Runs while the app's last alert is younger than `ALERT_GAP_MS`. */
let alertGap: ReturnType<typeof setTimeout> | null = null;

/** Android has not answered yet for a ring that makes a sound: its alert is
 *  still to come, so the next ring waits for the answer first. */
let ringOut = false;

/** The ring that waits for its turn, if one does. */
let waitingRing: {
  readonly channelId: number;
  readonly send: () => void;
  readonly drop: () => void;
} | null = null;

/** Settles when Android has answered for the ring last sent its way, or that
 *  ring was dropped while it waited. */
let ringAnswered: Promise<unknown> = Promise.resolve();

/** Android was just asked for an alert, or just answered for one. */
function alerted(): void {
  if (alertGap !== null) clearTimeout(alertGap);
  alertGap = setTimeout(() => {
    alertGap = null;
    if (!ringOut) waitingRing?.send();
  }, ALERT_GAP_MS);
}

/** Show a ring that makes a sound, as soon as Android will let it sound. */
function ringAloud(ring: CallRing): Promise<void> {
  const shownNow = new Promise<void>((resolve, reject) => {
    const send = (): void => {
      waitingRing = null;
      ringOut = true;
      showRing(ring)
        .finally(() => {
          ringOut = false;
          alerted();
        })
        .then(resolve, reject);
    };
    const drop = (): void => {
      waitingRing = null;
      resolve();
    };
    if (alertGap === null && !ringOut) send();
    else waitingRing = { channelId: ring.channelId, send, drop };
  });
  ringAnswered = shownNow.catch(() => undefined);
  return shownNow;
}

/** A ring on its way goes first: a notification's alert just before it would
 *  mute it. Waits for a ring that was asked for meanwhile too. */
async function afterRing(): Promise<void> {
  const seen = ringAnswered;
  await seen;
  if (seen !== ringAnswered) await afterRing();
}

// Notifications asked for and not yet confirmed by the host, by id: a
// withdrawal waits for them, so its removal never reaches Android before the
// notification it removes.
const showing = new Map<number, Promise<unknown>>();

// What a tap opens for each notification this process showed and Android may
// still display, by id (null: just the app). Lost when the process dies; a
// tap on an older one then just opens the app.
const shown = new Map<number, NotificationTarget | null>();

let nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

function takeId(): number {
  nextId = nextId >= 0x7fffffff ? 1_000_000 : nextId + 1;
  if (nextId === CALL_SERVICE_NOTIFICATION_ID) nextId += 1;
  return nextId;
}

let channelsReady: Promise<void> | null = null;

/** Create the channel once per process; a failure is retried at the next
 *  notification. */
function ensureChannels(): Promise<void> {
  channelsReady ??= invokeOrThrow<void>("android_notification_channels", {
    names: {
      messages: connectText("notifications.androidChannel.messages"),
      messagesDescription: connectText("notifications.androidChannel.messagesDesc"),
    },
  }).catch((err: unknown) => {
    channelsReady = null;
    throw err;
  });
  return channelsReady;
}

/** The group Android stacks a server's notifications under. */
function groupOf(target: NotificationTarget | null): string | undefined {
  return target === null ? undefined : `owncord:${target.host}`;
}

async function present(
  title: string,
  body: string,
  target: NotificationTarget | null,
): Promise<void> {
  // On the list before it waits: a withdrawal meanwhile takes it off, and it
  // is then never shown.
  const id = takeId();
  shown.set(id, target);
  try {
    await ensureChannels();
    await afterRing();
    if (!shown.has(id)) return;
    await deliver(id, title, body, target);
  } catch (err) {
    shown.delete(id);
    throw err;
  }
}

async function deliver(
  id: number,
  title: string,
  body: string,
  target: NotificationTarget | null,
): Promise<void> {
  alerted();
  const shownNow = invokeOrThrow("android_notify", {
    id,
    title,
    body,
    group: groupOf(target) ?? null,
  });
  showing.set(id, shownNow);
  try {
    await shownNow;
  } finally {
    showing.delete(id);
    alerted();
  }
}

/** Remove the notifications shown for `channelId` from the shade, or every
 *  one when no id is given. */
async function withdraw(channelId?: number): Promise<void> {
  const removed = [...shown].filter(
    ([, target]) => channelId === undefined || target?.channelId === channelId,
  );
  if (removed.length === 0) return;
  const ids = removed.map(([id]) => id);
  for (const id of ids) shown.delete(id);
  const pending = ids.flatMap((id) => {
    const notify = showing.get(id);
    return notify === undefined ? [] : [notify];
  });
  await Promise.allSettled(pending);
  try {
    await invokeOrThrow("android_clear_notifications", { ids });
  } catch (err) {
    // Still on screen: keep them, so a later read or tap still finds them.
    for (const [id, target] of removed) shown.set(id, target);
    throw err;
  }
}

/** The target of the notification the user just tapped, if this process showed it. */
async function tappedTarget(): Promise<NotificationTarget | null> {
  const result = await tryInvoke<number | null>("take_notification_tap");
  if (!result.ok) {
    log.warn("Tapped notification not known", result.error.message);
    return null;
  }
  if (result.value === null) return null;
  const target = shown.get(result.value) ?? null;
  shown.delete(result.value);
  return target;
}

export const androidNotifier: Notifier = {
  // The plugin's mobile side asks Android, so a block in the system settings
  // shows as one.
  readsOsPermission: true,
  ringsCalls: true,
  async permissionGranted(): Promise<boolean> {
    const state = await invokeOrThrow<string>("android_notification_permission", { ask: false });
    return state === "granted";
  },
  async requestPermission(): Promise<boolean> {
    const state = await invokeOrThrow<string>("android_notification_permission", { ask: true });
    return state === "granted";
  },
  async show(title: string, body: string): Promise<void> {
    await present(title, body, null);
  },
  async showMessage(title: string, body: string, target: NotificationTarget): Promise<void> {
    await present(title, body, target);
  },
  async showCall(title: string, body: string, target, ringing = false, quiet = false) {
    if (ringing) {
      // One ring at a time, and the same one again starts its time over. One
      // that still waits is this ring's earlier self, or a call it took the
      // place of: the newest is the one to show.
      waitingRing?.drop();
      const ring = {
        channelId: target.channelId,
        title,
        text: body,
        quiet,
        timeoutMs: RING_NOTIFICATION_MS,
      };
      await (quiet ? showRing(ring) : ringAloud(ring));
      return;
    }
    // A call that was missed: a tap opens its conversation, at no message.
    await present(title, body, { host: target.host, channelId: target.channelId });
  },
  clearCall(channelId: number): Promise<void> {
    // A ring that ended while it waited is never shown.
    if (waitingRing?.channelId === channelId) waitingRing.drop();
    return clearRing(channelId);
  },
  clearMessages: (channelId?: number): Promise<void> => withdraw(channelId),
  onMessageActivated(handler: (target: NotificationTarget) => void): () => void {
    let active = true;
    let stop: (() => void) | null = null;
    void import("@tauri-apps/plugin-notification")
      .then(({ onAction }) =>
        onAction((event) => {
          if (!active || event.actionId !== "tap") return;
          void tappedTarget().then((target) => {
            if (active && target !== null) handler(target);
          });
        }),
      )
      .then((listener) => {
        const unregister = (): void => {
          listener.unregister().catch((err: unknown) => log.debug("Tap listener not removed", err));
        };
        if (active) stop = unregister;
        else unregister();
      })
      .catch((err: unknown) => log.warn("Notification tap listener failed", err));
    return () => {
      active = false;
      stop?.();
    };
  },
  async flashTaskbar(): Promise<void> {},
  async requestAttention(): Promise<void> {},
  async setUnreadBadge(): Promise<void> {},
};
