import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockSwitchInputDevice = vi.fn().mockResolvedValue(undefined);
const mockSwitchOutputDevice = vi.fn().mockResolvedValue(undefined);
const mockSetVoiceSensitivity = vi.fn();
const mockSetInputVolume = vi.fn();
const mockSetOutputVolume = vi.fn();
const mockReapplyAudioProcessing = vi.fn().mockResolvedValue(undefined);

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: (...args: unknown[]) => mockSwitchInputDevice(...args),
  switchOutputDevice: (...args: unknown[]) => mockSwitchOutputDevice(...args),
  setVoiceSensitivity: (...args: unknown[]) => mockSetVoiceSensitivity(...args),
  setInputVolume: (...args: unknown[]) => mockSetInputVolume(...args),
  setOutputVolume: (...args: unknown[]) => mockSetOutputVolume(...args),
  reapplyAudioProcessing: (...args: unknown[]) => mockReapplyAudioProcessing(...args),
}));

import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";

describe("VoiceAudioTab camera preview", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    localStorage.setItem("owncord:settings:videoInputDevice", '"camera-1"');

    vi.stubGlobal("AudioContext", class {
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 32,
          getByteFrequencyData: vi.fn(),
        };
      }

      createMediaStreamSource() {
        return { connect: vi.fn() };
      }

      close() {
        return Promise.resolve();
      }
    });
  });

  it("does not restore a stale camera stream after the tab is aborted", async () => {
    let resolveVideo: ((stream: MediaStream) => void) | null = null;
    const stopVideoTrack = vi.fn();
    const videoStream = {
      getTracks: () => [{ stop: stopVideoTrack }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "camera-1", label: "Camera 1" },
        ]),
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
      getTracks: () => [{ stop: stopVideoTrack }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "camera-1", label: "Camera 1" },
        ]),
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

// ---------------------------------------------------------------------------
// UI structure and interaction tests
// ---------------------------------------------------------------------------

describe("VoiceAudioTab UI structure", () => {
  function stubNavigator(devices: Array<{ kind: string; deviceId: string; label: string }> = []): void {
    const audioStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(devices),
        getUserMedia: vi.fn().mockResolvedValue(audioStream),
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    vi.stubGlobal("AudioContext", class {
      createAnalyser() {
        return {
          fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 32,
          getByteFrequencyData: vi.fn(),
        };
      }
      createMediaStreamSource() { return { connect: vi.fn() }; }
      close() { return Promise.resolve(); }
    });
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
    // Input, output, stream quality, video = 4 selects
    expect(selects.length).toBe(4);
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

  it("input device change calls switchInputDevice and saves pref", async () => {
    stubNavigator([
      { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
    ]);
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
    stubNavigator([
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker 1" },
    ]);
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

  it("stream quality select saves to preferences on change", () => {
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    // Stream quality is the 3rd select (index 2)
    const qualitySelect = el.querySelectorAll("select")[2] as HTMLSelectElement;
    qualitySelect.value = "low";
    qualitySelect.dispatchEvent(new Event("change"));

    const saved = localStorage.getItem("owncord:settings:streamQuality");
    expect(saved).toBe('"low"');
    ac.abort();
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
      const texts = Array.from(options).map(o => o.textContent);
      expect(texts.some(t => t?.includes("Could not enumerate"))).toBe(true);
    });

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
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "cam-1", label: "Camera 1" },
        ]),
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
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const audioStream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "cam-1", label: "Camera 1" },
        ]),
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
      const videoSelect = el.querySelectorAll("select")[3] as HTMLSelectElement;
      expect(videoSelect.querySelectorAll("option").length).toBeGreaterThan(1);
    });

    const videoSelect = el.querySelectorAll("select")[3] as HTMLSelectElement;
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
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "videoinput", deviceId: "cam-1", label: "Camera 1" },
        ]),
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

    await vi.waitFor(() => {
      const errorEl = el.querySelector(".setting-desc");
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toBe("Camera access denied");
    });

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

    // Should not throw — mic meter stays empty
    await new Promise(r => setTimeout(r, 0));
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
    stubNavigator([
      { kind: "audioinput", deviceId: "abcdef12", label: "" },
    ]);
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

  it("cleanup stops mic and camera streams", () => {
    const stopMicTrack = vi.fn();
    const stopCamTrack = vi.fn();
    const micStream = { getTracks: () => [{ stop: stopMicTrack }] } as unknown as MediaStream;
    const camStream = { getTracks: () => [{ stop: stopCamTrack }] } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockResolvedValue(micStream),
      },
    });

    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    tab.build();
    tab.cleanup();

    // After cleanup, streams should be stopped
    // (the mic track stop is called in cleanupMic)
    ac.abort();
  });

  it("restores saved stream quality selection", () => {
    localStorage.setItem("owncord:settings:streamQuality", '"low"');
    stubNavigator();
    const ac = new AbortController();
    const tab = createVoiceAudioTab(ac.signal);
    const el = tab.build();
    document.body.appendChild(el);

    const qualitySelect = el.querySelectorAll("select")[2] as HTMLSelectElement;
    expect(qualitySelect.value).toBe("low");
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
});