import { describe, it, expect, vi, beforeEach } from "vitest";

const linux = vi.hoisted(() => ({ value: true }));
vi.mock("./platform", () => ({ isLinuxDesktop: () => linux.value }));
const videoCodecs = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/desktop", () => ({
  desktop: { nativeVoice: { videoCodecs } },
}));

import { nativeVideoCodecs, resetNativeVideoCodecsForTest } from "./videoCodecs";

const HAS = { h264: true, vp9: true, decode: ["vp8", "vp9"] };
const NONE = { h264: false, vp9: false, decode: [] };

beforeEach(() => {
  linux.value = true;
  videoCodecs.mockReset();
  videoCodecs.mockResolvedValue(HAS);
  resetNativeVideoCodecsForTest();
});

describe("nativeVideoCodecs", () => {
  it("reports the engine's answer and asks the host once", async () => {
    await expect(nativeVideoCodecs()).resolves.toEqual(HAS);
    await expect(nativeVideoCodecs()).resolves.toEqual(HAS);
    expect(videoCodecs).toHaveBeenCalledTimes(1);
  });

  it("asks again after a reset", async () => {
    await nativeVideoCodecs();
    resetNativeVideoCodecsForTest();
    videoCodecs.mockResolvedValue(NONE);
    await expect(nativeVideoCodecs()).resolves.toEqual(NONE);
    expect(videoCodecs).toHaveBeenCalledTimes(2);
  });

  it("reads a probe that throws as no H.264", async () => {
    videoCodecs.mockRejectedValue(new Error("host gone"));
    await expect(nativeVideoCodecs()).resolves.toEqual(NONE);
  });

  it("has no extra codecs off Linux and never asks the host", async () => {
    linux.value = false;
    await expect(nativeVideoCodecs()).resolves.toEqual(NONE);
    expect(videoCodecs).not.toHaveBeenCalled();
  });
});
