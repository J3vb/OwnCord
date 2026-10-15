import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const supportsVP9 = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
}));
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
vi.mock("@lib/livekitSession", () => ({
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
import { DEV_VP9_OPTION_KEY } from "../../src/features/voice/decodeCaps";
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

describe("VoiceAudioTab VP9 entry (WP M-5a)", () => {
  it("is hidden without the dev flag", () => {
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("is shown with the dev flag where VP9 can be published", () => {
    localStorage.setItem(DEV_VP9_OPTION_KEY, "1");
    expect(codecOptions()).toEqual(["vp8", "h264", "vp9", "auto"]);
  });

  it("stays hidden with the dev flag when VP9 is not supported", () => {
    localStorage.setItem(DEV_VP9_OPTION_KEY, "1");
    supportsVP9.mockReturnValue(false);
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("is never shown on Linux: the whole codec choice is hidden", () => {
    localStorage.setItem(DEV_VP9_OPTION_KEY, "1");
    isLinuxDesktop.mockReturnValue(true);
    expect(codecOptions()).toEqual([]);
  });

  it("shows a saved VP9 that is no longer offered as VP8", () => {
    localStorage.setItem("owncord:settings:videoCodec", '"vp9"');
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
    expect(select.value).toBe("vp8");
    ac.abort();
  });
});
