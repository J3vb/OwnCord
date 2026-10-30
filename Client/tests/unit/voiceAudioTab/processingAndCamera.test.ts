import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/voiceAudioTabMocks";
import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { GATE_LOOKAHEAD_S } from "@lib/voice/micProcessor";
import { expectConsole } from "../../helpers/console";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  installFakeAudio,
} from "../../helpers/fakeAudioContext";
import { stubNavigator } from "../../helpers/voiceAudioTabHarness";

vi.mock("../../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockSwitchVideoDevice,
  mockSetVoiceSensitivity,
  mockReapplyAudioProcessing,
  mockReapplyEnhancedNoiseSuppression,
  mockApplyInputMode,
  mockPttStop,
  mockPttUpdateKey,
} = mocks;

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

  it("Automatically play cameras is on by default and saves its choice", () => {
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

  it("does not register a new permanent abort listener on every rebuild", () => {
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

describe("VoiceAudioTab input mode", () => {
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

describe("VoiceAudioTab mic test", () => {
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

  it("lets Output Volume go to 200% and shows a saved 150% as 150%", async () => {
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
