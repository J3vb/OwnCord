// jsdom never applies app.css, so this asserts the parsed stylesheet rules
// (tests/helpers/app-css.ts) rather than computed style.
//
// .quick-switch-modal sat in a `position: fixed; inset: 0; display: flex;
// align-items: center` backdrop with `overflow: hidden` and no max-height, so
// once enough saved server profiles made the modal taller than the viewport
// it overflowed the fixed backdrop symmetrically above and below the fold
// with nothing to scroll -- the first profile row and the "Add new server"
// row (both children of .quick-switch-list) became unreachable.
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe(".quick-switch-modal", () => {
  it("clamps its own height instead of overflowing the fixed backdrop", () => {
    expect(
      cascadedDeclaration(".quick-switch-modal", "max-height"),
      "modal must cap its height against the viewport",
    ).toBeDefined();
  });

  it("lets .quick-switch-list scroll so clipped rows (profiles, Add new server) stay reachable", () => {
    expect(
      keyword(cascadedDeclaration(".quick-switch-list", "overflow-y")),
      "row list must scroll once the modal clamps",
    ).toBe("auto");
  });
});
