/**
 * The Command Deck status bar: the strip along the bottom of the page that
 * holds the user bar and, in a call, the voice widget. It is built empty and
 * detached; `mountDeckFrame` moves the sidebar's two slots into it.
 */
import { createElement } from "@lib/dom";

/** A detached `div.deck-status-bar` (data-testid "deck-status-bar"). Owns nothing. */
export function createDeckStatusBar(): HTMLDivElement {
  return createElement("div", {
    class: "deck-status-bar",
    "data-testid": "deck-status-bar",
  });
}
