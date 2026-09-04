// jsdom never applies app.css (see base-font-size-css.test.ts for the same
// pattern), so this pins the CSS *source* rather than computed style.
//
// .quick-switch-modal sat in a `position: fixed; inset: 0; display: flex;
// align-items: center` backdrop with `overflow: hidden` and no max-height, so
// once enough saved server profiles made the modal taller than the viewport
// it overflowed the fixed backdrop symmetrically above and below the fold
// with nothing to scroll -- the first profile row and the "Add new server"
// row (both children of .quick-switch-list) became unreachable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe(".quick-switch-modal", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

  it("clamps its own height instead of overflowing the fixed backdrop", () => {
    const match = /\.quick-switch-modal\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a `.quick-switch-modal { ... }` rule in app.css").not.toBeNull();
    expect(match![1]!, "modal must cap its height against the viewport").toMatch(/max-height\s*:/);
  });

  it("lets .quick-switch-list scroll so clipped rows (profiles, Add new server) stay reachable", () => {
    const match = /\.quick-switch-list\s*\{([^}]*)\}/.exec(css);
    expect(match, "expected a `.quick-switch-list { ... }` rule in app.css").not.toBeNull();
    expect(match![1]!, "row list must scroll once the modal clamps").toMatch(
      /overflow-y\s*:\s*auto\b/,
    );
  });
});
