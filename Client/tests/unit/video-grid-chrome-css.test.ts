// The call view's View button (its menu holds the view toggles, pop-out and
// show chat) sits bottom right beside the control bar. Pinned top-left, the
// old controls covered the focused tile's name and doubled up with the
// tile's own top-right controls.
import { cascadedDeclaration } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("video grid chrome CSS", () => {
  it("anchors the call view's own controls bottom right", () => {
    expect(cascadedDeclaration(".video-grid__views", "top")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid__views", "left")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid__views", "bottom")).toBeDefined();
    expect(cascadedDeclaration(".video-grid__views", "right")).toBeDefined();
  });

  it("scrolls the cards in their own box, never the grid that holds the call bar", () => {
    expect(cascadedDeclaration(".video-grid__cards", "overflow-y")).toBeDefined();
    expect(cascadedDeclaration(".video-grid--cards", "overflow-y")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid", "overflow-y")).toBeUndefined();
    expect(cascadedDeclaration(".video-grid__cards > .video-cell--avatar", "width")).toBeDefined();
    expect(cascadedDeclaration(".video-grid__cards .video-username", "position")).toBeDefined();
  });
});
