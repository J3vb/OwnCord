import { describe, expect, it } from "vitest";
import { formatDuration } from "../../../../src/lib/text/duration";

describe("formatDuration", () => {
  it("shows m:ss, and h:mm:ss from an hour on", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(4_999)).toBe("0:04");
    expect(formatDuration(83_000)).toBe("1:23");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
  });

  it("pads the leading part for the call timer", () => {
    expect(formatDuration(5_000, true)).toBe("00:05");
    expect(formatDuration(754_000, true)).toBe("12:34");
    expect(formatDuration(3_725_000, true)).toBe("01:02:05");
  });

  it("counts negative and non-finite values as zero", () => {
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatDuration(Number.NaN, true)).toBe("00:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
