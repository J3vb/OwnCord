// Push-to-Talk service tests, continued from keyAndGating.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as ptt from "../../helpers/pttHarness";
import { loggerMock } from "../../helpers/loggerMock";

vi.mock("@tauri-apps/api/core", () => ptt.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => ptt.tauriEventMock());
vi.mock("@lib/prefs/preferences", () => ptt.preferencesMock());
vi.mock("@stores/voice.store", () => ptt.voiceStoreMock());
vi.mock("@lib/logger", () => loggerMock());
vi.mock("../../../src/lib/voice/livekitSession", () => ptt.livekitSessionMock());

const {
  mockInvoke,
  mockListen,
  testPrefs,
  pttState,
  mockSetPttGated,
  mockSetMuted,
  mockSetPttPollingLive,
  resetAll,
} = ptt;

// ---------------------------------------------------------------------------
// Import module under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { pushToTalk } from "../../../src/platform/desktop/pushToTalkService";

const { init: initPtt, stop: stopPtt, updateKey: updatePttKey } = pushToTalk;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests: ptt-state event handler (integration via initPtt + listen callback)
// ---------------------------------------------------------------------------

/** Records the callback registered for each event name. */
function captureListeners(): Record<string, (e: { payload: unknown }) => void> {
  const capturedHandlers: Record<string, (e: { payload: unknown }) => void> = {};
  mockListen.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
    capturedHandlers[event] = cb;
    return Promise.resolve(() => {});
  });
  return capturedHandlers;
}

describe("ptt-state event listener", () => {
  beforeEach(resetAll);

  afterEach(() => {
    vi.resetModules();
  });

  /** Bind a key and return the ptt-state callback. */
  async function bind(): Promise<(event: { payload: boolean }) => void> {
    testPrefs.set("pttVk", 0x20);
    let cb: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, fn: (e: { payload: boolean }) => void) => {
      cb = fn;
      return Promise.resolve(() => {});
    });
    await initPtt();
    expect(cb).not.toBeNull();
    return cb!;
  }

  it("opens the gate via setPttGated(false) and never calls setMuted when PTT is pressed in a voice channel", async () => {
    pttState.currentChannelId = 7;
    const press = await bind();

    press({ payload: true });

    // setPttGated is reached via a dynamic import of livekitSession
    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("ignores key events where key polling is unsupported (a Wayland session)", async () => {
    pttState.currentChannelId = 7;
    testPrefs.set("pttVk", 0x20);
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? false : undefined),
    );

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    // A press and release seen through XWayland, with the app's own window
    // native Wayland: nothing here can lift a gate it would apply.
    capturedCallback!({ payload: true });
    capturedCallback!({ payload: false });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetPttGated).not.toHaveBeenCalled();
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("closes the gate via setPttGated(true) and never calls setMuted when PTT is released in a voice channel", async () => {
    pttState.currentChannelId = 7;
    const press = await bind();

    press({ payload: false }); // key released

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(true);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not touch the gate when not in a voice channel", async () => {
    pttState.currentChannelId = null; // not in a channel
    const press = await bind();

    press({ payload: true });

    // Flush pending microtasks so a (wrong) dynamic-import path would have
    // had the chance to run before we assert it never happens.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetPttGated).not.toHaveBeenCalled();
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  // Rewritten (v006): a press while self-muted or deafened only sets the gate;
  // the user's mute is untouched and keeps the capture stopped.
  it("a press while the user is self-muted still only sets the gate (mute untouched)", async () => {
    pttState.currentChannelId = 7;
    pttState.localMuted = true; // user explicitly muted themselves via the widget
    const press = await bind();

    press({ payload: true });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(pttState.localMuted).toBe(true);
  });

  it("a press while the user is deafened still only sets the gate (mute untouched)", async () => {
    pttState.currentChannelId = 7;
    pttState.localDeafened = true;
    const press = await bind();

    press({ payload: true });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  // Deleted "still unmutes on press when not self-muted or deafened" (covered by
  // the press test above) and "stays muted on the press after self-mute
  // mid-hold" (PTT no longer owns or reads a mute, so there is nothing to stay).

  it("opens the gate on every press and closes it on every release", async () => {
    pttState.currentChannelId = 7;
    const press = await bind();
    mockSetPttGated.mockClear();

    for (let i = 0; i < 2; i++) {
      press({ payload: true }); // pressed — gate open
      await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenCalledTimes(2 * i + 1));
      press({ payload: false }); // released — gate closed
      await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenCalledTimes(2 * i + 2));
    }

    expect(mockSetPttGated.mock.calls.map((c) => c[0])).toEqual([false, true, false, true]);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: 'ptt-error' listener recovers from a backend thread panic
// (B1_voice_mic-10)
// ---------------------------------------------------------------------------

describe("ptt-error event listener", () => {
  beforeEach(resetAll);

  it("registers a listener for 'ptt-error' and resets polling-live on a backend panic", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers = captureListeners();

    await initPtt();
    mockSetPttPollingLive.mockClear();

    expect(capturedHandlers["ptt-error"]).toBeTypeOf("function");
    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    expect(mockSetPttPollingLive).toHaveBeenCalledWith(false);
  });

  it("opens a closed gate (never a mute change) when the backend thread panics", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers = captureListeners();

    await initPtt();
    pttState.pttGated = true;

    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("opens the gate but leaves the user's own self-mute alone when the polling thread panics", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers = captureListeners();

    await initPtt();
    pttState.pttGated = true;
    pttState.localMuted = true;
    pttState.localDeafened = true;

    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(pttState.localMuted).toBe(true);
  });

  // Deleted the "after a PTT release applied the mute" and "deafened, even if a
  // PTT release owns the mute" variants: no PTT-owned mute exists any more.
});

describe("PTT binding lifecycle races", () => {
  beforeEach(async () => {
    resetAll();
    await stopPtt();
    resetAll();
    pttState.currentChannelId = 7;
  });

  afterEach(async () => {
    await stopPtt();
  });

  it("Clear cancels an unfinished bind without waiting for readiness or stranding the mic", async () => {
    let finishSupport!: (supported: boolean) => void;
    let nativeKey = 0;
    mockInvoke.mockImplementation((command: string, args?: { vkCode: number }) => {
      if (command === "ptt_set_key") nativeKey = args!.vkCode;
      if (command === "ptt_polling_supported") {
        return new Promise<boolean>((resolve) => {
          finishSupport = resolve;
        });
      }
      return Promise.resolve();
    });
    const pending = updatePttKey(0x20);
    await vi.waitFor(() => expect(finishSupport).toBeTypeOf("function"));
    // Clearing an unfinished binding must also release an existing PTT gate.
    // Start closed so the assertion proves a transition rather than false → false.
    pttState.pttGated = true;
    await updatePttKey(0);
    expect(nativeKey).toBe(0);
    expect(testPrefs.get("pttVk")).toBe(0);
    finishSupport(true);
    await pending;
    // Await this Clear's observable microphone work. dynamicImportSettled waits
    // every unresolved import in the worker, including unrelated module work.
    await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenCalledWith(false));

    expect(pttState.pollingLive).toBe(false);
    expect(pttState.pttGated).toBe(false);
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("ptt_start");
  });

  it("cleans up listeners that finish registering after Clear", async () => {
    const removeError = vi.fn();
    const removeState = vi.fn();
    let finishListener!: (unlisten: () => void) => void;
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    mockListen.mockImplementation((name: string) =>
      name === "ptt-state"
        ? new Promise<() => void>((resolve) => {
            finishListener = resolve;
          })
        : Promise.resolve(removeError),
    );
    const pending = updatePttKey(0x20);
    await vi.waitFor(() => expect(finishListener).toBeTypeOf("function"));
    await updatePttKey(0);
    finishListener(removeState);
    await pending;

    expect(removeError).toHaveBeenCalledTimes(1);
    expect(removeState).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalledWith("ptt_start");
    expect(pttState.pollingLive).toBe(false);
  });

  it("keeps the newest binding when an earlier readiness call finishes late", async () => {
    let finishFirst!: (supported: boolean) => void;
    let checks = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "ptt_polling_supported") {
        if (++checks === 1)
          return new Promise<boolean>((resolve) => {
            finishFirst = resolve;
          });
        return Promise.resolve(true);
      }
      return Promise.resolve();
    });
    const first = updatePttKey(0x20);
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
    await updatePttKey(0x70);
    finishFirst(false);
    await first;

    expect(testPrefs.get("pttVk")).toBe(0x70);
    expect(pttState.pollingLive).toBe(true);
    expect(mockInvoke.mock.calls.filter(([name]) => name === "ptt_start")).toHaveLength(1);
    expect(mockListen).toHaveBeenCalledTimes(2);
  });

  it("stops a native start whose IPC response is still pending", async () => {
    let finishStart!: () => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "ptt_start")
        return new Promise<void>((resolve) => {
          finishStart = resolve;
        });
      return Promise.resolve(command === "ptt_polling_supported" ? true : undefined);
    });
    const pending = updatePttKey(0x20);
    await vi.waitFor(() => expect(finishStart).toBeTypeOf("function"));
    await updatePttKey(0);
    expect(mockInvoke).toHaveBeenCalledWith("ptt_stop");
    finishStart();
    await pending;

    expect(pttState.pollingLive).toBe(false);
    expect(pttState.pttGated).toBe(false);
    expect(pttState.localMuted).toBe(false);
  });

  it("a repeated Clear cannot hide an earlier stop from the next start", async () => {
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    await updatePttKey(0x20);
    let finishStop!: () => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "ptt_stop")
        return new Promise<void>((resolve) => {
          finishStop = resolve;
        });
      return Promise.resolve(command === "ptt_polling_supported" ? true : undefined);
    });
    const stopping = stopPtt();
    await vi.waitFor(() => expect(finishStop).toBeTypeOf("function"));
    await updatePttKey(0);
    mockInvoke.mockClear();
    const restarting = updatePttKey(0x70);
    await vi.dynamicImportSettled();
    expect(mockInvoke).not.toHaveBeenCalledWith("ptt_start");
    finishStop();
    await stopping;
    await restarting;
    expect(mockInvoke).toHaveBeenCalledWith("ptt_start");
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
  });

  it("restarts polling when a key is rebound after a poller error", async () => {
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    const onError = mockListen.mock.calls.find(([name]) => name === "ptt-error")![1];
    onError({ payload: "PTT thread panicked" });
    expect(pttState.pollingLive).toBe(false);
    mockInvoke.mockClear();
    await updatePttKey(0x70);

    expect(mockInvoke).toHaveBeenCalledWith("ptt_start");
    expect(pttState.pollingLive).toBe(true);
  });

  it.each(["clear", "error"])(
    "reopens the gate on the rebound key's press after a released gate through %s immediately followed by rebind",
    async (reason) => {
      mockInvoke.mockImplementation((command: string) =>
        Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
      );
      testPrefs.set("pttVk", 0x20);
      // The release must have closed the gate already (no release delay).
      testPrefs.set("pttReleaseDelayMs", 0);
      await initPtt();
      const oldStateHandler = mockListen.mock.calls.find(([name]) => name === "ptt-state")![1];
      oldStateHandler({ payload: false });
      await vi.dynamicImportSettled();
      expect(pttState.localMuted).toBe(false);
      expect(pttState.pttGated).toBe(true);

      let clearing: Promise<void> | undefined;
      if (reason === "clear") clearing = updatePttKey(0);
      else
        mockListen.mock.calls.find(([name]) => name === "ptt-error")![1]({
          payload: "poller stopped",
        });
      const rebound = updatePttKey(0x70);
      await clearing;
      await rebound;
      const newStateHandler = mockListen.mock.calls
        .filter(([name]) => name === "ptt-state")
        .at(-1)![1];
      newStateHandler({ payload: true });
      await vi.dynamicImportSettled();

      expect(pttState.pttGated).toBe(false);
      expect(pttState.localMuted).toBe(false);
      expect(mockSetMuted).not.toHaveBeenCalled();
    },
  );

  it("leaves a user-owned mute alone through Clear and immediate rebind", async () => {
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    pttState.localMuted = true;
    pttState.pttGated = true;
    const clearing = updatePttKey(0);
    const rebound = updatePttKey(0x70);
    await clearing;
    await rebound;
    const onState = mockListen.mock.calls.filter(([name]) => name === "ptt-state").at(-1)![1];
    onState({ payload: true });
    await vi.dynamicImportSettled();

    expect(pttState.localMuted).toBe(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("preserves a press received before native startup's IPC response", async () => {
    let finishStart!: () => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "ptt_start") {
        const onState = mockListen.mock.calls.find(([name]) => name === "ptt-state")![1];
        onState({ payload: true });
        return new Promise<void>((resolve) => {
          finishStart = resolve;
        });
      }
      return Promise.resolve(command === "ptt_polling_supported" ? true : undefined);
    });
    const pending = updatePttKey(0x20);
    await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenCalledWith(false));
    finishStart();
    await pending;

    expect(pttState.pttGated).toBe(false);
    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("gates an idle key when a call joins during startup readiness", async () => {
    pttState.currentChannelId = null;
    testPrefs.set("pttVk", 0x20);
    let finishSupport!: (supported: boolean) => void;
    mockInvoke.mockImplementation((command: string) =>
      command === "ptt_polling_supported"
        ? new Promise<boolean>((resolve) => {
            finishSupport = resolve;
          })
        : Promise.resolve(),
    );
    const pending = initPtt();
    await vi.waitFor(() => expect(finishSupport).toBeTypeOf("function"));
    pttState.currentChannelId = 7;
    finishSupport(true);
    await pending;

    expect(pttState.pollingLive).toBe(true);
    expect(pttState.pttGated).toBe(true);
    expect(pttState.localMuted).toBe(false);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("ignores queued events from a removed binding and mic work for a previous call", async () => {
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    const onState = mockListen.mock.calls.find(([name]) => name === "ptt-state")![1];
    onState({ payload: false });
    pttState.currentChannelId = 8;
    await vi.dynamicImportSettled();
    expect(mockSetPttGated).not.toHaveBeenCalled();

    await stopPtt();
    await vi.dynamicImportSettled();
    mockSetPttGated.mockClear();
    onState({ payload: true });
    await vi.dynamicImportSettled();
    expect(mockSetPttGated).not.toHaveBeenCalled();
    expect(mockSetMuted).not.toHaveBeenCalled();
  });
});

// DP-30: a release keeps the gate open for the saved delay (D5: 20 ms by
// default, 0–2000 ms), and a press inside it cancels the close, so a short
// pause between words never cuts the next one.
describe("ptt release delay", () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function bind(): Promise<(event: { payload: boolean }) => void> {
    testPrefs.set("pttVk", 0x20);
    let cb: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, fn: (e: { payload: boolean }) => void) => {
      cb = fn;
      return Promise.resolve(() => {});
    });
    await initPtt();
    mockSetPttGated.mockClear();
    return cb!;
  }

  /** Deliver a key edge and let its lazy livekitSession import settle. */
  async function edgeOf(cb: (event: { payload: boolean }) => void, pressed: boolean) {
    cb({ payload: pressed });
    await vi.dynamicImportSettled();
  }

  const gateCalls = () => mockSetPttGated.mock.calls.map((c) => c[0]);

  it("a press after a release only toggles the gate and never touches mute", async () => {
    pttState.currentChannelId = 7;
    const key = await bind();

    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(20);
    await edgeOf(key, true);

    expect(gateCalls()).toEqual([false, true, false]);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("release then press within the delay transmits continuously; release past the delay gates once", async () => {
    pttState.currentChannelId = 7;
    const key = await bind();

    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(10);
    await edgeOf(key, true);
    await vi.advanceTimersByTimeAsync(100);
    expect(gateCalls()).not.toContain(true);

    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(19);
    expect(gateCalls()).not.toContain(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(gateCalls().filter((g) => g)).toEqual([true]);
  });

  it("follows the saved delay, and a delay of 0 closes on the release itself", async () => {
    pttState.currentChannelId = 7;
    testPrefs.set("pttReleaseDelayMs", 300);
    const key = await bind();
    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(299);
    expect(gateCalls()).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(gateCalls()).toEqual([false, true]);

    testPrefs.set("pttReleaseDelayMs", 0);
    await edgeOf(key, true);
    await edgeOf(key, false);
    expect(gateCalls()).toEqual([false, true, false, true]);
  });

  it("caps a saved delay at 2000 ms", async () => {
    pttState.currentChannelId = 7;
    testPrefs.set("pttReleaseDelayMs", 60_000);
    const key = await bind();
    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(gateCalls()).toEqual([false, true]);
  });

  it("a pending close is dropped when the call ends or the binding is cleared", async () => {
    pttState.currentChannelId = 7;
    const key = await bind();
    await edgeOf(key, true);
    await edgeOf(key, false);
    pttState.currentChannelId = null;
    await vi.advanceTimersByTimeAsync(100);
    expect(gateCalls()).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// Tests: Input Mode (WP 1D-2) — a key bound in Voice Activity mode never gates
// ---------------------------------------------------------------------------

describe("Input Mode: Voice Activity keeps a bound key idle", () => {
  beforeEach(async () => {
    resetAll();
    await stopPtt();
    resetAll();
  });

  const commands = (): unknown[] => mockInvoke.mock.calls.map((c) => c[0]);

  it("init does not start polling for a key bound in Voice Activity mode", async () => {
    testPrefs.set("pttVk", 0x41);
    testPrefs.set("inputMode", "vad");

    await initPtt();

    expect(commands()).not.toContain("ptt_start");
    expect(mockListen).not.toHaveBeenCalled();
    expect(pttState.pollingLive).toBe(false);
  });

  it("binding a key mid-call in Voice Activity mode saves it but does not gate the mic", async () => {
    testPrefs.set("inputMode", "vad");
    pttState.currentChannelId = 7;

    await updatePttKey(0x41);

    expect(testPrefs.get("pttVk")).toBe(0x41);
    expect(commands()).not.toContain("ptt_start");
    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
  });

  it("binding a key in Voice Activity mode stops a poller left running", async () => {
    testPrefs.set("pttVk", 0x41);
    testPrefs.set("inputMode", "ptt");
    await initPtt();
    expect(commands()).toContain("ptt_start");
    testPrefs.set("inputMode", "vad");
    mockInvoke.mockClear();

    await updatePttKey(0x42);

    expect(commands()).toContain("ptt_stop");
    expect(pttState.pollingLive).toBe(false);
  });

  it("re-arming the saved key after switching to Push to Talk gates the mic mid-call", async () => {
    testPrefs.set("pttVk", 0x41);
    testPrefs.set("inputMode", "vad");
    pttState.currentChannelId = 7;
    await initPtt();
    expect(commands()).not.toContain("ptt_start");

    testPrefs.set("inputMode", "ptt");
    await updatePttKey(0x41);

    expect(commands()).toContain("ptt_start");
    expect(mockSetPttGated).toHaveBeenCalledWith(true);
  });

  it("a profile from before Input Mode with a bound key still arms (no saved mode)", async () => {
    testPrefs.set("pttVk", 0x41);

    await initPtt();

    expect(commands()).toContain("ptt_start");
  });
});

// ---------------------------------------------------------------------------
// LP-9b: the desktop's shortcut service binds the PTT key after the binding
// started, and can lose it again.
// ---------------------------------------------------------------------------

describe("PTT on the portal backend", () => {
  const portalStatus = (ptt: string | null) => ({
    backend: "portal",
    portalVersion: 2,
    triggers: { ptt, mute: null, deafen: null },
    canConfigure: true,
    triggersUnnamed: false,
    sessionRefused: false,
  });
  let handlers: Map<string, (event: { payload: unknown }) => void>;
  let unlistened: string[];
  let supported: boolean;

  beforeEach(() => {
    resetAll();
    vi.resetModules();
    handlers = new Map();
    unlistened = [];
    supported = false;
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? supported : undefined),
    );
    let registration = 0;
    mockListen.mockImplementation((event: string, fn: (e: { payload: unknown }) => void) => {
      handlers.set(event, fn);
      const id = `${event}#${++registration}`;
      return Promise.resolve(() => unlistened.push(id));
    });
    testPrefs.set("pttVk", 0x77); // F8
    testPrefs.set("inputMode", "ptt");
    pttState.currentChannelId = 7;
  });

  afterEach(() => {
    vi.resetModules();
  });

  const starts = () => mockInvoke.mock.calls.filter((c) => c[0] === "ptt_start").length;
  const emit = (event: string, payload: unknown) => handlers.get(event)!({ payload });
  async function service() {
    const mod = await import("../../../src/platform/desktop/pushToTalkService");
    return mod.pushToTalk;
  }

  it("a lost portal binding opens the gate and a rebind re-arms once", async () => {
    const ptt = await service();
    // Start before the desktop has bound the key: armed, but nothing can gate.
    await ptt.init();
    expect(starts()).toBe(1);
    expect(pttState.pollingLive).toBe(false);
    expect(mockSetPttGated).not.toHaveBeenCalled();

    // The bind finishes: one new start, and the gate closes mid-call.
    supported = true;
    emit("global-keys-changed", portalStatus("F8"));
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(starts()).toBe(2);
    expect(mockSetPttGated.mock.calls.map((c) => c[0])).toEqual([true]);

    // The desktop drops the binding: the host reports ptt-error, the gate
    // opens and PTT is not live, so the mic is never stranded closed.
    emit("ptt-error", "portal_lost");
    await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenLastCalledWith(false));
    expect(pttState.pollingLive).toBe(false);

    // A rebind re-arms exactly once; a repeated event while live starts nothing.
    emit("global-keys-changed", portalStatus("F8"));
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(starts()).toBe(3);
    emit("global-keys-changed", portalStatus("F8"));
    // Long enough for a start (several awaited imports and invokes) to have run.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(starts()).toBe(3);
    expect(mockSetPttGated.mock.calls.map((c) => c[0])).toEqual([true, false, true]);

    // One set of listeners: each earlier binding's listeners were released.
    expect(unlistened.filter((id) => id.startsWith("ptt-state"))).toHaveLength(2);
    expect(unlistened.filter((id) => id.startsWith("ptt-error"))).toHaveLength(2);
  });

  it("a trigger the desktop drops while live opens the gate and stops PTT", async () => {
    const ptt = await service();
    await ptt.init();
    supported = true;
    emit("global-keys-changed", portalStatus("F8"));
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(mockSetPttGated).toHaveBeenLastCalledWith(true);

    // The user cleared the key in system settings: no release can ever arrive.
    emit("global-keys-changed", portalStatus(null));
    await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenLastCalledWith(false));
    expect(pttState.pollingLive).toBe(false);
    expect(unlistened.filter((id) => id.startsWith("ptt-state"))).toHaveLength(2);

    // Binding it again re-arms.
    emit("global-keys-changed", portalStatus("F9"));
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(starts()).toBe(3);
  });

  it("a portal that names no keys keeps PTT live and re-arms after a restart", async () => {
    const unnamed = { ...portalStatus(null), triggersUnnamed: true };
    const ptt = await service();
    await ptt.init();
    supported = true;
    emit("global-keys-changed", unnamed);
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(starts()).toBe(2);

    // The portal restarts: the host reports ptt-error, then the rebind lands
    // with the same unnamed status, which re-arms instead of tearing down.
    emit("ptt-error", "portal_lost");
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(false));
    emit("global-keys-changed", unnamed);
    await vi.waitFor(() => expect(pttState.pollingLive).toBe(true));
    expect(starts()).toBe(3);
    expect(mockSetPttGated).toHaveBeenLastCalledWith(true);
  });

  it("ignores a status that leaves PTT unbound, or PTT off", async () => {
    const ptt = await service();
    await ptt.init();
    emit("global-keys-changed", portalStatus(null));
    emit("global-keys-changed", { ...portalStatus("F8"), backend: "polling" });
    testPrefs.set("inputMode", "vad");
    emit("global-keys-changed", portalStatus("F8"));
    await Promise.resolve();
    expect(starts()).toBe(1);
  });
});
