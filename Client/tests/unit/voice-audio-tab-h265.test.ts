import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as codecMocks from "../helpers/voiceCodecTabMocks";

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

vi.mock("../../src/features/voice/native/platform", () =>
  codecMocks.nativePlatformMock(() => isLinuxDesktop()),
);
vi.mock("../../src/features/voice/native/videoCodecs", () => ({
  nativeVideoCodecs: () => Promise.resolve({ h264: true, vp9: false, decode: [] }),
}));
vi.mock("../../src/features/voice/native/devices", () => codecMocks.nativeDevicesMock());
vi.mock("../../src/platform/desktop", (importOriginal) =>
  codecMocks.desktopMicTestBusyMock(importOriginal),
);
vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("livekit-client")>()),
  supportsVP9: () => false,
  supportsH265: () => supportsH265(),
}));
vi.mock("../../src/platform/desktop/pushToTalk", () => codecMocks.inertPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => codecMocks.reapplyAudioSessionMock());

import { installFakeAudio } from "../helpers/fakeAudioContext";
import {
  buildTab,
  codecOptions,
  expectCodecsEventually,
  shownCodecFor,
} from "../helpers/voiceCodecTab";

beforeEach(() => {
  localStorage.clear();
  isLinuxDesktop.mockReturnValue(false);
  supportsH265.mockReturnValue(true);
  stubGpu(NVIDIA);
  installFakeAudio({ worklets: true });
  codecMocks.stubEmptyMediaDevices();
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
    await expectCodecsEventually(["vp8", "h264", "auto"]);
  });

  it("shows a saved H.265 that is no longer offered as VP8", () => {
    supportsH265.mockReturnValue(false);
    expect(shownCodecFor("h265")).toBe("vp8");
  });
});

describe("VoiceAudioTab screen share fps note", () => {
  it("tells Linux users that Wayland caps a share at 60 fps", () => {
    isLinuxDesktop.mockReturnValue(true);
    const { ac, el } = buildTab();
    expect(el.querySelector("[data-testid='screen-fps-wayland-note']")?.textContent).toBe(
      "On a Wayland desktop, screen sharing is limited to 60 FPS.",
    );
    ac.abort();
  });

  it("has no Wayland note off Linux", () => {
    const { ac, el } = buildTab();
    expect(el.querySelector("[data-testid='screen-fps-wayland-note']")).toBeNull();
    ac.abort();
  });
});
