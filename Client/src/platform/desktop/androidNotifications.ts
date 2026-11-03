// The Android app's notifier. The desktop host's own command
// (`notify_message`) is not built for Android; `src-tauri/src/android_notifications.rs`
// shows notifications through tauri-plugin-notification's mobile side, on two
// channels Android lists under the app's settings, and a tap opens what the
// notification was for.
//
// The plugin reports that a notification was tapped but not which one, so
// `NotificationTapPlugin.kt` keeps the tapped notification's id and
// `take_notification_tap` hands it over; the target is looked up here.
//
// A phone has no taskbar to flash and draws its own launcher badge from the
// notifications, so those members do nothing.
import { createLogger } from "@lib/logger";
import { connectText } from "../../i18n/connect";
import { invokeOrThrow, tryInvoke } from "./nativeInvoke";
import type { Notifier, NotificationTarget } from "../contracts/notifications";

const log = createLogger("notifications");

/** Messages and mentions: a banner over the app and a sound (Android's "high"). */
const MESSAGES_CHANNEL = "messages";
/** A DM call ringing while the app is open but not in front. */
const INCOMING_CALLS_CHANNEL = "incoming-calls";

// The id of the call service's own "in a call" notification (CallService.kt);
// a message must never replace it.
const CALL_SERVICE_NOTIFICATION_ID = 4101;

interface Shown {
  readonly target: NotificationTarget | null;
  readonly kind: "message" | "call" | "ring";
}

// Notifications this process showed and Android may still display, by id.
// Lost when the process dies; a tap on an older one then just opens the app.
const shown = new Map<number, Shown>();

let nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

function takeId(): number {
  nextId = nextId >= 0x7fffffff ? 1_000_000 : nextId + 1;
  if (nextId === CALL_SERVICE_NOTIFICATION_ID) nextId += 1;
  return nextId;
}

let channelsReady: Promise<void> | null = null;

/** Create the two channels once per process; a failure is retried at the
 *  next notification. */
function ensureChannels(): Promise<void> {
  channelsReady ??= invokeOrThrow<void>("android_notification_channels", {
    names: {
      messages: connectText("notifications.androidChannel.messages"),
      messagesDescription: connectText("notifications.androidChannel.messagesDesc"),
      calls: connectText("notifications.androidChannel.calls"),
      callsDescription: connectText("notifications.androidChannel.callsDesc"),
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
  channelId: string,
  title: string,
  body: string,
  entry: Shown,
): Promise<void> {
  await ensureChannels();
  const id = takeId();
  shown.set(id, entry);
  try {
    await invokeOrThrow("android_notify", {
      id,
      channel: channelId,
      title,
      body,
      group: groupOf(entry.target) ?? null,
    });
  } catch (err) {
    shown.delete(id);
    throw err;
  }
}

/** Remove the notifications `matches` picks from the shade. */
async function withdraw(matches: (entry: Shown) => boolean): Promise<void> {
  const ids: number[] = [];
  for (const [id, entry] of shown) {
    if (matches(entry)) ids.push(id);
  }
  if (ids.length === 0) return;
  for (const id of ids) shown.delete(id);
  await invokeOrThrow("android_clear_notifications", { ids });
}

/** The target of the notification the user just tapped, if this process showed it. */
async function tappedTarget(): Promise<NotificationTarget | null> {
  const result = await tryInvoke<number | null>("take_notification_tap");
  if (!result.ok) {
    log.warn("Tapped notification not known", result.error.message);
    return null;
  }
  if (result.value === null) return null;
  const entry = shown.get(result.value);
  shown.delete(result.value);
  return entry?.target ?? null;
}

export const androidNotifier: Notifier = {
  // The plugin's mobile side asks Android, so a block in the system settings
  // shows as one.
  readsOsPermission: true,
  async permissionGranted(): Promise<boolean> {
    const state = await invokeOrThrow<string>("android_notification_permission", { ask: false });
    return state === "granted";
  },
  async requestPermission(): Promise<boolean> {
    const state = await invokeOrThrow<string>("android_notification_permission", { ask: true });
    return state === "granted";
  },
  async show(title: string, body: string): Promise<void> {
    await present(MESSAGES_CHANNEL, title, body, { target: null, kind: "message" });
  },
  async showMessage(title: string, body: string, target: NotificationTarget): Promise<void> {
    await present(MESSAGES_CHANNEL, title, body, { target, kind: "message" });
  },
  async showCall(title: string, body: string, target, ringing = false): Promise<void> {
    const callTarget: NotificationTarget = { host: target.host, channelId: target.channelId };
    if (ringing) {
      // One ring per channel: a newer ring replaces one still showing.
      await withdraw((e) => e.kind === "ring" && e.target?.channelId === target.channelId);
      await present(INCOMING_CALLS_CHANNEL, title, body, { target: callTarget, kind: "ring" });
    } else {
      await present(MESSAGES_CHANNEL, title, body, { target: callTarget, kind: "call" });
    }
  },
  async clearCall(channelId: number): Promise<void> {
    await withdraw((e) => e.kind === "ring" && e.target?.channelId === channelId);
  },
  async clearMessages(channelId?: number): Promise<void> {
    await withdraw(
      (e) => e.kind !== "ring" && (channelId === undefined || e.target?.channelId === channelId),
    );
  },
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
