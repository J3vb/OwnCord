// B9-22 scoped polish: every hover-only reveal in the messaging surfaces gains
// a matching :focus-within so a keyboard user gets the same affordance a mouse
// user does (Q1: no hover-only action), and the small icon controls meet the
// 24x24 pointer-target minimum. Message timestamps move off the unqualified
// --text-micro (about 2.5:1) onto --text-muted (5.1:1+), which a reader needs.
//
// jsdom never applies app.css, so these assert the parsed stylesheet rules
// (tests/helpers/app-css.ts) rather than the rendered DOM. The e2e spec proves
// the computed behavior.
import type { Declaration } from "lightningcss";
import { cascadedDeclaration, hasRule } from "../helpers/app-css";
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

describe("B9-22 messaging hover/focus parity and target size", () => {
  it.each([
    ".message:focus-within .msg-actions-bar",
    ".msg-codeblock-wrap:focus-within .msg-codeblock-copy",
    ".msg-image:focus-within .gif-play-btn",
    ".msg-video:focus-within .msg-media-overlay",
    ".pinned-msg:focus-within .pinned-msg__actions",
  ])("reveals %s without hover", (selector) => {
    expect(
      hasRule(selector),
      `expected ${selector} so the control is reachable without a pointer`,
    ).toBe(true);
  });

  it("gives the attachment remove button a 24x24 target", () => {
    expect(px(cascadedDeclaration(".attachment-preview-remove", "width"))).toBe(24);
    expect(px(cascadedDeclaration(".attachment-preview-remove", "height"))).toBe(24);
  });

  it("gives the add-reaction chip a 24px minimum height", () => {
    expect(px(cascadedDeclaration(".reaction-chip", "min-height"))).toBe(24);
  });

  it("uses the qualified muted text token for message times, not the incidental one", () => {
    expect(varToken(cascadedDeclaration(".message .msg-time", "color"))).toBe("--text-muted");
    expect(varToken(cascadedDeclaration(".message .msg-edited", "color"))).toBe("--text-muted");
  });
});
