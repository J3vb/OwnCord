// B9 exit-audit accessibility fixes whose effect is a stylesheet rule:
// A11Y-03 (restore the focus ring on mentions/link chips and the status
// custom input), A11Y-04 (the in-app Reduce Motion toggle must stop
// ::before/::after animations too) and A11Y-06 (--red is fill-only; text uses
// the qualified --text-danger token).
//
// jsdom never applies app.css, so these assert the parsed stylesheet rules
// (tests/helpers/app-css.ts) rather than the rendered DOM. The e2e specs prove
// the computed behaviour.
import type { Declaration } from "lightningcss";
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

/** The custom-property name a declaration reads as a bare `var(--x)`. */
function varToken(d: ReturnType<typeof cascadedDeclaration>): string | undefined {
  const v = d?.value as Declaration | undefined;
  if (v?.property !== "unparsed") return undefined;
  const tokens = v.value.value;
  if (tokens.length !== 1) return undefined;
  const t = tokens[0]!;
  return t.type === "var" ? t.value.name.ident : undefined;
}

/** A time declaration's seconds value (`0s` -> 0), or undefined. */
function seconds(d: ReturnType<typeof cascadedDeclaration>): number | undefined {
  const v = (d?.value as Declaration | undefined)?.value as unknown;
  const first = Array.isArray(v) ? v[0] : v;
  if (
    typeof first === "object" &&
    first !== null &&
    (first as { type?: string }).type === "seconds" &&
    typeof (first as { value?: number }).value === "number"
  ) {
    return (first as { value: number }).value;
  }
  return undefined;
}

describe("B9 exit-audit accessibility CSS", () => {
  it.each([
    ".channel-mention:focus-visible",
    ".message-link-chip:focus-visible",
    ".status-picker-custom-input:focus",
  ])("does not suppress the focus outline on %s (A11Y-03)", (selector) => {
    expect(keyword(cascadedDeclaration(selector, "outline"))).not.toBe("none");
  });

  it("names the mention/chip focus fill as the accent, not the ring", () => {
    // The fill stays for keyboard focus; only the outline was removed before.
    expect(varToken(cascadedDeclaration(".channel-mention:focus-visible", "background"))).toBe(
      "--accent",
    );
  });

  it.each([".reduced-motion *::before", ".reduced-motion *::after"])(
    "zeroes animations on %s under the in-app toggle (A11Y-04)",
    (selector) => {
      const d = cascadedDeclaration(selector, "animation-duration");
      expect(d?.important).toBe(true);
      expect(seconds(d)).toBe(0);
    },
  );

  it.each([
    ".context-menu-item.danger",
    ".context-menu__item--danger",
    ".settings-nav-item.danger",
    ".attachment-upload-error",
  ])("uses the qualified --text-danger token for %s (A11Y-06)", (selector) => {
    expect(varToken(cascadedDeclaration(selector, "color"))).toBe("--text-danger");
  });
});
