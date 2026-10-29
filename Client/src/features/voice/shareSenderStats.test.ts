import { describe, expect, it } from "vitest";
import { readSenderSample, senderSample, senderSampleFromReport } from "./shareSenderStats";
import { layersText, senderText } from "../../components/video-grid/stream-info";

const shareTrack = (entries: Array<[string, Record<string, unknown>]>) => ({
  sender: { getStats: async () => new Map(entries) as unknown as RTCStatsReport },
  mediaStreamTrack: { getSettings: () => ({ frameRate: 120 }) },
});

type Entry = [string, Record<string, unknown>];
const report = (entries: Entry[]) => new Map(entries);
const layer = (id: string, at: number, extra: Record<string, unknown>): Entry => [
  id,
  { type: "outbound-rtp", kind: "video", timestamp: at, ...extra },
];
const source = (id: string, at: number, frames: number, extra = {}): Entry => [
  id,
  { type: "media-source", kind: "video", timestamp: at, frames, ...extra },
];

describe("shareSenderStats", () => {
  it("summarises the top sending layer, never a faster lower one", () => {
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
    expect(sample).toMatchObject({
      captureFps: 120,
      captureFpsSource: "configured",
      sentFps: 24,
      width: 1920,
      height: 1080,
      limitation: "bandwidth",
      encoder: "SimulcastEncoderAdapter (libvpx, libvpx)",
      codec: "video/VP8",
    });
    expect(sample.layers?.map((l) => [l.height, l.sentFps])).toEqual([
      [1080, 24],
      [360, 30],
    ]);
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
    // Its rate never stands in for the share's.
    expect(senderSample([paused], new Map(), undefined).sentFps).toBeUndefined();
  });

  it("prefers the rate actually captured over the one the capture opened at", async () => {
    const out: [string, Record<string, unknown>] = [
      "o",
      { type: "outbound-rtp", framesPerSecond: 59 },
    ];
    await expect(
      readSenderSample(shareTrack([["s", { type: "media-source", framesPerSecond: 60 }], out])),
    ).resolves.toMatchObject({ captureFps: 60, captureFpsSource: "measured", sentFps: 59 });
    await expect(readSenderSample(shareTrack([out]))).resolves.toMatchObject({
      captureFps: 120,
      captureFpsSource: "configured",
    });
  });

  it("is empty with no layers yet, and null without a track", async () => {
    expect(senderSample([], new Map(), undefined)).toEqual({
      captureFps: undefined,
      captureFpsSource: undefined,
      sentFps: undefined,
      width: undefined,
      height: undefined,
      limitation: undefined,
      encoder: undefined,
      codec: undefined,
      layers: undefined,
    });
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
    expect(senderText({ captureFps: 60, captureFpsSource: "configured" })).toBe(
      "Capture set to 60 fps",
    );
    expect(senderText({})).toBe("");
    expect(senderText(null)).toBe("Encoder details not available");
  });

  it("lists every layer only when there is more than one", () => {
    expect(
      layersText({
        layers: [
          { active: true, height: 1080, sentFps: 24 },
          { active: true, height: 720 },
          { active: false, height: 360, sentFps: 0 },
        ],
      }),
    ).toBe("1080p · 24 fps\n720p\n360p paused");
    expect(layersText({ layers: [{ active: true, height: 1080, sentFps: 24 }] })).toBe("");
    expect(layersText(null)).toBe("");
  });

  describe("rates from counter deltas (PR 2a)", () => {
    it("computes per-layer fps, bitrate and encode time over the interval", () => {
      const first = senderSampleFromReport(
        report([
          source("S", 1000, 100),
          layer("h", 1000, {
            rid: "h",
            mediaSourceId: "S",
            frameWidth: 1920,
            framesEncoded: 100,
            framesSent: 100,
            bytesSent: 1_000_000,
            totalEncodeTime: 1,
          }),
          layer("q", 1000, {
            rid: "q",
            mediaSourceId: "S",
            frameWidth: 1280,
            framesEncoded: 50,
            framesSent: 50,
            bytesSent: 200_000,
            totalEncodeTime: 0.5,
          }),
        ]),
        30,
      );
      const second = senderSampleFromReport(
        report([
          source("S", 3000, 220),
          layer("h", 3000, {
            rid: "h",
            mediaSourceId: "S",
            frameWidth: 1920,
            framesEncoded: 140,
            framesSent: 138,
            bytesSent: 2_500_000,
            totalEncodeTime: 1.4,
          }),
          layer("q", 3000, {
            rid: "q",
            mediaSourceId: "S",
            frameWidth: 1280,
            framesEncoded: 110,
            framesSent: 110,
            bytesSent: 500_000,
            totalEncodeTime: 0.8,
          }),
        ]),
        30,
        first.counters,
      );
      expect(second.sample).toMatchObject({
        captureFps: 60,
        captureFpsSource: "measured",
        sentFps: 19,
        width: 1920,
      });
      expect(second.sample.layers).toEqual([
        expect.objectContaining({
          rid: "h",
          sentFps: 19,
          encodedFps: 20,
          bitrateBps: 6_000_000,
          encodeMsPerFrame: 10,
        }),
        expect.objectContaining({
          rid: "q",
          sentFps: 30,
          encodedFps: 30,
          bitrateBps: 1_200_000,
          encodeMsPerFrame: 5,
        }),
      ]);
    });

    it("leaves a rate unavailable when counters reset or the clock runs backwards", () => {
      const first = senderSampleFromReport(
        report([layer("h", 2000, { frameWidth: 1920, framesSent: 500, bytesSent: 9_000 })]),
        undefined,
      );
      const reset = senderSampleFromReport(
        report([
          layer("h", 3000, {
            frameWidth: 1920,
            framesSent: 10,
            bytesSent: 100,
            framesPerSecond: 60,
          }),
        ]),
        undefined,
        first.counters,
      );
      expect(reset.sample.sentFps).toBeUndefined();
      expect(reset.sample.layers?.[0]?.bitrateBps).toBeUndefined();
      const outOfOrder = senderSampleFromReport(
        report([layer("h", 1000, { frameWidth: 1920, framesSent: 600, bytesSent: 9_500 })]),
        undefined,
        first.counters,
      );
      expect(outOfOrder.sample.sentFps).toBeUndefined();
    });

    it("joins the source by id, not by report order", () => {
      const { sample } = senderSampleFromReport(
        report([
          source("other", 1000, 0, { framesPerSecond: 5 }),
          source("mine", 1000, 0, { framesPerSecond: 60 }),
          layer("h", 1000, { mediaSourceId: "mine", frameWidth: 1920, framesPerSecond: 58 }),
        ]),
        30,
      );
      expect(sample).toMatchObject({ captureFps: 60, captureFpsSource: "measured" });
    });

    it("falls back to the configured rate when the source is ambiguous", () => {
      const { sample } = senderSampleFromReport(
        report([
          source("a", 1000, 0, { framesPerSecond: 5 }),
          source("b", 1000, 0, { framesPerSecond: 60 }),
          layer("h", 1000, { frameWidth: 1920, framesPerSecond: 58 }),
        ]),
        30,
      );
      expect(sample).toMatchObject({ captureFps: 30, captureFpsSource: "configured" });
    });

    it("excludes a paused top layer from the summary and keeps missing fields missing", () => {
      const { sample } = senderSampleFromReport(
        report([
          layer("f", 1000, { rid: "f", active: false, frameWidth: 1920, framesPerSecond: 0 }),
          layer("h", 1000, { rid: "h", active: true, frameWidth: 1280, framesPerSecond: 29 }),
          ["mic", { type: "outbound-rtp", kind: "audio", timestamp: 1000 }],
        ]),
        undefined,
      );
      expect(sample).toMatchObject({ sentFps: 29, width: 1280 });
      expect(sample.encoder).toBeUndefined();
      expect(sample.captureFps).toBeUndefined();
      expect(sample.layers?.map((l) => [l.rid, l.active])).toEqual([
        ["f", false],
        ["h", true],
      ]);
    });

    it("keeps counters per sender, so a new share starts clean", async () => {
      let frames = 100;
      let at = 1000;
      const sender = {
        getStats: async () =>
          new Map([
            layer("h", at, { frameWidth: 1920, framesSent: frames, framesPerSecond: 1 }),
          ]) as unknown as RTCStatsReport,
      };
      const track = { sender, mediaStreamTrack: { getSettings: () => ({ frameRate: 60 }) } };
      await expect(readSenderSample(track)).resolves.toMatchObject({ sentFps: 1 });
      frames = 220;
      at = 3000;
      await expect(readSenderSample(track)).resolves.toMatchObject({ sentFps: 60 });
      const fresh = { ...track, sender: { getStats: sender.getStats } };
      await expect(readSenderSample(fresh)).resolves.toMatchObject({ sentFps: 1 });
    });
  });
});
