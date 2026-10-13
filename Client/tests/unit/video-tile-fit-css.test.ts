// A camera fills its grid tile (cropped, as Discord does); focused, full screen
// or in the theatre view it shows the whole frame, and a screen share always
// does. jsdom never applies app.css, so these assert the parsed stylesheet
// rules (tests/helpers/app-css.ts).
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

const CAMERA_IN_GRID =
  '.video-cell[data-stream-type="camera"]:not(.focused):not(:fullscreen):not(.video-cell--theatre) video';

describe("video tile fit CSS", () => {
  it("crops a camera to fill its grid tile", () => {
    expect(keyword(cascadedDeclaration(CAMERA_IN_GRID, "object-fit"))).toBe("cover");
  });

  it("shows the whole frame everywhere else", () => {
    expect(keyword(cascadedDeclaration(".video-cell video", "object-fit"))).toBe("contain");
  });
});
