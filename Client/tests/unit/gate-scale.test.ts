import { describe, it, expect, beforeEach } from "vitest";
import {
  GATE_DB_MAX,
  GATE_DB_MIN,
  legacySensitivityToDbScale,
  migrateVoiceSensitivityScale,
  vadLevelPosition,
  vadThreshold,
  vadThresholdDb,
} from "../../src/lib/voice/gateScale";

const PREFIX = "owncord:settings:";
const set = (key: string, value: unknown): void =>
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
const get = (key: string): unknown => {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? null : JSON.parse(raw);
};
const db = (rms: number): number => 20 * Math.log10(rms);

describe("the sensitivity slider's decibel scale", () => {
  it("is linear in decibels from the strictest gate to the most open", () => {
    expect(vadThresholdDb(0)).toBe(GATE_DB_MAX);
    expect(vadThresholdDb(50)).toBe((GATE_DB_MAX + GATE_DB_MIN) / 2);
    expect(vadThresholdDb(100)).toBe(GATE_DB_MIN);
    // Every step is the same loudness change: 5 steps are 3 dB anywhere.
    expect(vadThresholdDb(20) - vadThresholdDb(25)).toBeCloseTo(3, 9);
    expect(vadThresholdDb(90) - vadThresholdDb(95)).toBeCloseTo(3, 9);
  });

  it("gates at the RMS of its decibel level, and not at all at 100", () => {
    expect(db(vadThreshold(50))).toBeCloseTo(-40, 9);
    expect(vadThreshold(100)).toBe(0);
    expect(vadThreshold(0)).toBeGreaterThan(vadThreshold(99));
  });

  it("draws a level where the handle for that level sits", () => {
    expect(vadLevelPosition(vadThreshold(50))).toBeCloseTo(0.5, 9);
    expect(vadLevelPosition(vadThreshold(75))).toBeCloseTo(0.25, 9);
    expect(vadLevelPosition(0)).toBe(0);
    expect(vadLevelPosition(1)).toBe(1);
  });
});

describe("legacySensitivityToDbScale", () => {
  it("keeps the gate level the old amplitude-linear slider had", () => {
    // The old default, -26 dBFS, and the old quiet-voice stretch.
    expect(db(vadThreshold(legacySensitivityToDbScale(50)))).toBeCloseTo(-26, 0);
    expect(db(vadThreshold(legacySensitivityToDbScale(90)))).toBeCloseTo(-40, 0);
    expect(db(vadThreshold(legacySensitivityToDbScale(99)))).toBeCloseTo(-60, 0);
    expect(db(vadThreshold(legacySensitivityToDbScale(0)))).toBeCloseTo(-20, 0);
  });

  it("keeps 100 as no gate", () => {
    expect(legacySensitivityToDbScale(100)).toBe(100);
  });
});

describe("migrateVoiceSensitivityScale", () => {
  beforeEach(() => localStorage.clear());

  it("moves a saved sensitivity onto the decibel scale once", () => {
    set("voiceSensitivity", 90);
    migrateVoiceSensitivityScale();
    expect(get("voiceSensitivity")).toBe(50);
    expect(get("voiceSensitivityScale")).toBe("db");
    // A second start does not move it again.
    migrateVoiceSensitivityScale();
    expect(get("voiceSensitivity")).toBe(50);
  });

  it("marks a profile on automatic sensitivity as on the scale without inventing a value", () => {
    migrateVoiceSensitivityScale();
    expect(get("voiceSensitivity")).toBeNull();
    expect(get("voiceSensitivityScale")).toBe("db");
  });

  it("keeps the old default's gate for a manual profile that never moved the slider", () => {
    set("autoInputSensitivity", false);
    migrateVoiceSensitivityScale();
    // The old 50 gated at -26 dBFS; on this scale that is 27, not 50 (-40 dBFS).
    expect(get("voiceSensitivity")).toBe(legacySensitivityToDbScale(50));
    expect(vadThresholdDb(get("voiceSensitivity") as number)).toBeCloseTo(-26, 0);
  });

  it("leaves a value saved on the scale alone", () => {
    set("voiceSensitivity", 30);
    set("voiceSensitivityScale", "db");
    migrateVoiceSensitivityScale();
    expect(get("voiceSensitivity")).toBe(30);
  });

  it("ignores a corrupt saved value", () => {
    set("voiceSensitivity", "loud");
    migrateVoiceSensitivityScale();
    expect(get("voiceSensitivity")).toBe("loud");
    expect(get("voiceSensitivityScale")).toBe("db");
  });
});
