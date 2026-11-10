import { afterEach, describe, expect, it } from "vitest";
import {
  applyVideoBitrateCap,
  onVideoBitrateCap,
  resetVideoBitrateCap,
  videoBitrateCap,
} from "./videoBitrateCap";

describe("videoBitrateCap", () => {
  afterEach(resetVideoBitrateCap);

  it("starts with no cap and reads a bad wire value as no cap", () => {
    expect(videoBitrateCap()).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "6000000", null, undefined]) {
      applyVideoBitrateCap(6_000_000);
      expect(applyVideoBitrateCap(bad)).toBe(true);
      expect(videoBitrateCap()).toBe(0);
    }
  });

  it("tells listeners only on a change, and a removed listener hears nothing", () => {
    const seen: number[] = [];
    const off = onVideoBitrateCap((b) => seen.push(b));
    expect(applyVideoBitrateCap(4_000_000)).toBe(true);
    expect(applyVideoBitrateCap(4_000_000)).toBe(false);
    off();
    applyVideoBitrateCap(1_000_000);
    expect(seen).toEqual([4_000_000]);
  });

  it("a session reset forgets the cap but keeps listeners", () => {
    const seen: number[] = [];
    const off = onVideoBitrateCap((b) => seen.push(b));
    applyVideoBitrateCap(8_000_000);
    resetVideoBitrateCap();
    expect(videoBitrateCap()).toBe(0);
    applyVideoBitrateCap(8_000_000);
    expect(seen).toEqual([8_000_000, 8_000_000]);
    off();
  });
});
