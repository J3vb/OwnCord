// An incoming call on the Android app, through every layer between the ring
// and the phone: the real ring controller, the alerts (`callAlerts.ts`), the
// chime's latch (`notificationSound.ts`), the Android notifier and its host
// side (`androidNotifications.ts`, `callServiceHost.ts`) and the handler of
// the notification's buttons, put together the way the main page does it
// (`pageMountCalls.ts`). The phone is a stand-in that follows
// `CallServicePlugin.kt` and `CallButtons.kt`, and Android's own rule for an
// app's alerts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { followCallActions } from "../../../src/features/direct-messages/callNotificationActions";
import { startRingChime, stopRingChime } from "../../../src/lib/media/notificationSound";
import { setChannelMutesHost } from "../../../src/lib/prefs/channelMutes";
import { createRingController, type RingController } from "../../../src/lib/voice/callRing";
import { desktop } from "../../../src/platform/desktop";
// What the app loads on first use: in before a test's clock is a fake one.
import "../../../src/features/direct-messages/callAlerts";
import "../../../src/platform/desktop/androidNotifications";
import "../../../src/platform/desktop/callServiceHost";

const phone = vi.hoisted(() => ({
  notificationsOn: true,
  /** The ring notification on screen: whose call, its buttons' token, and
   *  whether the phone rings for it. */
  up: null as { channelId: number; token: string; sounds: boolean } | null,
  tokens: 0,
  alertedAt: Number.NEGATIVE_INFINITY,
  /** What the app asked of the host, in the order it was done. */
  asked: [] as string[],
  /** How long the host takes over a command, by its name; none by default. */
  slow: {} as Record<string, number>,
  listeners: new Set<(raw: unknown) => void>(),
}));

/** Android lets an app alert once a second: what comes sooner makes no sound. */
function alerts(): boolean {
  const now = Date.now();
  if (now - phone.alertedAt < 1_000) return false;
  phone.alertedAt = now;
  return true;
}

function takeDown(channelId: number): void {
  if (phone.up?.channelId === channelId) phone.up = null;
}

async function host(command: string, args: Record<string, unknown>): Promise<unknown> {
  const takes = phone.slow[command] ?? 0;
  if (takes > 0) await new Promise((done) => setTimeout(done, takes));
  if (command === "android_notify") {
    phone.asked.push("notify");
    alerts();
  } else if (command === "clear_call_ring") {
    const channelId = Number(args["channelId"]);
    phone.asked.push(`clear ${channelId}`);
    takeDown(channelId);
  } else if (command === "show_call_ring") {
    const ring = args["ring"] as { channelId: number; quiet: boolean };
    phone.asked.push(`ring ${ring.channelId}`);
    if (!phone.notificationsOn) {
      takeDown(ring.channelId);
      throw new Error("call ring: notifications are off");
    }
    // A ring that is up keeps its token when it is shown again. One Android
    // mutes makes no sound, and stops ringing if it rang.
    const token =
      phone.up?.channelId === ring.channelId ? phone.up.token : `token-${++phone.tokens}`;
    phone.up = { channelId: ring.channelId, token, sounds: !ring.quiet && alerts() };
  }
  return undefined;
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => host(command, args ?? {}),
  addPluginListener: async (_plugin: string, _event: string, heard: (raw: unknown) => void) => {
    phone.listeners.add(heard);
    return { unregister: async () => void phone.listeners.delete(heard) };
  },
}));
vi.mock("@lib/hostPlatform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/hostPlatform")>()),
  isAndroidHost: () => true,
}));
vi.mock("../../../src/lib/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../../src/platform/desktop", async () => {
  const { androidNotifier } = await import("../../../src/platform/desktop/androidNotifierLazy");
  const { callService } = await import("../../../src/platform/desktop/callService");
  return { desktop: { notifier: androidNotifier, callService } };
});

/** Every note the app's own chime played. */
const chimeNotes: number[] = [];
vi.stubGlobal(
  "AudioContext",
  class {
    readonly currentTime = 0;
    readonly destination = {};
    createOscillator = () => ({
      connect() {},
      start() {},
      stop() {},
      frequency: { setValueAtTime: (hz: number) => void chimeNotes.push(hz) },
    });
    createGain = () => ({
      connect() {},
      gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    });
    close = () => Promise.resolve();
  },
);

const HOST = "a.example";
const otto = { channelId: 50, fromUserId: 10, fromUsername: "Otto" };
const mira = { channelId: 51, fromUserId: 11, fromUsername: "Mira" };
const callAlerts = () => import("../../../src/features/direct-messages/callAlerts");
const pass = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

/** The main page's ring controller and button handler, as it mounts them. */
function mountPage(): { ring: RingController; joined: number[]; close(): void } {
  const joined: number[] = [];
  const st: { ringCtrl: RingController | null } = { ringCtrl: null };
  const ring = createRingController({
    onRingStateChange: () => {},
    onChime: (playing) => (playing ? startRingChime() : stopRingChime()),
    onAccept: (channelId) => void joined.push(channelId),
    onDecline: () => {},
    onRingStart: (state) => void callAlerts().then((m) => m.alertIncomingCall(state)),
    onRedial: (state) => void callAlerts().then((m) => m.alertRedial(state)),
    onMissed: (state) => void callAlerts().then((m) => m.alertMissedCall(state)),
    onRingEnd: (state, reason) =>
      void callAlerts().then((m) => {
        m.clearIncomingCall(state);
        if (reason === "superseded") m.alertSupersededCall(state);
      }),
  });
  st.ringCtrl = ring;
  const stop = followCallActions(
    st,
    { acceptRing: () => ring.accept() },
    { onMuteToggle: () => {}, onDisconnect: () => {} },
  );
  return {
    ring,
    joined,
    close() {
      stop();
      ring.destroy();
    },
  };
}

/** A press on the ring notification that is on screen. */
function press(kind: "accept" | "decline"): void {
  const up = phone.up;
  if (up === null) return;
  // Declined: the plugin takes the ring down at once.
  if (kind === "decline") takeDown(up.channelId);
  for (const heard of phone.listeners) heard({ kind, channelId: up.channelId });
}

describe("an incoming call on the Android app", () => {
  let page: ReturnType<typeof mountPage>;

  beforeEach(async () => {
    vi.useFakeTimers();
    Object.assign(phone, {
      notificationsOn: true,
      up: null,
      tokens: 0,
      alertedAt: Number.NEGATIVE_INFINITY,
      asked: [],
      slow: {},
    });
    chimeNotes.length = 0;
    setChannelMutesHost(HOST);
    // Another app is on screen.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    page = mountPage();
    await pass(0);
  });

  afterEach(async () => {
    page.close();
    // Every command answered, every ring down, every wait over.
    await pass(40_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
    setChannelMutesHost(null);
  });

  test("rings on the phone and nowhere else, and leaves a missed call behind", async () => {
    page.ring.incoming(otto);
    await pass(4_000);
    expect(phone.up).toEqual({ channelId: 50, token: "token-1", sounds: true });
    expect(chimeNotes).toEqual([]);

    page.ring.cancel(50, "ringer-left");
    await pass(4_000);
    expect(phone.up).toBeNull();
    expect(phone.asked).toEqual(["ring 50", "clear 50", "notify"]);
    expect(chimeNotes).toEqual([]);
  });

  test("goes on ringing when the call is rung again, with the same buttons", async () => {
    page.ring.incoming(otto);
    await pass(5_000);
    page.ring.incoming(otto);
    await pass(4_000);
    expect(phone.asked).toEqual(["ring 50", "ring 50"]);
    expect(phone.up).toEqual({ channelId: 50, token: "token-1", sounds: true });
    expect(chimeNotes).toEqual([]);
  });

  /** Otto sends a message, and rings 0.3 s later. */
  async function messageThenRing(): Promise<void> {
    await desktop.notifier.showMessage("Otto", "you there?", {
      host: HOST,
      channelId: 50,
      messageId: 1,
    });
    await pass(300);
    page.ring.incoming(otto);
  }

  test("rings for a call that comes right after a message", async () => {
    await messageThenRing();
    await pass(4_000);
    expect(phone.asked).toEqual(["notify", "ring 50"]);
    expect(phone.up?.sounds).toBe(true);
    expect(chimeNotes).toEqual([]);
  });

  test("goes on ringing when a message comes just before the call is rung again", async () => {
    page.ring.incoming(otto);
    await pass(3_000);
    await desktop.notifier.showMessage("Mira", "hi", { host: HOST, channelId: 51, messageId: 2 });
    await pass(300);
    page.ring.incoming(otto);
    await pass(4_000);
    expect(phone.asked).toEqual(["ring 50", "notify", "ring 50"]);
    expect(phone.up?.sounds).toBe(true);
    expect(chimeNotes).toEqual([]);
  });

  test("sends a message that comes while a ring waits for its turn after that ring", async () => {
    await messageThenRing();
    await pass(300);
    void desktop.notifier.showMessage("Mira", "hi", { host: HOST, channelId: 51, messageId: 2 });
    await pass(4_000);
    expect(phone.asked).toEqual(["notify", "ring 50", "notify"]);
    expect(phone.up?.sounds).toBe(true);
  });

  test("takes a ring down after it went up, however slow the phone is to show it", async () => {
    phone.slow = { show_call_ring: 500 };
    page.ring.incoming(otto);
    await pass(100);
    page.ring.cancel(50, "ringer-left");
    await pass(4_000);
    expect(phone.asked.filter((asked) => asked !== "notify")).toEqual(["ring 50", "clear 50"]);
    expect(phone.up).toBeNull();
  });

  test("never shows a call that ended while its ring waited for its turn", async () => {
    await desktop.notifier.showMessage("Otto", "you there?", {
      host: HOST,
      channelId: 50,
      messageId: 1,
    });
    page.ring.incoming(otto);
    await pass(500);
    page.ring.cancel(50, "ringer-left");
    await pass(4_000);
    expect(phone.asked).toEqual(["notify", "clear 50", "notify"]);
    expect(phone.up).toBeNull();
    expect(chimeNotes).toEqual([]);
  });

  test("rings in the app when the phone will not show the call", async () => {
    phone.notificationsOn = false;
    page.ring.incoming(otto);
    await pass(4_000);
    expect(phone.up).toBeNull();
    expect(chimeNotes.length).toBeGreaterThan(0);

    page.ring.decline();
    await pass(100);
    chimeNotes.length = 0;
    await pass(4_000);
    expect(chimeNotes).toEqual([]);
    expect(phone.asked).toEqual(["ring 50", "clear 50"]);
  });

  test("rings for a newer call that takes the first one's place within a second", async () => {
    page.ring.incoming(otto);
    await pass(300);
    page.ring.incoming(mira);
    await pass(4_000);
    expect(phone.asked).toEqual(["ring 50", "clear 50", "ring 51"]);
    expect(phone.up).toEqual({ channelId: 51, token: "token-2", sounds: true });
    expect(chimeNotes).toEqual([]);
  });

  test("joins once when the call is accepted on its notification", async () => {
    page.ring.incoming(otto);
    await pass(1_000);
    press("accept");
    await pass(1_000);
    expect(page.joined).toEqual([50]);
    expect(page.ring.current()).toBeNull();
    expect(phone.up).toBeNull();
    expect(phone.asked).toEqual(["ring 50", "clear 50"]);
  });

  test("stops ringing at once when the call is declined on its notification", async () => {
    page.ring.incoming(otto);
    await pass(1_000);
    press("decline");
    expect(phone.up).toBeNull();
    await pass(1_000);
    expect(page.ring.current()).toBeNull();
    expect(page.joined).toEqual([]);
    expect(phone.asked).toEqual(["ring 50", "clear 50"]);
  });
});
