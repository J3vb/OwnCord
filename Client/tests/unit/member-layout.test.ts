import { describe, it, expect, beforeEach } from "vitest";
import {
  MEMBER_LAYOUT_PREF,
  MEMBER_OPEN_PREF,
  MEMBER_WIDTH_PREF,
  clampMemberWidth,
  loadMemberLayout,
} from "../../src/features/members/memberLayout";
import { STORAGE_PREFIX, savePref } from "../../src/lib/prefs/preferences";

describe("memberLayout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("names the three prefs", () => {
    expect(MEMBER_LAYOUT_PREF).toBe("memberListLayout");
    expect(MEMBER_OPEN_PREF).toBe("memberListOpen");
    expect(MEMBER_WIDTH_PREF).toBe("memberListWidth");
  });

  it("missing layout reads as right", () => {
    expect(loadMemberLayout()).toBe("right");
  });

  it("unknown layout reads as right", () => {
    savePref(MEMBER_LAYOUT_PREF, "top");
    expect(loadMemberLayout()).toBe("right");
    savePref(MEMBER_LAYOUT_PREF, 7);
    expect(loadMemberLayout()).toBe("right");
    localStorage.setItem(STORAGE_PREFIX + MEMBER_LAYOUT_PREF, "{not json");
    expect(loadMemberLayout()).toBe("right");
  });

  it("stored right reads as right and stored left reads as left", () => {
    savePref(MEMBER_LAYOUT_PREF, "right");
    expect(loadMemberLayout()).toBe("right");
    savePref(MEMBER_LAYOUT_PREF, "left");
    expect(loadMemberLayout()).toBe("left");
  });

  it("clampMemberWidth clamps and defaults", () => {
    expect(clampMemberWidth(100)).toBe(200);
    expect(clampMemberWidth(200)).toBe(200);
    expect(clampMemberWidth(300)).toBe(300);
    expect(clampMemberWidth(360)).toBe(360);
    expect(clampMemberWidth(999)).toBe(360);
    expect(clampMemberWidth(Number.POSITIVE_INFINITY)).toBe(360);
    expect(clampMemberWidth(Number.NEGATIVE_INFINITY)).toBe(200);
    expect(clampMemberWidth(Number.NaN)).toBe(240);
    expect(clampMemberWidth(250.4)).toBe(250);
    // Not a number at all: the default, never a coerced guess.
    expect(clampMemberWidth("300" as unknown as number)).toBe(240);
    expect(clampMemberWidth("wide" as unknown as number)).toBe(240);
    expect(clampMemberWidth(undefined as unknown as number)).toBe(240);
  });
});
