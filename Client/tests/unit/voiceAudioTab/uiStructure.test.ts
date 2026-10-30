import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/voiceAudioTabMocks";
import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { vadThreshold } from "@lib/voice/audioPipeline";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  installFakeAudio,
} from "../../helpers/fakeAudioContext";
import {
  VOLUME_SLIDERS,
  emitDeviceChange,
  stubNavigator,
} from "../../helpers/voiceAudioTabHarness";

vi.mock("../../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockSwitchInputDevice,
  mockSwitchOutputDevice,
  mockSetVoiceSensitivity,
  mockSetInputVolume,
  mockSetOutputVolume,
  mockGetLocalMicSettings,
  mockApplyInputMode,
} = mocks;

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

  it("video codec select offers VP8, H.264 and Auto, defaults to Auto and saves the choice", () => {
    stubNavigator();
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);

    const codecSelect = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
    expect([...codecSelect.options].map((o) => o.value)).toEqual(["vp8", "h264", "auto"]);
    expect(codecSelect.value).toBe("auto");
    expect(localStorage.getItem("owncord:settings:videoCodec")).toBeNull();
    codecSelect.value = "vp8";
    codecSelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("owncord:settings:videoCodec")).toBe('"vp8"');
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

  it("video codec select shows the saved choice, and Auto for an unknown one", () => {
    stubNavigator();
    localStorage.setItem("owncord:settings:videoCodec", '"h264"');
    const ac = new AbortController();
    let el = createVoiceAudioTab(ac.signal).build();
    expect((el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement).value).toBe(
      "h264",
    );

    localStorage.setItem("owncord:settings:videoCodec", '"vp8"');
    el = createVoiceAudioTab(ac.signal).build();
    expect((el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement).value).toBe(
      "vp8",
    );

    localStorage.setItem("owncord:settings:videoCodec", '"av1"');
    el = createVoiceAudioTab(ac.signal).build();
    expect((el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement).value).toBe(
      "auto",
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
});
