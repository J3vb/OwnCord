// jsdom never applies app.css, so a computed-style assertion here would pass
// whether or not the rules exist. Instead this asserts the parsed stylesheet
// rules (tests/helpers/app-css.ts).
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
import { cascadedDeclaration } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("high-contrast CSS overrides beat inline theme styles", () => {
  const PROPS = ["--text-normal", "--text-muted", "--bg-active"];

  function expectImportantOverrides(selector: string, why: string): void {
    for (const prop of PROPS) {
      const declaration = cascadedDeclaration(selector, prop);
      expect(declaration, `expected \`${selector}\` to declare ${prop}`).toBeDefined();
      expect(
        declaration!.important,
        `${prop} on \`${selector}\` must be !important -- ${why}`,
      ).toBe(true);
    }
  }

  it("declares --text-normal, --text-muted, and --bg-active with !important", () => {
    expectImportantOverrides(
      ".high-contrast",
      "otherwise applyTheme()'s inline style on documentElement always wins and the toggle does nothing",
    );
  });

  it("also reaches document.body, where custom-theme inline overrides live", () => {
    expectImportantOverrides(
      ".high-contrast body",
      "otherwise custom themes' inline body vars never see the override",
    );
  });
});
