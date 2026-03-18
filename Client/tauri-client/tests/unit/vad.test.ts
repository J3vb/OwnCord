/**
 * Unit tests for VAD pure functions.
 */
import { describe, it, expect } from "vitest";
import { sensitivityToThreshold } from "@lib/vad";

describe("sensitivityToThreshold", () => {
  it("maps 0% sensitivity to max threshold (0.15)", () => {
    expect(sensitivityToThreshold(0)).toBeCloseTo(0.15);
  });

  it("maps 100% sensitivity to zero threshold", () => {
    expect(sensitivityToThreshold(100)).toBeCloseTo(0);
  });

  it("maps 50% sensitivity to half max threshold", () => {
    expect(sensitivityToThreshold(50)).toBeCloseTo(0.075);
  });

  it("maps 75% sensitivity to quarter max threshold", () => {
    expect(sensitivityToThreshold(75)).toBeCloseTo(0.0375);
  });

  it("is monotonically decreasing (higher sensitivity = lower threshold)", () => {
    const t0 = sensitivityToThreshold(0);
    const t25 = sensitivityToThreshold(25);
    const t50 = sensitivityToThreshold(50);
    const t75 = sensitivityToThreshold(75);
    const t100 = sensitivityToThreshold(100);
    expect(t0).toBeGreaterThan(t25);
    expect(t25).toBeGreaterThan(t50);
    expect(t50).toBeGreaterThan(t75);
    expect(t75).toBeGreaterThan(t100);
  });
});
