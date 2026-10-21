// The SPOILER_ filename convention (6.12): detection and the toggle.
import { describe, expect, it } from "vitest";
import {
  SPOILER_PREFIX,
  isSpoilerFilename,
  toggleSpoilerFilename,
} from "../../src/features/messaging/spoilerAttachment";

describe("isSpoilerFilename", () => {
  it("detects the prefix, case-sensitively, and not the bare prefix", () => {
    expect(isSpoilerFilename("SPOILER_cat.png")).toBe(true);
    expect(isSpoilerFilename("spoiler_cat.png")).toBe(false);
    expect(isSpoilerFilename("cat_SPOILER_.png")).toBe(false);
    expect(isSpoilerFilename(SPOILER_PREFIX)).toBe(false);
    expect(isSpoilerFilename(`${SPOILER_PREFIX}x`)).toBe(true);
    expect(isSpoilerFilename("")).toBe(false);
  });
});

describe("toggleSpoilerFilename", () => {
  it("adds the prefix, and twice returns the original name", () => {
    expect(toggleSpoilerFilename("cat.png")).toBe("SPOILER_cat.png");
    expect(toggleSpoilerFilename(toggleSpoilerFilename("cat.png"))).toBe("cat.png");
  });

  it("strips the prefix once from an already marked name", () => {
    expect(toggleSpoilerFilename("SPOILER_x.png")).toBe("x.png");
    expect(toggleSpoilerFilename("SPOILER_SPOILER_x.png")).toBe("SPOILER_x.png");
  });

  it("marks the bare prefix, which was not a mark", () => {
    expect(toggleSpoilerFilename(SPOILER_PREFIX)).toBe("SPOILER_SPOILER_");
  });
});
