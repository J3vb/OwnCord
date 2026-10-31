/**
 * Unit tests for the Push-to-Talk service (src/platform/desktop/pushToTalkService.ts, and
 * the vkName display helper in src/lib/voice/ptt.ts).
 *
 * Covers:
 *  - vkName: known keys, A-Z, 0-9, Numpad, unknown (hex fallback)
 *  - initPtt: no-op when pttVk is 0; invokes ptt_set_key + ptt_start when set
 *  - stopPtt: calls invoke("ptt_stop"); no-op when not listening
 *  - updatePttKey: saves pref, calls ptt_set_key; calls stopPtt when vk === 0
 *  - captureKeyPress: calls invoke("ptt_listen_for_key")
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { vkName } from "../../../src/lib/voice/ptt";
import { pushToTalk } from "../../../src/platform/desktop/pushToTalkService";

const { init: initPtt, stop: stopPtt, updateKey: updatePttKey, captureKeyPress } = pushToTalk;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bindKeyAndExpectNoGate(opts: {
  channelId: number | null;
  gated: boolean;
  pollingSupported: boolean;
}): Promise<void> {
  pttState.currentChannelId = opts.channelId;
  pttState.pttGated = opts.gated;
  mockInvoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "ptt_polling_supported" ? opts.pollingSupported : undefined),
  );

  await updatePttKey(0x20);

  await new Promise((r) => setTimeout(r, 0));
  expect(mockSetPttGated).not.toHaveBeenCalledWith(true);
  expect(mockSetMuted).not.toHaveBeenCalled();
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

    it("names F13 to F24 for 0x7C to 0x87", () => {
      for (let n = 13; n <= 24; n++) {
        expect(vkName(0x7c + (n - 13))).toBe(`F${n}`);
      }
    });

    it("returns 'Enter' for 0x0D", () => {
      expect(vkName(0x0d)).toBe("Enter");
    });

    it("names the single modifiers and Caps Lock", () => {
      expect(vkName(0x10)).toBe("Shift");
      expect(vkName(0x11)).toBe("Ctrl");
      expect(vkName(0x12)).toBe("Alt");
      expect(vkName(0x14)).toBe("Caps Lock");
    });

    it("returns '`' for the backtick key 0xC0", () => {
      expect(vkName(0xc0)).toBe("`");
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
    // A missing bridge says nothing about the key: the binding stays saved.
    expect(testPrefs.get("pttVk")).toBe(0x20);
  });

  it("clears a saved key the backend refuses, so Settings shows it unbound", async () => {
    testPrefs.set("pttVk", 0x41); // A, never bindable
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ptt_set_key"
        ? Promise.reject("unsupported_ptt_key: 65")
        : Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
    );

    await expect(initPtt()).resolves.toBeUndefined();

    expect(testPrefs.get("pttVk")).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalledWith("ptt_start");
    expect(mockSetPttPollingLive).not.toHaveBeenCalledWith(true);
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

describe("updatePttKey gates the mic when binding a key mid-call", () => {
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
    pttState.currentChannelId = 7;
    pttState.pttGated = false;
    pttState.localMuted = false;
    pttState.localDeafened = false;
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
    await bindKeyAndExpectNoGate({ channelId: null, gated: false, pollingSupported: true });
  });

  it("does not gate the mic when the backend cannot actually observe key state", async () => {
    // ptt_polling_supported === false: macOS is_key_down stub / Wayland — no
    // ptt-state event can ever arrive, so gating here would strand the mic
    // muted forever with no press able to lift it.
    await bindKeyAndExpectNoGate({ channelId: 7, gated: false, pollingSupported: false });
  });

  it("does not re-gate when the mic is already PTT-gated", async () => {
    // Already gated, e.g. the join-time gate is armed.
    await bindKeyAndExpectNoGate({ channelId: 7, gated: true, pollingSupported: true });
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
    pttState.pttGated = true;

    await stopPtt();

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
  });

  it("opens the gate but leaves the user's own self-mute or deafen alone", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();

    pttState.pttGated = true;
    pttState.localMuted = true;
    pttState.localDeafened = true;

    await stopPtt();

    await vi.waitFor(() => {
      expect(mockSetPttGated).toHaveBeenCalledWith(false);
    });
    expect(mockSetMuted).not.toHaveBeenCalled();
    expect(pttState.localMuted).toBe(true);
  });

  it("does nothing when pttGated was already false", async () => {
    testPrefs.set("pttVk", 0x20);
    await initPtt();
    mockSetPttGated.mockClear();

    pttState.pttGated = false;
    await stopPtt();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetPttGated).not.toHaveBeenCalledWith(false);
  });

  // Deleted the three "PTT release owned the mute" stopPtt tests
  // (B1_voice_mic-11): a release no longer applies a mute, so the only thing
  // stopPtt has to undo is the closed gate, covered above.
});
