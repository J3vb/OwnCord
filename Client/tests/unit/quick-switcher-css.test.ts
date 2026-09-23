// jsdom never applies app.css, so this asserts the parsed stylesheet rules
// (tests/helpers/app-css.ts) rather than computed style.
//
// createQuickSwitcher (Ctrl+K) builds its whole UI out of `quick-switcher`,
// `quick-switcher__input`, `quick-switcher__results`, `quick-switcher__item`
// and `quick-switcher__item--active`. None of those classes existed in any
// stylesheet: the modal rendered as unstyled text on a dark backdrop, the
// results list had no max-height/scroller, and — the functional break — the
// roving `--active` highlight ArrowUp/ArrowDown moves painted nothing at all.
import { cascadedDeclaration, hasRule, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe(".quick-switcher (Ctrl+K) has a stylesheet", () => {
  it("styles the modal container", () => {
    expect(hasRule(".quick-switcher"), "expected a `.quick-switcher { ... }` rule in app.css").toBe(
      true,
    );
  });

  it("styles the search input", () => {
    expect(
      hasRule(".quick-switcher__input"),
      "expected a `.quick-switcher__input { ... }` rule in app.css",
    ).toBe(true);
  });

  it("gives the results list a bounded height and a scroller", () => {
    expect(
      cascadedDeclaration(".quick-switcher__results", "max-height"),
      "results list must clamp its height",
    ).toBeDefined();
    expect(
      keyword(cascadedDeclaration(".quick-switcher__results", "overflow-y")),
      "results list must scroll once clamped",
    ).toBe("auto");
  });

  it("paints the roving keyboard highlight ArrowUp/ArrowDown moves onto --active", () => {
    expect(
      cascadedDeclaration(".quick-switcher__item--active", "background"),
      "expected `.quick-switcher__item--active` to set a background so the " +
        "arrow-key selection renderResults() moves is actually visible",
    ).toBeDefined();
  });
});
