// jsdom never applies app.css, so a computed-style assertion against the
// rendered tile would pass whether or not the rule exists. This asserts the
// parsed stylesheet rules (tests/helpers/app-css.ts) instead.
//
// VideoGrid.ts's onTrackMute toggles `.track-muted` on the `.video-cell` to
// hide a stalled remote camera's last frame. If app.css has no rule for that
// class, the toggle is a no-op and the viewer keeps seeing a frozen frame
// with no indication the track stalled.
import { transform } from "lightningcss";
import type { Declaration } from "lightningcss";
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("VideoGrid track-muted CSS", () => {
  it("reads a parsed display: none declaration as none", () => {
    let value: Declaration | undefined;
    transform({
      filename: "probe.css",
      code: Buffer.from(".probe { display: none }"),
      visitor: {
        Declaration(d) {
          value = d;
        },
      },
    });
    expect(keyword(value && { value, important: false })).toBe("none");
  });

  it("app.css hides the video element while .video-cell.track-muted is active", () => {
    const selector = ".video-cell.track-muted video";
    const hidden =
      keyword(cascadedDeclaration(selector, "visibility")) === "hidden" ||
      keyword(cascadedDeclaration(selector, "display")) === "none";
    expect(
      hidden,
      "expected `.video-cell.track-muted video` to set visibility: hidden (or display: none) " +
        "so the mute handler's class toggle actually hides the stalled frame",
    ).toBe(true);
  });
});
