import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockSwitchInputDevice = vi.fn().mockResolvedValue(undefined);
const mockSwitchOutputDevice = vi.fn().mockResolvedValue(undefined);
const mockSetVoiceSensitivity = vi.fn();
const mockSetInputVolume = vi.fn();
const mockSetOutputVolume = vi.fn();
const mockReapplyAudioProcessing = vi.fn().mockResolvedValue(undefined);
const mockReapplyEnhancedNoiseSuppression = vi.fn().mockResolvedValue(undefined);
const mockGetLocalMicSettings = vi.fn((): MediaTrackSettings | null => null);

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: (...args: unknown[]) => mockSwitchInputDevice(...args),
  switchOutputDevice: (...args: unknown[]) => mockSwitchOutputDevice(...args),
  setVoiceSensitivity: (...args: unknown[]) => mockSetVoiceSensitivity(...args),
  setInputVolume: (...args: unknown[]) => mockSetInputVolume(...args),
  setOutputVolume: (...args: unknown[]) => mockSetOutputVolume(...args),
  reapplyAudioProcessing: (...args: unknown[]) => mockReapplyAudioProcessing(...args),
  reapplyEnhancedNoiseSuppression: (...args: unknown[]) =>
    mockReapplyEnhancedNoiseSuppression(...args),
  getLocalMicSettings: () => mockGetLocalMicSettings(),
}));

import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { vadThreshold } from "@lib/audioPipeline";
// vi.resetModules() below would hand the re-imported module a fresh logger,
// which re-installs the logger's app-lifetime pref-change listener on every
// reset. Those tests re-import against this already-loaded instance instead,
// so the singleton stays one.
import * as appLogger from "@lib/logger";
import { expectConsole } from "../helpers/console";
import { FakeAudioWorkletNode, installFakeAudio } from "../helpers/fakeAudioContext";

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
    // video = 6 selects
    expect(selects.length).toBe(6);
    ac.abort();
  });

  it("contains input volume and output volume sliders", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(2); // input volume + output volume
    ac.abort();
  });

  it("input volume slider calls setInputVolume on change", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const sliders = el.querySelectorAll('input[type="range"]') as NodeListOf<HTMLInputElement>;
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

    const sliders = el.querySelectorAll('input[type="range"]') as NodeListOf<HTMLInputElement>;
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

    const sliders = el.querySelectorAll('input[type="range"]') as NodeListOf<HTMLInputElement>;
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

    const sliders = el.querySelectorAll('input[type="range"]') as NodeListOf<HTMLInputElement>;
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
    expect(qualitySelect.value).toBe("high");
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

    it("groups the tab into Microphone, Speakers, Camera & screen share and Voice processing", () => {
      const { el, ac } = build();
      const titles = [...el.querySelectorAll(".settings-card-head h3")].map((h) => h.textContent);
      expect(titles).toEqual([
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
      const { el, ac } = build();
      const value = el.querySelector<HTMLElement>("[data-testid='sensitivity-value']")!;
      expect(value.textContent).toBe("50%");
      el.querySelector(".mic-meter-threshold")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
      expect(value.textContent).toBe("45%");
      ac.abort();
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

    const settingRows = el.querySelectorAll(".setting-row");
    // 4 toggles: echo cancellation, noise suppression, auto gain control, enhanced NS
    expect(settingRows.length).toBe(4);
    ac.abort();
  });

  it("audio toggle calls reapplyAudioProcessing when changed", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Toggles are divs with class "toggle" (not buttons)
    const toggleDiv = el.querySelector(".setting-row .toggle") as HTMLElement;
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

    await vi.waitFor(() => {
      const preview = el.querySelector("video") as HTMLVideoElement;
      expect(preview.srcObject).toBe(cameraStream);
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
    // user re-opens the Voice & Audio tab (e.g. hide()/show() cycles):
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
  beforeEach(async () => {
    vi.resetModules();
    startCameraPreview
      .mockReset()
      .mockResolvedValue({ width: 320, height: 180, frames: "ws://127.0.0.1:9/tok" });
    stopCameraPreview.mockReset().mockResolvedValue(undefined);
    nativeCameraDevices
      .mockReset()
      .mockResolvedValue([{ deviceId: "cam-1", label: "Camera", kind: "videoinput" }]);
    nativeCameraSupport.mockReset().mockResolvedValue({ available: true, missing: [] });
    vi.doMock("@lib/logger", () => appLogger);
    vi.doMock("../../src/features/voice/native/platform", () => ({ isLinuxDesktop: () => true }));
    vi.doMock("../../src/features/voice/native/devices", () => ({
      nativeAudioDevices: async (kind: string) =>
        kind === "audioinput"
          ? [{ deviceId: "guid-mic", label: "USB Mic", kind }]
          : [{ deviceId: "guid-spk", label: "Speakers", kind }],
      nativeCameraDevices: (...args: unknown[]) => nativeCameraDevices(...args),
      nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
    }));
    vi.doMock("../../src/platform/desktop", () => ({
      desktop: {
        nativeVoice: {
          startCameraPreview: (...args: unknown[]) => startCameraPreview(...args) as unknown,
          stopCameraPreview: (...args: unknown[]) => stopCameraPreview(...args) as unknown,
        },
      },
    }));
    vi.doMock("../../src/features/voice/native/videoRenderer", () => ({
      NativeVideoRenderer: class {
        readonly mediaStreamTrack = { stop: vi.fn(), dispatchEvent: vi.fn() };
        constructor(readonly url: string) {}
        dispose() {}
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
    vi.doUnmock("../../src/platform/desktop");
    vi.doUnmock("../../src/features/voice/native/videoRenderer");
    vi.doUnmock("@lib/logger");
    vi.unstubAllGlobals();
  });

  async function mount() {
    const { createVoiceAudioTab: create } = await import("@components/settings/VoiceAudioTab");
    const ac = new AbortController();
    const element = create(ac.signal).build();
    document.body.appendChild(element);
    await new Promise((r) => setTimeout(r, 0));
    return { element };
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

  it("hides the input volume and sensitivity controls and explains why", async () => {
    const tab = await mount();
    const headings = [...tab.element.querySelectorAll(".settings-field-label")].map(
      (h) => h.textContent,
    );
    expect(headings).not.toContain("Input Volume");
    expect(headings).not.toContain("Input Sensitivity");
    // The engine's playout mixer applies output volume.
    expect(headings).toEqual(
      expect.arrayContaining(["Input Device", "Output Device", "Output Volume"]),
    );
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
    const note = tab.element.querySelector('[data-testid="native-audio-note"]');
    expect(note?.textContent).toContain("system mixer");
    expect(tab.element.querySelector(".mic-meter-wrap")).toBeNull();
    // The native engine acquires no audio through the webview. The camera
    // preview may still call getUserMedia (video only) since voice #22 starts
    // it on the default device; no audio request may occur.
    for (const call of getUserMedia.mock.calls) {
      expect((call[0] as MediaStreamConstraints).audio).toBe(false);
    }
  });

  it("tells the user the processing toggles apply on the next join", async () => {
    const tab = await mount();
    const descs = [...tab.element.querySelectorAll(".setting-desc")].map((d) => d.textContent);
    expect(
      descs.filter((d) => d?.endsWith("Applies when you next join a voice channel.")),
    ).toHaveLength(4);
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
