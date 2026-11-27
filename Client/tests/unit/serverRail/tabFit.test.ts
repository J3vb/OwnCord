/** Which server tabs fit in the row, from their natural widths. */
import { describe, expect, it } from "vitest";
import { fitTabs } from "../../../src/features/server-rail/tabFit";

const base = { pinned: -1, moreWidth: 40, gap: 2 };

describe("fitTabs", () => {
  it("everything fits: nothing hidden", () => {
    // 3 x 100 + 2 gaps of 2 = 304, exactly the room.
    expect(fitTabs({ ...base, widths: [100, 100, 100], room: 304 })).toEqual({
      shown: [true, true, true],
      hidden: 0,
    });
    expect(fitTabs({ ...base, widths: [], room: 0 })).toEqual({ shown: [], hidden: 0 });
  });

  it("overflow hides from the end and counts them", () => {
    // Room for tabs: 300 - 40 - 2 = 258; two tabs take 202, three 304.
    expect(fitTabs({ ...base, widths: [100, 100, 100, 100], room: 300 })).toEqual({
      shown: [true, true, false, false],
      hidden: 2,
    });
  });

  it("stops at the first item that does not fit, even when a later one would", () => {
    expect(fitTabs({ ...base, widths: [100, 200, 20], room: 300 })).toEqual({
      shown: [true, false, false],
      hidden: 2,
    });
  });

  it("the pinned item past the fit stays shown and the one before it hides", () => {
    // Pinned 3 is counted first (100), then 0 (202); 1 would make 304 > 258.
    expect(fitTabs({ ...base, widths: [100, 100, 100, 100], room: 300, pinned: 3 })).toEqual({
      shown: [true, false, false, true],
      hidden: 2,
    });
  });

  it("the pinned item shows even when it alone overflows", () => {
    expect(fitTabs({ ...base, widths: [100, 500, 100], room: 300, pinned: 1 })).toEqual({
      shown: [false, true, false],
      hidden: 2,
    });
  });

  it("pinned -1 fits in layout order", () => {
    // Room for tabs: 200 - 42 = 158; three take 154, four 206.
    expect(fitTabs({ ...base, widths: [50, 50, 50, 50, 50], room: 200 })).toEqual({
      shown: [true, true, true, false, false],
      hidden: 2,
    });
  });

  it("the room for +N is taken only when something is hidden", () => {
    // All five fit in 258 without +N; with +N reserved they would not.
    expect(fitTabs({ ...base, widths: [50, 50, 50, 50, 50], room: 258 }).hidden).toBe(0);
    // One px less: +N and its gap take 42, leaving 215: four tabs take 206, five 258.
    expect(fitTabs({ ...base, widths: [50, 50, 50, 50, 50], room: 257 })).toEqual({
      shown: [true, true, true, true, false],
      hidden: 1,
    });
  });
});
