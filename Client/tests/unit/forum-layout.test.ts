import { describe, expect, it } from "vitest";
import { FORUM_LAYOUTS, parseForumLayout } from "../../src/features/forums/forumModel";

describe("parseForumLayout", () => {
  it("keeps each known layout", () => {
    for (const layout of FORUM_LAYOUTS) expect(parseForumLayout(layout)).toBe(layout);
  });

  it("falls back to cards for anything else", () => {
    for (const value of [undefined, null, "", "table", 3, { layout: "list" }]) {
      expect(parseForumLayout(value)).toBe("grid");
    }
  });
});
