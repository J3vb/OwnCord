import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const supportsVP9 = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
  isWindowsDesktop: () => false,
  isAndroidApp: () => false,
}));
const nativeH264 = vi.hoisted(() => ({ value: true }));
const nativeVp9 = vi.hoisted(() => ({ value: false }));
vi.mock("../../src/features/voice/native/videoCodecs", () => ({
  nativeVideoCodecs: () =>
    Promise.resolve({ h264: nativeH264.value, vp9: nativeVp9.value, decode: [] }),
}));
// The Linux case waits for the codec probe, so the tab outlives the build:
// keep the native device lists and hot-plug watch off the real desktop host.
vi.mock("../../src/features/voice/native/devices", () => ({
  nativeAudioDevices: async () => null,
  nativeCameraDevices: async () => null,
  nativeCameraSupport: async () => null,
  onNativeDevicesChanged: () => null,
}));
// The Linux tab starts the meter's capture-only monitor on the host; a call
// holding the capture stands in for it here.
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/platform/desktop")>();
  return {
    ...original,
    desktop: {
      ...original.desktop,
      nativeVoice: {
        ...original.desktop.nativeVoice,
        onMicTestEvent: () => () => {},
        startMicTest: async () => {
          throw new Error("mic test unavailable during a call");
        },
      },
    },
  };
});
vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("livekit-client")>()),
  supportsVP9: () => supportsVP9(),
}));
vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: {
    supported: async () => true,
    captureKeyPress: async () => 0,
    stop: async () => {},
    updateKey: async () => {},
  },
}));
vi.mock("@lib/voice/livekitSession", () => ({
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  switchVideoDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  applyInputMode: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn(),
  reapplyEnhancedNoiseSuppression: vi.fn(),
  getLocalMicSettings: () => null,
  onNativeInputLevel: () => () => {},
}));

import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { installFakeAudio } from "../helpers/fakeAudioContext";

function codecOptions(): string[] {
  const ac = new AbortController();
  const el = createVoiceAudioTab(ac.signal).build();
  const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement | null;
  const values = select === null ? [] : [...select.options].map((o) => o.value);
  ac.abort();
  return values;
}

beforeEach(() => {
  localStorage.clear();
  isLinuxDesktop.mockReturnValue(false);
  nativeVp9.value = false;
  supportsVP9.mockReturnValue(true);
  installFakeAudio({ worklets: true });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VoiceAudioTab VP9 entry", () => {
  it("is shown where VP9 can be published", () => {
    expect(codecOptions()).toEqual(["vp8", "h264", "vp9", "auto"]);
  });

  it("is hidden when VP9 is not supported", () => {
    supportsVP9.mockReturnValue(false);
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("never offers VP9 on Linux when the native engine lacks it", async () => {
    isLinuxDesktop.mockReturnValue(true);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    await vi.waitFor(() => {
      const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["vp8", "h264", "auto"]);
    });
    ac.abort();
  });

  it("offers VP9 on Linux when the native engine has it", async () => {
    isLinuxDesktop.mockReturnValue(true);
    nativeVp9.value = true;
    // The webview's own check does not matter on Linux.
    supportsVP9.mockReturnValue(false);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    await vi.waitFor(() => {
      const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["vp8", "h264", "vp9", "auto"]);
    });
    ac.abort();
  });

  it("shows a saved VP9 that is no longer offered as VP8", () => {
    supportsVP9.mockReturnValue(false);
    localStorage.setItem("owncord:settings:videoCodec", '"vp9"');
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
    expect(select.value).toBe("vp8");
    ac.abort();
  });
});
