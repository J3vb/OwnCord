import { describe, it, expect } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

describe("emoji picker skip boxes", () => {
  it("each category grid skips its own off-screen work", () => {
    expect(keyword(cascadedDeclaration(".ep-grid", "content-visibility"))).toBe("auto");
  });

  it("the cells are not skip boxes of their own", () => {
    expect(cascadedDeclaration(".ep-emoji", "content-visibility")).toBeUndefined();
  });

  it("the scroll area is the size container the grid height reads", () => {
    expect(cascadedDeclaration(".ep-scroll", "container-type")).toBeDefined();
    expect(cascadedDeclaration(".ep-grid", "contain-intrinsic-block-size")).toBeDefined();
  });
});
