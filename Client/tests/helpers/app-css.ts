// jsdom never applies stylesheets, so the CSS tests parse app.css with
// Lightning CSS (the parser Vite already uses) and assert on its rules rather
// than on the source text: comments and formatting cannot fake a match.
// bundle() inlines app.css's @import manifest in cascade order, as the build
// does.
import { join } from "node:path";
import { bundle } from "lightningcss";
import type { Declaration, Selector, StyleSheet } from "lightningcss";

export interface CssDeclaration {
  readonly value: Declaration;
  readonly important: boolean;
}

interface StyleRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyArray<CssDeclaration & { readonly property: string }>;
}

const COMBINATORS: Record<string, string> = {
  descendant: " ",
  child: " > ",
  "next-sibling": " + ",
  "later-sibling": " ~ ",
  "pseudo-element": "",
};

function selectorText(selector: Selector): string {
  return selector
    .map((c) => {
      switch (c.type) {
        case "class":
          return `.${c.name}`;
        case "id":
          return `#${c.name}`;
        case "type":
          return c.name;
        case "universal":
          return "*";
        case "combinator":
          return COMBINATORS[c.value] ?? ` ${c.value} `;
        case "pseudo-class":
          return `:${c.kind}`;
        case "pseudo-element":
          return `::${c.kind}`;
        default:
          // Not needed by any test; never equal to a real selector string.
          return `<${c.type}>`;
      }
    })
    .join("");
}

function propertyName(d: Declaration): string {
  if (d.property === "custom") return d.value.name;
  if (d.property === "unparsed") return d.value.propertyId.property;
  return d.property;
}

let cached: readonly StyleRule[] | undefined;

/** Top-level style rules of app.css, in cascade order. Rules inside @media
 *  and other conditional at-rules are left out: they do not always apply. */
function appCssRules(): readonly StyleRule[] {
  if (cached) return cached;
  let sheet: StyleSheet | undefined;
  bundle({
    filename: join(process.cwd(), "src/styles/app.css"),
    visitor: {
      StyleSheet(s) {
        sheet = s;
      },
    },
  });
  const rules: StyleRule[] = [];
  for (const rule of sheet!.rules) {
    if (rule.type !== "style") continue;
    const { declarations = [], importantDeclarations = [] } = rule.value.declarations ?? {};
    rules.push({
      selectors: rule.value.selectors.map(selectorText),
      declarations: [
        ...declarations.map((value) => ({
          value,
          important: false,
          property: propertyName(value),
        })),
        ...importantDeclarations.map((value) => ({
          value,
          important: true,
          property: propertyName(value),
        })),
      ],
    });
  }
  cached = rules;
  return rules;
}

/** Whether any unconditional rule targets exactly `selector` (one entry of its
 *  selector list, as Lightning CSS prints it, e.g. `.a:hover .b > c`). */
export function hasRule(selector: string): boolean {
  return appCssRules().some((r) => r.selectors.includes(selector));
}

/** The declaration of `property` that wins the cascade for an element matched
 *  by exactly `selector`: across every unconditional rule listing that
 *  selector, !important beats normal and a later rule beats an earlier one. */
export function cascadedDeclaration(
  selector: string,
  property: string,
): CssDeclaration | undefined {
  let winner: CssDeclaration | undefined;
  for (const rule of appCssRules()) {
    if (!rule.selectors.includes(selector)) continue;
    for (const d of rule.declarations) {
      if (d.property !== property) continue;
      if (winner?.important && !d.important) continue;
      winner = { value: d.value, important: d.important };
    }
  }
  return winner;
}

/** A single-keyword or single-number value as text (`auto`, `none`, `1`),
 *  whether Lightning CSS typed the property or kept it as raw tokens;
 *  undefined for anything more complex. */
export function keyword(d: CssDeclaration | undefined): string | undefined {
  if (!d) return undefined;
  const v: unknown = d.value.value;
  if (typeof v === "string" || typeof v === "number") return String(v);
  const tokens = d.value.property === "custom" ? d.value.value.value : undefined;
  if (tokens?.length !== 1) return undefined;
  const t = tokens[0]!;
  if (t.type !== "token") return undefined;
  if (t.value.type === "ident") return t.value.value;
  if (t.value.type === "number") return String(t.value.value);
  return undefined;
}
