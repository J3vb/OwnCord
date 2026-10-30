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
  isWindowsDesktop: () => false,
}));
vi.mock("../../src/features/voice/native/videoCodecs", () => ({
  nativeVideoCodecs: () => Promise.resolve({ h264: true, vp9: false, decode: [] }),
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

describe("VoiceAudioTab H.265 entry", () => {
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

  it("never offers H.265 on Linux", async () => {
    isLinuxDesktop.mockReturnValue(true);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    await vi.waitFor(() => {
      const select = el.querySelector('select[aria-label="Video Codec"]') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["vp8", "h264", "auto"]);
    });
    ac.abort();
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

describe("VoiceAudioTab screen share fps note", () => {
  it("tells Linux users that Wayland caps a share at 60 fps", () => {
    isLinuxDesktop.mockReturnValue(true);
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    expect(el.querySelector("[data-testid='screen-fps-wayland-note']")?.textContent).toBe(
      "On a Wayland desktop, screen sharing is limited to 60 FPS.",
    );
    ac.abort();
  });

  it("has no Wayland note off Linux", () => {
    const ac = new AbortController();
    const el = createVoiceAudioTab(ac.signal).build();
    expect(el.querySelector("[data-testid='screen-fps-wayland-note']")).toBeNull();
    ac.abort();
  });
});
