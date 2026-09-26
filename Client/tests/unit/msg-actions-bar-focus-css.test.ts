// jsdom never applies app.css, so a computed-style assertion against the
// rendered action bar would pass whether or not the rule exists. This asserts
// the parsed stylesheet rules (tests/helpers/app-css.ts) instead.
//
// renderers.ts creates the per-message action bar (.msg-actions-bar) out of
// real, focusable <button> elements (msg-react-*, msg-reply-*, msg-pin-*,
// msg-edit-*, msg-delete-*, msg-copy-link-*). app.css only reveals that bar
// on `.message:hover` -- Tab still walks a keyboard user through the
// buttons (they are in the tab order), but they stay `opacity: 0` and
// `pointer-events: none` the whole time, so focus is invisible and Enter can
// fire an action (e.g. delete) the user never saw highlighted.
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe(".msg-actions-bar keyboard-focus visibility", () => {
  it("app.css reveals .msg-actions-bar when the message has focus-within, not just on hover", () => {
    const selector = ".message:focus-within .msg-actions-bar";
    expect(
      keyword(cascadedDeclaration(selector, "opacity")),
      "expected `.message:focus-within .msg-actions-bar` to set opacity: 1 so " +
        "Tab-focused action buttons (created as real <button>s in renderers.ts) become " +
        "visible instead of firing invisibly at opacity: 0",
    ).toBe("1");
    expect(
      keyword(cascadedDeclaration(selector, "pointer-events")),
      "the focus-within rule must re-enable pointer-events so the now-visible buttons are clickable",
    ).toBe("auto");
  });
});
