import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const supportsH265 = vi.hoisted(() => vi.fn(() => true));
const NVIDIA = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
const INTEL = "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";

/** Makes WebGL report `renderer` as the GPU. */
function stubGpu(renderer: string): void {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const gl = {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info"
        ? { UNMASKED_RENDERER_WEBGL }
        : name === "WEBGL_lose_context"
          ? { loseContext: () => {} }
          : null,
    getParameter: () => renderer,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    gl as unknown as WebGLRenderingContext,
  );
}

vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
}));
vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("livekit-client")>()),
  supportsVP9: () => false,
  supportsH265: () => supportsH265(),
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
  supportsH265.mockReturnValue(true);
  stubGpu(NVIDIA);
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
  vi.restoreAllMocks();
});

describe("VoiceAudioTab H.265 entry (WP M-6)", () => {
  it("is shown where H.265 can be published", () => {
    expect(codecOptions()).toEqual(["vp8", "h264", "h265", "auto"]);
  });

  it("is hidden on Intel graphics", () => {
    stubGpu(INTEL);
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("is hidden when H.265 is not supported", () => {
    supportsH265.mockReturnValue(false);
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("is never shown on Linux: the whole codec choice is hidden", () => {
    isLinuxDesktop.mockReturnValue(true);
    expect(codecOptions()).toEqual([]);
  });

  it("shows a saved H.265 that is no longer offered as VP8", () => {
    supportsH265.mockReturnValue(false);
    localStorage.setItem("owncord:settings:videoCodec", '"h265"');
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
    expect(select.value).toBe("vp8");
    ac.abort();
  });
});
