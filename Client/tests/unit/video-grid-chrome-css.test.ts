// The call view's own controls (view toggles, pop-out, show chat) sit bottom
// right beside the control bar. Pinned top-left they covered the focused
// tile's name and doubled up with the tile's own top-right controls.
import { cascadedDeclaration } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("video grid chrome CSS", () => {
  it("anchors the call view's own controls bottom right", () => {
    expect(cascadedDeclaration(".video-grid__views", "top")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid__views", "left")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid__views", "bottom")).toBeDefined();
    expect(cascadedDeclaration(".video-grid__views", "right")).toBeDefined();
  });

  it("never pins the exit control on its own", () => {
    expect(cascadedDeclaration(".video-grid__exit", "position")).toBeUndefined();
  });
});
