// B9-24 scoped voice/media polish: the video tile's audio overlay is no longer
// hover-only (Q1: no pointer-only action), 24x24 pointer targets on the tile
// controls, and the voice widget's header/status text uses the qualified
// --text-* status tokens rather than the --green/--yellow/--red fills, which
// miss 4.5:1 on the widget's --bg-secondary.
//
// jsdom never applies app.css, so these assert the parsed stylesheet rules
// (tests/helpers/app-css.ts). The e2e spec proves the computed behaviour.
import type { Declaration } from "lightningcss";
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

/** A length declaration's px value, or undefined for anything else. */
function px(d: ReturnType<typeof cascadedDeclaration>): number | undefined {
  const v: { type?: string; value?: { type?: string; value?: { unit?: string; value?: number } } } =
    (d?.value as Declaration | undefined)?.value as never;
  if (v?.type === "length-percentage" && v.value?.value?.unit === "px") {
    return v.value.value.value;
  }
  return undefined;
}

/** The custom-property name a declaration reads as a bare `var(--x)`, or undefined. */
function varToken(d: ReturnType<typeof cascadedDeclaration>): string | undefined {
  const v = d?.value as Declaration | undefined;
  if (v?.property !== "unparsed") return undefined;
  const tokens = v.value.value;
  if (tokens.length !== 1) return undefined;
  const t = tokens[0]!;
  return t.type === "var" ? t.value.name.ident : undefined;
}

describe("B9-24 voice/media polish CSS", () => {
  it("reveals the tile audio overlay on focus-within, not just hover", () => {
    expect(
      keyword(cascadedDeclaration(".video-cell:focus-within .video-tile-overlay", "opacity")),
    ).toBe("1");
  });

  it("gives the tile mute button a 24x24 target", () => {
    // The e2e spec measures the rendered box; this pins the CSS box so a
    // regression in the rule itself (not the icon size) fails here.
    expect(px(cascadedDeclaration(".tile-mute-btn", "min-width"))).toBe(24);
    expect(px(cascadedDeclaration(".tile-mute-btn", "min-height"))).toBe(24);
  });

  it.each([
    [".vw-connected", "--text-positive"],
    [".vw-connected.vw-securing", "--text-warning"],
    [".vw-connected.vw-reconnecting", "--text-warning"],
    [".vw-secured", "--text-positive"],
    [".vw-secured.vw-secured--degraded", "--text-danger"],
    [".vw-timer", "--text-positive"],
    [".vw-controls button.active-ctrl", "--text-danger"],
    [".vw-controls button.disconnect", "--text-danger"],
  ])("uses the qualified status text token on %s", (selector, token) => {
    expect(varToken(cascadedDeclaration(selector, "color"))).toBe(token);
  });
});
