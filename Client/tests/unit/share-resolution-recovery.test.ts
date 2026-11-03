import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COOLDOWN_MS,
  STUCK_MS,
  fullCaptureWidth,
  initialRecoveryState,
  readingFromStats,
  recoveryStep,
  watchShareResolutionRecovery,
  type RecoveryReading,
  type RecoveryState,
  type RecoveryTrack,
} from "@lib/voice/shareResolutionRecovery";

/** A share stuck at 320 px of a 2560 px capture, held back for bandwidth. */
function reading(over: Partial<RecoveryReading> = {}): RecoveryReading {
  return {
    now: 0,
    fullWidth: 2560,
    width: 320,
    targetBitrate: 300_000,
    limitation: "bandwidth",
    ...over,
  };
}

/** Feed readings in order; returns the final state and every nudge time. */
function run(readings: RecoveryReading[]): { state: RecoveryState; nudges: number[] } {
  let state = initialRecoveryState;
  const nudges: number[] = [];
  for (const r of readings) {
    const step = recoveryStep(state, r);
    state = step.state;
    if (step.nudge) nudges.push(r.now);
  }
  return { state, nudges };
}

describe("recoveryStep", () => {
  it("nudges a share stuck small after its bitrate came back", () => {
    const { nudges } = run([
      reading({ now: 0 }),
      reading({ now: STUCK_MS - 1, targetBitrate: 5_000_000 }),
      reading({ now: STUCK_MS, targetBitrate: 5_000_000 }),
    ]);
    expect(nudges).toEqual([STUCK_MS]);
  });

  it("leaves a share alone while its bitrate stays low", () => {
    const { nudges } = run([
      reading({ now: 0 }),
      reading({ now: STUCK_MS, targetBitrate: 500_000 }),
      reading({ now: 2 * STUCK_MS, targetBitrate: 590_000 }),
    ]);
    expect(nudges).toEqual([]);
  });

  it("leaves a share alone that is not held back for bandwidth", () => {
    const { nudges } = run([
      reading({ now: 0, limitation: "none" }),
      reading({ now: STUCK_MS, targetBitrate: 5_000_000, limitation: "none" }),
      reading({ now: STUCK_MS, targetBitrate: 5_000_000, limitation: "cpu" }),
    ]);
    expect(nudges).toEqual([]);
  });

  it("leaves a share at (nearly) its full size alone", () => {
    const { nudges } = run([
      reading({ now: 0, width: 2400 }),
      reading({ now: STUCK_MS, width: 2400, targetBitrate: 5_000_000 }),
    ]);
    expect(nudges).toEqual([]);
  });

  it("restarts the stuck clock whenever the size changes", () => {
    const { nudges } = run([
      reading({ now: 0 }),
      reading({ now: STUCK_MS - 1000, width: 480 }),
      reading({ now: STUCK_MS, width: 480, targetBitrate: 5_000_000 }),
      reading({ now: 2 * STUCK_MS - 1000, width: 480, targetBitrate: 5_000_000 }),
    ]);
    expect(nudges).toEqual([2 * STUCK_MS - 1000]);
  });

  it("waits out the cooldown before nudging again", () => {
    const high = { targetBitrate: 5_000_000 };
    const { nudges } = run([
      reading({ now: 0 }),
      reading({ now: STUCK_MS, ...high }),
      // Fell back to the same size straight after the restart.
      reading({ now: STUCK_MS + 1000, ...high }),
      reading({ now: STUCK_MS + 1000 + STUCK_MS, targetBitrate: 300_000 }),
      reading({ now: STUCK_MS + COOLDOWN_MS - 1, ...high }),
      reading({ now: STUCK_MS + COOLDOWN_MS, ...high }),
    ]);
    expect(nudges).toEqual([STUCK_MS, STUCK_MS + COOLDOWN_MS]);
  });
});

describe("readingFromStats", () => {
  const outbound = { type: "outbound-rtp", kind: "video", targetBitrate: 1_000_000 };

  it("judges the layer that should be widest, scaled by its encoding", () => {
    const r = readingFromStats(
      [
        { ...outbound, rid: "q", frameWidth: 320 },
        { ...outbound, rid: "f", frameWidth: 640, qualityLimitationReason: "bandwidth" },
        { type: "media-source", kind: "video", frameWidth: 2560 },
      ],
      [
        { rid: "q", scaleResolutionDownBy: 2 },
        { rid: "f", scaleResolutionDownBy: 1 },
      ],
      2560,
      7,
    );
    expect(r).toEqual({
      now: 7,
      fullWidth: 2560,
      width: 640,
      targetBitrate: 1_000_000,
      limitation: "bandwidth",
    });
  });

  it("skips a paused layer, judging the lower one against its own scale", () => {
    const r = readingFromStats(
      [
        { ...outbound, rid: "q", frameWidth: 1280 },
        { ...outbound, rid: "f", frameWidth: 2560, active: false },
      ],
      [
        { rid: "q", scaleResolutionDownBy: 2 },
        { rid: "f", scaleResolutionDownBy: 1 },
      ],
      2560,
      0,
    );
    expect(r).toMatchObject({ fullWidth: 1280, width: 1280 });
  });

  it("judges the larger-budget layer when two layers share a size", () => {
    const encodings = [
      { rid: "q", scaleResolutionDownBy: 1, maxBitrate: 1_200_000 },
      { rid: "h", scaleResolutionDownBy: 1, maxBitrate: 3_000_000 },
    ];
    const q = { ...outbound, rid: "q", frameWidth: 640 };
    const h = { ...outbound, rid: "h", frameWidth: 320 };
    expect(readingFromStats([q, h], encodings, 1280, 0)).toMatchObject({ width: 320 });
    expect(readingFromStats([h, q], encodings, 1280, 0)).toMatchObject({ width: 320 });
  });

  it("skips a layer the allocator gave no bitrate", () => {
    expect(
      readingFromStats([{ ...outbound, frameWidth: 320, targetBitrate: 0 }], [{}], 2560, 0),
    ).toBeNull();
  });

  it("has nothing to judge before the encoder reports a size and target", () => {
    expect(readingFromStats([{ ...outbound, frameWidth: undefined }], [{}], 2560, 0)).toBeNull();
    expect(readingFromStats([{ type: "outbound-rtp", kind: "audio" }], [{}], 2560, 0)).toBeNull();
  });
});

describe("fullCaptureWidth", () => {
  function mst(over: Partial<Record<string, unknown>>): MediaStreamTrack {
    return {
      getSettings: () => ({ width: 320, height: 200 }),
      getCapabilities: () => ({ width: { max: 2560 }, height: { max: 1600 } }),
      getConstraints: () => ({}),
      ...over,
    } as unknown as MediaStreamTrack;
  }

  it("is the shared surface's size, not the shrunk settings", () => {
    expect(fullCaptureWidth(mst({}))).toBe(2560);
  });

  it("fits the surface into the size the share asked for", () => {
    const capped = mst({
      getConstraints: () => ({ width: { ideal: 1920 }, height: { ideal: 1080 } }),
    });
    // 2560x1600 into 1920x1080: the height decides, 1728x1080.
    expect(fullCaptureWidth(capped)).toBe(1728);
  });

  it("falls back to the settings without capabilities", () => {
    expect(fullCaptureWidth(mst({ getCapabilities: undefined }))).toBe(320);
  });
});

describe("watchShareResolutionRecovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rig(): {
    track: RecoveryTrack;
    setPref: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
    row: { frameWidth: number; targetBitrate: number; qualityLimitationReason: string };
    source: { width: number };
  } {
    const row = { frameWidth: 320, targetBitrate: 300_000, qualityLimitationReason: "bandwidth" };
    const source = { width: 2560 };
    const getStats = vi.fn(() =>
      Promise.resolve(new Map([["o", { type: "outbound-rtp", kind: "video", ...row }]])),
    );
    const sender = {
      getStats,
      getParameters: () => ({ encodings: [{}] }),
    } as unknown as RTCRtpSender;
    const setPref = vi.fn(() => Promise.resolve());
    const mst = {
      getSettings: () => ({ width: source.width, height: 180 }),
      getCapabilities: () => ({ width: { max: 2560 }, height: { max: 1440 } }),
      getConstraints: () => ({}),
    } as unknown as MediaStreamTrack;
    return {
      track: { sender, mediaStreamTrack: mst, setDegradationPreference: setPref },
      setPref,
      getStats,
      row,
      source,
    };
  }

  it("restarts a stuck share's adaptation, then restores its preference", async () => {
    const r = rig();
    const stop = watchShareResolutionRecovery(r.track, "maintain-framerate");
    await vi.advanceTimersByTimeAsync(4000);
    r.row.targetBitrate = 8_000_000;
    await vi.advanceTimersByTimeAsync(STUCK_MS);

    expect(r.setPref.mock.calls).toEqual([["maintain-resolution"], ["maintain-framerate"]]);
    stop();
  });

  it("stops reading once stopped", async () => {
    const r = rig();
    const stop = watchShareResolutionRecovery(r.track, "maintain-framerate");
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    const reads = r.getStats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.getStats).toHaveBeenCalledTimes(reads);
    expect(r.setPref).not.toHaveBeenCalled();
  });

  it("survives a failed stats read and keeps watching", async () => {
    const r = rig();
    r.getStats.mockRejectedValueOnce(new Error("sender closed"));
    const stop = watchShareResolutionRecovery(r.track, "maintain-framerate");
    await vi.advanceTimersByTimeAsync(4000);
    r.row.targetBitrate = 8_000_000;
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    expect(r.setPref).toHaveBeenCalledTimes(2);
    stop();
  });

  it("starts over on a new source instead of carrying the old one's clock", async () => {
    const r = rig();
    const stop = watchShareResolutionRecovery(r.track, "maintain-framerate");
    // Stuck at 320 px for a full STUCK_MS on the old source.
    await vi.advanceTimersByTimeAsync(STUCK_MS + 2000);
    // Change source to another large screen, then the bitrate comes back:
    // the old source's clock and low target must not make this nudge at once.
    const fresh = {
      getSettings: () => ({ width: 320, height: 180 }),
      getCapabilities: () => ({ width: { max: 2560 }, height: { max: 1440 } }),
      getConstraints: () => ({}),
    } as unknown as MediaStreamTrack;
    (r.track as { mediaStreamTrack: MediaStreamTrack }).mediaStreamTrack = fresh;
    r.row.targetBitrate = 8_000_000;
    await vi.advanceTimersByTimeAsync(STUCK_MS - 2000);
    expect(r.setPref).not.toHaveBeenCalled();
    stop();
  });
});
