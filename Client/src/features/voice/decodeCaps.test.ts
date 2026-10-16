import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
vi.mock("./native/platform", () => ({ isLinuxDesktop: () => isLinuxDesktop() }));

const {
  BASELINE_DECODE,
  DEV_H265_OPTION_KEY,
  DEV_VP8_ONLY_KEY,
  devShowsH265,
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

beforeEach(() => {
  resetLocalVideoDecodeForTest();
  isLinuxDesktop.mockReturnValue(false);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("devShowsH265", () => {
  it("is on with the flag in a development build", () => {
    localStorage.setItem(DEV_H265_OPTION_KEY, "1");
    expect(devShowsH265()).toBe(true);
  });

  it("stays off in a release build even with the flag set", () => {
    vi.stubEnv("DEV", false);
    try {
      localStorage.setItem(DEV_H265_OPTION_KEY, "1");
      expect(devShowsH265()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("localVideoDecode", () => {
  it("maps mime types to lowercase names and drops non-codecs", () => {
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
    expect(localVideoDecode()).toEqual(["vp8", "h264", "vp9", "h265"]);
  });

  it("excludes AV1, which E2EE cannot decrypt", () => {
    stubReceiver(["video/VP8", "video/AV1"]);
    expect(localVideoDecode()).not.toContain("av1");
  });

  it("always includes the baseline", () => {
    stubReceiver(["video/VP9"]);
    expect(localVideoDecode()).toEqual(expect.arrayContaining([...BASELINE_DECODE, "vp9"]));
  });

  it("falls back to the baseline when getCapabilities throws", () => {
    stubReceiver(new Error("nope"));
    expect(localVideoDecode()).toEqual(BASELINE_DECODE);
  });

  it("falls back to the baseline without RTCRtpReceiver", () => {
    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(localVideoDecode()).toEqual(BASELINE_DECODE);
  });

  it("reports the fixed baseline on the Linux desktop without probing", () => {
    isLinuxDesktop.mockReturnValue(true);
    const getCapabilities = stubReceiver(["video/VP9"]);
    expect(localVideoDecode()).toEqual(BASELINE_DECODE);
    expect(getCapabilities).not.toHaveBeenCalled();
  });

  it("memoises the probe", () => {
    const getCapabilities = stubReceiver(["video/VP9"]);
    localVideoDecode();
    localVideoDecode();
    expect(getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("forces VP8 only under the dev flag", () => {
    stubReceiver(["video/VP9"]);
    localStorage.setItem(DEV_VP8_ONLY_KEY, "1");
    expect(localVideoDecode()).toEqual(["vp8"]);
    localStorage.removeItem(DEV_VP8_ONLY_KEY);
    expect(localVideoDecode()).toContain("vp9");
  });

  it("ignores a storage that throws", () => {
    stubReceiver(["video/VP9"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(localVideoDecode()).toContain("vp9");
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
