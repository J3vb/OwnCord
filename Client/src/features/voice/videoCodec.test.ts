import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
vi.mock("./native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
}));

const { getVideoCodecPref, gpuRenderer, pickAutoCodec, resolveVideoCodec } =
  await import("./videoCodec");
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
  it("defaults to VP8", () => {
    expect(getVideoCodecPref()).toBe("vp8");
  });

  it("reads a saved choice", () => {
    savePref("h264");
    expect(getVideoCodecPref()).toBe("h264");
    savePref("auto");
    expect(getVideoCodecPref()).toBe("auto");
  });

  it("falls back to VP8 for an unknown saved value", () => {
    savePref("av1");
    expect(getVideoCodecPref()).toBe("vp8");
  });
});

describe("resolveVideoCodec", () => {
  it("publishes VP8 by default without probing", async () => {
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  it("publishes H.264 when the user picked it, without probing", async () => {
    savePref("h264");
    await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("h264");
    expect(encodingInfo).not.toHaveBeenCalled();
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

  it("always publishes VP8 on the Linux native path, whatever is saved", async () => {
    isLinuxDesktop.mockReturnValue(true);
    encodingInfo.mockResolvedValue({ supported: true, smooth: true, powerEfficient: true });
    for (const saved of ["h264", "auto"]) {
      savePref(saved);
      // oxlint-disable-next-line no-await-in-loop -- one pref at a time
      await expect(resolveVideoCodec(track(), 30, 1_700_000)).resolves.toBe("vp8");
    }
    expect(encodingInfo).not.toHaveBeenCalled();
  });

  describe("at 120 fps (M-2)", () => {
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

    it("keeps a saved H.264 without probing", async () => {
      savePref("h264");
      await expect(resolveVideoCodec(track(1920, 1080), 120, 12_000_000)).resolves.toBe("h264");
      expect(encodingInfo).not.toHaveBeenCalled();
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
  beforeEach(() => resetVoiceStore());

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

  it("still gives VP8 on the Linux native engine", async () => {
    isLinuxDesktop.mockReturnValue(true);
    savePref("h264");
    inChannel({ 2: ["vp8", "h264"] });
    await expect(resolveVideoCodec(track(), 30, 5_000_000, channelPeerDecode)).resolves.toBe("vp8");
  });
});
