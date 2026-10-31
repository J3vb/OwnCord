// The phone polish is mostly CSS, which jsdom never applies, so these read the
// parsed stylesheet (Lightning CSS, as tests/helpers/app-css.ts does) and walk
// its @media rules too.
import { join } from "node:path";
import { bundle } from "lightningcss";
import type { Declaration, Rule, Selector } from "lightningcss";
import { describe, expect, it } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

interface FlatRule {
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
        case "type":
          return c.name;
        case "combinator":
          return c.value === "descendant" ? " " : ` ${c.value} `;
        default:
          return `<${c.type}>`;
      }
    })
    .join("");
}

function flatRules(): FlatRule[] {
  let sheetRules: Rule[] = [];
  bundle({
    filename: join(process.cwd(), "src/styles/app.css"),
    visitor: {
      StyleSheet(s) {
        sheetRules = s.rules;
      },
    },
  });
  const out: FlatRule[] = [];
  const walk = (rules: Rule[], queries: readonly string[]): void => {
    for (const rule of rules) {
      if (rule.type === "media") {
        walk(
          rule.value.rules,
          rule.value.query.mediaQueries.map((q) => JSON.stringify(q)),
        );
      } else if (rule.type === "style") {
        const declarations = [
          ...(rule.value.declarations?.declarations ?? []),
          ...(rule.value.declarations?.importantDeclarations ?? []),
        ];
        for (const sel of rule.value.selectors) {
          out.push({ queries, selector: selectorText(sel), declarations });
        }
      }
    }
  };
  walk(sheetRules, []);
  return out;
}

const rules = flatRules();

/** Only the phone layout: both halves of the query are a coarse pointer and a size. */
function phoneRule(selector: string): FlatRule | undefined {
  return rules.find(
    (r) =>
      r.selector === selector &&
      r.queries.length === 2 &&
      r.queries.every((q) => q.includes('"coarse"')),
  );
}

/** The declaration of `property` in a rule, as JSON text. */
function declared(rule: FlatRule | undefined, property: string): string {
  const d = rule?.declarations.find((x) => x.property === property);
  return d === undefined ? "" : JSON.stringify(d);
}

const FORTY_FOUR = '"unit":"px","value":44';

describe("44 px touch targets on the phone layout", () => {
  it("reaction chips are 44 px tall", () => {
    expect(declared(phoneRule(".reaction-chip"), "min-height")).toContain(FORTY_FOUR);
  });

  it("the add-reaction button is 44 px wide as well", () => {
    expect(declared(phoneRule(".reaction-chip.add-reaction"), "min-width")).toContain(FORTY_FOUR);
  });

  it("rows of both context menu families are 44 px tall", () => {
    expect(declared(phoneRule(".context-menu-item"), "min-height")).toContain(FORTY_FOUR);
    expect(declared(phoneRule(".context-menu__item"), "min-height")).toContain(FORTY_FOUR);
  });

  it("leave the desktop chip and rows at their own size", () => {
    expect(
      declared(
        rules.find((r) => r.selector === ".reaction-chip" && r.queries.length === 0),
        "min-height",
      ),
    ).toContain('"value":24');
    expect(cascadedDeclaration(".context-menu-item", "min-height")).toBeUndefined();
  });
});

describe("the 'delivery not confirmed' line", () => {
  it("wraps its row, so Retry and Delete drop under a long reason", () => {
    expect(keyword(cascadedDeclaration(".msg-send-failed", "flex-wrap"))).toBe("wrap");
  });

  it("lets the reason shrink and break instead of running off the row", () => {
    const text = (property: string): Declaration | undefined =>
      cascadedDeclaration(".msg-send-failed-text", property)?.value;
    expect(JSON.stringify(text("min-width"))).toContain('"value":0');
    // `flex: 0 1 auto` - the shrink factor is 1, not the old `flex-shrink: 0`.
    expect(JSON.stringify(text("flex"))).toContain('"shrink":1');
    expect(text("flex-shrink")).toBeUndefined();
    expect(keyword(cascadedDeclaration(".msg-send-failed-text", "overflow-wrap"))).toBe("anywhere");
    // No ellipsis, no single-line clip.
    expect(cascadedDeclaration(".msg-send-failed-text", "text-overflow")).toBeUndefined();
    expect(cascadedDeclaration(".msg-send-failed-text", "white-space")).toBeUndefined();
  });
});
