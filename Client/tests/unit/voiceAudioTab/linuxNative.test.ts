import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/voiceAudioTabMocks";
import { vadThreshold } from "@lib/voice/audioPipeline";
import type { NativeMicTestEnvelope } from "../../../src/platform/contracts/nativeVoice";
import * as appLogger from "@lib/logger";
import { expectConsole } from "../../helpers/console";
import { nativeLevelListener } from "../../helpers/voiceAudioTabMocks";
import { VOLUME_SLIDERS } from "../../helpers/voiceAudioTabHarness";

vi.mock("../../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockSetVoiceSensitivity,
  mockSetInputVolume,
  mockUnsubscribeNativeLevel,
  mockApplyInputMode,
} = mocks;

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
    vi.doMock("../../../src/features/voice/native/videoCodecs", () => ({
      nativeVideoCodecs: () => nativeVideoCodecs() as unknown,
    }));
    vi.doMock("@lib/logger", () => appLogger);
    vi.doMock("../../../src/features/voice/native/platform", () => ({
      isLinuxDesktop: () => true,
    }));
    vi.doMock("../../../src/features/voice/native/devices", () => ({
      nativeAudioDevices: async (kind: string) =>
        kind === "audioinput"
          ? [{ deviceId: "guid-mic", label: "USB Mic", kind }]
          : [{ deviceId: "guid-spk", label: speakersLabel, kind }],
      nativeCameraDevices: (...args: unknown[]) => nativeCameraDevices(...args),
      nativeCameraSupport: (...args: unknown[]) => nativeCameraSupport(...args),
      onNativeDevicesChanged: (handler: () => void) => onNativeDevicesChanged(handler) as unknown,
    }));
    vi.doMock("../../../src/platform/desktop", () => ({
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
    vi.doMock("../../../src/features/voice/native/videoRenderer", () => ({
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
