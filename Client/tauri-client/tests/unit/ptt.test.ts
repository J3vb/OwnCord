/**
 * Unit tests for the Push-to-Talk service (src/lib/ptt.ts).
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
const mockSetPttGated = vi.fn();
const mockSetPttPollingLive = vi.fn();

/** Captures the listener passed to voiceStore.subscribe() so tests can fire
 *  a simulated store notification (real createStore() batches these via
 *  queueMicrotask; the mock fires only when a test invokes it explicitly). */
let capturedStoreListener: ((state: { localMuted: boolean }) => void) | null = null;
const mockSubscribeStore = vi.fn((listener: (state: { localMuted: boolean }) => void) => {
  capturedStoreListener = listener;
  return () => {
    capturedStoreListener = null;
  };
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

vi.mock("@components/settings/helpers", () => ({
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
    subscribe: (listener: (state: { localMuted: boolean }) => void) => mockSubscribeStore(listener),
  },
  setPttGated: (...args: unknown[]) => mockSetPttGated(...args),
  setPttPollingLive: (...args: unknown[]) => mockSetPttPollingLive(...args),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// setMuted is called internally by the ptt-state listener — mock to isolate
vi.mock("../../src/lib/livekitSession", () => ({
  setMuted: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { vkName, initPtt, stopPtt, updatePttKey, captureKeyPress } from "../../src/lib/ptt";

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
  mockSetPttGated.mockReset();
  mockSetPttPollingLive.mockReset();
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockSubscribeStore.mockReset();
  mockSubscribeStore.mockImplementation((listener: (state: { localMuted: boolean }) => void) => {
    capturedStoreListener = listener;
    return () => {
      capturedStoreListener = null;
    };
  });
  capturedStoreListener = null;
  // Default: invoke resolves with undefined; listen resolves with a no-op unlistener
  mockInvoke.mockResolvedValue(undefined);
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

  it("calls setMuted(false) when PTT is pressed (payload true) and in a voice channel", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ payload: true }); // key pressed

    // setMuted is reached via a dynamic import of livekitSession
    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });
  });

  it("calls setMuted(true) when PTT is released (payload false) and in a voice channel", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: false }); // key released

    // setMuted is reached via a dynamic import of livekitSession
    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(true);
    });
  });

  it("does not call setMuted when not in a voice channel", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = null; // not in a channel
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true });

    // Flush pending microtasks so a (wrong) dynamic-import path would have
    // had the chance to call setMuted before we assert it never happens.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not call setMuted(false) when PTT is pressed while the user is self-muted (v006)", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = 7;
    mockLocalMuted = true; // user explicitly muted themselves via the widget
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true }); // key pressed

    // Give the dynamic import a chance to resolve and (wrongly) call setMuted.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does not call setMuted(false) when PTT is pressed while the user is deafened (v006)", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = 7;
    mockLocalDeafened = true;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("still unmutes on press when the user is not self-muted or deafened", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    mockCurrentChannelId = 7;
    mockLocalMuted = false;
    mockLocalDeafened = false;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true });

    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });
  });

  it("updates pttGated in the store on press and release", async () => {
    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    mockSetPttGated.mockClear();

    capturedCallback!({ payload: true }); // pressed — gate open
    expect(mockSetPttGated).toHaveBeenCalledWith(false);

    capturedCallback!({ payload: false }); // released — gate closed
    expect(mockSetPttGated).toHaveBeenCalledWith(true);
  });

  it("keeps unmuting on every press even though a release writes localMuted (v006)", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockReset();
    // livekitSession.setMuted() writes localMuted for every caller, PTT
    // included — the self-mute guard must not read that write back as an
    // explicit self-mute, or PTT unmutes exactly once and is dead after.
    mockSetMuted.mockImplementation((muted: boolean) => {
      mockLocalMuted = muted;
    });

    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true });
    await vi.waitFor(() => expect(mockSetMuted).toHaveBeenCalledWith(false));
    capturedCallback!({ payload: false });
    await vi.waitFor(() => expect(mockLocalMuted).toBe(true));

    mockSetMuted.mockClear();
    capturedCallback!({ payload: true }); // second press
    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });
  });

  it("stays muted on the press after the user self-mutes mid-hold (v006)", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockReset();
    mockSetMuted.mockImplementation((muted: boolean) => {
      mockLocalMuted = muted;
    });

    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();

    capturedCallback!({ payload: true });
    await vi.waitFor(() => expect(mockSetMuted).toHaveBeenCalledWith(false));
    // The user hits the widget mute button while still holding the key.
    mockLocalMuted = true;
    capturedCallback!({ payload: false }); // release — mic was already muted
    await new Promise((r) => setTimeout(r, 0));

    mockSetMuted.mockClear();
    capturedCallback!({ payload: true }); // next press must not republish
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pttOwnsMute latch is cleared by a non-PTT unmute (B1_voice_mic-7)
// ---------------------------------------------------------------------------

describe("pttOwnsMute latch reset on external unmute", () => {
  beforeEach(resetAll);

  it("stays muted on a later press after a widget unmute+re-mute clears a stale PTT-owned latch", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockReset();
    mockSetMuted.mockImplementation((muted: boolean) => {
      mockLocalMuted = muted;
    });

    mockCurrentChannelId = 7;
    testPrefs.set("pttVk", 0x20);

    let capturedCallback: ((event: { payload: boolean }) => void) | null = null;
    mockListen.mockImplementation((_event: string, cb: (e: { payload: boolean }) => void) => {
      capturedCallback = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    expect(capturedStoreListener).not.toBeNull();

    // 1. Press then release — the release is PTT's own mute, so pttOwnsMute
    //    latches true.
    capturedCallback!({ payload: true });
    await vi.waitFor(() => expect(mockSetMuted).toHaveBeenCalledWith(false));
    capturedCallback!({ payload: false });
    await vi.waitFor(() => expect(mockLocalMuted).toBe(true));

    // 2. A non-PTT path unmutes (e.g. the widget's own mic button calling
    //    livekitSession.setMuted(false) directly) — simulate both the write
    //    and the resulting store notification our subscriber reacts to.
    mockSetMuted(false);
    capturedStoreListener!({ localMuted: mockLocalMuted });

    // 3. The user then genuinely self-mutes via the same non-PTT path.
    mockSetMuted(true);
    capturedStoreListener!({ localMuted: mockLocalMuted });

    // 4. The next PTT press must not lift this genuine self-mute — the
    //    latch from step 1 must not have survived steps 2-3.
    mockSetMuted.mockClear();
    capturedCallback!({ payload: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: stopPtt ungates a still-gated mic when the binding is cleared
// (B1_voice_mic-9)
// ---------------------------------------------------------------------------

describe("stopPtt ungates the mic when clearing the key mid-gate", () => {
  beforeEach(resetAll);

  it("clears pttGated and re-opens the mic when nothing else wants it muted", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    testPrefs.set("pttVk", 0x20);
    await initPtt();

    // Simulates livekitSession's join-time gate, still armed because the key
    // was never pressed before the user cleared the binding.
    mockPttGated = true;
    mockLocalMuted = false;
    mockLocalDeafened = false;

    await stopPtt();

    expect(mockSetPttGated).toHaveBeenCalledWith(false);
    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });
  });

  it("does not force-unmute when the user is separately self-muted or deafened", async () => {
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    testPrefs.set("pttVk", 0x20);
    await initPtt();

    mockPttGated = true;
    mockLocalMuted = true;

    await stopPtt();

    expect(mockSetPttGated).toHaveBeenCalledWith(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("does nothing when pttGated was already false", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockSetPttGated.mockClear();

    mockPttGated = false;
    await stopPtt();

    expect(mockSetPttGated).not.toHaveBeenCalledWith(false);
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

  it("re-opens a PTT-gated mic when the backend thread panics", async () => {
    testPrefs.set("pttVk", 0x20);
    const { setMuted } = await import("../../src/lib/livekitSession");
    const mockSetMuted = vi.mocked(setMuted);
    mockSetMuted.mockClear();

    const capturedHandlers: Record<string, (e: { payload: unknown }) => void> = {};
    mockListen.mockImplementation((event: string, cb: (e: { payload: unknown }) => void) => {
      capturedHandlers[event] = cb;
      return Promise.resolve(() => {});
    });

    await initPtt();
    mockPttGated = true;
    mockLocalMuted = false;
    mockLocalDeafened = false;

    capturedHandlers["ptt-error"]!({ payload: "PTT thread panicked" });

    expect(mockSetPttGated).toHaveBeenCalledWith(false);
    await vi.waitFor(() => {
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });
  });
});
