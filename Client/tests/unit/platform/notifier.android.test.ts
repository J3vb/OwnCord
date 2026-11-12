// Android binding for the Notifier suite: `platform/desktop`'s Android
// notifier, over the host's `android_*` notification commands and the tap
// command of NotificationTapPlugin.kt. A call that rings is the call
// service's own notification (`show_call_ring`, `clear_call_ring`). A phone
// has no window to flash and draws its own launcher badge, so those suite
// tests are skipped and pinned as no-ops below.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { RING_TIMEOUT_MS } from "../../../src/lib/voice/callRing";
import type { Notifier, NotificationTarget } from "../../../src/platform/contracts/notifications";
import { describeNotifierSuite } from "./notifier.suite";

interface NotifyArgs {
  id: number;
  title: string;
  body: string;
  group: string | null;
}
/** The ringing call's notification, as `show_call_ring` takes it. */
interface RingArgs {
  channelId: number;
  title: string;
  text: string;
  acceptLabel: string;
  declineLabel: string;
  channelName: string;
  channelDescription: string;
  quiet: boolean;
  timeoutMs: number;
}
type ActionHandler = (event: { actionId: string }) => void;

const native = vi.hoisted(() => ({
  state: "prompt" as string,
  answer: "denied" as string,
  unavailable: false,
  failNotify: false,
  tapped: null as number | null,
  actionHandlers: new Set<(event: { actionId: string }) => void>(),
  unregistered: 0,
  requests: 0,
  failClear: false,
  notifyGate: Promise.resolve() as Promise<void>,
  refuseRing: false,
  ringGate: Promise.resolve() as Promise<void>,
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "android_notification_permission":
        if (native.unavailable) throw new Error("not running under the native host");
        if (native.state === "granted" || args?.["ask"] !== true) return native.state;
        native.requests += 1;
        return native.answer;
      case "android_notify":
        if (native.failNotify) throw new Error("notify refused");
        await native.notifyGate;
        return undefined;
      case "android_clear_notifications":
        if (native.failClear) throw new Error("clear refused");
        return undefined;
      case "show_call_ring":
        await native.ringGate;
        if (native.refuseRing) throw new Error("call ring: notifications are off");
        return undefined;
      case "take_notification_tap": {
        const id = native.tapped;
        native.tapped = null;
        return id;
      }
      default:
        return undefined;
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Each subject is a fresh module (its shown list and channels are per
// process); the real logger would add a pref listener at every import.
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  onAction: async (handler: ActionHandler) => {
    native.actionHandlers.add(handler);
    return {
      unregister: async () => {
        native.unregistered += 1;
        native.actionHandlers.delete(handler);
      },
    };
  },
}));

const calls = (command: string) =>
  invoke.mock.calls.filter((call) => call[0] === command).map((call) => call[1]);
const notified = (): NotifyArgs[] =>
  calls("android_notify").map((args) => args as unknown as NotifyArgs);
const removed = (): number[] =>
  calls("android_clear_notifications").flatMap((args) => (args as { ids: number[] }).ids);
const rung = (): RingArgs[] =>
  calls("show_call_ring").map((args) => (args as { ring: RingArgs }).ring);
const ringsTakenDown = (): number[] =>
  calls("clear_call_ring").map((args) => (args as { channelId: number }).channelId);
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The user taps the notification with `id`, as the plugin and the tap plugin report it. */
async function tap(id: number | null): Promise<void> {
  await flush();
  native.tapped = id;
  for (const handler of native.actionHandlers) handler({ actionId: "tap" });
  await flush();
}

async function freshNotifier(): Promise<Notifier> {
  vi.resetModules();
  invoke.mockClear();
  Object.assign(native, {
    state: "prompt",
    answer: "denied",
    unavailable: false,
    failNotify: false,
    tapped: null,
    unregistered: 0,
    requests: 0,
    failClear: false,
    notifyGate: Promise.resolve(),
    refuseRing: false,
    ringGate: Promise.resolve(),
  });
  native.actionHandlers.clear();
  const mod = await import("../../../src/platform/desktop/androidNotifications");
  return mod.androidNotifier;
}

describeNotifierSuite(
  async () => {
    const notifier = await freshNotifier();
    // Android is handed an id, not the target, which stays in the webview
    // until the tap: record what each notification was raised for, in order.
    const targets: NotificationTarget[] = [];
    const subject: Notifier = {
      ...notifier,
      async showMessage(title, body, target) {
        targets.push(target);
        await notifier.showMessage(title, body, target);
      },
      async showCall(title, body, target, ringing) {
        // A ring is the call service's notification, not one of these.
        if (ringing !== true) targets.push({ host: target.host, channelId: target.channelId });
        await notifier.showCall(title, body, target, ringing);
      },
    };
    const withTarget = () =>
      notified()
        .filter((n) => n.group !== null)
        .map((n, i) => ({ ...n, target: targets[i]! }));
    return {
      subject,
      native: {
        permissionIs(granted) {
          native.state = granted ? "granted" : "denied";
        },
        userAnswers(answer) {
          native.answer = answer;
        },
        unavailable() {
          native.unavailable = true;
        },
        shown: () =>
          notified()
            .filter((n) => n.group === null)
            .map(({ title, body }) => ({ title, body })),
        messageShown: () =>
          withTarget().map(({ title, body, target }) => ({ title, body, target })),
        async emitsActivation(target) {
          // A tap reaches the handler only for a notification this process showed.
          await subject.showMessage("t", "b", target);
          const last = notified().at(-1)!;
          await tap(last.id);
        },
        attentionRequests: () => 0,
        urgentAttentionRequests: () => 0,
        badgeCounts: () => [],
        ringsShown: () => rung().map((ring) => ring.channelId),
        callsCleared: ringsTakenDown,
      },
    };
  },
  { windowAttention: false, unreadBadge: false },
);

describe("Android notifier", () => {
  let notifier: Notifier;
  const dm: NotificationTarget = { host: "h", channelId: 7, messageId: 42 };
  const other: NotificationTarget = { host: "h", channelId: 9, messageId: 1 };
  /** A call in `dm`'s conversation: its target names no message. */
  const call = { host: "h", channelId: 7 };

  beforeEach(async () => {
    notifier = await freshNotifier();
  });

  test("reads the system's permission state", () => {
    expect(notifier.readsOsPermission).toBe(true);
  });

  test("reads the permission without asking, and asks only when told to", async () => {
    await expect(notifier.permissionGranted()).resolves.toBe(false);
    expect(native.requests).toBe(0);
    native.answer = "granted";
    await expect(notifier.requestPermission()).resolves.toBe(true);
    expect(native.requests).toBe(1);
  });

  test("creates its channel once, before the first notification", async () => {
    await notifier.showMessage("a", "b", dm);
    await notifier.showMessage("c", "d", other);
    expect(calls("android_notification_channels")).toEqual([
      {
        names: {
          messages: "Messages",
          messagesDescription: "Direct messages, mentions and channel messages",
        },
      },
    ]);
    const order = invoke.mock.calls.map((call) => call[0]);
    expect(order.indexOf("android_notification_channels")).toBeLessThan(
      order.indexOf("android_notify"),
    );
  });

  test("shows a message grouped by server", async () => {
    await notifier.showMessage("Bob", "hi", dm);
    expect(notified()).toEqual([
      { id: expect.any(Number), title: "Bob", body: "hi", group: "owncord:h" },
    ]);
  });

  test("retries the channels when creating them failed", async () => {
    invoke.mockRejectedValueOnce(new Error("no channels"));
    await expect(notifier.showMessage("a", "b", dm)).rejects.toThrow("no channels");
    expect(notified()).toEqual([]);
    await notifier.showMessage("a", "b", dm);
    expect(calls("android_notification_channels")).toHaveLength(2);
    expect(notified()).toHaveLength(1);
  });

  test("gives every notification its own id, never the call service's", async () => {
    await notifier.showMessage("a", "b", dm);
    await notifier.showMessage("a", "b", dm);
    const ids = notified().map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(4101);
  });

  test("withdraws a channel's messages and missed calls, and never a ring", async () => {
    await notifier.showMessage("a", "b", dm);
    await notifier.showMessage("c", "d", other);
    await notifier.showCall("Missed call from Bob", "Voice call", call);
    await notifier.showCall("Bob is calling", "Voice call", call, true);
    const [first, second, missed] = notified();
    await notifier.clearMessages(7);
    expect(removed()).toEqual([first!.id, missed!.id]);
    await notifier.clearMessages();
    expect(removed()).toEqual([first!.id, missed!.id, second!.id]);
    expect(ringsTakenDown()).toEqual([]);
  });

  test("makes no native call when it has no message to withdraw", async () => {
    await notifier.clearMessages(7);
    await notifier.clearMessages();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("says that its ringing call rings by itself", () => {
    expect(notifier.ringsCalls).toBe(true);
  });

  test("shows a ringing call through the call service, in the app's words", async () => {
    await notifier.showCall("Bob is calling", "Voice call", call, true);
    expect(rung()).toEqual([
      {
        channelId: 7,
        title: "Bob is calling",
        text: "Voice call",
        acceptLabel: "Accept",
        declineLabel: "Decline",
        channelName: "Incoming calls",
        channelDescription: "A direct message call ringing",
        quiet: false,
        timeoutMs: 35_000,
      },
    ]);
    // Not one of the message notifications: no id, no channel of theirs.
    expect(notified()).toEqual([]);
    expect(calls("android_notification_channels")).toEqual([]);
  });

  test("shows a ring without a sound on a channel of its own", async () => {
    await notifier.showCall("Bob is calling", "Voice call", call, true, true);
    expect(rung()).toEqual([
      expect.objectContaining({
        channelName: "Incoming calls, silent",
        channelDescription: "Used while the ring sound is off in the app's settings",
        quiet: true,
      }),
    ]);
  });

  test("keeps a ring up a little longer than a ring lasts", async () => {
    await notifier.showCall("Bob is calling", "Voice call", call, true);
    const { timeoutMs } = rung()[0]!;
    expect(timeoutMs).toBeGreaterThan(RING_TIMEOUT_MS);
    expect(timeoutMs - RING_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  test("shows the same ring again in place, so its time starts over", async () => {
    await notifier.showCall("Bob is calling", "Voice call", call, true);
    await notifier.showCall("Bob is calling", "Voice call", call, true);
    expect(rung().map((ring) => ring.channelId)).toEqual([7, 7]);
    expect(ringsTakenDown()).toEqual([]);
  });

  test("takes a ring down by its conversation, the host knowing which one is up", async () => {
    await notifier.clearCall(9);
    expect(ringsTakenDown()).toEqual([9]);
    expect(calls("android_clear_notifications")).toEqual([]);
  });

  test("rejects a ring Android will not show, and still takes it down after", async () => {
    native.refuseRing = true;
    await expect(notifier.showCall("Bob is calling", "Voice call", call, true)).rejects.toThrow(
      "call ring: notifications are off",
    );
    await notifier.clearCall(7);
    expect(ringsTakenDown()).toEqual([7]);
  });

  test("takes a ring down only once Android has answered for showing it", async () => {
    let answer = (): void => {};
    native.ringGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const up = notifier.showCall("Bob is calling", "Voice call", call, true);
    const down = notifier.clearCall(7);
    await flush();
    expect(ringsTakenDown()).toEqual([]);
    answer();
    await Promise.all([up, down]);
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order).toEqual(["show_call_ring", "clear_call_ring"]);
  });

  test("leaves a missed call as a notification whose tap opens the conversation", async () => {
    const handler = vi.fn();
    notifier.onMessageActivated(handler);
    await notifier.showCall("Missed call from Bob", "Voice call", call);
    expect(notified()).toEqual([
      {
        id: expect.any(Number),
        title: "Missed call from Bob",
        body: "Voice call",
        group: "owncord:h",
      },
    ]);
    await tap(notified()[0]!.id);
    expect(handler.mock.calls).toEqual([[call]]);
  });

  test("does not track a notification Android refused", async () => {
    native.failNotify = true;
    await expect(notifier.showMessage("a", "b", dm)).rejects.toThrow("notify refused");
    await notifier.clearMessages(7);
    expect(calls("android_clear_notifications")).toEqual([]);
  });

  test("keeps what a failed withdrawal left on screen, to withdraw it later", async () => {
    await notifier.showMessage("a", "b", dm);
    const id = notified()[0]!.id;
    native.failClear = true;
    await expect(notifier.clearMessages(7)).rejects.toThrow("clear refused");
    native.failClear = false;
    await notifier.clearMessages(7);
    expect(removed()).toEqual([id, id]);
  });

  test("withdraws a notification only once Android has shown it", async () => {
    let release = (): void => {};
    native.notifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const showing = notifier.showMessage("a", "b", dm);
    await flush();
    const clearing = notifier.clearMessages(7);
    await flush();
    expect(calls("android_clear_notifications")).toEqual([]);
    release();
    await Promise.all([showing, clearing]);
    expect(removed()).toEqual([notified()[0]!.id]);
  });

  test("ignores a tap on a notification it did not show", async () => {
    const handler = vi.fn();
    notifier.onMessageActivated(handler);
    await tap(123);
    await tap(null);
    expect(handler).not.toHaveBeenCalled();
  });

  test("opens a tapped notification once, and forgets it", async () => {
    const handler = vi.fn();
    notifier.onMessageActivated(handler);
    await notifier.showMessage("a", "b", dm);
    const id = notified()[0]!.id;
    await tap(id);
    await tap(id);
    expect(handler.mock.calls).toEqual([[dm]]);
    await notifier.clearMessages(7);
    expect(calls("android_clear_notifications")).toEqual([]);
  });

  test("drops the listener when unsubscribed before it registered", async () => {
    const stop = notifier.onMessageActivated(vi.fn());
    stop();
    await flush();
    expect(native.unregistered).toBe(1);
  });

  test("has no window to flash and no badge to draw", async () => {
    await notifier.flashTaskbar();
    await notifier.requestAttention();
    await notifier.setUnreadBadge(3);
    expect(invoke).not.toHaveBeenCalled();
  });
});
