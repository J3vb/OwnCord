// jsdom never applies app.css, so a computed-style assertion here would pass
// whether or not the rules exist (see status-picker-userbar.test.ts for the
// same pattern). Instead this pins the CSS *source*.
//
// applyTheme() (components/settings/helpers.ts) writes theme tokens --
// including --text-normal -- as an *inline* style on document.documentElement.
// An inline declaration always beats a plain class rule on the same element,
// so `.high-contrast { --text-normal: ... }` can never win against it: the
// High Contrast toggle's headline promise (pure-white body text) is a no-op
// unless the override is `!important`.
//
// applyThemeByName() (lib/themes.ts) does the same thing for custom themes,
// except it writes the inline override on document.body instead of
// documentElement -- so the override also needs a selector that reaches body
// while high-contrast is active, not just one that targets html.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe("high-contrast CSS overrides beat inline theme styles", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

  function highContrastRuleBody(): string {
    const match = /\.high-contrast[^{]*\{([^}]*)\}/.exec(css);
    expect(match, "expected a `.high-contrast { ... }` rule in app.css").not.toBeNull();
    return match![1]!;
  }

  it("declares --text-normal, --text-muted, and --bg-active with !important", () => {
    const body = highContrastRuleBody();

    for (const prop of ["--text-normal", "--text-muted", "--bg-active"]) {
      const declaration = new RegExp(`${prop}\\s*:[^;]*;`).exec(body);
      expect(declaration, `expected a declaration for ${prop}`).not.toBeNull();
      expect(
        declaration![0],
        `${prop} must be !important -- otherwise applyTheme()'s inline style on ` +
          `documentElement always wins and the toggle does nothing`,
      ).toMatch(/!important/);
    }
  });

  it("also reaches document.body, where custom-theme inline overrides live", () => {
    expect(
      css,
      "expected a selector reaching body while .high-contrast is active (e.g. " +
        "`.high-contrast body`), otherwise custom themes' inline body vars never see the override",
    ).toMatch(/\.high-contrast[^{,]*body\s*[{,]/);
  });
});
