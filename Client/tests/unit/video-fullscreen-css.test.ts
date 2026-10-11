// The theatre view (VideoGrid's fallback when the full-screen API is refused)
// must fill the window whatever inline size the grid layout or the filmstrip
// gave the tile, and the tile menu must open above it.
//
// jsdom never applies app.css, so these assert the parsed stylesheet rules
// (tests/helpers/app-css.ts).
import { cascadedDeclaration } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("video full-screen CSS", () => {
  it.each(["width", "height"])(
    "the theatre tile's %s fills the window, over any inline size",
    (prop) => {
      const d = cascadedDeclaration(".video-cell--theatre", prop);
      expect(d?.important).toBe(true);
      expect(d?.value.value).toEqual({
        type: "length-percentage",
        value: { type: "percentage", value: 1 },
      });
    },
  );

  it("opens the tile menu above the theatre tile", () => {
    const zIndex = (selector: string): number => {
      const v = cascadedDeclaration(selector, "z-index")?.value.value as
        { type?: string; value?: number } | undefined;
      return v?.type === "integer" ? v.value! : Number.NaN;
    };
    expect(zIndex(".context-menu.video-tile-menu")).toBeGreaterThan(zIndex(".video-cell--theatre"));
  });
});

// An inline video is capped like an image (max 300px tall, never wider than the
// column); a 16:9 placeholder ratio limits the jump until metadata sets the real one.
describe("inline video attachment CSS", () => {
  it("has no fixed-size box", () => {
    expect(cascadedDeclaration(".msg-video", "width")).toBeUndefined();
    expect(cascadedDeclaration(".msg-video", "aspect-ratio")).toBeUndefined();
  });

  it("caps the video at the column width and 300px tall", () => {
    expect(cascadedDeclaration(".msg-video video", "max-height")?.value.value).toMatchObject({
      value: { type: "dimension", value: { unit: "px", value: 300 } },
    });
    expect(cascadedDeclaration(".msg-video video", "max-width")).toBeDefined();
  });

  it("starts with a 16:9 placeholder ratio", () => {
    expect(cascadedDeclaration(".msg-video video", "aspect-ratio")?.value.value).toEqual({
      auto: false,
      ratio: [16, 9],
    });
  });
});
