// Compact mode puts a grouped row's clock time in the left gutter and draws an
// emoji-only message large. jsdom never applies app.css, so these assert the
// parsed stylesheet (tests/helpers/app-css.ts).
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

/** A px length nested anywhere in a parsed value, e.g. `{ type: "dimension", value: { unit, value } }`. */
function pxIn(node: unknown): number | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  if ("unit" in node && "value" in node && node.unit === "px") return Number(node.value);
  return "value" in node ? pxIn(node.value) : undefined;
}

function px(selector: string, property: string): number {
  const v = pxIn(cascadedDeclaration(selector, property)?.value);
  if (v === undefined) throw new Error(`${selector} ${property} is not a px length`);
  return v;
}

/** The left side of a `padding` shorthand. */
function paddingLeft(selector: string): number {
  const v: unknown = cascadedDeclaration(selector, "padding")?.value.value;
  const left = typeof v === "object" && v !== null && "left" in v ? pxIn(v.left) : undefined;
  if (left === undefined) throw new Error(`${selector} has no px padding-left`);
  return left;
}

describe("compact mode", () => {
  it("the grouped row's time column ends before the text starts", () => {
    const hoverTime = ".compact-mode .message.grouped .msg-hover-time";
    const timeRight = px(hoverTime, "left") + px(hoverTime, "width");
    const textLeft = paddingLeft(".compact-mode .message");
    // Wide enough for a 12-hour "12:59 PM" at the small type size.
    expect(px(hoverTime, "width")).toBeGreaterThanOrEqual(60);
    expect(timeRight).toBeLessThan(textLeft);
    expect(keyword(cascadedDeclaration(hoverTime, "text-align"))).toBe("right");
  });

  it("an emoji-only message keeps a large size instead of the small body text", () => {
    expect(px(".compact-mode .message .msg-text-jumbo", "font-size")).toBeGreaterThan(20);
  });
});

describe("a disabled composer", () => {
  it("draws none of its buttons", () => {
    expect(
      keyword(cascadedDeclaration(".message-input-wrap.composer-disabled .input-btn", "display")),
    ).toBe("none");
  });
});
