// jsdom never applies app.css, so a computed-style assertion against the
// rendered action bar would pass whether or not the rule exists (see
// video-grid-track-muted-css.test.ts / base-font-size-css.test.ts for the
// same pattern). This pins the CSS *source* instead.
//
// renderers.ts creates the per-message action bar (.msg-actions-bar) out of
// real, focusable <button> elements (msg-react-*, msg-reply-*, msg-pin-*,
// msg-edit-*, msg-delete-*, msg-copy-link-*). app.css only reveals that bar
// on `.message:hover` -- Tab still walks a keyboard user through the
// buttons (they are in the tab order), but they stay `opacity: 0` and
// `pointer-events: none` the whole time, so focus is invisible and Enter can
// fire an action (e.g. delete) the user never saw highlighted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe(".msg-actions-bar keyboard-focus visibility", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

  it("app.css reveals .msg-actions-bar when the message has focus-within, not just on hover", () => {
    // Match a `.message:focus-within .msg-actions-bar { ... }` rule (order of
    // declarations inside doesn't matter) that sets opacity to 1.
    const match = /\.message:focus-within\s+\.msg-actions-bar\s*\{([^}]*)\}/.exec(css);
    expect(
      match,
      "expected a `.message:focus-within .msg-actions-bar { ... }` rule in app.css so " +
        "Tab-focused action buttons (created as real <button>s in renderers.ts) become " +
        "visible instead of firing invisibly at opacity: 0",
    ).not.toBeNull();

    const body = match![1]!;
    expect(body, "the focus-within rule must set opacity: 1").toMatch(/opacity\s*:\s*1\b/);
    expect(
      body,
      "the focus-within rule must re-enable pointer-events so the now-visible buttons are clickable",
    ).toMatch(/pointer-events\s*:\s*auto\b/);
  });
});
