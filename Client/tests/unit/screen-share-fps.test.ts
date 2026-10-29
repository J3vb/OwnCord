import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLoadPref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
}));

vi.mock("@lib/preferences", () => ({
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
  bumpLocalShareRev: vi.fn(),
}));

import {
  getScreenShareFps,
  getEffectiveScreenShareFps,
  getScreenShareMaxBitrate,
  getScreenShareCaptureOptions,
  getCameraQuality,
  getScreenShareQuality,
  isScreenShareSimulcast,
  cameraSimulcastLayers,
  videoLayerOptions,
  screenShareDegradation,
  screenVideoPublishOptions,
  SCREENSHARE_PRESETS,
  SCREENSHARE_SIMULCAST_LAYERS,
  SCREENSHARE_PUBLISH_BITRATES,
  type StreamQuality,
} from "@lib/screenShare";

const SCREENSHARE_AUDIO_CAPTURE = {
  restrictOwnAudio: true,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

function setPolicy(value: unknown): void {
  mockLoadPref.mockImplementation((key: string, defaultVal: unknown) =>
    key === "shareMotionPolicy" ? value : defaultVal,
  );
}

describe("screen share FPS", () => {
  beforeEach(() => {
    mockLoadPref.mockReset();
    mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
  });

  describe("getScreenShareFps", () => {
    it("defaults to 30", () => {
      expect(getScreenShareFps()).toBe(30);
    });

    it("accepts 60, and reads a saved 120 as 60 while 120 is hidden", () => {
      mockLoadPref.mockReturnValue(60);
      expect(getScreenShareFps()).toBe(60);
      mockLoadPref.mockReturnValue(120);
      expect(getScreenShareFps()).toBe(60);
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
      expect(getEffectiveScreenShareFps("medium", 30)).toBe(30);
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

  describe("screen share quality presets", () => {
    it("captures medium at 720p30 and high at 1080p30", () => {
      expect(getScreenShareCaptureOptions("medium", 30).resolution).toMatchObject({
        width: 1280,
        height: 720,
        frameRate: 30,
      });
      expect(getScreenShareCaptureOptions("high", 30).resolution).toMatchObject({
        width: 1920,
        height: 1080,
        frameRate: 30,
      });
    });

    it("defaults the screen share to medium (720p30), read from its own pref", () => {
      expect(getScreenShareQuality()).toBe("medium");
      expect(mockLoadPref).toHaveBeenCalledWith("screenShareQuality", "medium");
    });

    it("keeps the camera on the streamQuality pref, defaulting to medium (720p)", () => {
      expect(getCameraQuality()).toBe("medium");
      expect(mockLoadPref).toHaveBeenCalledWith("streamQuality", "medium");
    });

    it("reads the two prefs independently and rejects garbage", () => {
      mockLoadPref.mockImplementation((key: string) =>
        key === "screenShareQuality" ? "source" : "low",
      );
      expect(getScreenShareQuality()).toBe("source");
      expect(getCameraQuality()).toBe("low");
      mockLoadPref.mockReturnValue("ultra");
      expect(getScreenShareQuality()).toBe("medium");
      expect(getCameraQuality()).toBe("medium");
    });

    it("simulcasts medium and high only", () => {
      expect(isScreenShareSimulcast("low", 30)).toBe(false);
      expect(isScreenShareSimulcast("medium", 30)).toBe(true);
      expect(isScreenShareSimulcast("high", 30)).toBe(true);
      expect(isScreenShareSimulcast("source", 30)).toBe(false);
    });

    it("drops the lower layer for High at 120 fps, as Source does", () => {
      // Encoding both layers in turn held a 1080p120 share to 40-50 fps.
      expect(isScreenShareSimulcast("high", 120)).toBe(false);
      expect(isScreenShareSimulcast("high", 60)).toBe(true);
      expect(isScreenShareSimulcast("medium", 120)).toBe(true);
    });

    it("adds one text-friendly 720p layer of at most 1.2 Mbps and 15 fps", () => {
      expect(SCREENSHARE_SIMULCAST_LAYERS).toHaveLength(1);
      const [layer] = SCREENSHARE_SIMULCAST_LAYERS;
      expect(layer).toMatchObject({ width: 1280, height: 720 });
      expect(layer!.encoding.maxBitrate).toBeLessThanOrEqual(1_200_000);
      expect(layer!.encoding.maxFramerate).toBe(15);
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

  describe("screenShareDegradation", () => {
    it("is balanced only at 120 fps", () => {
      expect(screenShareDegradation(120)).toBe("balanced");
      for (const fps of [5, 30, 60]) {
        expect(screenShareDegradation(fps)).toBe("maintain-resolution");
      }
    });
  });

  describe("getScreenShareCaptureOptions", () => {
    it("injects frameRate into presets that have a resolution", () => {
      const opts = getScreenShareCaptureOptions("high", 60);
      expect(opts.resolution?.frameRate).toBe(60);
      expect(opts.resolution?.width).toBe(SCREENSHARE_PRESETS.high.resolution?.width);
      expect(opts.audio).toEqual(SCREENSHARE_AUDIO_CAPTURE);
    });

    it("keeps the per-quality fps at the default setting", () => {
      expect(getScreenShareCaptureOptions("low", 30).resolution?.frameRate).toBe(5);
      expect(getScreenShareCaptureOptions("medium", 30).resolution?.frameRate).toBe(30);
    });

    it("returns a copy of the source preset at the default fps", () => {
      const opts = getScreenShareCaptureOptions("source", 30);
      expect(opts).not.toBe(SCREENSHARE_PRESETS.source);
      expect(opts.resolution).toBeUndefined();
      expect(opts.audio).toEqual(SCREENSHARE_AUDIO_CAPTURE);
    });

    it("captures screen audio unprocessed and stereo, excluding the call itself", () => {
      for (const quality of ["low", "medium", "high", "source"] as const) {
        expect(getScreenShareCaptureOptions(quality, 30).audio).toEqual(SCREENSHARE_AUDIO_CAPTURE);
        expect(SCREENSHARE_PRESETS[quality].audio).toEqual(SCREENSHARE_AUDIO_CAPTURE);
      }
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

describe("videoLayerOptions", () => {
  it.each(["low", "medium", "high", "source"] as const)(
    "gives a VP9 camera at %s no simulcast and no layers",
    (quality) => {
      expect(videoLayerOptions("camera", "vp9", quality, 30)).toEqual({ simulcast: false });
    },
  );

  it.each([
    ["low", 30],
    ["medium", 30],
    ["high", 30],
    ["high", 120],
    ["source", 60],
  ] as const)(
    "gives a VP9 screen share at %s %i fps no simulcast and no layers",
    (quality, fps) => {
      expect(videoLayerOptions("screen", "vp9", quality, fps)).toEqual({ simulcast: false });
    },
  );

  it.each(["vp8", "h264", "h265"] as const)("keeps today's camera options for %s", (codec) => {
    expect(videoLayerOptions("camera", codec, "low", 15)).toEqual({ simulcast: true });
    expect(videoLayerOptions("camera", codec, "medium", 30)).toEqual({ simulcast: true });
    expect(videoLayerOptions("camera", codec, "source", 30)).toEqual({ simulcast: false });
    expect(videoLayerOptions("camera", codec, "high", 30)).toEqual({
      simulcast: true,
      videoSimulcastLayers: cameraSimulcastLayers("high"),
    });
  });

  it.each(["vp8", "h264", "h265"] as const)(
    "keeps today's screen share options for %s",
    (codec) => {
      expect(videoLayerOptions("screen", codec, "medium", 30)).toEqual({
        simulcast: true,
        screenShareSimulcastLayers: [...SCREENSHARE_SIMULCAST_LAYERS],
      });
      expect(videoLayerOptions("screen", codec, "high", 60)).toEqual({
        simulcast: true,
        screenShareSimulcastLayers: [...SCREENSHARE_SIMULCAST_LAYERS],
      });
      expect(videoLayerOptions("screen", codec, "high", 120)).toEqual({ simulcast: false });
      expect(videoLayerOptions("screen", codec, "low", 30)).toEqual({ simulcast: false });
      expect(videoLayerOptions("screen", codec, "source", 30)).toEqual({ simulcast: false });
    },
  );
  describe("shareMotionPolicy test arm", () => {
    const QUALITIES = ["low", "medium", "high", "source"] as const;
    const ARMS = [
      ["detail-balanced", "detail", "balanced"],
      ["detail-framerate", "detail", "maintain-framerate"],
      ["motion-resolution", "motion", "maintain-resolution"],
      ["motion-balanced", "motion", "balanced"],
      ["motion-framerate", "motion", "maintain-framerate"],
    ] as const;

    it("legacy leaves capture options and degradation exactly as before", () => {
      for (const quality of QUALITIES) {
        const opts = getScreenShareCaptureOptions(quality, 30);
        expect(opts.contentHint).toBe(SCREENSHARE_PRESETS[quality].contentHint);
      }
      expect(getScreenShareCaptureOptions("low", 30).contentHint).toBeUndefined();
      expect(screenVideoPublishOptions("vp8", "high", 30).degradationPreference).toBe(
        "maintain-resolution",
      );
      expect(screenVideoPublishOptions("vp8", "source", 120).degradationPreference).toBe(
        "balanced",
      );
    });

    it.each(ARMS)("%s sets hint %s and degradation %s for every quality", (policy, hint, deg) => {
      setPolicy(policy);
      for (const quality of QUALITIES) {
        expect(getScreenShareCaptureOptions(quality, 30).contentHint).toBe(hint);
        expect(screenVideoPublishOptions("vp8", quality, 30).degradationPreference).toBe(deg);
      }
      expect(getScreenShareCaptureOptions("source", 60).contentHint).toBe(hint);
    });

    it("does not touch the rest of the capture options", () => {
      const before = getScreenShareCaptureOptions("high", 60);
      setPolicy("motion-balanced");
      const after = getScreenShareCaptureOptions("high", 60);
      expect({ ...after, contentHint: before.contentHint }).toEqual(before);
    });

    it("an unknown stored value behaves as legacy", () => {
      setPolicy("sideways");
      expect(getScreenShareCaptureOptions("low", 30).contentHint).toBeUndefined();
      expect(screenVideoPublishOptions("vp8", "medium", 30).degradationPreference).toBe(
        "maintain-resolution",
      );
    });
  });
});
