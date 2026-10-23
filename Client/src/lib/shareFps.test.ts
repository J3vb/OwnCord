import { describe, expect, it } from "vitest";
import { SCREEN_SHARE_120_FPS, SHARE_FPS_OPTIONS, offeredShareFps } from "./shareFps";

describe("shareFps", () => {
  it("hides 120 fps for now", () => {
    expect(SCREEN_SHARE_120_FPS).toBe(false);
    expect(SHARE_FPS_OPTIONS).toEqual([60]);
  });

  it("keeps a saved 60", () => {
    expect(offeredShareFps(60)).toBe(60);
  });

  it("reads a saved 120 as 60 while 120 is hidden", () => {
    expect(offeredShareFps(120)).toBe(60);
  });

  it("reads 30 and anything else as the default 30", () => {
    for (const saved of [30, 0, 45, 144, -1, Number.NaN]) {
      expect(offeredShareFps(saved)).toBe(30);
    }
  });
});
