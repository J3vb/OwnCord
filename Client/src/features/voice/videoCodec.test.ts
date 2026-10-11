import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
vi.mock("./native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
}));

const { getVideoCodecPref, pickAutoCodec, resolveVideoCodec } = await import("./videoCodec");

const encodingInfo = vi.fn();

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickAutoCodec", () => {
  it("picks H.264 when the probe reports a supported, power-efficient encoder", () => {
    expect(pickAutoCodec({ supported: true, smooth: true, powerEfficient: true })).toBe("h264");
  });

  it("keeps VP8 when H.264 is supported but only in software", () => {
    expect(pickAutoCodec({ supported: true, smooth: true, powerEfficient: false })).toBe("vp8");
  });

  it("keeps VP8 when H.264 is not supported", () => {
    expect(pickAutoCodec({ supported: false, smooth: false, powerEfficient: false })).toBe("vp8");
  });

  it("keeps VP8 when there is no probe result", () => {
    expect(pickAutoCodec(null)).toBe("vp8");
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
});
