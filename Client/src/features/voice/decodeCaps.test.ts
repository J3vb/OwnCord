import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
vi.mock("./native/platform", () => ({
  isLinuxDesktop: () => isLinuxDesktop(),
  isWindowsDesktop: () => false,
}));

const nativeVideoCodecs = vi.hoisted(() => vi.fn());
vi.mock("./native/videoCodecs", () => ({ nativeVideoCodecs: () => nativeVideoCodecs() }));

const {
  BASELINE_DECODE,
  DEV_VP8_ONLY_KEY,
  localVideoDecode,
  pickCommonCodec,
  resetLocalVideoDecodeForTest,
} = await import("./decodeCaps");

function stubReceiver(mimeTypes: string[] | Error): ReturnType<typeof vi.fn> {
  const getCapabilities = vi.fn(() => {
    if (mimeTypes instanceof Error) throw mimeTypes;
    return { codecs: mimeTypes.map((mimeType) => ({ mimeType, clockRate: 90000 })) };
  });
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities });
  return getCapabilities;
}

function nativeDecodes(decode: string[]): void {
  nativeVideoCodecs.mockResolvedValue({ h264: false, vp9: false, decode });
}

beforeEach(() => {
  resetLocalVideoDecodeForTest();
  isLinuxDesktop.mockReturnValue(false);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("localVideoDecode", () => {
  it("maps mime types to lowercase names and drops non-codecs", async () => {
    stubReceiver([
      "video/VP8",
      "video/H264",
      "video/VP9",
      "video/H265",
      "video/rtx",
      "video/red",
      "video/ulpfec",
      "video/flexfec-03",
    ]);
    expect(await localVideoDecode()).toEqual(["vp8", "h264", "vp9", "h265"]);
  });

  it("excludes AV1, which E2EE cannot decrypt", async () => {
    stubReceiver(["video/VP8", "video/AV1"]);
    expect(await localVideoDecode()).not.toContain("av1");
  });

  it("always includes the baseline", async () => {
    stubReceiver(["video/VP9"]);
    expect(await localVideoDecode()).toEqual(expect.arrayContaining([...BASELINE_DECODE, "vp9"]));
  });

  it("falls back to the baseline when getCapabilities throws", async () => {
    stubReceiver(new Error("nope"));
    expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
  });

  it("falls back to the baseline without RTCRtpReceiver", async () => {
    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
  });

  describe("on the Linux desktop", () => {
    beforeEach(() => {
      isLinuxDesktop.mockReturnValue(true);
      nativeVideoCodecs.mockReset();
    });

    it("Linux reports vp9 when the native receiver lists it", async () => {
      nativeDecodes(["vp8", "h264", "vp9"]);
      const getCapabilities = stubReceiver(["video/H265"]);
      expect(await localVideoDecode()).toEqual(["vp8", "h264", "vp9"]);
      expect(getCapabilities).not.toHaveBeenCalled();
    });

    it("reports the baseline when the native receiver lists no vp9", async () => {
      nativeDecodes(["vp8", "h264"]);
      expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
    });

    it("a failed native probe reports the baseline", async () => {
      nativeVideoCodecs.mockRejectedValue(new Error("host gone"));
      expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
      nativeDecodes([]);
      expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
    });

    it("h265 and av1 from the probe are never reported on Linux", async () => {
      nativeDecodes(["vp8", "h264", "vp9", "h265", "av1"]);
      const codecs = await localVideoDecode();
      expect(codecs).not.toContain("h265");
      expect(codecs).not.toContain("av1");
      expect(codecs).toContain("vp9");
    });

    it("a probe that never answers reports the baseline without memoising it", async () => {
      vi.useFakeTimers();
      try {
        nativeVideoCodecs.mockReturnValue(new Promise(() => {}));
        const pending = localVideoDecode();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toEqual(BASELINE_DECODE);
        nativeDecodes(["vp8", "vp9"]);
        expect(await localVideoDecode()).toContain("vp9");
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves no timeout armed once the probe has answered", async () => {
      vi.useFakeTimers();
      try {
        nativeDecodes(["vp8", "vp9"]);
        expect(await localVideoDecode()).toContain("vp9");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves no timeout armed once the probe has failed", async () => {
      vi.useFakeTimers();
      try {
        nativeVideoCodecs.mockRejectedValue(new Error("host gone"));
        expect(await localVideoDecode()).toEqual(BASELINE_DECODE);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("memoises the native answer", async () => {
      nativeDecodes(["vp9"]);
      await localVideoDecode();
      await localVideoDecode();
      expect(nativeVideoCodecs).toHaveBeenCalledTimes(1);
    });

    it("the dev VP8-only flag wins over the native list", async () => {
      nativeDecodes(["vp8", "vp9"]);
      localStorage.setItem(DEV_VP8_ONLY_KEY, "1");
      expect(await localVideoDecode()).toEqual(["vp8"]);
    });
  });

  it("memoises the probe", async () => {
    const getCapabilities = stubReceiver(["video/VP9"]);
    await localVideoDecode();
    await localVideoDecode();
    expect(getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("forces VP8 only under the dev flag", async () => {
    stubReceiver(["video/VP9"]);
    localStorage.setItem(DEV_VP8_ONLY_KEY, "1");
    expect(await localVideoDecode()).toEqual(["vp8"]);
    localStorage.removeItem(DEV_VP8_ONLY_KEY);
    expect(await localVideoDecode()).toContain("vp9");
  });

  it("asks the receiver about video only", async () => {
    const getCapabilities = stubReceiver([]);
    getCapabilities.mockImplementation((kind: string) =>
      kind === "video" ? { codecs: [{ mimeType: "video/VP9", clockRate: 90000 }] } : { codecs: [] },
    );
    expect(await localVideoDecode()).toContain("vp9");
    expect(getCapabilities).toHaveBeenCalledExactlyOnceWith("video");
  });

  it("ignores the dev VP8-only flag outside a development build", async () => {
    stubReceiver(["video/VP9"]);
    localStorage.setItem(DEV_VP8_ONLY_KEY, "1");
    vi.stubEnv("DEV", false);
    try {
      expect(await localVideoDecode()).toContain("vp9");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores a storage that throws", async () => {
    stubReceiver(["video/VP9"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await localVideoDecode()).toContain("vp9");
  });
});

describe("pickCommonCodec", () => {
  it.each([
    ["no peers", "h264", [], "h264"],
    [
      "all decode it",
      "h264",
      [
        ["vp8", "h264"],
        ["h264", "vp9"],
      ],
      "h264",
    ],
    ["one VP8-only peer", "h264", [["vp8", "h264"], ["vp8"]], "vp8"],
    ["absent list is the baseline", "h264", [undefined], "h264"],
    ["empty list is the baseline", "h264", [[]], "h264"],
    ["unknown names are ignored", "h264", [["av2", "zzz"]], "vp8"],
    ["vp8 preferred stays vp8", "vp8", [["vp8"], undefined], "vp8"],
    ["vp9 alone", "vp9", [], "vp9"],
    ["vp9 with an unknown peer", "vp9", [undefined], "vp8"],
    ["vp9 with a baseline peer", "vp9", [["vp8", "h264"]], "vp8"],
    ["vp9 when every peer lists it", "vp9", [["vp8", "vp9"], ["vp9"]], "vp9"],
    ["h265 alone", "h265", [], "h265"],
    ["h265 with an unknown peer", "h265", [undefined], "vp8"],
    ["h265 with a baseline peer", "h265", [["vp8", "h264"]], "vp8"],
    ["h265 with a peer that lists only vp9", "h265", [["h265"], ["vp8", "vp9"]], "vp8"],
    [
      "h265 when every peer lists it",
      "h265",
      [
        ["vp8", "h265"],
        ["h265", "vp9"],
      ],
      "h265",
    ],
  ] as const)("%s", (_name, preferred, peers, expected) => {
    expect(pickCommonCodec(preferred, peers)).toBe(expected);
  });
});
