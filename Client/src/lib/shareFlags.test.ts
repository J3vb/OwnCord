import { beforeEach, describe, expect, it } from "vitest";
import { savePref } from "@lib/preferences";
import {
  SHARE_MOTION_POLICIES,
  SHARE_POLICY_VERSION,
  getShareDiagnosticsEnabled,
  getShareMotionPolicy,
  shareMotionArm,
} from "./shareFlags";

describe("shareFlags", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults: diagnostics off, policy legacy", () => {
    expect(getShareDiagnosticsEnabled()).toBe(false);
    expect(getShareMotionPolicy()).toBe("legacy");
  });

  it("reads saved values", () => {
    savePref("shareDiagnosticsV2", true);
    savePref("shareMotionPolicy", "motion-balanced");
    expect(getShareDiagnosticsEnabled()).toBe(true);
    expect(getShareMotionPolicy()).toBe("motion-balanced");
  });

  it.each([["bogus"], [7], [null], [true], [["legacy"]]])(
    "reads malformed policy %j as legacy",
    (value) => {
      savePref("shareMotionPolicy", value);
      expect(getShareMotionPolicy()).toBe("legacy");
    },
  );

  it.each([["yes"], [1], [null]])("reads malformed diagnostics flag %j as off", (value) => {
    savePref("shareDiagnosticsV2", value);
    expect(getShareDiagnosticsEnabled()).toBe(false);
  });

  it("reads unparsable storage as the defaults", () => {
    localStorage.setItem("owncord:settings:shareMotionPolicy", "{not json");
    localStorage.setItem("owncord:settings:shareDiagnosticsV2", "{not json");
    expect(getShareMotionPolicy()).toBe("legacy");
    expect(getShareDiagnosticsEnabled()).toBe(false);
  });

  it("legacy resolves to no change; every other arm sets hint and degradation", () => {
    expect(shareMotionArm("legacy")).toEqual({});
    expect(shareMotionArm("detail-balanced")).toEqual({
      contentHint: "detail",
      degradation: "balanced",
    });
    expect(shareMotionArm("detail-framerate")).toEqual({
      contentHint: "detail",
      degradation: "maintain-framerate",
    });
    expect(shareMotionArm("motion-resolution")).toEqual({
      contentHint: "motion",
      degradation: "maintain-resolution",
    });
    expect(shareMotionArm("motion-balanced")).toEqual({
      contentHint: "motion",
      degradation: "balanced",
    });
    expect(shareMotionArm("motion-framerate")).toEqual({
      contentHint: "motion",
      degradation: "maintain-framerate",
    });
    expect(SHARE_MOTION_POLICIES).toHaveLength(6);
  });

  it("exposes a policy version", () => {
    expect(SHARE_POLICY_VERSION).toBe("2b-1");
  });
});
