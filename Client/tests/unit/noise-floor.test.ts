import { describe, expect, it } from "vitest";
import {
  AUTO_MARGIN_DB,
  AUTO_MAX_THRESHOLD,
  AUTO_MIN_THRESHOLD,
  NoiseFloorTracker,
} from "../../src/lib/voice/noiseFloor";

const db = (rms: number): number => 20 * Math.log10(rms);
const rmsAt = (dbfs: number): number => 10 ** (dbfs / 20);

/** Feed `level(t)` every `stepMs` from `fromMs` for `durationMs`; returns the end time. */
function feed(
  tracker: NoiseFloorTracker,
  level: (t: number) => number,
  fromMs: number,
  durationMs: number,
  stepMs = 50,
): number {
  let t = fromMs;
  for (; t < fromMs + durationMs; t += stepMs) tracker.push(level(t), t);
  return t;
}

describe("NoiseFloorTracker", () => {
  it("steady noise settles the threshold the margin above it", () => {
    const tracker = new NoiseFloorTracker();
    feed(tracker, () => rmsAt(-50), 0, 3000);
    expect(db(tracker.threshold)).toBeCloseTo(-50 + AUTO_MARGIN_DB, 5);
    // The noise itself stays below the gate.
    expect(rmsAt(-50)).toBeLessThan(tracker.threshold);
  });

  it("speech above the floor clears the threshold", () => {
    const tracker = new NoiseFloorTracker();
    feed(tracker, () => rmsAt(-50), 0, 3000);
    expect(rmsAt(-25)).toBeGreaterThan(tracker.threshold);
  });

  it("the floor follows rising noise within the window", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-55), 0, 3000);
    expect(db(tracker.threshold)).toBeCloseTo(-45, 5);
    // A fan starts: 15 dB louder. Within the 3 s window plus one sub-window
    // the old quiet ages out and the gate rises above the fan.
    t = feed(tracker, () => rmsAt(-40), t, 4500);
    expect(db(tracker.threshold)).toBeCloseTo(-30, 5);
    expect(rmsAt(-40)).toBeLessThan(tracker.threshold);
  });

  it("the floor drops at once to quieter noise", () => {
    const tracker = new NoiseFloorTracker();
    const t = feed(tracker, () => rmsAt(-40), 0, 3000);
    tracker.push(rmsAt(-55), t);
    expect(db(tracker.threshold)).toBeCloseTo(-45, 5);
  });

  it("continuous speech with short pauses does not lift the floor", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-55), 0, 3000);
    // 20 s of talking at -20 dBFS with a 100 ms pause back to the room's
    // level every 1.5 s: the floor stays at the room, so the threshold sits
    // halfway between the floor margin (-45) and the voice margin (-35).
    t = feed(tracker, (now) => (now % 1500 < 100 ? rmsAt(-55) : rmsAt(-20)), t, 20000);
    expect(db(tracker.threshold)).toBeCloseTo(-40, 1);
    expect(db(tracker.speechLevel!)).toBeCloseTo(-20, 1);
  });

  it("the voice lifts the threshold halfway toward itself over suppressed silence", () => {
    // Noise suppression leaves the room below the lowest threshold.
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-80), 0, 3000);
    expect(db(tracker.threshold)).toBeCloseTo(db(AUTO_MIN_THRESHOLD), 5);
    t = feed(tracker, () => rmsAt(-20), t, 2000);
    t = feed(tracker, () => rmsAt(-80), t, 500);
    // Halfway between -55 (the floor margin) and -35 (15 dB under the voice).
    expect(db(tracker.threshold)).toBeCloseTo(-45, 1);
    // A breath or a keyboard at -50 dBFS stays below the gate; the voice clears it.
    expect(rmsAt(-50)).toBeLessThan(tracker.threshold);
    expect(rmsAt(-20)).toBeGreaterThan(tracker.threshold);
  });

  it("a quiet voice over a loud room keeps the floor margin", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-50), 0, 3000);
    t = feed(tracker, () => rmsAt(-32), t, 2000);
    feed(tracker, () => rmsAt(-50), t, 500);
    // 15 dB under the voice would be -47, below the floor margin: the margin wins.
    expect(db(tracker.threshold)).toBeCloseTo(-40, 5);
    expect(rmsAt(-32)).toBeGreaterThan(tracker.threshold);
  });

  it("learns the voice only from levels well above the gate", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-55), 0, 3000);
    // Levels 3 dB over the threshold are the room's own peaks, not the voice.
    t = feed(tracker, () => rmsAt(-42), t, 2000);
    expect(tracker.speechLevel).toBeNull();
    feed(tracker, () => rmsAt(-55), t, 500);
    expect(db(tracker.threshold)).toBeCloseTo(-45, 5);
  });

  it("one thump does not set the voice level, so a voice under it still clears the gate", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-50), 0, 3000);
    // A desk thump: 150 ms at -6 dBFS.
    t = feed(tracker, () => rmsAt(-6), t, 150);
    feed(tracker, () => rmsAt(-50), t, 500);
    expect(tracker.speechLevel).toBeNull();
    expect(db(tracker.threshold)).toBeCloseTo(-40, 5);
    expect(rmsAt(-30)).toBeGreaterThan(tracker.threshold);
  });

  it("a voice that turns quieter brings the gate back down", () => {
    const tracker = new NoiseFloorTracker();
    // Talking with a 100 ms pause back to the room every 1.5 s.
    const talk = (level: number) => (now: number) => (now % 1500 < 100 ? rmsAt(-55) : rmsAt(level));
    let t = feed(tracker, () => rmsAt(-55), 0, 3000);
    t = feed(tracker, talk(-10), t, 3000);
    // Halfway between -45 (the floor margin) and -25 (15 dB under the voice).
    expect(db(tracker.threshold)).toBeCloseTo(-35, 0);
    // The next sentences are 22 dB softer and never clear the gate by the
    // 6 dB the estimate wants. Two seconds on, the estimate sinks 1.5 dB/s,
    // and the gate with it, until the soft voice is well over it again.
    t = feed(tracker, talk(-32), t, 2000);
    expect(rmsAt(-32)).toBeGreaterThan(tracker.threshold);
    feed(tracker, talk(-32), t, 8000);
    expect(db(tracker.speechLevel!)).toBeLessThan(-20);
    expect(db(tracker.threshold)).toBeLessThan(-38);
    expect(rmsAt(-32)).toBeGreaterThan(tracker.threshold);
  });

  it("an input-volume change forgets the voice level with the floor", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-55), 0, 3000);
    t = feed(tracker, () => rmsAt(-20), t, 2000);
    expect(tracker.speechLevel).not.toBeNull();
    tracker.reset(t);
    expect(tracker.speechLevel).toBeNull();
  });

  it("digital silence (a muted capture) does not drag the floor down", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-50), 0, 5000);
    t = feed(tracker, () => 0, t, 3000);
    expect(db(tracker.threshold)).toBeCloseTo(-40, 5);
    // The fan after the unmute stays below the gate.
    feed(tracker, () => rmsAt(-50), t, 1000);
    expect(rmsAt(-50)).toBeLessThan(tracker.threshold);
  });

  it("an input-volume change relearns the floor without learning its gain ramp", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-50), 0, 5000);
    // Volume to 0: the gain ramps down (time constant 15 ms) before the
    // reports reach digital silence.
    tracker.reset(t);
    const start = t;
    t = feed(tracker, (now) => rmsAt(-50) * Math.exp(-(now - start) / 15), t, 2000);
    expect(db(tracker.threshold)).toBeCloseTo(-40, 5);
    // Volume back up: the room is relearned and stays below the gate.
    tracker.reset(t);
    t = feed(tracker, () => rmsAt(-50), t, 3000);
    expect(db(tracker.threshold)).toBeCloseTo(-40, 5);
    expect(rmsAt(-50)).toBeLessThan(tracker.threshold);
  });

  it("clamps to the minimum and maximum thresholds", () => {
    const quiet = new NoiseFloorTracker();
    feed(quiet, () => rmsAt(-90), 0, 3000);
    expect(quiet.threshold).toBeCloseTo(AUTO_MIN_THRESHOLD, 9);

    const loud = new NoiseFloorTracker();
    feed(loud, () => rmsAt(-20), 0, 3000);
    expect(loud.threshold).toBeCloseTo(AUTO_MAX_THRESHOLD, 9);
  });

  it("gates at the seed, or the maximum, until a second of levels has come in", () => {
    expect(new NoiseFloorTracker().threshold).toBe(AUTO_MAX_THRESHOLD);
    const seeded = new NoiseFloorTracker(0.004);
    expect(seeded.threshold).toBe(0.004);
    feed(seeded, () => rmsAt(-60), 0, 1000);
    expect(seeded.threshold).toBe(0.004);
    expect(seeded.push(rmsAt(-60), 1000)).toBeCloseTo(rmsAt(-50), 9);
  });

  it("reports only moves of a decibel or more", () => {
    const tracker = new NoiseFloorTracker();
    feed(tracker, () => rmsAt(-50), 0, 1100);
    expect(tracker.push(rmsAt(-50.5), 1150)).toBeNull();
    expect(tracker.push(rmsAt(-52), 1200)).toBeCloseTo(rmsAt(-42), 9);
  });

  it("still adapts when a hidden window throttles reports to one a second", () => {
    const tracker = new NoiseFloorTracker();
    let t = feed(tracker, () => rmsAt(-55), 0, 3000, 1000);
    expect(db(tracker.threshold)).toBeCloseTo(-45, 5);
    t = feed(tracker, () => rmsAt(-40), t, 10000, 1000);
    expect(db(tracker.threshold)).toBeCloseTo(-30, 5);
  });
});
