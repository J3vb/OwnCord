// jsdom never applies login.css (see base-font-size-css.test.ts for the same
// pattern), so this pins the CSS *source* rather than computed style.
//
// CreateChannelModal, EditChannelModal, DeleteChannelModal and NsfwGate all
// give their secondary action the class `btn-modal-cancel`. The rule that
// clearly belongs to it existed only as the orphaned `.btn-cancel` (nothing
// used that selector), so base.css's global `button { border:none;
// background:none; }` reset was all that ever applied — Cancel rendered as
// bare unstyled text beside a styled `.btn-modal-save` pill.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe(".btn-modal-cancel", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/login.css"), "utf8");

  it("is defined in login.css", () => {
    const match = /\.btn-modal-cancel\s*\{([^}]*)\}/.exec(css);
    expect(
      match,
      "expected a `.btn-modal-cancel { ... }` rule in login.css -- " +
        "CreateChannelModal/EditChannelModal/DeleteChannelModal/NsfwGate all use this class",
    ).not.toBeNull();
    expect(match![1]!, "must give the button padding, not just the bare reset").toMatch(
      /padding\s*:/,
    );
  });

  it("has no leftover .btn-cancel selector nothing uses", () => {
    expect(
      /(?<![-\w])\.btn-cancel\b/.test(css),
      "the orphaned .btn-cancel selector should have been renamed, not duplicated",
    ).toBe(false);
  });

  it("styles the hover state", () => {
    expect(/\.btn-modal-cancel:hover\s*\{/.test(css)).toBe(true);
  });
});
