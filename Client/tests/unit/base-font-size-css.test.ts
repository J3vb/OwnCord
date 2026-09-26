// jsdom never applies base.css (see appearance-high-contrast.test.ts for the
// same pattern), so this pins the CSS *source* rather than computed style.
//
// Three code paths write the `--font-size` custom property:
//   - applyStoredAppearance() (lib/appearance.ts) at startup
//   - the Appearance-tab Font Size slider (components/settings/AppearanceTab.ts)
//   - the Accessibility-tab "Large Font" toggle, which since OC-0319 goes
//     through the same applyFontSize() writer rather than a `.large-font` CSS
//     rule (an inline style outranks a class rule, so that rule never fired)
// and base.css:22 reads it back as `font-size: var(--font-size, 14px)`. This
// test is what keeps that read in place: when it was a hardcoded literal, both
// controls persisted state and changed nothing rendered.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe("body font-size consumes the --font-size custom property", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/base.css"), "utf8");

  function bodyRuleBody(): string {
    // The bare `body { ... }` rule (not the `html,\nbody { ... }` reset above
    // it) -- require a preceding closing brace so we don't match mid-selector
    // "html,\nbody {".
    const match = /(?<=\})\s*body\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a `body { ... }` rule in base.css").not.toBeNull();
    return match![1]!;
  }

  it("declares font-size via var(--font-size, ...), not a hardcoded literal", () => {
    const body = bodyRuleBody();
    const declaration = /font-size\s*:[^;]*;/.exec(body);
    expect(declaration, "expected a font-size declaration on body").not.toBeNull();
    expect(
      declaration![0],
      "body's font-size must read var(--font-size, ...) -- otherwise the Font Size " +
        "slider and the Large Font accessibility toggle write --font-size and nothing " +
        "renders differently",
    ).toMatch(/var\(--font-size\b/);
  });
});
