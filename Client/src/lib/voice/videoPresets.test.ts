import { describe, expect, it } from "vitest";
import {
  CAMERA_BUDGET_FLOOR,
  budgetedRate,
  cameraPublishOptions,
  SCREENSHARE_SIMULCAST_LAYERS,
  screenVideoPublishOptions,
  shareBudgetFitsLayers,
  videoBudget,
} from "./videoPresets";

const BOTH = { camera: true, screen: true };

describe("videoBudget", () => {
  it("no cap means no limit for either stream", () => {
    expect(videoBudget(0, BOTH)).toEqual({ camera: 0, screen: 0 });
    expect(videoBudget(-5, BOTH)).toEqual({ camera: 0, screen: 0 });
    expect(videoBudget(Number.NaN, BOTH)).toEqual({ camera: 0, screen: 0 });
  });

  it("a stream alone gets the whole cap, and so does an idle pair", () => {
    expect(videoBudget(6_000_000, { camera: true, screen: false })).toEqual({
      camera: 6_000_000,
      screen: 6_000_000,
    });
    expect(videoBudget(6_000_000, { camera: false, screen: true }).screen).toBe(6_000_000);
    expect(videoBudget(6_000_000, { camera: false, screen: false }).screen).toBe(6_000_000);
  });

  it("splits 75% share and 25% camera when both are live", () => {
    expect(videoBudget(8_000_000, BOTH)).toEqual({ camera: 2_000_000, screen: 6_000_000 });
  });

  it("never gives the camera less than its floor, taking it from the share", () => {
    expect(videoBudget(1_000_000, BOTH)).toEqual({
      camera: CAMERA_BUDGET_FLOOR,
      screen: 1_000_000 - CAMERA_BUDGET_FLOOR,
    });
  });

  it("a tiny cap still leaves both streams a positive budget that sums to the cap", () => {
    for (const cap of [1, 2, 300_000, 400_000, 600_000]) {
      const { camera, screen } = videoBudget(cap, BOTH);
      expect(camera).toBeGreaterThan(0);
      expect(screen).toBeGreaterThan(0);
      if (cap > 1) expect(camera + screen).toBe(cap);
    }
    expect(videoBudget(400_000, BOTH)).toEqual({ camera: 200_000, screen: 200_000 });
  });
});

describe("budgetedRate and the share's layer room", () => {
  it("holds a rate under a budget, and 0 is no budget", () => {
    expect(budgetedRate(3_000_000, 1_000_000)).toBe(1_000_000);
    expect(budgetedRate(500_000, 1_000_000)).toBe(500_000);
    expect(budgetedRate(3_000_000, 0)).toBe(3_000_000);
  });

  it("the share's layer room counts its real lower layer", () => {
    const lower = SCREENSHARE_SIMULCAST_LAYERS[0]?.encoding.maxBitrate ?? 0;
    expect(shareBudgetFitsLayers(lower + 1_000_000)).toBe(true);
    expect(shareBudgetFitsLayers(lower + 999_999)).toBe(false);
  });

  it("a share needs its 720p layer plus 1 Mbps before it is simulcast", () => {
    expect(shareBudgetFitsLayers(0)).toBe(true);
    expect(shareBudgetFitsLayers(2_200_000)).toBe(true);
    expect(shareBudgetFitsLayers(2_199_999)).toBe(false);
  });
});

describe("publish options under a budget", () => {
  it("the camera's top rate is the lower of its preset and its budget", () => {
    expect(cameraPublishOptions("vp8", "high").videoEncoding?.maxBitrate).toBe(4_000_000);
    expect(cameraPublishOptions("vp8", "high", 1_000_000).videoEncoding?.maxBitrate).toBe(
      1_000_000,
    );
    expect(cameraPublishOptions("vp8", "low", 1_000_000).videoEncoding?.maxBitrate).toBe(600_000);
  });

  it("the share's top rate is the lower of its preset and its budget", () => {
    expect(screenVideoPublishOptions("vp8", "medium", 30).screenShareEncoding?.maxBitrate).toBe(
      3_000_000,
    );
    expect(
      screenVideoPublishOptions("vp8", "medium", 30, 2_500_000).screenShareEncoding?.maxBitrate,
    ).toBe(2_500_000);
    // 60 fps asks for 1.5x its quality's rate; the budget still wins.
    expect(screenVideoPublishOptions("vp8", "high", 60).screenShareEncoding?.maxBitrate).toBe(
      9_000_000,
    );
    expect(
      screenVideoPublishOptions("vp8", "high", 60, 5_000_000).screenShareEncoding?.maxBitrate,
    ).toBe(5_000_000);
  });

  it("a share under its layer room goes out as one layer, with room as simulcast", () => {
    const roomy = screenVideoPublishOptions("vp8", "medium", 30, 4_000_000);
    expect(roomy.simulcast).toBe(true);
    expect(roomy.screenShareSimulcastLayers).toHaveLength(1);
    const tight = screenVideoPublishOptions("vp8", "medium", 30, 2_000_000);
    expect(tight.simulcast).toBe(false);
    expect(tight.screenShareSimulcastLayers).toBeUndefined();
    expect(screenVideoPublishOptions("vp8", "medium", 30).simulcast).toBe(true);
  });
});
