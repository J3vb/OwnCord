import { describe, expect, it } from "vitest";
import { readSenderSample, senderSample } from "./shareSenderStats";
import { senderText } from "../../components/video-grid/stream-info";

const shareTrack = (entries: Array<[string, Record<string, unknown>]>) => ({
  sender: { getStats: async () => new Map(entries) as unknown as RTCStatsReport },
  mediaStreamTrack: { getSettings: () => ({ frameRate: 120 }) },
});

describe("shareSenderStats (M-1)", () => {
  it("takes the fastest layer's rate and the top layer's size, limit and encoder", () => {
    const sample = senderSample(
      [
        { frameWidth: 640, frameHeight: 360, framesPerSecond: 30, qualityLimitationReason: "none" },
        {
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 24,
          qualityLimitationReason: "bandwidth",
          encoderImplementation: "SimulcastEncoderAdapter (libvpx, libvpx)",
          codecId: "c",
        },
      ],
      new Map([["c", "video/VP8"]]),
      119.6,
    );
    expect(sample).toEqual({
      captureFps: 120,
      sentFps: 30,
      width: 1920,
      height: 1080,
      limitation: "bandwidth",
      encoder: "SimulcastEncoderAdapter (libvpx, libvpx)",
      codec: "video/VP8",
    });
  });

  it("reads a paused layer's last size only when no layer is sending", () => {
    const paused = {
      frameWidth: 1920,
      frameHeight: 1080,
      active: false,
      encoderImplementation: "old",
    };
    const live = {
      frameWidth: 640,
      frameHeight: 360,
      active: true,
      encoderImplementation: "libvpx",
    };
    expect(senderSample([paused, live], new Map(), undefined)).toMatchObject({
      width: 640,
      encoder: "libvpx",
    });
    expect(senderSample([paused], new Map(), undefined)).toMatchObject({ width: 1920 });
  });

  it("prefers the rate actually captured over the one the capture opened at", async () => {
    const out: [string, Record<string, unknown>] = [
      "o",
      { type: "outbound-rtp", framesPerSecond: 59 },
    ];
    await expect(
      readSenderSample(shareTrack([["s", { type: "media-source", framesPerSecond: 60 }], out])),
    ).resolves.toMatchObject({ captureFps: 60, sentFps: 59 });
    await expect(readSenderSample(shareTrack([out]))).resolves.toMatchObject({ captureFps: 120 });
  });

  it("is empty with no layers yet, and null without a track", async () => {
    expect(senderSample([], new Map(), undefined)).toEqual({});
    await expect(readSenderSample(undefined)).resolves.toBeNull();
    await expect(readSenderSample({ mediaStreamTrack: {} })).resolves.toBeNull();
  });

  it.each([
    ["none", "Not limited"],
    ["cpu", "Limited by CPU"],
    ["bandwidth", "Limited by bandwidth"],
    ["other", "Limited by something else"],
  ])("names the %s limit", (limitation, text) => {
    expect(senderText({ limitation })).toBe(text);
  });

  it("joins capture rate, limit, codec and encoder; says when there is nothing to read", () => {
    expect(
      senderText({
        captureFps: 120,
        limitation: "cpu",
        codec: "video/H264",
        encoder: "NvEnc",
      }),
    ).toBe("Capture 120 fps · Limited by CPU · H264 · NvEnc");
    expect(senderText({})).toBe("");
    expect(senderText(null)).toBe("Encoder details not available");
  });
});
