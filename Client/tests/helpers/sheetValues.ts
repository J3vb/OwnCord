// Reading one stylesheet's parsed declarations by selector, for the tests that
// pin a Deck stylesheet's values (tests/helpers/deck-css.ts parses them).
import { expect } from "vitest";
import { parseDeckCss, type DeckDeclaration, type DeckRule } from "./deck-css";

export interface SheetValues {
  /** Every declaration of `property` in a rule listing `selector`, in `media` (null: top level). */
  declarations(selector: string, property: string, media?: string | null): DeckDeclaration[];
  /** The one such declaration, as its parsed value. */
  valueOf(selector: string, property: string, media?: string | null): string;
  /** The parse of `property: value` in a one-rule fixture. */
  parsed(property: string, value: string): string;
}

export function sheetValues(rules: () => readonly DeckRule[]): SheetValues {
  const declarations = (selector: string, property: string, media: string | null = null) =>
    rules()
      .filter((r) => r.media === media && r.selectors.includes(selector))
      .flatMap((r) => r.declarations.filter((d) => d.property === property));
  return {
    declarations,
    valueOf(selector, property, media = null) {
      const found = declarations(selector, property, media);
      expect(found, `${selector} { ${property} }`).toHaveLength(1);
      return JSON.stringify(found[0]!.value);
    },
    parsed(property, value) {
      const rule = parseDeckCss(`html.layout-deck .x { ${property}: ${value}; }`)[0]!;
      return JSON.stringify(rule.declarations[0]!.value);
    },
  };
}
