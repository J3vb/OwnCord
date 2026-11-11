// A full-screen tile and the theatre view (VideoGrid's fallback when the
// full-screen API is refused) must fill the screen whatever inline size the
// packed grid gave the tile, and the tile menu must open above the theatre.
//
// jsdom never applies app.css, so these assert the parsed stylesheet rules
// (tests/helpers/app-css.ts).
import { cascadedDeclaration } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("video full-screen CSS", () => {
  it.each(
    [".video-cell--theatre", ".video-cell:fullscreen"].flatMap((sel) => [
      [sel, "width"],
      [sel, "height"],
    ]),
  )("%s's %s fills the screen, over the packed grid's inline size", (selector, prop) => {
    const d = cascadedDeclaration(selector!, prop!);
    expect(d?.important).toBe(true);
    expect(d?.value.value).toEqual({
      type: "length-percentage",
      value: { type: "percentage", value: 1 },
    });
  });

  it.each(["position", "left", "top"])(
    "the theatre tile's %s wins over the packed grid's placement",
    (prop) => {
      expect(cascadedDeclaration(".video-cell--theatre", prop)?.important).toBe(true);
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

// An inline video's box hugs the player (no black bars beside a small or
// portrait clip), the player never grows past the column, and a 16:9
// placeholder at the box width stands in until the real size is known.
describe("inline video attachment CSS", () => {
  it("hugs the player instead of filling the column", () => {
    expect(cascadedDeclaration(".msg-video", "width")?.value.value).toMatchObject({
      type: "fit-content",
    });
    expect(cascadedDeclaration(".msg-video", "aspect-ratio")).toBeUndefined();
  });

  it("starts 400px wide, never wider than the column", () => {
    expect(cascadedDeclaration(".msg-video video", "width")?.value.value).toMatchObject({
      type: "length-percentage",
      value: { type: "dimension", value: { unit: "px", value: 400 } },
    });
    expect(cascadedDeclaration(".msg-video video", "max-width")?.value.value).toEqual({
      type: "length-percentage",
      value: { type: "percentage", value: 1 },
    });
  });

  it("starts with a 16:9 placeholder ratio", () => {
    expect(cascadedDeclaration(".msg-video video", "aspect-ratio")?.value.value).toEqual({
      auto: false,
      ratio: [16, 9],
    });
  });
});
