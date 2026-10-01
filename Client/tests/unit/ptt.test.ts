/**
 * Unit tests for the Push-to-Talk service (src/platform/desktop/pushToTalkService.ts, and
 * the vkName display helper in src/lib/ptt.ts).
 *
 * Covers:
 *  - vkName: known keys, A-Z, 0-9, Numpad, unknown (hex fallback)
 *  - initPtt: no-op when pttVk is 0; invokes ptt_set_key + ptt_start when set
 *  - stopPtt: calls invoke("ptt_stop"); no-op when not listening
 *  - updatePttKey: saves pref, calls ptt_set_key; calls stopPtt when vk === 0
 *  - captureKeyPress: calls invoke("ptt_listen_for_key")
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();
const mockListen = vi.fn();

// Prefs storage
const testPrefs = new Map<string, unknown>();

// voiceStore state
let mockCurrentChannelId: number | null = null;
let mockLocalMuted = false;
let mockLocalDeafened = false;
let mockPttGated = false;
let mockPttPollingLive = false;
/** livekitSession.setPttGated: closes/opens the mic processor's gate and writes
 *  the store's pttGated (the real session does both; the mock mirrors the store
 *  write so later reads of pttGated see it). */
const mockSetPttGated = vi.fn((gated: boolean) => {
  mockPttGated = gated;
});
const mockSetMuted = vi.fn();
const mockSetPttPollingLive = vi.fn((live: boolean) => {
  mockPttPollingLive = live;
});

// ---------------------------------------------------------------------------
// Module mocks (must be declared before importing the module under test)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("@lib/preferences", () => ({
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => {
    testPrefs.set(key, value);
  },
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: () => ({
      currentChannelId: mockCurrentChannelId,
      localMuted: mockLocalMuted,
      localDeafened: mockLocalDeafened,
      pttGated: mockPttGated,
    }),
  },
  setPttPollingLive: (live: boolean) => mockSetPttPollingLive(live),
  isPttPollingLive: () => mockPttPollingLive,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// PTT only ever calls setPttGated; setMuted is mocked so tests can assert it is
// never touched (PTT no longer uses mute).
vi.mock("../../src/lib/livekitSession", () => ({
  setPttGated: (gated: boolean) => mockSetPttGated(gated),
  setMuted: (muted: boolean) => mockSetMuted(muted),
}));

// ---------------------------------------------------------------------------
// Import module under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { vkName } from "../../src/lib/ptt";
import { pushToTalk } from "../../src/platform/desktop/pushToTalkService";

const { init: initPtt, stop: stopPtt, updateKey: updatePttKey, captureKeyPress } = pushToTalk;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all mock state between tests. */
function resetAll(): void {
  testPrefs.clear();
  mockCurrentChannelId = null;
  mockLocalMuted = false;
  mockLocalDeafened = false;
  mockPttGated = false;
  mockPttPollingLive = false;
  mockSetPttGated.mockReset();
  mockSetPttGated.mockImplementation((gated: boolean) => {
    mockPttGated = gated;
  });
  mockSetMuted.mockReset();
  mockSetPttPollingLive.mockReset();
  mockSetPttPollingLive.mockImplementation((live: boolean) => {
    mockPttPollingLive = live;
  });
  mockInvoke.mockReset();
  mockListen.mockReset();
  // Default: key polling is supported and every other command resolves with
  // undefined; listen resolves with a no-op unlistener
  mockInvoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
  );
  mockListen.mockResolvedValue(() => {});
}

// ---------------------------------------------------------------------------
// Tests: vkName
// ---------------------------------------------------------------------------

describe("vkName", () => {
  describe("well-known named keys", () => {
    it("returns 'Mouse 4' for 0x05", () => {
      expect(vkName(0x05)).toBe("Mouse 4");
    });

    it("returns 'Mouse 5' for 0x06", () => {
      expect(vkName(0x06)).toBe("Mouse 5");
    });

    it("returns 'Mouse Left' for 0x01", () => {
      expect(vkName(0x01)).toBe("Mouse Left");
    });

    it("returns 'Mouse Right' for 0x02", () => {
      expect(vkName(0x02)).toBe("Mouse Right");
    });

    it("returns 'Mouse Middle' for 0x04", () => {
      expect(vkName(0x04)).toBe("Mouse Middle");
    });

    it("returns 'Space' for 0x20", () => {
      expect(vkName(0x20)).toBe("Space");
    });

    it("returns 'F1' for 0x70", () => {
      expect(vkName(0x70)).toBe("F1");
    });

    it("returns 'F12' for 0x7B", () => {
      expect(vkName(0x7b)).toBe("F12");
    });

    it("returns 'Enter' for 0x0D", () => {
      expect(vkName(0x0d)).toBe("Enter");
    });

    it("returns 'Escape' for 0x1B", () => {
      expect(vkName(0x1b)).toBe("Escape");
    });

    it("returns 'Backspace' for 0x08", () => {
      expect(vkName(0x08)).toBe("Backspace");
    });

    it("returns 'Tab' for 0x09", () => {
      expect(vkName(0x09)).toBe("Tab");
    });

    it("returns 'Delete' for 0x2E", () => {
      expect(vkName(0x2e)).toBe("Delete");
    });

    it("returns 'Insert' for 0x2D", () => {
      expect(vkName(0x2d)).toBe("Insert");
    });

    it("returns 'Arrow Left' for 0x25", () => {
      expect(vkName(0x25)).toBe("Arrow Left");
    });

    it("returns 'Arrow Right' for 0x27", () => {
      expect(vkName(0x27)).toBe("Arrow Right");
    });

    it("returns 'Arrow Up' for 0x26", () => {
      expect(vkName(0x26)).toBe("Arrow Up");
    });

    it("returns 'Arrow Down' for 0x28", () => {
      expect(vkName(0x28)).toBe("Arrow Down");
    });

    it("returns 'Page Up' for 0x21", () => {
      expect(vkName(0x21)).toBe("Page Up");
    });

    it("returns 'Page Down' for 0x22", () => {
      expect(vkName(0x22)).toBe("Page Down");
    });

    it("returns 'Home' for 0x24", () => {
      expect(vkName(0x24)).toBe("Home");
    });

    it("returns 'End' for 0x23", () => {
      expect(vkName(0x23)).toBe("End");
    });
  });

  describe("digit keys 0-9 (0x30-0x39)", () => {
    it("returns '0' for 0x30", () => {
      expect(vkName(0x30)).toBe("0");
    });

    it("returns '9' for 0x39", () => {
      expect(vkName(0x39)).toBe("9");
    });

    it("returns '5' for 0x35", () => {
      expect(vkName(0x35)).toBe("5");
    });
  });

  describe("letter keys A-Z (0x41-0x5A)", () => {
    it("returns 'A' for 0x41", () => {
      expect(vkName(0x41)).toBe("A");
    });

    it("returns 'Z' for 0x5A", () => {
      expect(vkName(0x5a)).toBe("Z");
    });

    it("returns 'M' for 0x4D", () => {
      expect(vkName(0x4d)).toBe("M");
    });
  });

  describe("Numpad keys (0x60-0x69)", () => {
    it("returns 'Numpad 0' for 0x60", () => {
      expect(vkName(0x60)).toBe("Numpad 0");
    });

    it("returns 'Numpad 9' for 0x69", () => {
      expect(vkName(0x69)).toBe("Numpad 9");
    });

    it("returns 'Numpad 5' for 0x65", () => {
      expect(vkName(0x65)).toBe("Numpad 5");
    });
  });

  describe("unknown keys — hex fallback", () => {
    it("returns hex string for an unrecognised VK code", () => {
      // 0xFF is not in the map and not in any named range
      expect(vkName(0xff)).toBe("Key 0xFF");
    });

    it("returns uppercase hex for 0xAB", () => {
      expect(vkName(0xab)).toBe("Key 0xAB");
    });

    it("returns 'Key 0x0' for vk code 0", () => {
      // 0 is unrecognised — not in map, not in any character range
      expect(vkName(0x00)).toBe("Key 0x0");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: initPtt
// ---------------------------------------------------------------------------

describe("initPtt", () => {
  beforeEach(resetAll);

  it("does nothing when pttVk pref is 0 (default)", async () => {
    // pttVk defaults to 0
    await initPtt();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("does nothing when pttVk pref is explicitly saved as 0", async () => {
    testPrefs.set("pttVk", 0);

    await initPtt();

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("calls invoke('ptt_set_key') with the stored vk code when key is non-zero", async () => {
    testPrefs.set("pttVk", 0x20); // Space

    await initPtt();

    expect(mockInvoke).toHaveBeenCalledWith("ptt_set_key", { vkCode: 0x20 });
  });

  it("calls invoke('ptt_start') when key is non-zero", async () => {
    testPrefs.set("pttVk", 0x20);

    await initPtt();

    expect(mockInvoke).toHaveBeenCalledWith("ptt_start");
  });

  it("calls ptt_set_key before ptt_start", async () => {
    testPrefs.set("pttVk", 0x41); // A

    await initPtt();

    const calls = mockInvoke.mock.calls.map((c) => c[0]);
    const setKeyIdx = calls.indexOf("ptt_set_key");
    const startIdx = calls.indexOf("ptt_start");
    expect(setKeyIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(setKeyIdx).toBeLessThan(startIdx);
  });

  // v007: livekitSession mutes the mic at join when PTT is armed, and only a
  // real ptt-state event can lift that mute. ptt_start spawns its thread on
  // every platform, so the frontend must gate on the backend's capability
  // answer instead — otherwise macOS (is_key_down stub) and pure-Wayland Linux
  // (no reachable display) join muted with no way to ever unmute.
  it("reports the backend's polling capability so join-time muting is safe", async () => {
    testPrefs.set("pttVk", 0x20);
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
    );

    await initPtt();

    expect(mockInvoke).toHaveBeenCalledWith("ptt_polling_supported");
    expect(mockSetPttPollingLive).toHaveBeenCalledWith(true);
  });

  it("reports polling as NOT live when the backend cannot observe key state", async () => {
    testPrefs.set("pttVk", 0x20);
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? false : undefined),
    );

    await initPtt();

    expect(mockSetPttPollingLive).toHaveBeenCalledWith(false);
    expect(mockSetPttPollingLive).not.toHaveBeenCalledWith(true);
  });

  it("reports polling as NOT live when a backend command rejects", async () => {
    testPrefs.set("pttVk", 0x20);
    mockInvoke.mockRejectedValue(new Error("not in Tauri"));

    await initPtt();

    expect(mockSetPttPollingLive).toHaveBeenCalledWith(false);
    expect(mockSetPttPollingLive).not.toHaveBeenCalledWith(true);
  });

  it("calls listen for 'ptt-state' events when key is non-zero", async () => {
    testPrefs.set("pttVk", 0x70); // F1

    await initPtt();

    expect(mockListen).toHaveBeenCalledWith("ptt-state", expect.any(Function));
  });

  it("does not throw when Tauri is unavailable (simulated by invoke rejecting)", async () => {
    testPrefs.set("pttVk", 0x20);
    mockInvoke.mockRejectedValue(new Error("not in Tauri"));

    await expect(initPtt()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: stopPtt
// ---------------------------------------------------------------------------

describe("stopPtt", () => {
  beforeEach(async () => {
    resetAll();
    // Drain any lingering listening state left by earlier test groups.
    // stopPtt with listening===true would call invoke — clear it silently.
    await stopPtt();
    mockInvoke.mockClear();
  });

  it("does not call invoke when PTT was never started (not listening)", async () => {
    // After beforeEach drain, listening is false — stopPtt must be a no-op.
    await stopPtt();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls invoke('ptt_stop') after PTT has been started", async () => {
    // Start PTT first so the listening flag is set
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockInvoke.mockClear();

    await stopPtt();

    expect(mockInvoke).toHaveBeenCalledWith("ptt_stop");
  });

  it("does not throw when invoke('ptt_stop') rejects", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockInvoke.mockRejectedValue(new Error("ptt_stop failed"));

    await expect(stopPtt()).resolves.toBeUndefined();
  });

  it("is idempotent — second stopPtt does not call invoke again", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();

    await stopPtt();
    mockInvoke.mockClear();

    await stopPtt();

    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: updatePttKey
// ---------------------------------------------------------------------------

describe("updatePttKey", () => {
  beforeEach(resetAll);

  it("saves the new vk code to prefs", async () => {
    await updatePttKey(0x41);

    expect(testPrefs.get("pttVk")).toBe(0x41);
  });

  it("calls invoke('ptt_set_key') with the new vk code", async () => {
    await updatePttKey(0x41);

    expect(mockInvoke).toHaveBeenCalledWith("ptt_set_key", { vkCode: 0x41 });
  });

  it("saves 0 to prefs when called with 0 (disable PTT)", async () => {
    // Start listening first
    testPrefs.set("pttVk", 0x20);
    await initPtt();

    await updatePttKey(0);

    expect(testPrefs.get("pttVk")).toBe(0);
  });

  it("calls invoke('ptt_stop') via stopPtt when vk is 0 and was listening", async () => {
    // Establish listening state
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockInvoke.mockClear();

    await updatePttKey(0);

    expect(mockInvoke).toHaveBeenCalledWith("ptt_stop");
  });

  it("does not call ptt_stop when vk is 0 but was never listening", async () => {
    // Never called initPtt, so listening === false
    await updatePttKey(0);

    // ptt_set_key should be called (updatePttKey always calls it), but not ptt_stop
    const stopCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ptt_stop");
    expect(stopCalls).toHaveLength(0);
  });

  it("does not throw when invoke rejects", async () => {
    mockInvoke.mockRejectedValue(new Error("invoke failed"));

    await expect(updatePttKey(0x20)).resolves.toBeUndefined();
  });

  it("calls initPtt (triggering ptt_start) when setting a key while not yet listening", async () => {
    // listening is false because initPtt was never called
    await updatePttKey(0x41);

    // updatePttKey calls initPtt internally when !listening && vk !== 0,
    // which in turn calls ptt_set_key (again) and ptt_start
    const startCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ptt_start");
    expect(startCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: updatePttKey gates an already-hot mic when bound mid-call (OC-0162)
// ---------------------------------------------------------------------------

describe("updatePttKey gates the mic when binding a key mid-call (OC-0162)", () => {
  beforeEach(async () => {
    resetAll();
    // The module-level `listening` flag is not reset by resetAll() (it lives
    // in ptt.ts, not in the mocks) and earlier describe blocks may leave it
    // true — drain it so each test here starts from the same "no key bound
    // yet" state the finding's repro assumes.
    await stopPtt();
    mockInvoke.mockClear();
  });

  it("closes the mic's PTT gate (never mutes) when a key is bound while already in a voice call", async () => {
    // Already in a voice call, joined with no PTT key bound — the mic was
    // published ungated (pttArmed was false at join time).
    mockCurrentChannelId = 7;
    mockPttGated = false;
    mockLocalMuted = false;
    mockLocalDeafened = false;
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
    );

    // The user now binds a PTT key from Settings -> Keybinds.
    await updatePttKey(0x20);

    // Without the fix, updatePttKey only starts the poller (initPtt) and
    // never applies the gate — the idle key produces no ptt-state transition
    // (see src-tauri/src/ptt.rs ptt_transition), so the mic stays hot forever
    // until the user's first physical press+release.
    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(true);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not gate the mic when binding a key while not in a voice call", async () => {
    mockCurrentChannelId = null; // not in a call
    mockPttGated = false;
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
    );

    await updatePttKey(0x20);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not gate the mic when the backend cannot actually observe key state", async () => {
    mockCurrentChannelId = 7; // in a call
    mockPttGated = false;
    // ptt_polling_supported === false: macOS is_key_down stub / Wayland — no
    // ptt-state event can ever arrive, so gating here would strand the mic
    // muted forever with no press able to lift it.
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? false : undefined),
    );

    await updatePttKey(0x20);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not re-gate when the mic is already PTT-gated", async () => {
    mockCurrentChannelId = 7;
    mockPttGated = true; // already gated (e.g. join-time gate already armed)
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
    );

    await updatePttKey(0x20);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: captureKeyPress
// ---------------------------------------------------------------------------

describe("captureKeyPress", () => {
  beforeEach(resetAll);

  it("calls invoke('ptt_listen_for_key') and returns the result", async () => {
    mockInvoke.mockResolvedValue(0x41);

    const result = await captureKeyPress();

    expect(mockInvoke).toHaveBeenCalledWith("ptt_listen_for_key");
    expect(result).toBe(0x41);
  });

  it("propagates the vk code returned by Tauri", async () => {
    mockInvoke.mockResolvedValue(0x20);

    const result = await captureKeyPress();

    expect(result).toBe(0x20);
  });

  it("propagates rejection from invoke", async () => {
    mockInvoke.mockRejectedValue(new Error("listener error"));

    await expect(captureKeyPress()).rejects.toThrow("listener error");
  });
});

// ---------------------------------------------------------------------------
// Tests: ptt-state event handler (integration via initPtt + listen callback)
// ---------------------------------------------------------------------------

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
    mockCurrentChannelId = 7;
    const press = await bind();

    press({ payload: true });

    // setPttGated is reached via a dynamic import of livekitSession
    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("ignores key events where key polling is unsupported (a Wayland session)", async () => {
    mockCurrentChannelId = 7;
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
    mockCurrentChannelId = 7;
    const press = await bind();

    press({ payload: false }); // key released

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(true);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not touch the gate when not in a voice channel", async () => {
    mockCurrentChannelId = null; // not in a channel
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
    mockCurrentChannelId = 7;
    mockLocalMuted = true; // user explicitly muted themselves via the widget
    const press = await bind();

    press({ payload: true });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(mockLocalMuted).toBe(true);
  });

  it("a press while the user is deafened still only sets the gate (mute untouched)", async () => {
    mockCurrentChannelId = 7;
    mockLocalDeafened = true;
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
    mockCurrentChannelId = 7;
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

// Deleted the "pttOwnsMute latch reset on external unmute" suite: the latch and
// its store subscriber no longer exist.

// ---------------------------------------------------------------------------
// Tests: stopPtt opens a still-closed gate when the binding is cleared
// (B1_voice_mic-9)
// ---------------------------------------------------------------------------

describe("stopPtt ungates the mic when clearing the key mid-gate", () => {
  beforeEach(resetAll);

  it("opens the gate (never a mute change) when nothing else is involved", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();

    // Simulates livekitSession's join-time gate, still armed because the key
    // was never pressed before the user cleared the binding.
    mockPttGated = true;

    await stopPtt();

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("opens the gate but leaves the user's own self-mute or deafen alone", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();

    mockPttGated = true;
    mockLocalMuted = true;
    mockLocalDeafened = true;

    await stopPtt();

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(mockLocalMuted).toBe(true);
  });

  it("does nothing when pttGated was already false", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockSetPttGated.mockClear();

    mockPttGated = false;
    await stopPtt();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetPttGated).not.toHaveBeenCalledWith(false);
  });

  // Deleted the three "PTT release owned the mute" stopPtt tests
  // (B1_voice_mic-11): a release no longer applies a mute, so the only thing
  // stopPtt has to undo is the closed gate, covered above.
});

// ---------------------------------------------------------------------------
// Tests: 'ptt-error' listener recovers from a backend thread panic
// (B1_voice_mic-10)
// ---------------------------------------------------------------------------

describe("ptt-error event listener", () => {
  beforeEach(resetAll);

  it("registers a listener for 'ptt-error' and resets polling-live on a backend panic", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers: Record<string, (e: { payload: unknown }) => void> = {};
    mockListen.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      capturedHandlers[event] = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    mockSetPttPollingLive.mockClear();

    expect(capturedHandlers["ptt-error"]).toBeTypeOf("function");
    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    expect(mockSetPttPollingLive).toHaveBeenCalledWith(false);
  });

  it("opens a closed gate (never a mute change) when the backend thread panics", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers: Record<string, (e: { payload: unknown }) => void> = {};
    mockListen.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      capturedHandlers[event] = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    mockPttGated = true;

    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("opens the gate but leaves the user's own self-mute alone when the polling thread panics", async () => {
    testPrefs.set("pttVk", 0x20);

    const capturedHandlers: Record<string, (e: { payload: unknown }) => void> = {};
    mockListen.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      capturedHandlers[event] = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    mockPttGated = true;
    mockLocalMuted = true;
    mockLocalDeafened = true;

    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(mockLocalMuted).toBe(true);
  });

  // Deleted the "after a PTT release applied the mute" and "deafened, even if a
  // PTT release owns the mute" variants: no PTT-owned mute exists any more.
});

describe("PTT binding lifecycle races", () => {
  beforeEach(async () => {
    resetAll();
    await stopPtt();
    resetAll();
    mockCurrentChannelId = 7;
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
    mockPttGated = true;
    await updatePttKey(0);
    expect(nativeKey).toBe(0);
    expect(testPrefs.get("pttVk")).toBe(0);
    finishSupport(true);
    await pending;
    // Await this Clear's observable microphone work. dynamicImportSettled waits
    // every unresolved import in the worker, including unrelated module work.
    await vi.waitFor(() => expect(mockSetPttGated).toHaveBeenCalledWith(false));

    expect(mockPttPollingLive).toBe(false);
    expect(mockPttGated).toBe(false);
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
    expect(mockPttPollingLive).toBe(false);
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
    expect(mockPttPollingLive).toBe(true);
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

    expect(mockPttPollingLive).toBe(false);
    expect(mockPttGated).toBe(false);
    expect(mockLocalMuted).toBe(false);
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
    expect(mockPttPollingLive).toBe(false);
    mockInvoke.mockClear();
    await updatePttKey(0x70);

    expect(mockInvoke).toHaveBeenCalledWith("ptt_start");
    expect(mockPttPollingLive).toBe(true);
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
      expect(mockLocalMuted).toBe(false);
      expect(mockPttGated).toBe(true);

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

      expect(mockPttGated).toBe(false);
      expect(mockLocalMuted).toBe(false);
      expect(mockSetMuted).not.toHaveBeenCalled();
    },
  );

  it("leaves a user-owned mute alone through Clear and immediate rebind", async () => {
    mockInvoke.mockImplementation((command: string) =>
      Promise.resolve(command === "ptt_polling_supported" ? true : undefined),
    );
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockLocalMuted = true;
    mockPttGated = true;
    const clearing = updatePttKey(0);
    const rebound = updatePttKey(0x70);
    await clearing;
    await rebound;
    const onState = mockListen.mock.calls.filter(([name]) => name === "ptt-state").at(-1)![1];
    onState({ payload: true });
    await vi.dynamicImportSettled();

    expect(mockLocalMuted).toBe(true);
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

    expect(mockPttGated).toBe(false);
    expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("gates an idle key when a call joins during startup readiness", async () => {
    mockCurrentChannelId = null;
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
    mockCurrentChannelId = 7;
    finishSupport(true);
    await pending;

    expect(mockPttPollingLive).toBe(true);
    expect(mockPttGated).toBe(true);
    expect(mockLocalMuted).toBe(false);
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
    mockCurrentChannelId = 8;
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
    mockCurrentChannelId = 7;
    const key = await bind();

    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(20);
    await edgeOf(key, true);

    expect(gateCalls()).toEqual([false, true, false]);
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("release then press within the delay transmits continuously; release past the delay gates once", async () => {
    mockCurrentChannelId = 7;
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
    mockCurrentChannelId = 7;
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
    mockCurrentChannelId = 7;
    testPrefs.set("pttReleaseDelayMs", 60_000);
    const key = await bind();
    await edgeOf(key, true);
    await edgeOf(key, false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(gateCalls()).toEqual([false, true]);
  });

  it("a pending close is dropped when the call ends or the binding is cleared", async () => {
    mockCurrentChannelId = 7;
    const key = await bind();
    await edgeOf(key, true);
    await edgeOf(key, false);
    mockCurrentChannelId = null;
    await vi.advanceTimersByTimeAsync(100);
    expect(gateCalls()).toEqual([false]);
  });
});
