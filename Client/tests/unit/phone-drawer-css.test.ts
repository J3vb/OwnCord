// The phone drawer's layout is CSS, and jsdom never applies it, so these read
// the parsed stylesheet (Lightning CSS, as tests/helpers/app-css.ts does) and
// walk the @media rules that helper leaves out.
import { join } from "node:path";
import { bundle } from "lightningcss";
import type { Rule, Selector } from "lightningcss";
import { describe, expect, it } from "vitest";

interface FlatRule {
  readonly media: string;
  /** Each comma-separated query of the media rule, as Lightning CSS parsed it. */
  readonly queries: readonly string[];
  readonly selector: string;
  readonly declarations: string;
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
  const walk = (rules: Rule[], media: string, queries: readonly string[]): void => {
    for (const rule of rules) {
      if (rule.type === "media") {
        walk(
          rule.value.rules,
          JSON.stringify(rule.value.query),
          rule.value.query.mediaQueries.map((q) => JSON.stringify(q)),
        );
      } else if (rule.type === "style") {
        const decls = [
          ...(rule.value.declarations?.declarations ?? []),
          ...(rule.value.declarations?.importantDeclarations ?? []),
        ];
        for (const sel of rule.value.selectors) {
          out.push({
            media,
            queries,
            selector: selectorText(sel),
            declarations: JSON.stringify(decls),
          });
        }
      }
    }
  };
  walk(sheetRules, "", []);
  return out;
}

const rules = flatRules();

/** The media text of the phone layout: a touch screen that is narrow or short. */
const isPhoneMedia = (r: FlatRule): boolean =>
  // Exactly the phone query's two halves: a rule that also lists the plain
  // 800 px width is the narrow-window rule, not a phone-only one.
  r.queries.length === 2 &&
  r.queries.every((q) => q.includes('"name":"pointer"') && q.includes('"coarse"')) &&
  r.media.includes('"name":"width"') &&
  r.media.includes('"value":899') &&
  r.media.includes('"name":"height"') &&
  r.media.includes('"value":499');

function phoneRule(selector: string): FlatRule | undefined {
  return rules.find((r) => r.selector === selector && isPhoneMedia(r));
}

describe("the server rail in the phone drawer", () => {
  it("stays hidden in a narrow window, whatever the pointer", () => {
    // One query of the rule is the plain 800 px width, with no pointer in it.
    const hiding = rules.filter(
      (r) =>
        r.selector === ".server-rail-slot" &&
        r.queries.some((q) => q.includes('"value":800') && !q.includes("coarse")) &&
        r.declarations.includes('"none"'),
    );
    expect(hiding.length).toBeGreaterThan(0);
  });

  it("shows as a fixed column on the drawer's left, in the drawer's layer, only while the drawer is open", () => {
    const shown = phoneRule(".server-rail-slot.drawer-open");
    expect(shown).toBeDefined();
    expect(shown!.declarations).toContain('"flex"');
    expect(shown!.declarations).toContain('"fixed"');
    expect(shown!.declarations).toContain("100");
    // No rule shows the slot on a phone without the drawer being open.
    expect(phoneRule(".server-rail-slot")?.declarations ?? "").not.toContain('"flex"');
  });

  it("is about 72 px wide, with touch-sized buttons", () => {
    const width = phoneRule(".app.has-server-rail");
    expect(width?.declarations).toContain("--drawer-rail-width");
    expect(width?.declarations).toContain("72");
    const button = phoneRule(".server-rail-slot.drawer-open .server-rail-btn");
    expect(button?.declarations).toContain("48");
  });

  it("moves the channel list to the rail's right", () => {
    const list = phoneRule(".app.has-server-rail .unified-sidebar.drawer-open");
    expect(list).toBeDefined();
    expect(list!.declarations).toContain("--drawer-rail-width");
  });

  it("replaces the user bar's Switch server button on a phone", () => {
    const rule = phoneRule('.app.has-server-rail .user-bar [data-testid="disconnect-btn"]');
    expect(rule).toBeDefined();
    expect(rule!.declarations).toContain('"none"');
    // The portal has no rail class, so its button is not matched here.
    expect(rule!.selector).toContain(".has-server-rail");
  });
});

describe("the drawer's search button", () => {
  it("is hidden by default and shown only in the open phone drawer", () => {
    const hidden = rules.find((r) => r.selector === ".sidebar-drawer-search" && r.media === "");
    expect(hidden?.declarations).toContain('"none"');
    const shown = phoneRule(".unified-sidebar.drawer-open .sidebar-drawer-search");
    expect(shown?.declarations).toContain('"flex"');
    // Touch-sized.
    expect(shown?.declarations).toContain("44");
  });
});

describe("touch-action for the swipes", () => {
  it("lets the browser scroll vertically and zoom, and leaves horizontal moves to the page", () => {
    for (const selector of [
      ".chat-area",
      ".messages-container",
      ".unified-sidebar",
      ".channel-list",
      ".member-column",
      ".member-column-body",
      ".server-rail-slot",
    ]) {
      const rule = phoneRule(selector);
      expect(rule, selector).toBeDefined();
      expect(rule!.declarations).toContain("touch-action");
      expect(rule!.declarations).toContain("pan-y");
    }
  });
});
