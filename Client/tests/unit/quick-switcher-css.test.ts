// jsdom never applies app.css (see base-font-size-css.test.ts /
// msg-actions-bar-focus-css.test.ts for the same pattern), so this pins the
// CSS *source* rather than computed style.
//
// createQuickSwitcher (Ctrl+K) builds its whole UI out of `quick-switcher`,
// `quick-switcher__input`, `quick-switcher__results`, `quick-switcher__item`
// and `quick-switcher__item--active`. None of those classes existed in any
// stylesheet: the modal rendered as unstyled text on a dark backdrop, the
// results list had no max-height/scroller, and — the functional break — the
// roving `--active` highlight ArrowUp/ArrowDown moves painted nothing at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe(".quick-switcher (Ctrl+K) has a stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

  it("styles the modal container", () => {
    expect(
      /\.quick-switcher\s*\{/.test(css),
      "expected a `.quick-switcher { ... }` rule in app.css",
    ).toBe(true);
  });

  it("styles the search input", () => {
    expect(
      /\.quick-switcher__input\s*\{/.test(css),
      "expected a `.quick-switcher__input { ... }` rule in app.css",
    ).toBe(true);
  });

  it("gives the results list a bounded height and a scroller", () => {
    const match = /\.quick-switcher__results\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a `.quick-switcher__results { ... }` rule in app.css").not.toBeNull();
    const body = match![1]!;
    expect(body, "results list must clamp its height").toMatch(/max-height\s*:/);
    expect(body, "results list must scroll once clamped").toMatch(/overflow-y\s*:\s*auto\b/);
  });

  it("paints the roving keyboard highlight ArrowUp/ArrowDown moves onto --active", () => {
    const match = /\.quick-switcher__item--active\s*\{([^}]*)\}/.exec(css);
    expect(
      match,
      "expected a `.quick-switcher__item--active { ... }` rule in app.css so the " +
        "arrow-key selection renderResults() moves is actually visible",
    ).not.toBeNull();
    const body = match![1]!;
    expect(body, "the active row must set a background").toMatch(/background\s*:/);
  });
});
