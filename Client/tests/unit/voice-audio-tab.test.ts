import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockSwitchInputDevice = vi.fn().mockResolvedValue(undefined);
const mockSwitchOutputDevice = vi.fn().mockResolvedValue(undefined);
const mockSwitchVideoDevice = vi.fn().mockResolvedValue(undefined);
const mockSetVoiceSensitivity = vi.fn();
const mockSetInputVolume = vi.fn();
/** The native engine's level reports: the meter's listener and its release. */
let nativeLevelListener: ((rms: number | null, open: boolean) => void) | null = null;
const mockUnsubscribeNativeLevel = vi.fn(() => {
  nativeLevelListener = null;
});
const mockSetOutputVolume = vi.fn();
const mockReapplyAudioProcessing = vi.fn().mockResolvedValue(undefined);
const mockReapplyEnhancedNoiseSuppression = vi.fn().mockResolvedValue(undefined);
const mockGetLocalMicSettings = vi.fn((): MediaTrackSettings | null => null);
const mockApplyInputMode = vi.fn();
const mockPttStop = vi.fn(async () => {});
const mockPttUpdateKey = vi.fn(async (_vk: number) => {});

vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: {
    supported: async () => true,
    captureKeyPress: async () => 0,
    stop: () => mockPttStop(),
    updateKey: (vk: number) => mockPttUpdateKey(vk),
  },
}));

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: (...args: unknown[]) => mockSwitchInputDevice(...args),
  switchOutputDevice: (...args: unknown[]) => mockSwitchOutputDevice(...args),
  switchVideoDevice: (...args: unknown[]) => mockSwitchVideoDevice(...args),
  setVoiceSensitivity: (...args: unknown[]) => mockSetVoiceSensitivity(...args),
  applyInputMode: () => mockApplyInputMode(),
  setInputVolume: (...args: unknown[]) => mockSetInputVolume(...args),
  onNativeInputLevel: (listener: (rms: number | null, open: boolean) => void) => {
    nativeLevelListener = listener;
    return mockUnsubscribeNativeLevel;
  },
  setOutputVolume: (...args: unknown[]) => mockSetOutputVolume(...args),
  reapplyAudioProcessing: (...args: unknown[]) => mockReapplyAudioProcessing(...args),
  reapplyEnhancedNoiseSuppression: (...args: unknown[]) =>
    mockReapplyEnhancedNoiseSuppression(...args),
  getLocalMicSettings: () => mockGetLocalMicSettings(),
}));

import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { vadThreshold } from "@lib/audioPipeline";
import type { NativeMicTestEnvelope } from "../../src/platform/contracts/nativeVoice";
import { GATE_LOOKAHEAD_S } from "@lib/micProcessor";
// vi.resetModules() below would hand the re-imported module a fresh logger,
// which re-installs the logger's app-lifetime pref-change listener on every
// reset. Those tests re-import against this already-loaded instance instead,
// so the singleton stays one.
import * as appLogger from "@lib/logger";
import { expectConsole } from "../helpers/console";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  installFakeAudio,
} from "../helpers/fakeAudioContext";

/** The volume sliders, not the Push to Talk release delay in the input mode card. */
const VOLUME_SLIDERS = 'input[type="range"]:not([data-testid="ptt-release-delay"])';

describe("VoiceAudioTab camera preview", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    localStorage.setItem("owncord:settings:videoInputDevice", '"camera-1"');

    installFakeAudio({ worklets: true });
  });

  it("does not restore a stale camera stream after the tab is aborted", async () => {
    let resolveVideo: ((stream: MediaStream) => void) | null = null;
    const stopVideoTrack = vi.fn();
    const videoStream = {
      getTracks: () => [{ stop: stopVideoTrack, kind: "audio" }],
      getAudioTracks: () => [{ stop: stopVideoTrack, kind: "audio" }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: "videoinput", deviceId: "camera-1", label: "Camera 1" }]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return new Promise<MediaStream>((resolve) => {
              resolveVideo = resolve;
            });
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const element = tab.build();
    document.body.appendChild(element);
    const preview = element.querySelector("video") as HTMLVideoElement;

    ac.abort();
    (resolveVideo as ((stream: MediaStream) => void) | null)?.(videoStream);

    await vi.waitFor(() => {
      expect(stopVideoTrack).toHaveBeenCalledTimes(1);
      expect(preview.srcObject).toBeNull();
    });
  });

  it("does not restore a stale camera stream after the tab is cleaned up", async () => {
    let resolveVideo: ((stream: MediaStream) => void) | null = null;
    const stopVideoTrack = vi.fn();
    const videoStream = {
      getTracks: () => [{ stop: stopVideoTrack, kind: "audio" }],
      getAudioTracks: () => [{ stop: stopVideoTrack, kind: "audio" }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: "videoinput", deviceId: "camera-1", label: "Camera 1" }]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return new Promise<MediaStream>((resolve) => {
              resolveVideo = resolve;
            });
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const element = tab.build();
    document.body.appendChild(element);
    const preview = element.querySelector("video") as HTMLVideoElement;

    tab.cleanup();
    (resolveVideo as ((stream: MediaStream) => void) | null)?.(videoStream);

    await vi.waitFor(() => {
      expect(stopVideoTrack).toHaveBeenCalledTimes(1);
      expect(preview.srcObject).toBeNull();
    });
  });
});

describe("VoiceAudioTab mic meter", () => {
  let resolveAudio: ((stream: MediaStream) => void) | null = null;
  const stopAudioTrack = vi.fn();
  const audioStream = {
    getTracks: () => [{ stop: stopAudioTrack, kind: "audio" }],
    getAudioTracks: () => [{ stop: stopAudioTrack, kind: "audio" }],
  } as unknown as MediaStream;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    resolveAudio = null;
    stopAudioTrack.mockClear();

    installFakeAudio({ worklets: true });

    // No videoInputDevice pref, so only the mic meter requests media.
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockImplementation(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveAudio = resolve;
            }),
        ),
      },
    });
  });

  it("stops the mic stream when cleanup ran while getUserMedia was pending", async () => {
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    document.body.appendChild(tab.build());

    // SettingsOverlay.hide() calls cleanup() without aborting; a getUserMedia
    // resolving afterwards must not open the mic — nobody is left to stop it.
    tab.cleanup();
    (resolveAudio as ((stream: MediaStream) => void) | null)?.(audioStream);

    await vi.waitFor(() => {
      expect(stopAudioTrack).toHaveBeenCalledTimes(1);
    });
  });

  it("stops the mic stream when the tab was aborted while getUserMedia was pending", async () => {
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    document.body.appendChild(tab.build());

    ac.abort();
    (resolveAudio as ((stream: MediaStream) => void) | null)?.(audioStream);

    await vi.waitFor(() => {
      expect(stopAudioTrack).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// UI structure and interaction tests
// ---------------------------------------------------------------------------

describe("VoiceAudioTab UI structure", () => {
  /** Fires the `devicechange` listeners registered on the stubbed MediaDevices. */
  let emitDeviceChange: () => void = () => {};

  type FakeDevice = { kind: string; deviceId: string; label: string; groupId?: string };
  function stubNavigator(devices: FakeDevice[] = []): {
    setDevices(next: FakeDevice[]): void;
  } {
    const audioStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;

    let current = devices;
    const listeners = new Set<() => void>();
    emitDeviceChange = () => {
      for (const l of listeners) l();
    };

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockImplementation(() => Promise.resolve(current)),
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
        addEventListener: (type: string, handler: () => void) => {
          if (type === "devicechange") listeners.add(handler);
        },
        removeEventListener: (_type: string, handler: () => void) => {
          listeners.delete(handler);
        },
      },
    });

    return {
      setDevices(next) {
        current = next;
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    installFakeAudio({ worklets: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a section element with settings-pane class", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("settings-pane")).toBe(true);
    ac.abort();
  });

  it("contains input device, output device, and video device selects", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const selects = el.querySelectorAll("select");
    // Input, output, camera quality, screen share quality, screen share fps,
    // video codec, video = 7 selects
    expect(selects.length).toBe(7);
    ac.abort();
  });

  it("contains input volume and output volume sliders", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll(VOLUME_SLIDERS);
    expect(sliders.length).toBe(2); // input volume + output volume
    // ...plus the Push to Talk release delay, under the input mode.
    expect(el.querySelectorAll('input[type="range"]').length).toBe(3);
    ac.abort();
  });

  it("input volume slider calls setInputVolume on change", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll(VOLUME_SLIDERS) as NodeListOf<HTMLInputElement>;
    const inputSlider = sliders[0]!;
    inputSlider.value = "75";
    inputSlider.dispatchEvent(new Event("input"));

    expect(mockSetInputVolume).toHaveBeenCalledWith(75);
    ac.abort();
  });

  it("output volume slider calls setOutputVolume on change", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll(VOLUME_SLIDERS) as NodeListOf<HTMLInputElement>;
    const outputSlider = sliders[1]!;
    outputSlider.value = "80";
    outputSlider.dispatchEvent(new Event("input"));

    expect(mockSetOutputVolume).toHaveBeenCalledWith(80);
    ac.abort();
  });

  it("restores saved input volume from preferences", () => {
    localStorage.setItem("owncord:settings:inputVolume", "75");
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll(VOLUME_SLIDERS) as NodeListOf<HTMLInputElement>;
    expect(sliders[0]!.value).toBe("75");
    ac.abort();
  });

  it("restores saved output volume from preferences", () => {
    localStorage.setItem("owncord:settings:outputVolume", "60");
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll(VOLUME_SLIDERS) as NodeListOf<HTMLInputElement>;
    expect(sliders[1]!.value).toBe("60");
    ac.abort();
  });

  it("refreshes the device lists when hardware is plugged or unplugged", async () => {
    const nav = stubNavigator([
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" },
    ]);
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("mic-1"));

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => {
      expect(inputSelect.querySelectorAll("option").length).toBe(2);
      expect(inputSelect.value).toBe("mic-1");
    });

    // Unplug mic-1, plug in mic-2. A stale list would keep offering a device
    // that no longer exists.
    nav.setDevices([
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" },
    ]);
    emitDeviceChange();

    // The saved device is gone: it stays the selection, marked disconnected
    // and not pickable, rather than silently reading as Default (DP-31).
    await vi.waitFor(() => {
      const values = Array.from(inputSelect.querySelectorAll("option")).map((o) => o.value);
      expect(values).toEqual(["", "mic-2", "mic-1"]);
    });
    expect(inputSelect.value).toBe("mic-1");
    expect(inputSelect.selectedOptions[0]!.textContent).toBe("Mic 1 (disconnected)");
    expect(inputSelect.selectedOptions[0]!.disabled).toBe(true);

    // Plugged back in: the entry is an ordinary one again.
    nav.setDevices([
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" },
    ]);
    emitDeviceChange();
    await vi.waitFor(() => expect(inputSelect.selectedOptions[0]!.textContent).toBe("Mic 1"));
    expect(inputSelect.value).toBe("mic-1");
    expect(inputSelect.selectedOptions[0]!.disabled).toBe(false);

    ac.abort();
  });

  it("names a saved device unplugged before the tab opened by its id", async () => {
    stubNavigator([{ kind: "audioinput", deviceId: "mic-2", label: "Mic 2" }]);
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("abcdef0123456789"));

    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => expect(inputSelect.value).toBe("abcdef0123456789"));
    expect(inputSelect.selectedOptions[0]!.textContent).toBe(
      "Microphone (abcdef01) (disconnected)",
    );
    ac.abort();
  });

  it("does not list nameless devices or mark the saved ones disconnected while the webview hides the device list", async () => {
    // Without a granted media permission Chromium (WebView2) answers
    // enumerateDevices with one entry per kind, id and label both empty.
    stubNavigator([
      { kind: "audioinput", deviceId: "", label: "" },
      { kind: "audiooutput", deviceId: "", label: "" },
    ]);
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("abcdef0123456789"));
    localStorage.setItem("owncord:settings:audioOutputDevice", JSON.stringify("default"));

    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const [inputSelect, outputSelect] = el.querySelectorAll("select");
    await vi.waitFor(() => expect(inputSelect!.value).toBe("abcdef0123456789"));
    for (const select of [inputSelect!, outputSelect!]) {
      const options = Array.from(select.querySelectorAll("option"));
      expect(options.map((o) => o.textContent)).not.toContain("Microphone ()");
      expect(options.map((o) => o.textContent)).not.toContain("Speaker ()");
      expect(options.some((o) => o.textContent?.includes("(disconnected)"))).toBe(false);
      expect(options.some((o) => o.disabled)).toBe(false);
    }
    expect(inputSelect!.selectedOptions[0]!.textContent).toBe("Microphone (abcdef01)");
    expect(outputSelect!.value).toBe("default");
    ac.abort();
  });

  it("meters the system default while the saved microphone is unplugged", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", '"mic-gone"');
    stubNavigator();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
      Object.assign(new Error("gone"), { name: "OverconstrainedError" }),
    );
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    await vi.waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
        audio: expect.objectContaining({ deviceId: "default" }),
        video: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector<HTMLElement>("[data-testid='mic-status']")!.textContent).not.toBe(
      "No microphone access",
    );
    ac.abort();
  });

  it("stops refreshing device lists once the tab is aborted", async () => {
    const nav = stubNavigator([{ kind: "audioinput", deviceId: "mic-1", label: "Mic 1" }]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => {
      expect(inputSelect.querySelectorAll("option").length).toBe(2);
    });

    ac.abort();
    nav.setDevices([
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
    ]);
    emitDeviceChange();
    await new Promise((r) => setTimeout(r, 10));

    expect(inputSelect.querySelectorAll("option").length).toBe(2);
  });

  it("populates device lists from enumerateDevices", async () => {
    stubNavigator([
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" },
      { kind: "videoinput", deviceId: "cam-1", label: "Cam 1" },
    ]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Wait for async device enumeration
    await vi.waitFor(() => {
      const selects = el.querySelectorAll("select");
      const inputSelect = selects[0];
      // Default + 2 mics = 3 options
      expect(inputSelect!.querySelectorAll("option").length).toBe(3);
    });

    const selects = el.querySelectorAll("select");
    const outputSelect = selects[1]!;
    // Default + 1 speaker = 2 options
    expect(outputSelect.querySelectorAll("option").length).toBe(2);

    ac.abort();
  });

  // Owner's report 2026-10-08: after an unplug and replug the call kept the
  // webcam mic while the list said only "Default".
  it("names the device the call captures next to a saved Default microphone", async () => {
    mockGetLocalMicSettings.mockReturnValue({ deviceId: "default", groupId: "g-webcam" });
    stubNavigator([
      { kind: "audioinput", deviceId: "default", label: "Default - USB Mic", groupId: "g-usb" },
      { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic", groupId: "g-usb" },
      { kind: "audioinput", deviceId: "webcam-mic", label: "Webcam Mic", groupId: "g-webcam" },
    ]);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => expect(inputSelect.options[0]!.text).toBe("Default (Webcam Mic)"));
    mockGetLocalMicSettings.mockReturnValue(null);
    ac.abort();
  });

  it("shows a plain Default while a named microphone is saved", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("usb-mic"));
    mockGetLocalMicSettings.mockReturnValue({ deviceId: "usb-mic", groupId: "g-usb" });
    stubNavigator([
      { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic", groupId: "g-usb" },
    ]);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => expect(inputSelect.options.length).toBe(2));
    expect(inputSelect.options[0]!.text).toBe("Default");
    mockGetLocalMicSettings.mockReturnValue(null);
    ac.abort();
  });

  it("refreshes the Default label once the session has moved the capture", async () => {
    vi.useFakeTimers();
    try {
      mockGetLocalMicSettings.mockReturnValue({ deviceId: "webcam-mic", groupId: "g-webcam" });
      stubNavigator([
        { kind: "audioinput", deviceId: "usb-mic", label: "USB Mic", groupId: "g-usb" },
        { kind: "audioinput", deviceId: "webcam-mic", label: "Webcam Mic", groupId: "g-webcam" },
      ]);
      const ac = new AbortController();
      const el = createVoiceAudioTab(ac.signal).build();
      document.body.appendChild(el);
      const inputSelect = el.querySelectorAll("select")[0]!;
      await vi.advanceTimersByTimeAsync(0);
      expect(inputSelect.options[0]!.text).toBe("Default (Webcam Mic)");

      emitDeviceChange();
      mockGetLocalMicSettings.mockReturnValue({ deviceId: "usb-mic", groupId: "g-usb" });
      await vi.advanceTimersByTimeAsync(1500);
      expect(inputSelect.options[0]!.text).toBe("Default (USB Mic)");
      mockGetLocalMicSettings.mockReturnValue(null);
      ac.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a plain Default label when no call captures the microphone", async () => {
    stubNavigator([{ kind: "audioinput", deviceId: "usb-mic", label: "USB Mic", groupId: "g" }]);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const inputSelect = el.querySelectorAll("select")[0]!;
    await vi.waitFor(() => expect(inputSelect.options.length).toBe(2));
    expect(inputSelect.options[0]!.text).toBe("Default");
    ac.abort();
  });

  it("input device change calls switchInputDevice and saves pref", async () => {
    stubNavigator([{ kind: "audioinput", deviceId: "mic-1", label: "Mic 1" }]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const selects = el.querySelectorAll("select");
      expect(selects[0]!.querySelectorAll("option").length).toBeGreaterThan(1);
    });

    const inputSelect = el.querySelectorAll("select")[0] as HTMLSelectElement;
    inputSelect.value = "mic-1";
    inputSelect.dispatchEvent(new Event("change"));

    expect(mockSwitchInputDevice).toHaveBeenCalledWith("mic-1");
    ac.abort();
  });

  it("output device change calls switchOutputDevice and saves pref", async () => {
    stubNavigator([{ kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" }]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const selects = el.querySelectorAll("select");
      expect(selects[1]!.querySelectorAll("option").length).toBeGreaterThan(1);
    });

    const outputSelect = el.querySelectorAll("select")[1] as HTMLSelectElement;
    outputSelect.value = "spk-1";
    outputSelect.dispatchEvent(new Event("change"));

    expect(mockSwitchOutputDevice).toHaveBeenCalledWith("spk-1");
    ac.abort();
  });

  it("camera quality select saves to preferences on change", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const qualitySelect = el.querySelector(
      'select[aria-label="Camera Quality"]',
    ) as HTMLSelectElement;
    expect(qualitySelect.value).toBe("medium");
    qualitySelect.value = "low";
    qualitySelect.dispatchEvent(new Event("change"));

    const saved = localStorage.getItem("owncord:settings:streamQuality");
    expect(saved).toBe('"low"');
    expect(localStorage.getItem("owncord:settings:screenShareQuality")).toBeNull();
    ac.abort();
  });

  it("screen share quality select defaults to medium and saves its own pref", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const qualitySelect = el.querySelector(
      'select[aria-label="Screen Share Quality"]',
    ) as HTMLSelectElement;
    expect(qualitySelect.value).toBe("medium");
    qualitySelect.value = "high";
    qualitySelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("owncord:settings:screenShareQuality")).toBe('"high"');
    expect(localStorage.getItem("owncord:settings:streamQuality")).toBeNull();
    ac.abort();
  });

  it("screen share fps select persists the preference as a number", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Screen share FPS is the 4th select (index 3)
    const fpsSelect = el.querySelector(
      'select[aria-label="Screen Share FPS"]',
    ) as HTMLSelectElement;
    expect(fpsSelect.value).toBe("30"); // default
    fpsSelect.value = "60";
    fpsSelect.dispatchEvent(new Event("change"));

    const saved = localStorage.getItem("owncord:settings:screenShareFps");
    expect(saved).toBe("60");
    ac.abort();
  });

  it("video codec select offers VP8, H.264 and Auto, defaults to VP8 and saves the choice", () => {
    stubNavigator();
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const codecSelect = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
    expect([...codecSelect.options].map((o) => o.value)).toEqual(["vp8", "h264", "auto"]);
    expect(codecSelect.value).toBe("vp8");
    codecSelect.value = "auto";
    codecSelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("owncord:settings:videoCodec")).toBe('"auto"');
    ac.abort();
  });

  it("warns under the video codec choice that H.264 does not work from Intel graphics yet", () => {
    stubNavigator();
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    const codecSelect = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;

    const warning = codecSelect.nextElementSibling;
    expect(warning?.classList.contains("setting-desc")).toBe(true);
    expect(warning?.textContent).toBe(
      "H.264 from Intel graphics cannot be played by viewers yet. Auto avoids it.",
    );
    ac.abort();
  });

  it("video codec select shows the saved choice, and VP8 for an unknown one", () => {
    stubNavigator();
    localStorage.setItem("owncord:settings:videoCodec", '"h264"');
    const ac = new AbortController();
    let el = createVoiceAudioTab(ac.signal).build();
    expect((el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement).value).toBe(
      "h264",
    );

    localStorage.setItem("owncord:settings:videoCodec", '"av1"');
    el = createVoiceAudioTab(ac.signal).build();
    expect((el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement).value).toBe(
      "vp8",
    );
    ac.abort();
  });

  describe("device and processing cards", () => {
    function build(): { el: HTMLDivElement; ac: AbortController } {
      stubNavigator();
      const ac = new AbortController();
      const el = createVoiceAudioTab(ac.signal).build();
      document.body.appendChild(el);
      return { el, ac };
    }
    const cardNamed = (el: HTMLElement, title: string): HTMLElement =>
      [...el.querySelectorAll<HTMLElement>("section.settings-card")].find(
        (c) => c.querySelector(".settings-card-head h3")!.textContent === title,
      )!;

    it("groups the tab into Input Mode, Microphone, Speakers, Camera & screen share and Voice processing", () => {
      const { el, ac } = build();
      const titles = [...el.querySelectorAll(".settings-card-head h3")].map((h) => h.textContent);
      expect(titles).toEqual([
        "Input Mode",
        "Microphone",
        "Speakers",
        "Camera & screen share",
        "Voice processing",
      ]);
      const mic = cardNamed(el, "Microphone");
      expect(mic.querySelector('select[aria-label="Input Device"]')).not.toBeNull();
      expect(mic.querySelector('input[aria-label="Input Volume"]')).not.toBeNull();
      expect(mic.querySelector(".mic-meter-threshold")).not.toBeNull();
      const speakers = cardNamed(el, "Speakers");
      expect(speakers.querySelector('select[aria-label="Output Device"]')).not.toBeNull();
      expect(speakers.querySelector('input[aria-label="Output Volume"]')).not.toBeNull();
      const camera = cardNamed(el, "Camera & screen share");
      for (const name of [
        "Video Device",
        "Camera Quality",
        "Screen Share Quality",
        "Screen Share FPS",
        "Video Codec",
      ]) {
        expect(camera.querySelector(`select[aria-label="${name}"]`), name).not.toBeNull();
      }
      expect(camera.querySelector("video")).not.toBeNull();
      expect(cardNamed(el, "Voice processing").querySelectorAll(".toggle")).toHaveLength(4);
      ac.abort();
    });

    it("nests Enhanced Noise Suppression under the Noise Suppression it builds on", () => {
      const { el, ac } = build();
      const labels = [...cardNamed(el, "Voice processing").querySelectorAll(".setting-label")].map(
        (l) => l.textContent,
      );
      expect(labels).toEqual([
        "Echo Cancellation",
        "Noise Suppression",
        "Enhanced Noise Suppression",
        "Automatic Gain Control",
      ]);
      const enhanced = el
        .querySelector('.toggle[aria-label="Enhanced Noise Suppression"]')!
        .closest(".setting-row")!;
      expect(enhanced.classList.contains("nested")).toBe(true);
      ac.abort();
    });

    it("labels the camera preview Camera off until a camera is chosen", () => {
      const { el, ac } = build();
      const label = el.querySelector<HTMLElement>(".camera-preview-label")!;
      expect(label.textContent).toBe("Camera off");
      expect(label.hidden).toBe(false);
      ac.abort();
    });

    it("states the input sensitivity beside the meter, and follows the handle", () => {
      localStorage.setItem("owncord:settings:voiceSensitivity", "50");
      localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
      const { el, ac } = build();
      const value = el.querySelector<HTMLElement>("[data-testid='sensitivity-value']")!;
      expect(value.textContent).toBe("50%");
      el.querySelector(".mic-meter-threshold")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      expect(value.textContent).toBe("45%");
      ac.abort();
    });

    describe("automatic sensitivity", () => {
      const autoToggle = (el: HTMLElement): HTMLElement =>
        el.querySelector<HTMLElement>("[data-testid='auto-sensitivity'] .toggle")!;
      const handleOf = (el: HTMLElement): HTMLElement =>
        el.querySelector<HTMLElement>(".mic-meter-threshold")!;
      const valueOf = (el: HTMLElement): HTMLElement =>
        el.querySelector<HTMLElement>("[data-testid='sensitivity-value']")!;

      it("is on for a fresh profile: the meter stays, the handle and value hide", () => {
        const { el, ac } = build();
        expect(autoToggle(el).getAttribute("aria-checked")).toBe("true");
        expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(false);
        expect(handleOf(el).hidden).toBe(true);
        expect(valueOf(el).hidden).toBe(true);
        ac.abort();
      });

      it("keeps a tuned slider manual, with its handle at the saved value", () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "30");
        const { el, ac } = build();
        expect(autoToggle(el).getAttribute("aria-checked")).toBe("false");
        expect(handleOf(el).hidden).toBe(false);
        expect(valueOf(el).textContent).toBe("30%");
        ac.abort();
      });

      it("turning it off shows the slider at the saved value and re-runs the call's gate", () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "50");
        const { el, ac } = build();
        mockApplyInputMode.mockClear();

        autoToggle(el).click();

        expect(localStorage.getItem("owncord:settings:autoInputSensitivity")).toBe("false");
        expect(handleOf(el).hidden).toBe(false);
        expect(valueOf(el).hidden).toBe(false);
        expect(handleOf(el).style.left).toBe("50%");
        expect(mockApplyInputMode).toHaveBeenCalledTimes(1);
        ac.abort();
      });

      it("a click on the meter does not move a threshold it does not show", () => {
        const { el, ac } = build();
        el.querySelector(".mic-meter-bar")!.dispatchEvent(new MouseEvent("click", { clientX: 0 }));
        expect(mockSetVoiceSensitivity).not.toHaveBeenCalled();
        ac.abort();
      });

      it("runs the meter's detector on the automatic threshold, and back on the slider's", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "50");
        const { el, ac } = build();
        await vi.waitFor(() =>
          expect(FakeAudioWorkletNode.instances.some((w) => w.name === "vad-processor")).toBe(true),
        );
        const worklet = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;
        // Before the first estimate, auto gates at the default threshold.
        expect(worklet.port.postMessage).toHaveBeenCalledWith({
          type: "config",
          threshold: vadThreshold(50),
        });
        vi.useFakeTimers({ toFake: ["performance"] });
        try {
          // A quiet room (-60 dBFS) for over a second: the gate moves to
          // 10 dB above it, without resetting the gate.
          worklet.emit({ type: "rms", value: 0.001 });
          vi.advanceTimersByTime(1100);
          worklet.emit({ type: "rms", value: 0.001 });
          const moved = worklet.port.postMessage.mock.calls.at(-1)![0] as {
            type: string;
            threshold: number;
          };
          expect(moved.type).toBe("threshold");
          expect(moved.threshold).toBeCloseTo(0.001 * 10 ** 0.5, 6);
        } finally {
          vi.useRealTimers();
        }

        autoToggle(el).click();
        expect(worklet.port.postMessage).toHaveBeenLastCalledWith({
          type: "config",
          threshold: vadThreshold(50),
        });
        ac.abort();
      });
    });

    it("shows the microphone's state as a pill: no input while the meter hears nothing", async () => {
      const { el, ac } = build();
      const pill = el.querySelector<HTMLElement>("[data-testid='mic-status']")!;
      expect(pill.hidden).toBe(true);
      await vi.waitFor(() =>
        expect(FakeAudioWorkletNode.instances.some((w) => w.name === "vad-processor")).toBe(true),
      );
      FakeAudioWorkletNode.instances
        .find((w) => w.name === "vad-processor")!
        .emit({
          type: "rms",
          value: 0,
        });
      expect(pill.textContent).toBe("No input");
      expect(pill.querySelector(".st-ic.st-pending")).not.toBeNull();
      ac.abort();
    });

    describe("meter and pill against the detector's reports", () => {
      // The meter's detector is the gate's own worklet (vad-worklet.js, whose
      // attack and hold tests/unit/vad-worklet-click.test.ts covers); here
      // its port is driven directly.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["performance"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Build the tab and wait for its detector worklet. */
      async function meter(): Promise<{
        el: HTMLDivElement;
        ac: AbortController;
        worklet: FakeAudioWorkletNode;
      }> {
        const built = build();
        await vi.waitFor(() =>
          expect(FakeAudioWorkletNode.instances.some((w) => w.name === "vad-processor")).toBe(true),
        );
        const worklet = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;
        return { ...built, worklet };
      }
      const pillOf = (el: HTMLElement): HTMLElement =>
        el.querySelector<HTMLElement>("[data-testid='mic-status']")!;
      const meterOf = (el: HTMLElement): HTMLElement =>
        el.querySelector<HTMLElement>(".mic-meter-level")!;

      it("configures the detector with the live gate's threshold for the saved sensitivity", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "30");
        const { worklet, ac } = await meter();
        expect(worklet.port.postMessage).toHaveBeenCalledWith({
          type: "config",
          threshold: vadThreshold(30),
        });
        ac.abort();
      });

      it("meters the microphone after Input Volume, as the live gate does", async () => {
        localStorage.setItem("owncord:settings:inputVolume", "150");
        const { el, ac } = await meter();
        const entry = () =>
          FakeAudioContext.instances.at(-1)!.nodes.find((n) => n.kind === "gain")!.gain;
        await vi.waitFor(() => expect(entry().value).toBe(1.5));

        const slider = el.querySelector<HTMLInputElement>('input[aria-label="Input Volume"]')!;
        slider.value = "50";
        slider.dispatchEvent(new Event("input"));
        expect(entry().value).toBe(0.5);
        ac.abort();
      });

      it("says No input for a silent mic even at sensitivity 100", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "100");
        const { el, worklet, ac } = await meter();
        worklet.emit({ type: "rms", value: 0 });
        expect(pillOf(el).textContent).toBe("No input");
        ac.abort();
      });

      it("says Hearing you for speech the gate rejects, while the meter stays yellow", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "0");
        const { el, worklet, ac } = await meter();
        // RMS 0.05: above the noise floor, below the 0.1 gate at sensitivity 0.
        worklet.emit({ type: "gate", gated: true });
        worklet.emit({ type: "rms", value: 0.05 });
        expect(pillOf(el).textContent).toBe("Hearing you");
        expect(pillOf(el).querySelector(".st-ic.st-ok")).not.toBeNull();
        expect(meterOf(el).style.background).toBe("var(--yellow)");
        ac.abort();
      });

      // DP-38: the meter used a frequency-domain level against a x0.15
      // threshold while the live gate compares a time-domain RMS against
      // x0.1, and turned green on one loud frame while the gate needs a
      // sustained level. Now the gate's own verdict colours it.
      it("is green exactly while the gate is open", async () => {
        const { el, worklet, ac } = await meter();
        expect(meterOf(el).style.background).toBe("");
        worklet.emit({ type: "gate", gated: true });
        expect(meterOf(el).style.background).toBe("var(--yellow)");
        worklet.emit({ type: "gate", gated: false });
        expect(meterOf(el).style.background).toBe("var(--green)");
        ac.abort();
      });

      it("draws the level on the threshold handle's own axis", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "50");
        localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
        const { el, worklet, ac } = await meter();
        const handle = el.querySelector<HTMLElement>(".mic-meter-threshold")!;
        expect(handle.style.left).toBe("50%");
        // A level equal to the threshold reaches the handle, no further.
        worklet.emit({ type: "rms", value: 0.05 });
        expect(meterOf(el).style.width).toBe("50%");
        worklet.emit({ type: "rms", value: 0.025 });
        expect(meterOf(el).style.width).toBe("25%");
        worklet.emit({ type: "rms", value: 0.4 });
        expect(meterOf(el).style.width).toBe("100%");
        ac.abort();
      });

      it("moves the detector's threshold as the handle is dragged, without reopening the mic", async () => {
        localStorage.setItem("owncord:settings:voiceSensitivity", "50");
        localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
        const { el, worklet, ac } = await meter();
        const handle = el.querySelector<HTMLElement>(".mic-meter-threshold")!;

        handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

        expect(el.querySelector("[data-testid='sensitivity-value']")!.textContent).toBe("45%");
        expect(worklet.port.postMessage).toHaveBeenLastCalledWith({
          type: "config",
          threshold: vadThreshold(45),
        });
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
        ac.abort();
      });

      it("holds Hearing you through a short pause, then says No input", async () => {
        const { el, worklet, ac } = await meter();
        worklet.emit({ type: "rms", value: 0.2 });
        expect(pillOf(el).textContent).toBe("Hearing you");
        vi.advanceTimersByTime(900);
        worklet.emit({ type: "rms", value: 0 });
        expect(pillOf(el).textContent).toBe("Hearing you");
        vi.advanceTimersByTime(200);
        worklet.emit({ type: "rms", value: 0 });
        expect(pillOf(el).textContent).toBe("No input");
        ac.abort();
      });
    });
  });

  it("contains audio processing toggles", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const settingRows = el.querySelectorAll(
      ".setting-row:not([data-testid='auto-sensitivity']):not([data-testid='mic-test']):not([data-testid='auto-play-cameras'])",
    );
    // 4 toggles: echo cancellation, noise suppression, auto gain control, enhanced NS
    expect(settingRows.length).toBe(4);
    ac.abort();
  });

  it("Automatically play cameras is on by default and saves its choice (WP 1B-3)", () => {
    stubNavigator();
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const toggle = el.querySelector<HTMLElement>("[data-testid='auto-play-cameras'] .toggle")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Automatically play cameras");
    toggle.click();
    expect(localStorage.getItem("owncord:settings:autoPlayCameras")).toBe("false");
    ac.abort();
  });

  it("audio toggle calls reapplyAudioProcessing when changed", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Toggles are divs with class "toggle" (not buttons)
    const toggleDiv = el.querySelector(
      ".setting-row:not([data-testid='auto-sensitivity']):not([data-testid='auto-play-cameras']) .toggle",
    ) as HTMLElement;
    expect(toggleDiv).not.toBeNull();
    toggleDiv.click();

    expect(mockReapplyAudioProcessing).toHaveBeenCalled();
    ac.abort();
  });

  // The meter has to hear what the call captures: the browser's gain control
  // and noise suppression change the level the gate sees, and a second stream
  // on the same device with other settings can override the call's own.
  it("opens the meter's microphone with the call's processing settings and device", async () => {
    localStorage.setItem("owncord:settings:echoCancellation", "false");
    localStorage.setItem("owncord:settings:noiseSuppression", "false");
    localStorage.setItem("owncord:settings:audioInputDevice", '"mic-2"');
    stubNavigator();
    const ac = new AbortController();
    document.body.appendChild(createVoiceAudioTab(ac.signal).build());

    await vi.waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          voiceIsolation: false,
          deviceId: { exact: "mic-2" },
        },
        video: false,
      }),
    );
    ac.abort();
  });

  it("reopens the meter's microphone when a processing toggle changes", async () => {
    const stop = vi.fn();
    stubNavigator();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({
      getTracks: () => [{ stop, kind: "audio" }],
      getAudioTracks: () => [{ stop, kind: "audio" }],
    } as unknown as MediaStream);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
    const audioRequests = () =>
      vi
        .mocked(navigator.mediaDevices.getUserMedia)
        .mock.calls.map(([c]) => c?.audio)
        .filter((audio) => audio !== false && audio !== undefined);
    await vi.waitFor(() => expect(audioRequests()).toHaveLength(1));

    el.querySelector<HTMLElement>("[role='switch'][aria-label='Noise Suppression']")!.click();

    await vi.waitFor(() => expect(audioRequests()).toHaveLength(2));
    expect(audioRequests()[1]).toMatchObject({ noiseSuppression: false });
    // The first stream is released; the second is the one now metering.
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    ac.abort();
  });

  it("re-routes the call and the meter through RNNoise on the Enhanced NS toggle, reopening no microphone", async () => {
    stubNavigator();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
    await vi.waitFor(() =>
      expect(FakeAudioWorkletNode.instances.some((w) => w.name === "vad-processor")).toBe(true),
    );
    const requests = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.length;

    el.querySelector<HTMLElement>(
      "[role='switch'][aria-label='Enhanced Noise Suppression']",
    )!.click();

    await vi.waitFor(() =>
      expect(FakeAudioWorkletNode.instances.some((w) => w.name === "rnnoise-processor")).toBe(true),
    );
    expect(mockReapplyEnhancedNoiseSuppression).toHaveBeenCalledTimes(1);
    expect(mockReapplyAudioProcessing).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(requests);
    ac.abort();
  });

  it("moves the meter to a newly chosen input device", async () => {
    stubNavigator([{ kind: "audioinput", deviceId: "mic-2", label: "Mic 2" }]);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
    const inputSelect = el.querySelector<HTMLSelectElement>('select[aria-label="Input Device"]')!;
    await vi.waitFor(() => expect(inputSelect.options.length).toBe(2));

    inputSelect.value = "mic-2";
    inputSelect.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          audio: expect.objectContaining({ deviceId: { exact: "mic-2" } }),
        }),
      ),
    );
    ac.abort();
  });

  it("handles enumerateDevices failure gracefully", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockRejectedValue(new Error("permission denied")),
        getUserMedia: vi.fn().mockRejectedValue(new Error("permission denied")),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const inputSelect = el.querySelectorAll("select")[0]!;
      const options = inputSelect.querySelectorAll("option");
      // Should have default + error option
      const texts = Array.from(options).map((o) => o.textContent);
      expect(texts.some((t) => t?.includes("Could not enumerate"))).toBe(true);
    });

    expectConsole("warn", /\[VoiceAudioTab\] Mic access denied or unavailable/);
    ac.abort();
  });

  it("does not start camera preview when no video device is saved", () => {
    stubNavigator();
    // Do NOT set videoInputDevice in localStorage
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const preview = el.querySelector("video") as HTMLVideoElement;
    // srcObject is undefined in JSDOM when never assigned (not null)
    expect(preview.srcObject).toBeFalsy();
    ac.abort();
  });

  it("starts camera preview when a video device is saved", async () => {
    localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');
    const cameraStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: "videoinput", deviceId: "cam-1", label: "Camera 1" }]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return Promise.resolve(cameraStream);
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const preview = el.querySelector("video") as HTMLVideoElement;
      expect(preview.srcObject).toBe(cameraStream);
    });
    ac.abort();
  });

  it("video select change starts camera preview", async () => {
    const cameraStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: "videoinput", deviceId: "cam-1", label: "Camera 1" }]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return Promise.resolve(cameraStream);
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Wait for devices to load
    await vi.waitFor(() => {
      const videoSelect = el.querySelector(
        'select[aria-label="Video Device"]',
      ) as HTMLSelectElement;
      expect(videoSelect.querySelectorAll("option").length).toBeGreaterThan(1);
    });

    const videoSelect = el.querySelector('select[aria-label="Video Device"]') as HTMLSelectElement;
    videoSelect.value = "cam-1";
    videoSelect.dispatchEvent(new Event("change"));
    // A live camera in a call moves to the picked device too.
    expect(mockSwitchVideoDevice).toHaveBeenCalledWith("cam-1");

    await vi.waitFor(() => {
      const preview = el.querySelector("video") as HTMLVideoElement;
      expect(preview.srcObject).toBe(cameraStream);
    });

    ac.abort();
  });

  it("a pick the live camera could not use shows the camera it kept", async () => {
    const stream = (label: string) =>
      ({
        label,
        getTracks: () => [{ stop: vi.fn(), kind: "video" }],
        getAudioTracks: () => [],
      }) as unknown as MediaStream;
    const cam1 = stream("cam-1");
    const getUserMedia = vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
      const video = constraints.video as { deviceId?: { exact: string } } | false | undefined;
      if (video && constraints.audio === false) {
        return Promise.resolve(video.deviceId?.exact === "cam-1" ? cam1 : stream("other"));
      }
      return Promise.resolve(stream("audio"));
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "cam-1", label: "Camera 1" },
          { kind: "videoinput", deviceId: "cam-2", label: "Camera 2" },
        ]),
        getUserMedia,
      },
    });
    // The call's camera stays on cam-1: the saved choice goes back to it.
    mockSwitchVideoDevice.mockImplementationOnce(async () => {
      localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');
    });

    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
    const videoSelect = await vi.waitFor(() => {
      const select = el.querySelector('select[aria-label="Video Device"]') as HTMLSelectElement;
      expect(select.querySelectorAll("option").length).toBeGreaterThan(2);
      return select;
    });

    videoSelect.value = "cam-2";
    videoSelect.dispatchEvent(new Event("change"));
    expect(mockSwitchVideoDevice).toHaveBeenCalledWith("cam-2");
    await vi.waitFor(() => {
      expect(videoSelect.value).toBe("cam-1");
      expect((el.querySelector("video") as HTMLVideoElement).srcObject).toBe(cam1);
    });
    ac.abort();
  });

  it("camera preview shows error when getUserMedia fails", async () => {
    localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');
    const audioStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([{ kind: "videoinput", deviceId: "cam-1", label: "Camera 1" }]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return Promise.reject(new Error("Camera access denied"));
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const label = el.querySelector<HTMLElement>(".camera-preview-label")!;
    await vi.waitFor(() => expect(label.textContent).toBe("Camera access denied"));
    expect(label.hidden).toBe(false);

    ac.abort();
  });

  it("camera preview falls back to Camera unavailable when the error has no message", async () => {
    // An unplugged saved camera rejects with OverconstrainedError, whose message is "".
    localStorage.setItem("owncord:settings:videoInputDevice", '"gone-camera-id"');
    const audioStream = {
      getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
      getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return Promise.reject(Object.assign(new Error(""), { name: "OverconstrainedError" }));
          }
          return Promise.resolve(audioStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const label = el.querySelector<HTMLElement>(".camera-preview-label")!;
    await vi.waitFor(() => expect(label.textContent).toBe("Camera unavailable"));
    expect(label.hidden).toBe(false);

    ac.abort();
  });

  it("sensitivity threshold handle is positioned based on saved sensitivity", () => {
    localStorage.setItem("owncord:settings:voiceSensitivity", "75");
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const threshold = el.querySelector(".mic-meter-threshold") as HTMLElement;
    expect(threshold).not.toBeNull();
    // Sensitivity 75 -> 100 - 75 = 25%
    expect(threshold.style.left).toBe("25%");
    ac.abort();
  });

  it("keyboard moves the threshold handle the way the key points", () => {
    localStorage.setItem("owncord:settings:voiceSensitivity", "50");
    localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const threshold = el.querySelector(".mic-meter-threshold") as HTMLElement;
    const press = (key: string): void => {
      threshold.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    expect(threshold.getAttribute("aria-valuenow")).toBe("50");

    press("ArrowRight");
    expect(threshold.style.left).toBe("55%");
    expect(threshold.getAttribute("aria-valuenow")).toBe("55");
    expect(threshold.getAttribute("aria-valuetext")).toBe("Sensitivity 45%");
    expect(mockSetVoiceSensitivity).toHaveBeenLastCalledWith(45);

    press("Home");
    expect(threshold.style.left).toBe("0%");
    expect(threshold.getAttribute("aria-valuenow")).toBe("0");
    expect(mockSetVoiceSensitivity).toHaveBeenLastCalledWith(100);

    press("End");
    expect(threshold.style.left).toBe("100%");
    expect(threshold.getAttribute("aria-valuenow")).toBe("100");
    expect(threshold.getAttribute("aria-valuetext")).toBe("Sensitivity 0%");
    expect(mockSetVoiceSensitivity).toHaveBeenLastCalledWith(0);
    ac.abort();
  });

  it("clicking the meter bar calls setVoiceSensitivity", () => {
    localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const meterBar = el.querySelector(".mic-meter-bar") as HTMLElement;
    expect(meterBar).not.toBeNull();

    // Simulate click at middle of bar — getBoundingClientRect returns 0,0
    // so clientX=0, ratio=0, sensitivity=100 (1-0)*100
    meterBar.dispatchEvent(new MouseEvent("click", { clientX: 0 }));

    expect(mockSetVoiceSensitivity).toHaveBeenCalled();
    ac.abort();
  });

  it("stops applying sensitivity after a pointercancel interrupts the drag (v097)", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const threshold = el.querySelector(".mic-meter-threshold") as HTMLElement;
    expect(threshold).not.toBeNull();
    // jsdom doesn't implement the Pointer Capture API — stub it as a no-op,
    // same as a real browser call the handler makes unconditionally.
    (threshold as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
      vi.fn();

    threshold.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0 }));
    mockSetVoiceSensitivity.mockClear();

    threshold.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 10 }));

    // The OS claims the touch gesture as a pan and fires pointercancel
    // instead of pointerup; the value the handle shows is applied then.
    threshold.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(mockSetVoiceSensitivity).toHaveBeenCalledTimes(1);
    const handlePosition = threshold.style.left;

    mockSetVoiceSensitivity.mockClear();
    threshold.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 50 }));
    threshold.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

    // Without a pointercancel listener, onMove stays attached and this
    // would move the handle and apply sensitivity again with no button held.
    expect(threshold.style.left).toBe(handlePosition);
    expect(mockSetVoiceSensitivity).not.toHaveBeenCalled();

    ac.abort();
  });

  it("applies and persists sensitivity once per drag, on release", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const meterBar = el.querySelector(".mic-meter-bar") as HTMLElement;
    const threshold = el.querySelector(".mic-meter-threshold") as HTMLElement;
    (threshold as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
      vi.fn();
    vi.spyOn(meterBar, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 200,
    } as DOMRect);

    threshold.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 0 }));
    for (let x = 1; x <= 200; x++) {
      threshold.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x }));
    }

    expect(threshold.getAttribute("aria-valuetext")).toBe("Sensitivity 0%");
    expect(mockSetVoiceSensitivity).not.toHaveBeenCalled();

    threshold.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));

    expect(mockSetVoiceSensitivity).toHaveBeenCalledTimes(1);
    expect(mockSetVoiceSensitivity).toHaveBeenCalledWith(0);
    expect(localStorage.getItem("owncord:settings:voiceSensitivity")).toBe("0");

    ac.abort();
  });

  it("mic level monitoring handles getUserMedia failure gracefully", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockRejectedValue(new Error("mic denied")),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Should not throw — mic meter stays empty, and the pill says why.
    await new Promise((r) => setTimeout(r, 0));
    expectConsole("warn", /\[VoiceAudioTab\] Mic access denied or unavailable/);
    const pill = el.querySelector<HTMLElement>("[data-testid='mic-status']")!;
    expect(pill.textContent).toBe("No microphone access");
    expect(pill.querySelector(".st-ic.st-warn")).not.toBeNull();
    ac.abort();
  });

  it("restores saved device selections from localStorage", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", '"mic-2"');
    localStorage.setItem("owncord:settings:audioOutputDevice", '"spk-2"');
    stubNavigator([
      { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
      { kind: "audiooutput", deviceId: "spk-2", label: "Speaker 2" },
    ]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const selects = el.querySelectorAll("select");
      expect((selects[0] as HTMLSelectElement).value).toBe("mic-2");
      expect((selects[1] as HTMLSelectElement).value).toBe("spk-2");
    });

    ac.abort();
  });

  it("uses device ID fallback label for devices without labels", async () => {
    stubNavigator([{ kind: "audioinput", deviceId: "abcdef12", label: "" }]);
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    await vi.waitFor(() => {
      const inputSelect = el.querySelectorAll("select")[0]!;
      const options = inputSelect.querySelectorAll("option");
      expect(options.length).toBe(2); // default + 1 device
      expect(options[1]!.textContent).toContain("Microphone");
    });

    ac.abort();
  });

  it("cleanup stops mic and camera streams", async () => {
    // A saved video device is required for the camera preview to start at all.
    localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');

    const stopMicTrack = vi.fn();
    const stopCamTrack = vi.fn();
    const micStream = {
      getTracks: () => [{ stop: stopMicTrack, kind: "audio" }],
      getAudioTracks: () => [{ stop: stopMicTrack, kind: "audio" }],
    } as unknown as MediaStream;
    const camStream = {
      getTracks: () => [{ stop: stopCamTrack, kind: "audio" }],
      getAudioTracks: () => [{ stop: stopCamTrack, kind: "audio" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
          if (constraints.video && constraints.audio === false) {
            return Promise.resolve(camStream);
          }
          return Promise.resolve(micStream);
        }),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);
    const preview = el.querySelector("video") as HTMLVideoElement;

    // Wait for both the mic-monitoring and camera-preview getUserMedia calls to
    // resolve and register their streams before triggering cleanup.
    await vi.waitFor(() => {
      expect(preview.srcObject).toBe(camStream);
    });

    tab.cleanup();

    expect(stopMicTrack).toHaveBeenCalled();
    expect(stopCamTrack).toHaveBeenCalled();

    ac.abort();
  });

  // Chrome keeps a detached media element that still has a source among its
  // pending activities, and the element keeps its whole pane alive: the
  // long-session soak caught a torn-down pane (~530 DOM nodes) held that way
  // for the rest of the page. Stopping the tracks alone does not release it.
  type Teardown = (tab: ReturnType<typeof createVoiceAudioTab>, ac: AbortController) => void;
  it.each<[string, Teardown]>([
    ["cleanup (tab switch or overlay close)", (tab) => tab.cleanup()],
    ["overlay abort", (_tab, ac) => ac.abort()],
  ])("detaches the camera preview from its stream on %s", async (_label, teardown) => {
    localStorage.setItem("owncord:settings:videoInputDevice", '"cam-1"');
    const camStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const micStream = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi
          .fn()
          .mockImplementation((constraints: MediaStreamConstraints) =>
            Promise.resolve(
              constraints.video && constraints.audio === false ? camStream : micStream,
            ),
          ),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);
    const preview = el.querySelector("video") as HTMLVideoElement;
    await vi.waitFor(() => {
      expect(preview.srcObject).toBe(camStream);
    });

    teardown(tab, ac);

    expect(preview.srcObject).toBeNull();
    ac.abort();
  });

  it("restores saved camera and screen share quality selections", () => {
    localStorage.setItem("owncord:settings:streamQuality", '"low"');
    localStorage.setItem("owncord:settings:screenShareQuality", '"source"');
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const qualitySelect = el.querySelector(
      'select[aria-label="Camera Quality"]',
    ) as HTMLSelectElement;
    expect(qualitySelect.value).toBe("low");
    const screenSelect = el.querySelector(
      'select[aria-label="Screen Share Quality"]',
    ) as HTMLSelectElement;
    expect(screenSelect.value).toBe("source");
    ac.abort();
  });

  it("rebuild cleans up previous mic/camera before building again", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    tab.build();
    // Calling build again should not throw
    expect(() => tab.build()).not.toThrow();
    ac.abort();
  });

  it("does not register a new permanent abort listener on every rebuild (OC-0125)", () => {
    // Simulates the settings overlay staying open for a session while the
    // user re-opens the Voice & Video tab (e.g. hide()/show() cycles):
    // SettingsOverlay's single AbortController lives for the whole session,
    // and build() is called again each time the tab is (re)rendered.
    stubNavigator();
    const ac = new AbortController();
    const addEventListenerSpy = vi.spyOn(ac.signal, "addEventListener");
    const abortListenerCount = (): number =>
      addEventListenerSpy.mock.calls.filter(([type]) => type === "abort").length;

    const tab = createVoiceAudioTab(ac.signal);

    // The first build may add jsdom's single internal bookkeeping listener
    // for `{ signal }`-scoped DOM listeners; snapshot after it so the
    // assertion isolates listener growth caused by rebuilds.
    tab.build();
    const afterFirstBuild = abortListenerCount();

    tab.build();
    tab.build();
    tab.build();

    // Rebuilding the tab three times must not add three more permanent
    // "abort" listeners to the overlay-lifetime signal — only the single
    // listener the factory registers once at creation should exist.
    expect(abortListenerCount()).toBe(afterFirstBuild);

    ac.abort();
  });
});

describe("VoiceAudioTab on the Linux native audio engine", () => {
  const getUserMedia = vi.fn();
  const startCameraPreview = vi.fn();
  const stopCameraPreview = vi.fn();
  const nativeCameraDevices = vi.fn();
  const nativeCameraSupport = vi.fn();
  const nativeVideoCodecs = vi.fn();
  const startMicTest = vi.fn();
  /** The meter's capture-only monitor, which shares the host's start command. */
  const startMonitor = vi.fn();
  const updateMicTest = vi.fn();
  const stopMicTest = vi.fn();
  const onMicTestEvent = vi.fn();
  const onNativeDevicesChanged = vi.fn();
  /** What the host's playout list calls its device; a test renames it to
   *  stand for a plug or unplug. */
  let speakersLabel = "Speakers";
  const unsubscribeNative = vi.fn();
  const unsubscribeTest = vi.fn();
  /** The mic test's event handler, as the host would call it. */
  let testHandler: ((envelope: NativeMicTestEnvelope) => void) | null = null;
  /** Every preview renderer the tab made, oldest first. */
  const renderers: Array<{ url: string; onClosed?: () => void; disposed: boolean }> = [];
  beforeEach(async () => {
    vi.resetModules();
    startMicTest.mockReset().mockResolvedValue(7);
    startMonitor.mockReset().mockResolvedValue(99);
    updateMicTest.mockReset().mockResolvedValue(undefined);
    stopMicTest.mockReset().mockResolvedValue(undefined);
    unsubscribeTest.mockReset();
    testHandler = null;
    speakersLabel = "Speakers";
    unsubscribeNative.mockReset();
    onNativeDevicesChanged.mockReset().mockReturnValue(unsubscribeNative);
    onMicTestEvent.mockReset().mockImplementation((handler: typeof testHandler) => {
      testHandler = handler;
      return unsubscribeTest;
    });
    startCameraPreview
      .mockReset()
      .mockResolvedValue({ width: 320, height: 180, frames: "ws://127.0.0.1:9/tok" });
    stopCameraPreview.mockReset().mockResolvedValue(undefined);
    nativeCameraDevices
      .mockReset()
      .mockResolvedValue([{ deviceId: "cam-1", label: "Camera", kind: "videoinput" }]);
    nativeCameraSupport.mockReset().mockResolvedValue({ available: true, missing: [] });
    nativeVideoCodecs.mockReset().mockResolvedValue({ h264: true, vp9: false, decode: [] });
    vi.doMock("../../src/features/voice/native/videoCodecs", () => ({
      nativeVideoCodecs: () => nativeVideoCodecs() as unknown,
    }));
    vi.doMock("@lib/logger", () => appLogger);
    vi.doMock("../../src/features/voice/native/platform", () => ({ isLinuxDesktop: () => true }));
    vi.doMock("../../src/features/voice/native/devices", () => ({
      nativeAudioDevices: async (kind: string) =>
        kind === "audioinput"
          ? [{ deviceId: "guid-mic", label: "USB Mic", kind }]
          : [{ deviceId: "guid-spk", label: speakersLabel, kind }],
      nativeCameraDevices: (...args: unknown[]) => nativeCameraDevices(...args),
      nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
      onNativeDevicesChanged: (handler: () => void) => onNativeDevicesChanged(handler) as unknown,
    }));
    vi.doMock("../../src/platform/desktop", () => ({
      desktop: {
        nativeVoice: {
          startCameraPreview: (...args: unknown[]) => startCameraPreview(...args) as unknown,
          stopCameraPreview: (...args: unknown[]) => stopCameraPreview(...args) as unknown,
          startMicTest: (options: { monitor?: boolean }) =>
            (options.monitor === true ? startMonitor(options) : startMicTest(options)) as unknown,
          updateMicTest: (...args: unknown[]) => updateMicTest(...args) as unknown,
          stopMicTest: (...args: unknown[]) => stopMicTest(...args) as unknown,
          onMicTestEvent: (...args: unknown[]) => onMicTestEvent(...args) as unknown,
        },
        pushToTalk: {
          supported: async () => true,
          stop: async () => {},
          updateKey: async () => {},
        },
        // The PTT control asks which global-keys backend the host reports.
        globalShortcuts: {
          status: async () => ({
            backend: "polling",
            portalVersion: 0,
            triggers: { ptt: null, mute: null, deafen: null },
            canConfigure: false,
            triggersUnnamed: false,
            sessionRefused: false,
          }),
          onStatusChange: () => () => {},
        },
      },
    }));
    renderers.length = 0;
    vi.doMock("../../src/features/voice/native/videoRenderer", () => ({
      NativeVideoRenderer: class {
        readonly mediaStreamTrack = { stop: vi.fn(), dispatchEvent: vi.fn() };
        disposed = false;
        constructor(
          readonly url: string,
          readonly onClosed?: () => void,
        ) {
          renderers.push(this);
        }
        dispose() {
          this.disposed = true;
        }
      },
    }));
    localStorage.clear();
    document.body.innerHTML = "";
    getUserMedia.mockReset();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { deviceId: "web-mic", kind: "audioinput", label: "Webview Mic" },
          { deviceId: "cam-1", kind: "videoinput", label: "Camera" },
        ]),
        getUserMedia,
        addEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    vi.doUnmock("../../src/features/voice/native/platform");
    vi.doUnmock("../../src/features/voice/native/devices");
    vi.doUnmock("../../src/features/voice/native/videoCodecs");
    vi.doUnmock("../../src/platform/desktop");
    vi.doUnmock("../../src/features/voice/native/videoRenderer");
    vi.doUnmock("@lib/logger");
    vi.unstubAllGlobals();
  });

  async function mount() {
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const tab = create(ac.signal);
    const element = tab.build();
    document.body.appendChild(element);
    await new Promise((r) => setTimeout(r, 0));
    return { element, ac, tab };
  }

  /** The camera select once its device options have been populated. */
  async function cameraSelect(element: HTMLElement): Promise<HTMLSelectElement> {
    let select: HTMLSelectElement | undefined;
    await vi.waitFor(() => {
      select = [...element.querySelectorAll("select")].find((sel) =>
        [...sel.options].some((o) => o.value === "cam-1"),
      );
      expect(select).toBeDefined();
    });
    return select!;
  }

  /** The Video Codec select once the native probe has filled its slot. */
  async function codecSelect(element: HTMLElement): Promise<HTMLSelectElement> {
    let select: HTMLSelectElement | null = null;
    await vi.waitFor(() => {
      select = element.querySelector('select[aria-label="Video Codec"]');
      expect(select).not.toBeNull();
    });
    return select!;
  }

  it("shows VP8, H.264 and Auto on Linux", async () => {
    const tab = await mount();
    const select = await codecSelect(tab.element);
    // VP9 and H.265 are never offered on Linux.
    expect([...select.options].map((o) => o.value)).toEqual(["vp8", "h264", "auto"]);
    expect([...select.options].every((o) => !o.disabled)).toBe(true);
    // Software H.264 and an Auto that is always VP8 are named as such.
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "VP8 (default, most compatible)",
      "H.264 (software)",
      "Auto (VP8)",
    ]);
    expect(tab.element.textContent).toContain(
      "Linux encodes video in software; VP8 uses the least CPU.",
    );
    expect(tab.element.textContent).not.toContain("Intel graphics");
    // The 120 fps hardware H.264 rule does not apply to the native engine.
    expect(tab.element.textContent).not.toContain("A 120 fps screen share uses H.264");
    const headings = [...tab.element.querySelectorAll(".settings-field-label")].map(
      (h) => h.textContent,
    );
    expect(headings).toContain("Video Codec");
    expect(headings).toContain("Screen Share FPS");
  });

  it("disables H.264 with the reason when the native encoder lacks it", async () => {
    nativeVideoCodecs.mockResolvedValue({ h264: false, vp9: false, decode: [] });
    const tab = await mount();
    const select = await codecSelect(tab.element);
    const h264 = [...select.options].find((o) => o.value === "h264")!;
    expect(h264.disabled).toBe(true);
    expect(h264.textContent).toBe("H.264 (not available in this build)");
    expect([...select.options].filter((o) => o.disabled).map((o) => o.value)).toEqual(["h264"]);
  });

  it("a saved H.264 shows as VP8 when unavailable", async () => {
    nativeVideoCodecs.mockResolvedValue({ h264: false, vp9: false, decode: [] });
    localStorage.setItem("owncord:settings:videoCodec", '"h264"');
    const tab = await mount();
    const select = await codecSelect(tab.element);
    expect(select.value).toBe("vp8");
    // Shown as VP8, not rewritten: a build with H.264 honours it again.
    expect(localStorage.getItem("owncord:settings:videoCodec")).toBe('"h264"');
  });

  it("shows a saved H.264 as H.264 when the native encoder has it", async () => {
    localStorage.setItem("owncord:settings:videoCodec", '"h264"');
    const tab = await mount();
    const select = await codecSelect(tab.element);
    expect(select.value).toBe("h264");
  });

  // The engine's capture applies the input volume, as the web processor does.
  it("keeps the input volume control and applies it to the call", async () => {
    mockSetInputVolume.mockClear();
    const tab = await mount();
    const headings = [...tab.element.querySelectorAll(".settings-field-label")].map(
      (h) => h.textContent,
    );
    // The engine's playout mixer applies output volume.
    expect(headings).toEqual(
      expect.arrayContaining(["Input Device", "Input Volume", "Output Device", "Output Volume"]),
    );
    const slider = tab.element.querySelector<HTMLInputElement>('input[aria-label="Input Volume"]')!;
    slider.value = "150";
    slider.dispatchEvent(new Event("input"));
    expect(mockSetInputVolume).toHaveBeenLastCalledWith(150);
    const labels = [...tab.element.querySelectorAll(".setting-label")].map((l) => l.textContent);
    // RNNoise runs on the engine's own capture path.
    expect(labels).toEqual(
      expect.arrayContaining([
        "Echo Cancellation",
        "Noise Suppression",
        "Automatic Gain Control",
        "Enhanced Noise Suppression",
      ]),
    );
    // The meter runs outside a call too; only the test waits for the call.
    const note = tab.element.querySelector('[data-testid="native-audio-note"]');
    expect(note?.textContent).toContain("mic test cannot run during a call");
    // The native engine acquires no audio through the webview. The camera
    // preview may still call getUserMedia (video only) since voice #22 starts
    // it on the default device; no audio request may occur.
    for (const call of getUserMedia.mock.calls) {
      expect((call[0] as MediaStreamConstraints).audio).toBe(false);
    }
  });

  // The engine's capture runs the sensitivity gate on the web path's scale;
  // with no level report yet (no call), the bar shows no level.
  it("shows the input sensitivity slider and applies it to the call", async () => {
    mockSetVoiceSensitivity.mockClear();
    localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
    const tab = await mount();
    const headings = [...tab.element.querySelectorAll(".settings-field-label")].map(
      (h) => h.textContent,
    );
    expect(headings).toContain("Input Sensitivity");
    const handle = tab.element.querySelector<HTMLElement>(".mic-meter-threshold")!;
    expect(handle.hidden).toBe(false);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(mockSetVoiceSensitivity).toHaveBeenLastCalledWith(45);
    expect(localStorage.getItem("owncord:settings:voiceSensitivity")).toBe("45");
    expect(tab.element.querySelector<HTMLElement>(".mic-meter-level")!.style.width).toBe("");
  });

  // The engine runs the web path's noise-floor estimate on its own capture.
  it("offers automatic sensitivity, saved and applied to the call", async () => {
    mockApplyInputMode.mockClear();
    localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
    const tab = await mount();
    const row = tab.element.querySelector<HTMLElement>("[data-testid='auto-sensitivity']")!;
    expect(row.textContent).toContain("Automatically determine input sensitivity");
    const handle = tab.element.querySelector<HTMLElement>(".mic-meter-threshold")!;
    expect(handle.hidden).toBe(false);
    row.querySelector<HTMLElement>("[role='switch'], input, button")!.click();
    expect(localStorage.getItem("owncord:settings:autoInputSensitivity")).toBe("true");
    expect(mockApplyInputMode).toHaveBeenCalledTimes(1);
    expect(handle.hidden).toBe(true);
  });

  // The bar shows the call capture's level reports, after its input volume
  // and with its gate's verdict, on the handle's axis.
  it("drives the meter from the engine's level reports", async () => {
    mockUnsubscribeNativeLevel.mockClear();
    const ac = new AbortController();
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    expect(nativeLevelListener).not.toBeNull();
    const level = element.querySelector<HTMLElement>(".mic-meter-level")!;
    nativeLevelListener!(vadThreshold(50), true);
    expect(level.style.width).toBe("50%");
    expect(level.style.background).toBe("var(--green)");
    nativeLevelListener!(vadThreshold(75), false);
    expect(level.style.width).toBe("25%");
    expect(level.style.background).toBe("var(--yellow)");
    expect(element.textContent).toContain("Hearing you");
    // Mute or leave: the capture stopped, so the bar and its status clear.
    nativeLevelListener!(null, false);
    expect(level.style.width).toBe("0%");
    expect(element.querySelector<HTMLElement>('[data-testid="mic-status"]')!.hidden).toBe(true);
    nativeLevelListener!(vadThreshold(50), true);
    expect(level.style.width).toBe("50%");
    expect(element.textContent).toContain("Hearing you");
    ac.abort();
    expect(mockUnsubscribeNativeLevel).toHaveBeenCalled();
  });

  /** The mic test row's button and description. */
  function micTestRow(element: HTMLElement) {
    const row = element.querySelector<HTMLElement>('[data-testid="mic-test"]')!;
    return {
      button: row.querySelector<HTMLButtonElement>('[data-testid="mic-test-button"]')!,
      desc: row.querySelector<HTMLElement>(".setting-desc")!,
    };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** Press the button and let the start resolve. */
  async function startTest(element: HTMLElement): Promise<void> {
    micTestRow(element).button.click();
    await vi.waitFor(() => expect(startMicTest).toHaveBeenCalledTimes(1));
    await settle();
  }

  const NORMAL_DESC =
    "Hear yourself the way others will, through your output device. Use headphones to avoid echo.";

  it("offers the mic test on Linux", async () => {
    const tab = await mount();
    const { button, desc } = micTestRow(tab.element);
    expect(button.disabled).toBe(false);
    expect(desc.textContent).toBe(NORMAL_DESC);
    expect(tab.element.textContent).not.toContain("not available on Linux yet");
    expect(startMicTest).not.toHaveBeenCalled();
  });

  describe("the meter's capture-only monitor", () => {
    const meterWidth = (element: HTMLElement) =>
      element.querySelector<HTMLElement>(".mic-meter-level")!.style.width;
    const level = (rms: number, test = 99): void =>
      testHandler?.({ test, event: { type: "inputLevel", rms, open: true } });

    it("starts when the tab opens, on the saved microphone and with no output", async () => {
      localStorage.setItem("owncord:settings:audioInputDevice", '"guid-mic"');
      localStorage.setItem("owncord:settings:inputVolume", "120");
      await mount();
      await vi.waitFor(() => expect(startMonitor).toHaveBeenCalledTimes(1));
      expect(startMonitor).toHaveBeenCalledWith(
        expect.objectContaining({
          input: "guid-mic",
          output: "",
          inputGain: 120,
          outputGain: 0,
          monitor: true,
        }),
      );
      expect(startMicTest).not.toHaveBeenCalled();
    });

    it("moves the bar with its level reports and ignores another test's", async () => {
      const tab = await mount();
      await settle();
      level(0.05);
      expect(meterWidth(tab.element)).not.toBe("0%");
      level(0, 99);
      expect(meterWidth(tab.element)).toBe("0%");
      level(0.05);
      const before = meterWidth(tab.element);
      level(0.5, 123);
      expect(meterWidth(tab.element)).toBe(before);
    });

    it("stops with the tab, once, and not again at the overlay's end", async () => {
      const tab = await mount();
      await settle();
      tab.tab.cleanup();
      expect(stopMicTest).toHaveBeenCalledTimes(1);
      expect(stopMicTest).toHaveBeenCalledWith(99);
      tab.ac.abort();
      expect(stopMicTest).toHaveBeenCalledTimes(1);
    });

    it("is stopped when a start still in flight resolves after the tab closed", async () => {
      let resolveStart!: (id: number) => void;
      startMonitor.mockReturnValue(
        new Promise<number>((resolve) => {
          resolveStart = resolve;
        }),
      );
      const tab = await mount();
      tab.ac.abort();
      expect(stopMicTest).not.toHaveBeenCalled();
      resolveStart(5);
      await vi.waitFor(() => expect(stopMicTest).toHaveBeenCalledWith(5));
    });

    it("hands the capture to the mic test and takes it back when the test stops", async () => {
      const tab = await mount();
      await settle();
      await startTest(tab.element);
      // The host replaced the monitor itself: no stop for it.
      expect(stopMicTest).not.toHaveBeenCalled();
      expect(startMonitor).toHaveBeenCalledTimes(1);
      micTestRow(tab.element).button.click();
      expect(stopMicTest).toHaveBeenCalledTimes(1);
      expect(stopMicTest).toHaveBeenCalledWith(7);
      await vi.waitFor(() => expect(startMonitor).toHaveBeenCalledTimes(2));
    });

    it("follows the call when one joins, and returns when the call's capture stops", async () => {
      const tab = await mount();
      await settle();
      testHandler?.({ test: 99, event: { type: "ended" } });
      // A call joined: no stop, no test messaging, the button is untouched.
      expect(stopMicTest).not.toHaveBeenCalled();
      const { button, desc } = micTestRow(tab.element);
      expect(button.textContent).toBe("Let's Check");
      expect(desc.textContent).toBe(NORMAL_DESC);
      expect(startMonitor).toHaveBeenCalledTimes(1);
      nativeLevelListener?.(0.05, true);
      expect(meterWidth(tab.element)).not.toBe("0%");
      // The call ended: the bar empties and the monitor runs again.
      nativeLevelListener?.(null, false);
      expect(meterWidth(tab.element)).toBe("0%");
      await vi.waitFor(() => expect(startMonitor).toHaveBeenCalledTimes(2));
    });

    it("stays quiet when a call holds the capture, and retries when it lets go", async () => {
      startMonitor.mockRejectedValueOnce(new Error("mic test unavailable during a call"));
      const tab = await mount();
      await settle();
      expect(micTestRow(tab.element).desc.textContent).toBe(NORMAL_DESC);
      nativeLevelListener?.(null, false);
      await vi.waitFor(() => expect(startMonitor).toHaveBeenCalledTimes(2));
    });

    describe("while a leaving call still holds the capture", () => {
      const inCall = () => new Error("mic test unavailable during a call");
      /** A tab whose monitor runs, then fake timers for the retries. */
      async function mountThenFakeTimers() {
        const tab = await mount();
        await settle();
        expect(startMonitor).toHaveBeenCalledTimes(1);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        // A call joined: the host ended the monitor.
        testHandler?.({ test: 99, event: { type: "ended" } });
        return tab;
      }
      afterEach(() => {
        vi.useRealTimers();
      });

      it("retries the refused start until the host lets go", async () => {
        const tab = await mountThenFakeTimers();
        startMonitor.mockRejectedValueOnce(inCall()).mockRejectedValueOnce(inCall());
        nativeLevelListener?.(null, false);
        await vi.advanceTimersByTimeAsync(1);
        expect(startMonitor).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(250);
        expect(startMonitor).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(250);
        expect(startMonitor).toHaveBeenCalledTimes(4);
        // It took: no more retries.
        await vi.advanceTimersByTimeAsync(5000);
        expect(startMonitor).toHaveBeenCalledTimes(4);
        tab.ac.abort();
      });

      it("gives up after eight retries, so a muted call does not loop", async () => {
        const tab = await mountThenFakeTimers();
        startMonitor.mockRejectedValue(inCall());
        nativeLevelListener?.(null, false);
        await vi.advanceTimersByTimeAsync(250 * 20);
        // The refused start and eight retries, after the first monitor.
        expect(startMonitor).toHaveBeenCalledTimes(1 + 9);
        tab.ac.abort();
      });

      it("stops retrying once the call's levels arrive or the tab closes", async () => {
        const tab = await mountThenFakeTimers();
        startMonitor.mockRejectedValue(inCall());
        nativeLevelListener?.(null, false);
        await vi.advanceTimersByTimeAsync(1);
        expect(startMonitor).toHaveBeenCalledTimes(2);
        nativeLevelListener?.(0.05, true);
        await vi.advanceTimersByTimeAsync(250 * 3);
        expect(startMonitor).toHaveBeenCalledTimes(2);
        nativeLevelListener?.(null, false);
        await vi.advanceTimersByTimeAsync(1);
        expect(startMonitor).toHaveBeenCalledTimes(3);
        tab.ac.abort();
        await vi.advanceTimersByTimeAsync(250 * 3);
        expect(startMonitor).toHaveBeenCalledTimes(3);
      });
    });

    it("does not start a monitor over a running mic test", async () => {
      const tab = await mount();
      await settle();
      await startTest(tab.element);
      nativeLevelListener?.(null, false);
      await settle();
      expect(startMonitor).toHaveBeenCalledTimes(1);
    });

    it("moves to a newly chosen microphone", async () => {
      const tab = await mount();
      await settle();
      const select = [...tab.element.querySelectorAll("select")].find(
        (sel) => sel.getAttribute("aria-label") === "Input Device",
      )!;
      select.value = "alsa:usb";
      select.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(startMonitor).toHaveBeenCalledTimes(2));
      expect(stopMicTest).toHaveBeenCalledWith(99);
    });
  });

  it("on Linux a native device change refills the lists outside a call, and stops after the tab is torn down", async () => {
    const tab = await mount();
    const outputLabels = () =>
      [...tab.element.querySelectorAll("option")].map((o) => o.textContent ?? "");
    expect(onNativeDevicesChanged).toHaveBeenCalledTimes(1);
    expect(outputLabels().some((l) => l.includes("Headset"))).toBe(false);
    const changed = onNativeDevicesChanged.mock.calls[0]![0] as () => void;

    speakersLabel = "Headset";
    changed();
    await vi.waitFor(() => expect(outputLabels().some((l) => l.includes("Headset"))).toBe(true));
    expect(unsubscribeNative).not.toHaveBeenCalled();

    tab.ac.abort();
    expect(unsubscribeNative).toHaveBeenCalledTimes(1);
  });

  it("starts the native loopback with the saved devices, processing, gains and gate", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", '"guid-mic"');
    localStorage.setItem("owncord:settings:audioOutputDevice", '"guid-spk"');
    localStorage.setItem("owncord:settings:inputVolume", "120");
    localStorage.setItem("owncord:settings:outputVolume", "150");
    localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
    localStorage.setItem("owncord:settings:voiceSensitivity", "40");
    localStorage.setItem("owncord:settings:echoCancellation", "false");
    localStorage.setItem("owncord:settings:enhancedNoiseSuppression", "true");
    const tab = await mount();
    await startTest(tab.element);
    expect(startMicTest).toHaveBeenCalledWith({
      input: "guid-mic",
      output: "guid-spk",
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        enhancedNoiseSuppression: true,
      },
      inputGain: 120,
      // The output volume caps at 100 %, as the web test does.
      outputGain: 1,
      threshold: vadThreshold(40),
    });
    const { button } = micTestRow(tab.element);
    expect(button.textContent).toBe("Stop Testing");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // The host's capture, not the webview's microphone, is what is tested.
    for (const call of getUserMedia.mock.calls) {
      expect((call[0] as MediaStreamConstraints).audio).toBe(false);
    }
  });

  it("runs the test ungated in Push to Talk", async () => {
    localStorage.setItem("owncord:settings:inputMode", '"ptt"');
    const tab = await mount();
    await startTest(tab.element);
    expect(startMicTest.mock.calls[0]![0]).toMatchObject({ threshold: 0 });
  });

  it("a second click stops the test by its id", async () => {
    const tab = await mount();
    await startTest(tab.element);
    const { button } = micTestRow(tab.element);
    button.click();
    expect(stopMicTest).toHaveBeenCalledTimes(1);
    expect(stopMicTest).toHaveBeenCalledWith(7);
    expect(unsubscribeTest).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("Let's Check");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("closing the tab stops a running test", async () => {
    const closed = await mount();
    await startTest(closed.element);
    closed.tab.cleanup();
    expect(stopMicTest).toHaveBeenCalledTimes(1);
    expect(stopMicTest).toHaveBeenCalledWith(7);
    // The overlay closing afterwards finds nothing left to stop.
    closed.ac.abort();
    expect(stopMicTest).toHaveBeenCalledTimes(1);

    stopMicTest.mockClear();
    startMicTest.mockClear();
    document.body.innerHTML = "";
    const aborted = await mount();
    await startTest(aborted.element);
    aborted.ac.abort();
    expect(stopMicTest).toHaveBeenCalledTimes(1);
    expect(stopMicTest).toHaveBeenCalledWith(7);
  });

  it("a start still in flight when the tab closes is stopped once it resolves", async () => {
    let resolveStart!: (id: number) => void;
    startMicTest.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const tab = await mount();
    micTestRow(tab.element).button.click();
    await vi.waitFor(() => expect(startMicTest).toHaveBeenCalledTimes(1));
    tab.ac.abort();
    // No id yet: nothing can be stopped, and the pending start owns itself.
    expect(stopMicTest).not.toHaveBeenCalled();
    resolveStart(9);
    await vi.waitFor(() => expect(stopMicTest).toHaveBeenCalledTimes(1));
    expect(stopMicTest).toHaveBeenCalledWith(9);
  });

  it("a start superseded by a stop click is stopped when it resolves", async () => {
    let resolveStart!: (id: number) => void;
    startMicTest.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const tab = await mount();
    const { button } = micTestRow(tab.element);
    button.click();
    await vi.waitFor(() => expect(startMicTest).toHaveBeenCalledTimes(1));
    button.click();
    expect(button.textContent).toBe("Let's Check");
    resolveStart(4);
    await vi.waitFor(() => expect(stopMicTest).toHaveBeenCalledWith(4));
    expect(stopMicTest).toHaveBeenCalledTimes(1);
  });

  it("level reports of the running test drive the meter; another test's are ignored", async () => {
    const tab = await mount();
    await startTest(tab.element);
    const level = tab.element.querySelector<HTMLElement>(".mic-meter-level")!;
    testHandler!({
      test: 7,
      event: { type: "inputLevel", rms: vadThreshold(50), open: true },
    });
    expect(level.style.width).toBe("50%");
    expect(level.style.background).toBe("var(--green)");
    testHandler!({
      test: 8,
      event: { type: "inputLevel", rms: vadThreshold(75), open: false },
    });
    expect(level.style.width).toBe("50%");
    // Stopping empties the meter, and a report queued before it cannot repaint it.
    micTestRow(tab.element).button.click();
    expect(level.style.width).toBe("0%");
    testHandler!({
      test: 7,
      event: { type: "inputLevel", rms: vadThreshold(50), open: true },
    });
    expect(level.style.width).toBe("0%");
  });

  it("automatic sensitivity retunes the test's gate from its level reports", async () => {
    const tab = await mount();
    await startTest(tab.element);
    // Automatic is the default: the gate starts at the tracker's seed.
    expect(startMicTest.mock.calls[0]![0]).toMatchObject({ threshold: 0.05 });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    for (let i = 0; i < 40; i++) {
      now += 100;
      testHandler!({ test: 7, event: { type: "inputLevel", rms: 0.002, open: false } });
    }
    expect(updateMicTest).toHaveBeenCalled();
    const [id, update] = updateMicTest.mock.calls[0]! as [number, { threshold: number }];
    expect(id).toBe(7);
    expect(update).toMatchObject({ kind: "voiceGate", retune: true });
    expect(update.threshold).toBeLessThan(0.05);
  });

  it("an ended test (a call joined) resets the button without a stop", async () => {
    const tab = await mount();
    await startTest(tab.element);
    testHandler!({ test: 7, event: { type: "ended" } });
    const { button, desc } = micTestRow(tab.element);
    expect(button.textContent).toBe("Let's Check");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(desc.textContent).toBe("Leave the voice channel to test your mic.");
    expect(stopMicTest).not.toHaveBeenCalled();
    expect(unsubscribeTest).toHaveBeenCalledTimes(1);
  });

  it("a test the host ended before its start resolved resets the button", async () => {
    let resolveStart!: (id: number) => void;
    startMicTest.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const tab = await mount();
    micTestRow(tab.element).button.click();
    await vi.waitFor(() => expect(startMicTest).toHaveBeenCalledTimes(1));
    testHandler!({ test: 7, event: { type: "ended" } });
    resolveStart(7);
    await settle();
    const { button, desc } = micTestRow(tab.element);
    expect(button.textContent).toBe("Let's Check");
    expect(desc.textContent).toBe("Leave the voice channel to test your mic.");
    expect(stopMicTest).not.toHaveBeenCalled();
  });

  it("a start refused in a call resets the button and says why", async () => {
    startMicTest.mockRejectedValue(new Error("mic test unavailable during a call"));
    const tab = await mount();
    micTestRow(tab.element).button.click();
    await vi.waitFor(() => {
      expect(micTestRow(tab.element).desc.textContent).toBe(
        "Leave the voice channel to test your mic.",
      );
    });
    const { button } = micTestRow(tab.element);
    expect(button.textContent).toBe("Let's Check");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(stopMicTest).not.toHaveBeenCalled();
    expectConsole("warn", /mic test could not start/i);
  });

  it("a start that fails otherwise says the test could not start", async () => {
    startMicTest.mockRejectedValue(new Error("no capture device"));
    const tab = await mount();
    micTestRow(tab.element).button.click();
    await vi.waitFor(() => {
      expect(micTestRow(tab.element).desc.textContent).toBe("The mic test could not start.");
    });
    expect(micTestRow(tab.element).button.textContent).toBe("Let's Check");
    // A later successful start clears the message.
    startMicTest.mockResolvedValue(7);
    micTestRow(tab.element).button.click();
    await vi.waitFor(() => expect(startMicTest).toHaveBeenCalledTimes(2));
    expect(micTestRow(tab.element).desc.textContent).toBe(NORMAL_DESC);
    expectConsole("warn", /mic test could not start/i);
  });

  describe("settings changes reach the running test", () => {
    const toggleFor = (element: HTMLElement, label: string): HTMLElement =>
      element.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)!;
    const audio = (over: Record<string, boolean>) => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      enhancedNoiseSuppression: false,
      ...over,
    });

    it("maps each control to its update", async () => {
      localStorage.setItem("owncord:settings:autoInputSensitivity", "false");
      const tab = await mount();
      await settle();
      await startTest(tab.element);
      const el = tab.element;
      const sliders = el.querySelectorAll<HTMLInputElement>(VOLUME_SLIDERS);
      const selects = el.querySelectorAll("select");
      const table: Array<[string, () => void, unknown]> = [
        [
          "input volume",
          () => {
            sliders[0]!.value = "150";
            sliders[0]!.dispatchEvent(new Event("input"));
          },
          { kind: "inputGain", percent: 150 },
        ],
        [
          "sensitivity drag",
          () =>
            el
              .querySelector<HTMLElement>(".mic-meter-threshold")!
              .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
          { kind: "voiceGate", threshold: vadThreshold(45), retune: true },
        ],
        [
          "echo cancellation",
          () => toggleFor(el, "Echo Cancellation").click(),
          { kind: "processing", audio: audio({ echoCancellation: false }) },
        ],
        [
          "enhanced noise suppression",
          () => toggleFor(el, "Enhanced Noise Suppression").click(),
          {
            kind: "processing",
            audio: audio({ echoCancellation: false, enhancedNoiseSuppression: true }),
          },
        ],
        [
          "noise suppression",
          () => toggleFor(el, "Noise Suppression").click(),
          {
            kind: "processing",
            audio: audio({
              echoCancellation: false,
              noiseSuppression: false,
              enhancedNoiseSuppression: true,
            }),
          },
        ],
        [
          "automatic gain control",
          () => toggleFor(el, "Automatic Gain Control").click(),
          {
            kind: "processing",
            audio: audio({
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              enhancedNoiseSuppression: true,
            }),
          },
        ],
        [
          "input device",
          () => {
            selects[0]!.value = "guid-mic";
            selects[0]!.dispatchEvent(new Event("change"));
          },
          { kind: "inputDevice", deviceId: "guid-mic" },
        ],
        [
          "output device",
          () => {
            selects[1]!.value = "guid-spk";
            selects[1]!.dispatchEvent(new Event("change"));
          },
          { kind: "outputDevice", deviceId: "guid-spk" },
        ],
        [
          "output volume",
          () => {
            sliders[1]!.value = "50";
            sliders[1]!.dispatchEvent(new Event("input"));
          },
          { kind: "outputGain", gain: 0.5 },
        ],
        [
          "automatic sensitivity on",
          () =>
            el
              .querySelector<HTMLElement>("[data-testid='auto-sensitivity'] [role='switch']")!
              .click(),
          { kind: "voiceGate", threshold: 0.05, retune: false },
        ],
        [
          "mode switch to Push to Talk",
          () => el.querySelector<HTMLElement>("[data-testid='input-mode-ptt']")!.click(),
          { kind: "voiceGate", threshold: 0, retune: false },
        ],
      ];
      for (const [name, act, expected] of table) {
        updateMicTest.mockClear();
        act();
        expect(updateMicTest, name).toHaveBeenCalledTimes(1);
        expect(updateMicTest, name).toHaveBeenCalledWith(7, expected);
      }
    });

    it("does nothing when neither a test nor a monitor runs", async () => {
      startMonitor.mockRejectedValue(new Error("mic test unavailable during a call"));
      const tab = await mount();
      const slider = tab.element.querySelector<HTMLInputElement>(
        'input[aria-label="Input Volume"]',
      )!;
      slider.value = "150";
      slider.dispatchEvent(new Event("input"));
      tab.element
        .querySelector<HTMLElement>('[role="switch"][aria-label="Echo Cancellation"]')!
        .click();
      expect(updateMicTest).not.toHaveBeenCalled();
    });
  });

  it("a meter restart (processing toggle, device change) does not stop the test", async () => {
    const tab = await mount();
    await startTest(tab.element);
    tab.element
      .querySelector<HTMLElement>('[role="switch"][aria-label="Noise Suppression"]')!
      .click();
    const input = tab.element.querySelectorAll("select")[0]!;
    input.value = "guid-mic";
    input.dispatchEvent(new Event("change"));
    await settle();
    await settle();
    expect(stopMicTest).not.toHaveBeenCalled();
    expect(unsubscribeTest).not.toHaveBeenCalled();
    expect(micTestRow(tab.element).button.textContent).toBe("Stop Testing");
    // The test still takes updates after the restart.
    updateMicTest.mockClear();
    testHandler!({ test: 7, event: { type: "inputLevel", rms: 0.01, open: true } });
    expect(tab.element.querySelector<HTMLElement>(".mic-meter-level")!.style.width).not.toBe("0%");
  });

  it("describes the processing toggles as it does elsewhere: they apply live", async () => {
    const tab = await mount();
    const descs = [...tab.element.querySelectorAll(".setting-desc")].map(
      (d) => d.textContent ?? "",
    );
    expect(descs.filter((d) => /next join/i.test(d))).toEqual([]);
    expect(descs).toContain("Reduce echo from speakers feeding back into microphone");
    expect(descs).toContain("Automatically adjust microphone volume");
  });

  it("lists the native engine's audio devices, not the webview's", async () => {
    const tab = await mount();
    const selects = tab.element.querySelectorAll("select");
    const inputOptions = [...selects[0]!.options].map((o) => o.value);
    const outputOptions = [...selects[1]!.options].map((o) => o.value);
    expect(inputOptions).toEqual(["", "guid-mic"]);
    expect(outputOptions).toEqual(["", "guid-spk"]);
    // The camera select still comes from the webview (index after the quality selects).
    const videoSelect = [...selects].find((sel) =>
      [...sel.options].some((o) => o.value === "cam-1"),
    );
    expect(videoSelect).toBeDefined();
  });

  it("starts the native preview again when the host closes its socket", async () => {
    // The call's camera turning on takes the device from the preview (or off,
    // handing it back): the host closes the preview socket, and the tab asks
    // again for whichever capture owns the camera now.
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[] = []) {}
        getTracks(): unknown[] {
          return this.tracks;
        }
      },
    );
    startCameraPreview
      .mockResolvedValueOnce({ width: 320, height: 180, frames: "ws://127.0.0.1:9/own" })
      .mockResolvedValue({ width: 1280, height: 720, frames: "ws://127.0.0.1:9/call" });
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    await vi.waitFor(() => expect(renderers).toHaveLength(1));
    const first = renderers[0]!;
    expect(first.url).toBe("ws://127.0.0.1:9/own/camera");

    first.onClosed?.();
    expect(first.disposed).toBe(true);
    await vi.waitFor(() => expect(renderers).toHaveLength(2));
    expect(startCameraPreview).toHaveBeenCalledTimes(2);
    expect(renderers[1]!.url).toBe("ws://127.0.0.1:9/call/camera");
    // The closed preview had nothing left to release on the host.
    expect(stopCameraPreview).not.toHaveBeenCalled();

    // A close after the tab is gone starts nothing.
    ac.abort();
    renderers[1]!.onClosed?.();
    await new Promise((r) => setTimeout(r, 600));
    expect(startCameraPreview).toHaveBeenCalledTimes(2);
  });

  it("does not let a superseded native preview stop the newer capture", async () => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[] = []) {}
        getTracks(): unknown[] {
          return this.tracks;
        }
      },
    );
    // First request starts and stays in flight; the user picks another camera
    // before it resolves, so the newer request owns the single native slot.
    let resolveFirst!: (v: { width: number; height: number; frames: string }) => void;
    startCameraPreview
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({ width: 320, height: 180, frames: "ws://127.0.0.1:9/tok2" });
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    const videoSelect = await cameraSelect(element);
    await vi.waitFor(() => {
      expect(startCameraPreview).toHaveBeenCalledTimes(1);
    });

    videoSelect.value = "cam-1";
    videoSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(startCameraPreview).toHaveBeenCalledTimes(2);
    });

    // The newer request has resolved against the slot; now the first resolves
    // stale. It must not stop the slot the newer preview owns.
    resolveFirst({ width: 320, height: 180, frames: "ws://127.0.0.1:9/tok1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(stopCameraPreview).not.toHaveBeenCalled();
  });

  it("releases the slot when the newer native preview fails to start", async () => {
    // The first request stays in flight; the user picks another camera, and
    // that newer request rejects before it can replace the backend slot. The
    // newer request is still current and must reclaim the orphaned capture.
    let resolveFirst!: (v: { width: number; height: number; frames: string }) => void;
    startCameraPreview
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockRejectedValue(new Error("no camera"));
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    const videoSelect = await cameraSelect(element);
    await vi.waitFor(() => {
      expect(startCameraPreview).toHaveBeenCalledTimes(1);
    });

    videoSelect.value = "cam-1";
    videoSelect.dispatchEvent(new Event("change"));

    // The newer request failed while the first is still in flight; the failure
    // path releases the standalone slot so its capture is not left running.
    await vi.waitFor(() => {
      expect(stopCameraPreview).toHaveBeenCalled();
    });
    void resolveFirst;
  });

  it("releases the in-flight native capture when the tab is torn down", async () => {
    // The overlay closes while the start IPC is in flight; cleanupMic had no
    // registered preview to stop, so the resolving start must release it.
    let resolveStart!: (v: { width: number; height: number; frames: string }) => void;
    startCameraPreview.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    await vi.waitFor(() => {
      expect(startCameraPreview).toHaveBeenCalledTimes(1);
    });

    ac.abort();
    resolveStart({ width: 320, height: 180, frames: "ws://127.0.0.1:9/tok" });

    await vi.waitFor(() => {
      expect(stopCameraPreview).toHaveBeenCalled();
    });
  });

  it("explains missing camera support instead of showing an empty list", async () => {
    nativeCameraDevices.mockResolvedValue([]);
    nativeCameraSupport.mockResolvedValue({ available: false, missing: ["v4l2src"] });
    const tab = await mount();
    const label = tab.element.querySelector(".camera-preview-label");
    await vi.waitFor(() => {
      expect(label?.textContent).toContain("Camera support is missing");
    });
    // No capture is attempted when the backend can never start one.
    expect(startCameraPreview).not.toHaveBeenCalled();
  });

  it("shows the no-camera wording when support is available but none is plugged in", async () => {
    nativeCameraDevices.mockResolvedValue([]);
    nativeCameraSupport.mockResolvedValue({ available: true, missing: [] });
    const tab = await mount();
    const label = tab.element.querySelector(".camera-preview-label");
    await vi.waitFor(() => {
      expect(label?.textContent).toBe("No camera found");
    });
    // No capture is attempted when there is no device to capture.
    expect(startCameraPreview).not.toHaveBeenCalled();
  });

  it("explains a failed support query instead of leaving the preview empty", async () => {
    nativeCameraSupport.mockRejectedValue(new Error("ipc failed"));
    const tab = await mount();
    const label = tab.element.querySelector(".camera-preview-label");
    await vi.waitFor(() => {
      expect(label?.textContent).toBe("Camera unavailable");
    });
    expect(startCameraPreview).not.toHaveBeenCalled();
  });

  it("does not let initial discovery replace a preview the user picked", async () => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[] = []) {}
        getTracks(): unknown[] {
          return this.tracks;
        }
      },
    );
    nativeCameraSupport.mockResolvedValue({ available: true, missing: [] });
    // Hold the initial discovery open while the user picks a camera.
    let resolveDevices!: (v: unknown[]) => void;
    nativeCameraDevices.mockReturnValue(
      new Promise((resolve) => {
        resolveDevices = resolve;
      }),
    );
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    // Let the support query resolve and the IIFE reach the discovery await.
    await new Promise((r) => setTimeout(r, 0));
    const videoSelect = element.querySelector(
      'select[aria-label="Video Device"]',
    ) as HTMLSelectElement;
    expect(videoSelect).toBeTruthy();
    videoSelect.value = "cam-1";
    videoSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(startCameraPreview).toHaveBeenCalledTimes(1));
    // Discovery now resolves with the startup preference; the stale
    // continuation must not replace the preview the user already selected.
    resolveDevices([{ deviceId: "cam-1", label: "Camera", kind: "videoinput" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(startCameraPreview).toHaveBeenCalledTimes(1);
    expect(stopCameraPreview).not.toHaveBeenCalled();
  });
});

describe("VoiceAudioTab input mode (WP 1D-2)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    installFakeAudio({ worklets: true });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    mockApplyInputMode.mockClear();
    mockPttStop.mockClear();
    mockPttUpdateKey.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mount(): { el: HTMLElement; ac: AbortController } {
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
    return { el, ac };
  }
  const option = (el: HTMLElement, mode: string): HTMLButtonElement =>
    el.querySelector<HTMLButtonElement>(`[data-testid="input-mode-${mode}"]`)!;
  const pttBox = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('[data-testid="ptt-controls"]')!;
  const sensitivityShown = (el: HTMLElement): boolean =>
    !el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden;

  it("opens on Voice Activity with the sensitivity row and no key controls", () => {
    const { el, ac } = mount();
    expect(option(el, "vad").getAttribute("aria-checked")).toBe("true");
    expect(option(el, "ptt").getAttribute("aria-checked")).toBe("false");
    expect(pttBox(el).hidden).toBe(true);
    expect(sensitivityShown(el)).toBe(true);
    ac.abort();
  });

  it("Push to Talk shows the key and release delay and hides the sensitivity row", () => {
    localStorage.setItem("owncord:settings:pttVk", "65");
    localStorage.setItem("owncord:settings:inputMode", '"vad"');
    const { el, ac } = mount();

    option(el, "ptt").click();

    expect(localStorage.getItem("owncord:settings:inputMode")).toBe('"ptt"');
    expect(option(el, "ptt").getAttribute("aria-checked")).toBe("true");
    expect(pttBox(el).hidden).toBe(false);
    expect(pttBox(el).querySelector('[data-testid="ptt-release-delay"]')).not.toBeNull();
    expect(sensitivityShown(el)).toBe(false);
    expect(el.querySelector<HTMLElement>("[data-testid='auto-sensitivity']")!.hidden).toBe(true);
    expect(mockApplyInputMode).toHaveBeenCalledTimes(1);
    expect(mockPttUpdateKey).toHaveBeenCalledWith(65);
    ac.abort();
  });

  it("repaints the key as Not set when arming Push to Talk clears a refused key", async () => {
    localStorage.setItem("owncord:settings:pttVk", "65");
    localStorage.setItem("owncord:settings:inputMode", '"vad"');
    mockPttUpdateKey.mockImplementationOnce(async () => {
      localStorage.setItem("owncord:settings:pttVk", "0");
    });
    const { el, ac } = mount();
    const keyButton = (): HTMLElement =>
      pttBox(el).querySelector<HTMLElement>('button[aria-label^="Push to Talk keybind"]')!;
    expect(keyButton().textContent).toBe("A");

    option(el, "ptt").click();
    await vi.waitFor(() => expect(keyButton().textContent).toBe("Not set"));
    ac.abort();
  });

  it("switching back to Voice Activity stops push to talk and restores the sensitivity row", () => {
    localStorage.setItem("owncord:settings:inputMode", '"ptt"');
    const { el, ac } = mount();
    expect(sensitivityShown(el)).toBe(false);

    option(el, "vad").click();

    expect(localStorage.getItem("owncord:settings:inputMode")).toBe('"vad"');
    expect(pttBox(el).hidden).toBe(true);
    expect(sensitivityShown(el)).toBe(true);
    expect(mockPttStop).toHaveBeenCalledTimes(1);
    expect(mockApplyInputMode).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("does not arm push to talk with no key bound, and ignores a click on the current mode", () => {
    const { el, ac } = mount();
    option(el, "vad").click();
    expect(mockApplyInputMode).not.toHaveBeenCalled();

    option(el, "ptt").click();
    expect(mockApplyInputMode).toHaveBeenCalledTimes(1);
    expect(mockPttUpdateKey).not.toHaveBeenCalled();
    ac.abort();
  });

  it("shows Push to Talk for a profile from before Input Mode with a bound key", () => {
    localStorage.setItem("owncord:settings:pttVk", "65");
    const { el, ac } = mount();
    expect(option(el, "ptt").getAttribute("aria-checked")).toBe("true");
    expect(pttBox(el).hidden).toBe(false);
    ac.abort();
  });
});

describe("VoiceAudioTab mic test (WP 1D-4)", () => {
  /** The audio elements the tab started playing, newest last. */
  let played: HTMLMediaElement[] = [];
  const pause = vi.fn();
  const setSinkId = vi.fn(async (_id: string) => {});

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    installFakeAudio({ worklets: true });
    played = [];
    pause.mockClear();
    setSinkId.mockClear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      played.push(this);
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      value: setSinkId,
      configurable: true,
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
          getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
        }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLMediaElement.prototype as Partial<{ setSinkId: unknown }>).setSinkId;
    vi.unstubAllGlobals();
  });

  async function mount(): Promise<{
    el: HTMLElement;
    ac: AbortController;
    tab: ReturnType<typeof createVoiceAudioTab>;
  }> {
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);
    await vi.waitFor(() =>
      expect(FakeAudioWorkletNode.instances.some((w) => w.name === "vad-processor")).toBe(true),
    );
    return { el, ac, tab };
  }
  const button = (el: HTMLElement): HTMLButtonElement =>
    el.querySelector<HTMLButtonElement>('[data-testid="mic-test-button"]')!;
  const tracksOf = (audio: HTMLMediaElement): MediaStreamTrack[] =>
    (audio.srcObject as MediaStream).getTracks();
  /** The meter processor's voice gate: the GainNode after the lookahead delay. */
  const gateOf = (ctx: FakeAudioContext) =>
    ctx.node("delay").outputs[0] as unknown as {
      gain: { value: number };
    };

  it("plays the meter's processed output on Let's Check, and stops on Stop Testing", async () => {
    localStorage.setItem("owncord:settings:audioOutputDevice", '"spk-1"');
    localStorage.setItem("owncord:settings:outputVolume", "60");
    const { el, ac } = await mount();
    expect(button(el).textContent).toBe("Let's Check");
    expect(played).toHaveLength(0);

    button(el).click();

    expect(button(el).textContent).toBe("Stop Testing");
    expect(button(el).getAttribute("aria-pressed")).toBe("true");
    expect(played).toHaveLength(1);
    const audio = played[0]!;
    expect(tracksOf(audio)).toEqual([FakeAudioContext.instances.at(-1)!.outputTrack]);
    expect(setSinkId).toHaveBeenCalledWith("spk-1");
    expect(audio.volume).toBeCloseTo(0.6);

    button(el).click();

    expect(button(el).textContent).toBe("Let's Check");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    ac.abort();
  });

  type Teardown = (tab: ReturnType<typeof createVoiceAudioTab>, ac: AbortController) => void;
  it.each<[string, Teardown]>([
    ["switching tabs or closing settings (cleanup)", (tab) => tab.cleanup()],
    ["the overlay being destroyed (abort)", (_tab, ac) => ac.abort()],
  ])("stops on %s", async (_label, teardown) => {
    const { el, ac, tab } = await mount();
    button(el).click();
    const audio = played[0]!;

    teardown(tab, ac);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    ac.abort();
  });

  it("keeps playing when a processing toggle reopens the meter's microphone", async () => {
    const { el, ac } = await mount();
    button(el).click();
    const first = played[0]!;
    const contexts = FakeAudioContext.instances.length;

    el.querySelector<HTMLElement>("[role='switch'][aria-label='Noise Suppression']")!.click();

    await vi.waitFor(() => expect(played).toHaveLength(2));
    expect(first.srcObject).toBeNull();
    expect(FakeAudioContext.instances.length).toBe(contexts + 1);
    expect(tracksOf(played[1]!)).toEqual([FakeAudioContext.instances.at(-1)!.outputTrack]);
    expect(button(el).textContent).toBe("Stop Testing");
    ac.abort();
  });

  it("gates the playback on the detector in Voice Activity, and not in Push to Talk", async () => {
    localStorage.setItem("owncord:settings:inputMode", '"vad"');
    const { el, ac } = await mount();
    const ctx = FakeAudioContext.instances.at(-1)!;
    const worklet = FakeAudioWorkletNode.instances.find((w) => w.name === "vad-processor")!;
    button(el).click();
    expect(ctx.node("delay").delayTime.value).toBe(GATE_LOOKAHEAD_S);

    worklet.emit({ type: "gate", gated: true });
    expect(gateOf(ctx).gain.value).toBe(0);
    worklet.emit({ type: "gate", gated: false });
    expect(gateOf(ctx).gain.value).toBe(1);

    worklet.emit({ type: "gate", gated: true });
    el.querySelector<HTMLButtonElement>('[data-testid="input-mode-ptt"]')!.click();
    expect(gateOf(ctx).gain.value).toBe(1);
    expect(ctx.node("delay").delayTime.value).toBe(0);
    ac.abort();
  });

  it.each([
    ["a corrupt", '"loud"', 1],
    ["a negative", "-20", 0],
    ["a boosted (150%)", "150", 1],
  ])("plays with %s saved output volume instead of failing", async (_label, saved, volume) => {
    localStorage.setItem("owncord:settings:outputVolume", saved);
    const { el, ac } = await mount();
    button(el).click();
    expect(played).toHaveLength(1);
    expect(played[0]!.volume).toBe(volume);
    ac.abort();
  });

  it("lets Output Volume go to 200% and shows a saved 150% as 150% (WP 1D-5)", async () => {
    localStorage.setItem("owncord:settings:outputVolume", "150");
    const { el, ac } = await mount();
    const volume = el.querySelector<HTMLInputElement>('input[aria-label="Output Volume"]')!;
    expect(volume.max).toBe("200");
    expect(volume.value).toBe("150");
    expect(volume.parentElement?.querySelector(".slider-val")?.textContent).toBe("150%");
    ac.abort();
  });

  it("follows the output device and volume chosen while testing", async () => {
    const { el, ac } = await mount();
    button(el).click();
    const audio = played[0]!;
    setSinkId.mockClear();

    const output = el.querySelector<HTMLSelectElement>('select[aria-label="Output Device"]')!;
    output.appendChild(Object.assign(document.createElement("option"), { value: "spk-2" }));
    output.value = "spk-2";
    output.dispatchEvent(new Event("change"));
    expect(setSinkId).toHaveBeenCalledWith("spk-2");

    const volume = el.querySelector<HTMLInputElement>('input[aria-label="Output Volume"]')!;
    volume.value = "25";
    volume.dispatchEvent(new Event("input"));
    expect(audio.volume).toBeCloseTo(0.25);
    ac.abort();
  });
});
