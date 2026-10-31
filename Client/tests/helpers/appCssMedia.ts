import { join } from "node:path";
import { bundle } from "lightningcss";
import type { Declaration, Rule, Selector } from "lightningcss";
import type { CssDeclaration } from "./app-css";

export interface FlatCssRule {
  readonly media: string;
  /** Each comma-separated query of the media rule, as Lightning CSS parsed it. */
  readonly queries: readonly string[];
  readonly selector: string;
  readonly declarations: readonly Declaration[];
}

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
        case "combinator":
          return c.value === "descendant" ? " " : ` ${c.value} `;
        case "attribute":
          return c.operation ? `[${c.name}="${c.operation.value}"]` : `[${c.name}]`;
        default:
          return `<${c.type}>`;
      }
    })
    .join("");
}

/** Every style rule of app.css, one entry per selector, with the @media text it sits under. */
export function flatMediaRules(): FlatCssRule[] {
  let sheetRules: Rule[] = [];
  bundle({
    filename: join(process.cwd(), "src/styles/app.css"),
    visitor: {
      StyleSheet(s) {
        sheetRules = s.rules;
      },
    },
  });
  const out: FlatCssRule[] = [];
  const walk = (rules: Rule[], media: string, queries: readonly string[]): void => {
    for (const rule of rules) {
      if (rule.type === "media") {
        walk(
          rule.value.rules,
          JSON.stringify(rule.value.query),
          rule.value.query.mediaQueries.map((q) => JSON.stringify(q)),
        );
      } else if (rule.type === "style") {
        const declarations = [
          ...(rule.value.declarations?.declarations ?? []),
          ...(rule.value.declarations?.importantDeclarations ?? []),
        ];
        for (const sel of rule.value.selectors) {
          out.push({ media, queries, selector: selectorText(sel), declarations });
        }
      }
    }
  };
  walk(sheetRules, "", []);
  return out;
}

/** A length declaration's px value, or undefined for anything else. */
export function px(d: CssDeclaration | undefined): number | undefined {
  const v: { type?: string; value?: { type?: string; value?: { unit?: string; value?: number } } } =
    (d?.value as Declaration | undefined)?.value as never;
  if (v?.type === "length-percentage" && v.value?.value?.unit === "px") {
    return v.value.value.value;
  }
  return undefined;
}
