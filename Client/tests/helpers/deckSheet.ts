// What a stylesheet held to a Deck colour policy needs besides the policy
// itself: its parsed rules, and the selectors that break the rule that every
// selector is scoped to Command Deck.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeckCss, type DeckRule } from "./deck-css";

/** The parsed rules of a stylesheet under src/styles, e.g. "app/server-tabs.css". */
export function sheetRules(file: string): readonly DeckRule[] {
  return parseDeckCss(readFileSync(join(process.cwd(), "src/styles", file), "utf8"));
}

/** The lines of src/styles/app.css, the @import manifest whose order is the cascade. */
export function appCssLines(): string[] {
  return readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8").split("\n");
}

/** True for `html.layout-deck` itself or a selector under it, High Contrast included. */
export function deckScoped(selector: string): boolean {
  return (
    selector === "html.layout-deck" ||
    selector.startsWith("html.layout-deck ") ||
    selector.startsWith("html.layout-deck.high-contrast ")
  );
}

/** Every selector in `rules` that is not Deck-scoped. */
export function unscopedSelectors(rules: readonly DeckRule[]): string[] {
  return rules.flatMap((r) => r.selectors.filter((s) => !deckScoped(s)));
}
