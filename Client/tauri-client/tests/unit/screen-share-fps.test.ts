import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLoadPref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@stores/voice.store", () => ({
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
}));

import {
  getScreenShareFps,
  getEffectiveScreenShareFps,
  getScreenShareMaxBitrate,
  getScreenShareCaptureOptions,
  SCREENSHARE_PRESETS,
  SCREENSHARE_PUBLISH_BITRATES,
  type StreamQuality,
} from "@lib/screenShare";

describe("screen share FPS", () => {
  beforeEach(() => {
    mockLoadPref.mockReset();
    mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
  });

  describe("getScreenShareFps", () => {
    it("defaults to 30", () => {
      expect(getScreenShareFps()).toBe(30);
    });

    it("accepts 60 and 120", () => {
      mockLoadPref.mockReturnValue(60);
      expect(getScreenShareFps()).toBe(60);
      mockLoadPref.mockReturnValue(120);
      expect(getScreenShareFps()).toBe(120);
    });

    it("falls back to 30 on garbage values", () => {
      for (const garbage of [45, 0, -1, "60", null, undefined, NaN]) {
        mockLoadPref.mockReturnValue(garbage);
        expect(getScreenShareFps()).toBe(30);
      }
    });
  });

  describe("getEffectiveScreenShareFps", () => {
    it("keeps historical per-quality caps at the default 30", () => {
      expect(getEffectiveScreenShareFps("low", 30)).toBe(5);
      expect(getEffectiveScreenShareFps("medium", 30)).toBe(15);
      expect(getEffectiveScreenShareFps("high", 30)).toBe(30);
      expect(getEffectiveScreenShareFps("source", 30)).toBe(30);
    });

    it("applies explicit 60/120 overrides to every quality", () => {
      const qualities: StreamQuality[] = ["low", "medium", "high", "source"];
      for (const q of qualities) {
        expect(getEffectiveScreenShareFps(q, 60)).toBe(60);
        expect(getEffectiveScreenShareFps(q, 120)).toBe(120);
      }
    });
  });

  describe("getScreenShareMaxBitrate", () => {
    it("returns the base bitrate at 30 fps", () => {
      expect(getScreenShareMaxBitrate("high", 30)).toBe(SCREENSHARE_PUBLISH_BITRATES.high);
    });

    it("scales bitrate up for 60 and 120 fps", () => {
      expect(getScreenShareMaxBitrate("high", 60)).toBe(SCREENSHARE_PUBLISH_BITRATES.high * 1.5);
      expect(getScreenShareMaxBitrate("source", 120)).toBe(SCREENSHARE_PUBLISH_BITRATES.source * 2);
    });
  });

  describe("getScreenShareCaptureOptions", () => {
    it("injects frameRate into presets that have a resolution", () => {
      const opts = getScreenShareCaptureOptions("high", 60);
      expect(opts.resolution?.frameRate).toBe(60);
      expect(opts.resolution?.width).toBe(SCREENSHARE_PRESETS.high.resolution?.width);
      expect(opts.audio).toBe(true);
    });

    it("keeps the per-quality fps at the default setting", () => {
      expect(getScreenShareCaptureOptions("low", 30).resolution?.frameRate).toBe(5);
      expect(getScreenShareCaptureOptions("medium", 30).resolution?.frameRate).toBe(15);
    });

    it("returns a copy of the source preset at the default fps", () => {
      const opts = getScreenShareCaptureOptions("source", 30);
      expect(opts).not.toBe(SCREENSHARE_PRESETS.source);
      expect(opts.resolution).toBeUndefined();
      expect(opts.audio).toBe(true);
    });

    it("uses a zero-size resolution sentinel for source with explicit fps", () => {
      const opts = getScreenShareCaptureOptions("source", 120);
      expect(opts).not.toBe(SCREENSHARE_PRESETS.source);
      // Zero width/height = uncapped in livekit's constraint translation, and
      // a defined resolution stops the library injecting its 1080p30 default.
      expect(opts.resolution).toEqual({ width: 0, height: 0, frameRate: 120 });
      expect(opts.video).toEqual({ frameRate: 120 });
    });

    it("does not mutate the shared presets", () => {
      const before = SCREENSHARE_PRESETS.high.resolution?.frameRate;
      getScreenShareCaptureOptions("high", 120);
      expect(SCREENSHARE_PRESETS.high.resolution?.frameRate).toBe(before);
    });
  });
});
