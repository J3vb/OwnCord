import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const isWindowsDesktop = vi.hoisted(() => vi.fn(() => false));
vi.mock("./native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
  isWindowsDesktop: () => isWindowsDesktop(),
}));

const nativeH264 = vi.hoisted(() => ({ value: false }));
const nativeVp9 = vi.hoisted(() => ({ value: false }));
vi.mock("./native/videoCodecs", () => ({
  nativeVideoCodecs: () =>
    Promise.resolve({ h264: nativeH264.value, vp9: nativeVp9.value, decode: [] }),
}));

const supportsVP9 = vi.hoisted(() => vi.fn(() => true));
const supportsH265 = vi.hoisted(() => vi.fn(() => true));
vi.mock("livekit-client", () => ({
  supportsVP9: () => supportsVP9(),
  supportsH265: () => supportsH265(),
}));

const {
  getVideoCodecPref,
  gpuRenderer,
  h264GpuProfiles,
  h264GpuPublish,
  h264Offered,
  h265Offered,
  pickAutoCodec,
  resolveCodecChoice,
  resolveVideoCodec,
  vp9Available,
  vp9Offered,
} = await import("./videoCodec");
const { voiceStore, resetVoiceStore } = await import("../../stores/voice.store");
const { channelPeerDecode } = await import("./peerDecode");
const { authStore } = await import("../../stores/auth.store");

const encodingInfo = vi.fn();
const NVIDIA = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
const INTEL = "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
const HARDWARE = { supported: true, smooth: true, powerEfficient: true };

/** Makes WebGL report `renderer` as the GPU (null: no debug extension) and
 *  returns the getContext spy. */
function stubGpu(renderer: string | null): ReturnType<typeof vi.spyOn> {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const loseContext = vi.fn();
  const gl = {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info"
        ? renderer === null
          ? null
          : { UNMASKED_RENDERER_WEBGL }
        : name === "WEBGL_lose_context"
          ? { loseContext }
          : null,
    getParameter: (param: number) => (param === UNMASKED_RENDERER_WEBGL ? renderer : null),
  };
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(gl as unknown as WebGLRenderingContext);
}

/** A captured track whose settings report `width` x `height`. */
function track(width = 1280, height = 720): MediaStreamTrack {
  return { getSettings: () => ({ width, height }) } as unknown as MediaStreamTrack;
}

function savePref(value: string): void {
  localStorage.setItem("owncord:settings:videoCodec", JSON.stringify(value));
}

beforeEach(() => {
  localStorage.clear();
  isLinuxDesktop.mockReturnValue(false);
  isWindowsDesktop.mockReturnValue(false);
  nativeH264.value = false;
  nativeVp9.value = false;
  supportsVP9.mockReset();
  supportsVP9.mockReturnValue(true);
  supportsH265.mockReset();
  supportsH265.mockReturnValue(true);
  encodingInfo.mockReset();
  vi.stubGlobal("navigator", { mediaCapabilities: { encodingInfo } });
  stubGpu(NVIDIA);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickAutoCodec", () => {
  it("picks H.264 when the probe reports a supported, power-efficient encoder on a non-Intel GPU", () => {
    expect(pickAutoCodec(HARDWARE, NVIDIA)).toBe("h264");
    expect(pickAutoCodec(HARDWARE, "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11)")).toBe("h264");
  });

  it("keeps VP8 on Intel graphics: livekit-client cannot decrypt Intel Quick Sync H.264", () => {
    expect(pickAutoCodec(HARDWARE, INTEL)).toBe("vp8");
    expect(pickAutoCodec(HARDWARE, "ANGLE (Intel, Intel(R) UHD Graphics 620)")).toBe("vp8");
  });

  it("keeps VP8 when the GPU cannot be named", () => {
    expect(pickAutoCodec(HARDWARE, null)).toBe("vp8");
  });

  it("keeps VP8 when H.264 is supported but only in software", () => {
    expect(pickAutoCodec({ supported: true, smooth: true, powerEfficient: false }, NVIDIA)).toBe(
      "vp8",
    );
  });

  it("keeps VP8 when H.264 is not supported", () => {
    expect(pickAutoCodec({ supported: false, smooth: false, powerEfficient: false }, NVIDIA)).toBe(
      "vp8",
    );
  });

  it("keeps VP8 when there is no probe result", () => {
    expect(pickAutoCodec(null, NVIDIA)).toBe("vp8");
  });
});

describe("gpuRenderer", () => {
  it("names the GPU from WebGL's unmasked renderer, asking for the low-power one", () => {
    const getContext = stubGpu(INTEL);
    expect(gpuRenderer()).toBe(INTEL);
    // A laptop with two GPUs names its integrated one, the likelier encoder.
    expect(getContext).toHaveBeenCalledWith("webgl", { powerPreference: "low-power" });
  });

  it("is null without the debug renderer extension", () => {
    stubGpu(null);
    expect(gpuRenderer()).toBeNull();
  });

  it("is null without WebGL", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(gpuRenderer()).toBeNull();
  });
});

describe("getVideoCodecPref", () => {
  it("defaults to Auto", () => {
    expect(getVideoCodecPref()).toBe("auto");
  });

  it("keeps a saved VP8", () => {
    savePref("vp8");
    expect(getVideoCodecPref()).toBe("vp8");
  });

  it("reads a saved choice", () => {
    savePref("h264");
    expect(getVideoCodecPref()).toBe("h264");
    savePref("auto");
    expect(getVideoCodecPref()).toBe("auto");
  });

  it("reads a saved VP9", () => {
    savePref("vp9");
    expect(getVideoCodecPref()).toBe("vp9");
  });

  it("falls back to Auto for an unknown saved value", () => {
    savePref("av1");
    expect(getVideoCodecPref()).toBe("auto");
  });
});

describe("resolveVideoCodec with VP9", () => {
  beforeEach(() => {
    savePref("vp9");
  });

  it("publishes VP8 for a saved VP9 the settings no longer offer", async () => {
    supportsVP9.mockReturnValue(false);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP9 when supported and nobody else is in the channel, without probing", async () => {
    await expect(resolveVideoCodec(track(), 120, 12_000_000)).resolves.toBe("vp9");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  it("publishes VP9 when every peer reports decoding it", async () => {
    await expect(
      resolveVideoCodec(track(), 30, 1_700_000, () => [["vp8", "vp9"], ["vp9"]]),
    ).resolves.toBe("vp9");
  });

  it("falls back to VP8 when livekit-client cannot publish VP9", async () => {
    supportsVP9.mockReturnValue(false);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("falls back to VP8 when supportsVP9 throws, as without RTCRtpSender", async () => {
    supportsVP9.mockImplementation(() => {
      throw new ReferenceError("RTCRtpSender is not defined");
    });
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("reports the preferred codec beside the pick, for the live switch", async () => {
    await expect(resolveCodecChoice(track(), 30, 1_700_000)).resolves.toEqual({
      preferred: "vp9",
      codec: "vp9",
    });
    await expect(resolveCodecChoice(track(), 30, 1_700_000, () => [undefined])).resolves.toEqual({
      preferred: "vp9",
      codec: "vp8",
    });
  });

  it("falls back to VP8 with a peer whose decode list is unknown", async () => {
    await expect(resolveVideoCodec(track(), 30, 1_700_000, () => [undefined])).resolves.toBe("vp8");
  });

  it("falls back to VP8 with a VP8 and H.264 peer", async () => {
    await expect(resolveVideoCodec(track(), 30, 1_700_000, () => [["vp8", "h264"]])).resolves.toBe(
      "vp8",
    );
  });

  it("publishes VP8 on the Linux native engine", async () => {
    isLinuxDesktop.mockReturnValue(true);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });
});

describe("Linux native codec choice", () => {
  beforeEach(() => {
    isLinuxDesktop.mockReturnValue(true);
  });

  it("Linux publishes H.264 when chosen and the native encoder has it", async () => {
    nativeH264.value = true;
    savePref("h264");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
  });

  it("Linux falls back to VP8 when the native encoder lacks H.264", async () => {
    nativeH264.value = false;
    savePref("h264");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    // The saved choice is not rewritten: a build with H.264 honours it later.
    expect(getVideoCodecPref()).toBe("h264");
  });

  it("Auto is VP8 on Linux", async () => {
    nativeH264.value = true;
    encodingInfo.mockResolvedValue(HARDWARE);
    savePref("auto");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  it("maps a saved VP9 or H.265 to VP8 on Linux", async () => {
    nativeH264.value = true;
    for (const saved of ["vp9", "h265"]) {
      savePref(saved);
      // oxlint-disable-next-line no-await-in-loop -- one pref at a time
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    }
  });

  it("falls back to VP8 for a chosen H.264 when a peer cannot decode it", async () => {
    nativeH264.value = true;
    savePref("h264");
    await expect(resolveVideoCodec(track(), 30, 1_700_000, () => [["vp8"]])).resolves.toBe("vp8");
  });
});

describe("h264Offered", () => {
  it("is true off Linux", async () => {
    await expect(h264Offered()).resolves.toBe(true);
  });

  it("follows the native encoder on Linux", async () => {
    isLinuxDesktop.mockReturnValue(true);
    nativeH264.value = true;
    await expect(h264Offered()).resolves.toBe(true);
    nativeH264.value = false;
    await expect(h264Offered()).resolves.toBe(false);
  });
});

describe("vp9Offered", () => {
  it("is true where VP9 can be published", () => {
    expect(vp9Offered()).toBe(true);
  });

  it("is false when VP9 cannot be published", () => {
    supportsVP9.mockReturnValue(false);
    expect(vp9Offered()).toBe(false);
  });

  it("is false on Linux", () => {
    isLinuxDesktop.mockReturnValue(true);
    expect(vp9Offered()).toBe(false);
  });
});

describe("vp9Available", () => {
  it("is the webview's answer off Linux", async () => {
    await expect(vp9Available()).resolves.toBe(true);
    supportsVP9.mockReturnValue(false);
    await expect(vp9Available()).resolves.toBe(false);
  });

  it("follows the native encoder on Linux, not the webview", async () => {
    isLinuxDesktop.mockReturnValue(true);
    supportsVP9.mockReturnValue(false);
    nativeVp9.value = true;
    await expect(vp9Available()).resolves.toBe(true);
    nativeVp9.value = false;
    await expect(vp9Available()).resolves.toBe(false);
  });
});

describe("Linux VP9 choice", () => {
  beforeEach(() => {
    isLinuxDesktop.mockReturnValue(true);
    savePref("vp9");
  });

  afterEach(() => {
    nativeVp9.value = false;
  });

  it("publishes VP9 when chosen and the native encoder has it", async () => {
    nativeVp9.value = true;
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp9");
  });

  it("publishes VP8 for a saved VP9 when the native encoder lacks it, and keeps the pref", async () => {
    nativeVp9.value = false;
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    expect(getVideoCodecPref()).toBe("vp9");
  });

  it("keeps Auto on VP8 even when the native encoder has VP9", async () => {
    nativeVp9.value = true;
    savePref("auto");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });
});

describe("h265Offered", () => {
  it("is true with support, a non-Intel GPU and not Linux, in a release build too", () => {
    vi.stubEnv("DEV", false);
    try {
      expect(h265Offered()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is false when H.265 cannot be published", () => {
    supportsH265.mockReturnValue(false);
    expect(h265Offered()).toBe(false);
  });

  it("is false when supportsH265 throws, as without RTCRtpSender", () => {
    supportsH265.mockImplementation(() => {
      throw new ReferenceError("RTCRtpSender is not defined");
    });
    expect(h265Offered()).toBe(false);
  });

  it("is false on Intel graphics and when the GPU cannot be named", () => {
    stubGpu(INTEL);
    expect(h265Offered()).toBe(false);
    stubGpu(null);
    expect(h265Offered()).toBe(false);
  });

  it("is false on Linux", () => {
    isLinuxDesktop.mockReturnValue(true);
    expect(h265Offered()).toBe(false);
  });
});

describe("resolveVideoCodec with H.265", () => {
  beforeEach(() => {
    savePref("h265");
    encodingInfo.mockResolvedValue(HARDWARE);
  });

  it("reads a saved H.265", () => {
    expect(getVideoCodecPref()).toBe("h265");
  });

  it("publishes H.265 when offered and the encoder is power efficient, probing H.265", async () => {
    await expect(resolveVideoCodec(track(1920, 1080), 60, 8_000_000)).resolves.toBe("h265");
    expect(encodingInfo).toHaveBeenCalledWith({
      type: "webrtc",
      video: {
        contentType: "video/H265",
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 60,
      },
    });
  });

  it("publishes H.265 when every peer decodes it, else VP8", async () => {
    await expect(
      resolveVideoCodec(track(), 30, 1_700_000, () => [["vp8", "h265"], ["h265"]]),
    ).resolves.toBe("h265");
    await expect(resolveVideoCodec(track(), 30, 1_700_000, () => [["vp8", "h264"]])).resolves.toBe(
      "vp8",
    );
    await expect(resolveCodecChoice(track(), 30, 1_700_000, () => [undefined])).resolves.toEqual({
      preferred: "h265",
      codec: "vp8",
    });
  });

  it.each([
    ["only in software", { supported: true, smooth: true, powerEfficient: false }],
    ["not supported", { supported: false, smooth: false, powerEfficient: false }],
  ])("publishes VP8 when the encoder is %s", async (_name, probe) => {
    encodingInfo.mockResolvedValue(probe);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP8 when the probe fails", async () => {
    encodingInfo.mockRejectedValue(new TypeError("bad configuration"));
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP8 when H.265 is not offered, without probing", async () => {
    supportsH265.mockReturnValue(false);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  it("publishes VP8 on Intel graphics", async () => {
    stubGpu(INTEL);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP8 on Linux", async () => {
    isLinuxDesktop.mockReturnValue(true);
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP8 when supportsH265 throws", async () => {
    supportsH265.mockImplementation(() => {
      throw new ReferenceError("RTCRtpSender is not defined");
    });
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("never lets Auto pick H.265", async () => {
    savePref("auto");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
  });
});

describe("h264GpuProfiles", () => {
  it("is true in the Windows app on a non-Intel GPU", () => {
    isWindowsDesktop.mockReturnValue(true);
    expect(h264GpuProfiles()).toBe(true);
  });

  it("is false off the Windows app", () => {
    expect(h264GpuProfiles()).toBe(false);
  });

  it("is false on Intel graphics and when the GPU cannot be named", () => {
    isWindowsDesktop.mockReturnValue(true);
    vi.restoreAllMocks();
    stubGpu(INTEL);
    expect(h264GpuProfiles()).toBe(false);
    vi.restoreAllMocks();
    stubGpu(null);
    expect(h264GpuProfiles()).toBe(false);
  });
});

describe("h264GpuProfiles on a software renderer", () => {
  it("is false for SwiftShader, the Basic Render Driver and llvmpipe", () => {
    isWindowsDesktop.mockReturnValue(true);
    for (const renderer of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
    ]) {
      vi.restoreAllMocks();
      stubGpu(renderer);
      expect(h264GpuProfiles()).toBe(false);
    }
  });
});

describe("h264GpuPublish", () => {
  it("is true only for an H.264 publish where the GPU profiles apply", () => {
    isWindowsDesktop.mockReturnValue(true);
    expect(h264GpuPublish("h264")).toBe(true);
    expect(h264GpuPublish("vp8")).toBe(false);
    expect(h264GpuPublish("vp9")).toBe(false);
    expect(h264GpuPublish("h265")).toBe(false);
  });

  it("is false for H.264 off the Windows app", () => {
    expect(h264GpuPublish("h264")).toBe(false);
  });
});

describe("resolveVideoCodec", () => {
  it("publishes a saved VP8 without probing", async () => {
    savePref("vp8");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  describe("a saved H.264 off Linux", () => {
    beforeEach(() => savePref("h264"));

    it("publishes H.264 when the probe reports a hardware encoder", async () => {
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(3440, 1440), 30, 8_000_000)).resolves.toBe("h264");
      expect(encodingInfo).toHaveBeenCalledWith({
        type: "webrtc",
        video: {
          contentType: "video/H264",
          width: 3440,
          height: 1440,
          bitrate: 8_000_000,
          framerate: 30,
        },
      });
    });

    it("publishes VP8 when the probe reports a software encoder", async () => {
      encodingInfo.mockResolvedValue({ supported: true, smooth: false, powerEfficient: false });
      await expect(resolveVideoCodec(track(3440, 1440), 30, 8_000_000)).resolves.toBe("vp8");
    });

    it("publishes VP8 when the probe reports H.264 unsupported", async () => {
      encodingInfo.mockResolvedValue({ supported: false, smooth: false, powerEfficient: true });
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    });

    it("keeps H.264 when the probe rejects", async () => {
      encodingInfo.mockRejectedValue(new TypeError("unsupported config"));
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
    });

    it("keeps H.264 where MediaCapabilities is missing", async () => {
      vi.stubGlobal("navigator", {});
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
    });

    it("keeps H.264 without probing in the Windows app on a non-Intel GPU", async () => {
      isWindowsDesktop.mockReturnValue(true);
      encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 60, 8_000_000)).resolves.toBe("h264");
      expect(encodingInfo).not.toHaveBeenCalled();
    });

    it("still probes in the Windows app on Intel graphics", async () => {
      isWindowsDesktop.mockReturnValue(true);
      vi.restoreAllMocks();
      stubGpu(INTEL);
      encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 60, 8_000_000)).resolves.toBe("vp8");
      expect(encodingInfo).toHaveBeenCalled();
    });
  });

  describe("Auto in the Windows app", () => {
    beforeEach(() => isWindowsDesktop.mockReturnValue(true));

    it("publishes GPU H.264 without probing on a non-Intel GPU", async () => {
      encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 30, 3_000_000)).resolves.toBe("h264");
      expect(encodingInfo).not.toHaveBeenCalled();
    });

    it("keeps VP8 on Intel graphics", async () => {
      vi.restoreAllMocks();
      stubGpu(INTEL);
      encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 30, 3_000_000)).resolves.toBe("vp8");
    });

    it("keeps VP8 on a software renderer", async () => {
      vi.restoreAllMocks();
      stubGpu("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)");
      encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 30, 3_000_000)).resolves.toBe("vp8");
    });
  });

  it("probes H.264 for WebRTC at the captured size, frame rate and bitrate on Auto", async () => {
    savePref("auto");
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });

    await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("h264");

    expect(encodingInfo).toHaveBeenCalledWith({
      type: "webrtc",
      video: {
        contentType: "video/H264",
        width: 1920,
        height: 1080,
        bitrate: 12_000_000,
        framerate: 120,
      },
    });
  });

  it("keeps VP8 on Auto on Intel graphics even when the hardware encoder is available", async () => {
    savePref("auto");
    stubGpu(INTEL);
    encodingInfo.mockResolvedValue(HARDWARE);

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("keeps VP8 on Auto when the GPU cannot be named", async () => {
    savePref("auto");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    encodingInfo.mockResolvedValue(HARDWARE);

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("still publishes H.264 on Intel graphics when the user picked it", async () => {
    savePref("h264");
    stubGpu(INTEL);
    encodingInfo.mockResolvedValue(HARDWARE);

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
  });

  it("falls back to VP8 on Auto when the hardware cannot take this size and rate", async () => {
    savePref("auto");
    encodingInfo.mockResolvedValue({ supported: true, smooth: false, powerEfficient: false });

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("falls back to VP8 on Auto when the probe rejects", async () => {
    savePref("auto");
    encodingInfo.mockRejectedValue(new TypeError("unsupported config"));

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("falls back to VP8 on Auto where MediaCapabilities is missing", async () => {
    savePref("auto");
    vi.stubGlobal("navigator", {});

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
  });

  it("publishes VP8 on the Linux native path when the encoder lacks H.264, whatever is saved", async () => {
    isLinuxDesktop.mockReturnValue(true);
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    for (const saved of ["h264", "auto"]) {
      savePref(saved);
      // oxlint-disable-next-line no-await-in-loop -- one pref at a time
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    }
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  describe("at 120 fps", () => {
    beforeEach(() => savePref("vp8"));

    it("uses Auto's hardware rule when the saved choice is VP8", async () => {
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("h264");
      expect(encodingInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ width: 1920, height: 1080, framerate: 120 }),
        }),
      );
    });

    it("keeps VP8 on Intel graphics", async () => {
      stubGpu(INTEL);
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("vp8");
    });

    it("keeps VP8 when the hardware cannot take 120 fps", async () => {
      encodingInfo.mockResolvedValue({ supported: true, smooth: false, powerEfficient: false });
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("vp8");
    });

    it("keeps a saved H.264 the hardware probe accepts", async () => {
      savePref("h264");
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("h264");
      expect(encodingInfo).toHaveBeenCalledTimes(1);
    });

    it("does not probe a saved VP8 at 60 fps", async () => {
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(1920, 1080), 60, 3_000_000)).resolves.toBe("vp8");
      expect(encodingInfo).not.toHaveBeenCalled();
    });

    it("stays VP8 on the Linux native path", async () => {
      isLinuxDesktop.mockReturnValue(true);
      encodingInfo.mockResolvedValue(HARDWARE);
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("vp8");
      expect(encodingInfo).not.toHaveBeenCalled();
    });
  });
});

function inChannel(peers: Record<number, readonly string[] | undefined>): void {
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 1, username: "me", avatar: null, role: "member" },
  }));
  const users = new Map(
    [1, ...Object.keys(peers).map(Number)].map((userId) => [
      userId,
      { userId, username: `u${userId}` } as never,
    ]),
  );
  const decode = new Map(
    Object.entries(peers).flatMap(([id, list]) => (list ? [[Number(id), list] as const] : [])),
  );
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: 4,
    voiceUsers: new Map([[4, users]]),
    peerVideoDecode: decode,
  }));
}

describe("resolveVideoCodec with channel peers", () => {
  beforeEach(() => {
    resetVoiceStore();
    encodingInfo.mockResolvedValue(HARDWARE);
  });

  it("downgrades a saved H.264 to VP8 for a VP8-only peer", async () => {
    savePref("h264");
    inChannel({ 2: ["vp8"] });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe("vp8");
  });

  it("keeps H.264 for a peer whose list is unknown", async () => {
    savePref("h264");
    inChannel({ 2: undefined });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe(
      "h264",
    );
  });

  it("keeps H.264 when every peer decodes it", async () => {
    savePref("h264");
    inChannel({ 2: ["vp8", "h264"], 3: ["vp8", "h264", "vp9"] });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe(
      "h264",
    );
  });

  it("ignores its own entry", async () => {
    savePref("h264");
    inChannel({ 1: ["vp8"] });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe(
      "h264",
    );
  });

  it("still gives VP8 on the Linux native engine without an H.264 encoder", async () => {
    isLinuxDesktop.mockReturnValue(true);
    savePref("h264");
    inChannel({ 2: ["vp8", "h264"] });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe("vp8");
  });
});

describe("codec choice details", () => {
  it("releases the WebGL context it opened to read the renderer name", () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn((name: string) =>
      name === "WEBGL_debug_renderer_info"
        ? { UNMASKED_RENDERER_WEBGL: 0x9246 }
        : name === "WEBGL_lose_context"
          ? { loseContext }
          : null,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension,
      getParameter: () => NVIDIA,
    } as unknown as WebGLRenderingContext);

    expect(gpuRenderer()).toBe(NVIDIA);

    expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("does not let the Windows GPU-profile shortcut override a saved VP8 or VP9", async () => {
    isWindowsDesktop.mockReturnValue(true);
    encodingInfo.mockResolvedValue(HARDWARE);

    savePref("vp8");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");

    savePref("vp9");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp9");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  it("does not open a WebGL context for Auto when the encoder probe has no answer", async () => {
    savePref("auto");
    encodingInfo.mockRejectedValue(new TypeError("unsupported config"));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    getContext.mockClear();

    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");

    expect(getContext).not.toHaveBeenCalled();
  });
});
