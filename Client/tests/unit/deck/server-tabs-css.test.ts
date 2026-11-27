// jsdom applies no stylesheets, so what the Deck mounts add to the top bar is
// pinned from the Lightning CSS parse of server-tabs.css
// (tests/helpers/deck-css.ts). Its colour policy widens deck.css's for the
// Ember top line, the count badge and the folder glyph.
import { describe, expect, it } from "vitest";
import { colourPolicyBreaches, parseDeckCss, type ColourPolicy } from "../../helpers/deck-css";
import { preludesOf, type DeckDeclaration, type DeckRule } from "../../helpers/deck-css";
import { appCssLines, sheetRules, unscopedSelectors as stray } from "../../helpers/deckSheet";
import { PHONE_LAYOUT_QUERY } from "../../../src/lib/ui/phoneLayout";

const POLICY: ColourPolicy = {
  colourVars: new Set([
    "--bg-secondary",
    "--bg-tertiary",
    "--bg-hover",
    "--border",
    "--border-control",
    "--text-muted",
    "--header-primary",
    "--accent-text",
    "--danger-fill",
    "--on-fill",
    "--folder-color",
  ]),
  fillOnlyVars: new Set(["--folder-color"]),
  fillProperties: new Set(["background", "background-color", "fill"]),
  keywords: new Set(["none", "transparent", "currentcolor", "inset", "solid", "dashed"]),
  layoutVar: /^--(deck-[a-z-]+|header-height|safe-bottom|radius-[a-z]+|font-size-[a-z]+)$/,
  allowOutlineOffset: true,
  exempt: [],
};

const breaches = (css: string): string[] => colourPolicyBreaches(parseDeckCss(css), POLICY);

const tabsRules = () => sheetRules("app/server-tabs.css");

const DIRECT_GRID = "html.layout-deck .deck-top-bar.has-deck-direct";

/** The grid-template-columns of the `has-deck-direct` rule under `media` (null: top level). */
function directColumns(media: string | null): string[] {
  return tabsRules()
    .filter((r) => r.media === media && r.selectors.includes(DIRECT_GRID))
    .flatMap((r) => r.declarations.filter((d) => d.property === "grid-template-columns"))
    .map((d) => JSON.stringify(d.value));
}

describe("server-tabs.css", () => {
  it("is parsed (the scan is not empty)", () => {
    expect(tabsRules().length).toBeGreaterThan(3);
  });

  it("holds its colour policy for every rule", () => {
    expect(colourPolicyBreaches(tabsRules(), POLICY)).toEqual([]);
  });

  it("every selector is one of the three allowed forms", () => {
    expect(stray(tabsRules())).toEqual([]);
    expect(stray(parseDeckCss("html.layout-deckx .x { margin: 0; }"))).toEqual([
      "html.layout-deckx .x",
    ]);
    expect(stray(parseDeckCss(".deck-direct { margin: 0; }"))).toEqual([".deck-direct"]);
  });

  it("declares the layout variables on html.layout-deck", () => {
    const root = tabsRules().find((r) => r.selectors.includes("html.layout-deck"))!;
    expect(root.declarations.map((d) => d.property)).toEqual(
      expect.arrayContaining([
        "--deck-tabs-min",
        "--deck-tab-gap",
        "--deck-row-gap",
        "--deck-direct-size",
      ]),
    );
  });

  it("gives the bar a fourth column for the Direct button at both widths", () => {
    const wide = directColumns(null);
    const narrow = directColumns("(max-width: 640px)");
    expect(wide).toHaveLength(1);
    expect(narrow).toHaveLength(1);
    // The narrow rule restates deck.css's 640px columns, so the two differ.
    expect(narrow[0]).not.toBe(wide[0]);
  });

  it("hides the badge when it is hidden, whatever its display", () => {
    const hidden = tabsRules().find((r) =>
      r.selectors.includes("html.layout-deck .deck-direct-badge[hidden]"),
    )!;
    expect(hidden.declarations.map((d) => d.property)).toEqual(["display"]);
  });

  // A deliberate exception to Client/CLAUDE.md ("never on its source text"):
  // that rule is about pinning CSS rules through the Lightning CSS parse. The
  // @import order is not a rule any parse shows, so it is read as text.
  it("is imported on the line directly before server-tree.css", () => {
    const lines = appCssLines();
    const tree = lines.indexOf('@import "./app/server-tree.css";');
    expect(tree).toBeGreaterThan(0);
    expect(lines[tree - 1]).toBe('@import "./app/server-tabs.css";');
  });
});

describe("the server-tabs policy", () => {
  it("allows the Ember top line, the badge and a solid folder glyph", () => {
    expect(
      breaches(`
        html.layout-deck .a { box-shadow: inset 0 2px 0 var(--accent-text), inset 1px 0 0 var(--border); }
        html.layout-deck .b { background: var(--danger-fill); color: var(--on-fill); }
        html.layout-deck .c { fill: var(--folder-color); stroke: none; }
        html.layout-deck .d { border: 1px dashed var(--border-control); }
        html.layout-deck .e { outline-offset: -2px; }
      `),
    ).toEqual([]);
  });

  it.each([
    [
      "the folder colour outside a fill property",
      "html.layout-deck .a { color: var(--folder-color); }",
    ],
    ["a token off the list", "html.layout-deck .a { color: var(--text-link); }"],
    ["a named colour", "html.layout-deck .a { color: red; }"],
    ["an outline", "html.layout-deck .a { outline: 1px solid; }"],
    ["a transition", "html.layout-deck .a { transition: color 1s; }"],
    ["an animation", "html.layout-deck .a { animation: spin 1s; }"],
    ["a non-layout var in a layout property", "html.layout-deck .a { padding: var(--space-2); }"],
  ])("fails on %s", (_name, css) => {
    expect(breaches(css).length).toBeGreaterThan(0);
  });
});

const PHONE = PHONE_LAYOUT_QUERY;
const FOLD = `(max-width: 640px), (max-height: 499px), ${PHONE}`;
const NARROW = "(max-width: 640px)";
const TABS_DIRECT = "html.layout-deck .deck-top-bar.has-server-tabs.has-deck-direct";

/** The rules whose selector list is exactly `selector`, under `media` (null: top level). */
function exactRules(selector: string, media: string | null, rules = tabsRules()): DeckRule[] {
  return rules.filter(
    (r) => r.media === media && r.selectors.length === 1 && r.selectors[0] === selector,
  );
}

/** The one declaration of `property` in the rule exactly `selector` under `media`. */
function exactDeclaration(
  selector: string,
  property: string,
  media: string | null,
  rules = tabsRules(),
): DeckDeclaration {
  const found = exactRules(selector, media, rules)
    .flatMap((r) => r.declarations)
    .filter((d) => d.property === property);
  expect(found, `${selector} { ${property} } under ${String(media)}`).toHaveLength(1);
  return found[0]!;
}

/** The parse of `property: value` in a one-rule fixture, to compare with a parsed declaration. */
function parsedValue(property: string, value: string): string {
  const rule = parseDeckCss(`html.layout-deck .x { ${property}: ${value}; }`)[0]!;
  return JSON.stringify(rule.declarations[0]!.value);
}

const valueOf = (d: DeckDeclaration): string => JSON.stringify(d.value);

describe("server-tabs.css: the tab row and the fold", () => {
  it("uses exactly three top-level media queries, the fold, (max-width: 640px) and the phone, and no nested one", () => {
    expect(preludesOf("app/server-tabs.css")).toEqual([FOLD, NARROW, PHONE]);
    expect([...new Set(tabsRules().map((r) => r.media))]).toEqual([null, FOLD, NARROW, PHONE]);
  });

  it("at 640px names each grid rule by its exact selector and value", () => {
    expect(valueOf(exactDeclaration(DIRECT_GRID, "grid-template-columns", NARROW))).toBe(
      parsedValue("grid-template-columns", "minmax(0, 1fr) auto minmax(0, 1fr) auto"),
    );
    expect(valueOf(exactDeclaration(TABS_DIRECT, "grid-template-columns", NARROW))).toBe(
      parsedValue("grid-template-columns", "auto minmax(0, 1fr) auto minmax(0, 1fr) auto"),
    );
  });

  it("the row, the Servers button and Switch server are base rules with fold overrides on the same selector", () => {
    const pairs: Array<[string, string, string, string]> = [
      ["html.layout-deck .deck-top-bar.has-server-tabs > .server-tabs", "display", "flex", "none"],
      [
        "html.layout-deck .deck-top-bar.has-server-tabs > .deck-servers-btn",
        "display",
        "none",
        "inline-flex",
      ],
      [
        'html.layout-deck .deck-top-bar.has-server-tabs ~ .deck-status-bar .user-bar [data-testid="disconnect-btn"]',
        "display",
        "none",
        "flex",
      ],
      [
        "html.layout-deck .deck-top-bar.has-server-tabs ~ .deck-status-bar .user-bar .ub-controls",
        "gap",
        "6px",
        "2px",
      ],
      [TABS_DIRECT + " > .deck-direct", "grid-row", "2", "1"],
      [
        TABS_DIRECT,
        "grid-template-columns",
        "minmax(0, 1fr) minmax(160px, 420px) minmax(0, 1fr)",
        "auto minmax(0, 1fr) minmax(160px, 420px) minmax(0, 1fr) auto",
      ],
    ];
    for (const [selector, property, base, folded] of pairs) {
      expect(valueOf(exactDeclaration(selector, property, null)), selector).toBe(
        parsedValue(property, base),
      );
      expect(valueOf(exactDeclaration(selector, property, FOLD)), selector).toBe(
        parsedValue(property, folded),
      );
    }
    expect(
      exactRules(
        "html.layout-deck .deck-top-bar.has-server-tabs > .server-tabs",
        null,
      )[0]!.declarations.map((d) => d.property),
    ).toEqual(expect.arrayContaining(["grid-row", "grid-column", "align-self", "border-top"]));
  });

  it("has-tabs-row reserves row 2 and the fold removes it", () => {
    const row = "html.layout-deck .deck-top-bar.has-tabs-row";
    expect(valueOf(exactDeclaration(row, "grid-template-rows", null))).toBe(
      parsedValue(
        "grid-template-rows",
        "minmax(var(--deck-top-min), auto) minmax(var(--deck-tabs-min), auto)",
      ),
    );
    expect(valueOf(exactDeclaration(row, "row-gap", null))).toBe(parsedValue("row-gap", "0"));
    expect(valueOf(exactDeclaration(row, "grid-template-rows", FOLD))).toBe(
      parsedValue("grid-template-rows", "none"),
    );
  });

  it("the Switch server overrides restore user-bar.css's own values", () => {
    const userBar = sheetRules("app/user-bar.css");
    const display = exactDeclaration(".user-bar .ub-controls button", "display", null, userBar);
    const gap = exactDeclaration(".user-bar .ub-controls", "gap", null, userBar);
    const prefix = "html.layout-deck .deck-top-bar.has-server-tabs ~ .deck-status-bar .user-bar";
    expect(
      valueOf(exactDeclaration(`${prefix} [data-testid="disconnect-btn"]`, "display", FOLD)),
    ).toBe(valueOf(display));
    expect(valueOf(exactDeclaration(`${prefix} .ub-controls`, "gap", FOLD))).toBe(valueOf(gap));
  });

  it("a hidden tab is display none, a tab never shrinks, and the folder colour is a fill only", () => {
    expect(valueOf(exactDeclaration("html.layout-deck .server-tab[hidden]", "display", null))).toBe(
      parsedValue("display", "none"),
    );
    expect(valueOf(exactDeclaration("html.layout-deck .server-tab", "flex", null))).toBe(
      parsedValue("flex", "none"),
    );
    const folderColour = tabsRules().flatMap((r) =>
      r.declarations.filter((d) => d.vars.includes("--folder-color")).map((d) => d.property),
    );
    expect(folderColour.length).toBeGreaterThan(0);
    expect(folderColour.every((p) => POLICY.fillProperties.has(p))).toBe(true);
  });

  it("High Contrast keeps the current tab's top line and adds a bottom inset", () => {
    const hc = exactDeclaration(
      'html.layout-deck.high-contrast .server-tab[aria-current="page"]',
      "box-shadow",
      null,
    );
    expect(hc.vars).toEqual(
      expect.arrayContaining(["--accent-text", "--border", "--header-primary"]),
    );
  });
});

describe("server-tabs.css: the drag markers", () => {
  const BEFORE = "html.layout-deck .server-tab.drop-before::after";
  const AFTER = "html.layout-deck .server-tab.drop-after::after";

  it("before and after are a 2px Ember line that takes no pointer, centred in the gap", () => {
    const line = tabsRules().find(
      (r) => r.media === null && r.selectors.includes(BEFORE) && r.selectors.includes(AFTER),
    );
    expect(line).toBeDefined();
    const decl = (property: string): DeckDeclaration => {
      const found = line!.declarations.filter((d) => d.property === property);
      expect(found, property).toHaveLength(1);
      return found[0]!;
    };
    expect(valueOf(decl("width"))).toBe(parsedValue("width", "2px"));
    expect(valueOf(decl("pointer-events"))).toBe(parsedValue("pointer-events", "none"));
    expect(valueOf(decl("position"))).toBe(parsedValue("position", "absolute"));
    expect(decl("background").vars).toEqual(["--accent-text"]);

    const offset = "calc(var(--deck-tab-gap) / -2 - 1px)";
    const start = exactDeclaration(BEFORE, "inset-inline-start", null);
    const end = exactDeclaration(AFTER, "inset-inline-end", null);
    expect(valueOf(start)).toBe(parsedValue("inset-inline-start", offset));
    expect(valueOf(end)).toBe(parsedValue("inset-inline-end", offset));
    expect(start.vars).toEqual(["--deck-tab-gap"]);
  });

  it("a tab with a before or after marker is the line's containing block, and into is an Ember ring", () => {
    const holder = tabsRules().find(
      (r) =>
        r.media === null &&
        r.selectors.includes("html.layout-deck .server-tab.drop-before") &&
        r.selectors.includes("html.layout-deck .server-tab.drop-after"),
    );
    expect(holder?.declarations.map((d) => [d.property, JSON.stringify(d.value)])).toEqual([
      ["position", parsedValue("position", "relative")],
    ]);
    const into = tabsRules().find(
      (r) => r.media === null && r.selectors.includes("html.layout-deck .server-tab.drop-into"),
    );
    const ring = into?.declarations.find((d) => d.property === "box-shadow");
    expect(ring?.vars).toEqual(["--accent-text"]);
  });
});

describe("server-tabs.css: the drop ring in High Contrast", () => {
  it("High Contrast keeps the into ring, drawn with --accent-text only", () => {
    const hc = "html.layout-deck.high-contrast .server-tab.drop-into";
    const rule = tabsRules().find((r) => r.media === null && r.selectors.includes(hc));
    expect(rule, hc).toBeDefined();
    const shadow = rule!.declarations.filter((d) => d.property === "box-shadow");
    expect(shadow).toHaveLength(1);
    expect(shadow[0]!.vars).toEqual(["--accent-text"]);
  });
});

describe("server-tabs.css: the end group", () => {
  const END = "html.layout-deck .deck-top-end";
  const PING = "html.layout-deck .deck-ping";
  const TOGGLE = `${END} > .member-list-btn`;
  const TABS_END = "html.layout-deck .deck-top-bar.has-server-tabs > .deck-top-end";

  /** Every declaration of the rule exactly `selector` at top level, as property and parsed value. */
  const declared = (selector: string, media: string | null = null): Array<[string, string]> =>
    exactRules(selector, media).flatMap((r) =>
      r.declarations.map((d): [string, string] => [d.property, valueOf(d)]),
    );
  const expected = (pairs: Array<[string, string]>): Array<[string, string]> =>
    pairs.map(([p, v]) => [p, parsedValue(p, v)]);

  it("the group ends its cell as a flex row, and the connection may shrink", () => {
    expect(declared(END)).toEqual(
      expected([
        ["justify-self", "end"],
        ["display", "flex"],
        ["align-items", "center"],
        ["gap", "var(--deck-gap)"],
        ["min-width", "0"],
      ]),
    );
    expect(declared(`${END} > .deck-connection`)).toEqual(expected([["min-width", "0"]]));
  });

  it("the ping never shrinks and spaces its bars by 4px", () => {
    expect(valueOf(exactDeclaration(PING, "flex", null))).toBe(parsedValue("flex", "none"));
    expect(valueOf(exactDeclaration(PING, "gap", null))).toBe(parsedValue("gap", "4px"));
    expect(exactDeclaration(PING, "color", null).vars).toEqual(["--text-muted"]);
  });

  it("the toggle takes the Direct button's box, hover, focus ring offset and pressed ring", () => {
    expect(declared(TOGGLE)).toEqual(
      expected([
        ["flex", "none"],
        ["display", "inline-flex"],
        ["align-items", "center"],
        ["justify-content", "center"],
        ["width", "var(--deck-direct-size)"],
        ["height", "var(--deck-direct-size)"],
        ["padding", "0"],
        ["border", "1px solid var(--border-control)"],
        ["border-radius", "var(--radius-sm)"],
        ["background", "transparent"],
        ["color", "var(--text-muted)"],
        ["cursor", "pointer"],
      ]),
    );
    expect(declared(`${TOGGLE}:hover`)).toEqual(expected([["background", "var(--bg-hover)"]]));
    expect(declared(`${TOGGLE}:focus-visible`)).toEqual(expected([["outline-offset", "-2px"]]));
    expect(declared(`${TOGGLE}[aria-pressed="true"]`)).toEqual(
      expected([
        ["background", "var(--bg-hover)"],
        ["color", "var(--header-primary)"],
        ["border-color", "var(--header-primary)"],
        ["box-shadow", "inset 0 0 0 1px var(--header-primary)"],
      ]),
    );
  });

  it("a hidden ping or toggle takes no space", () => {
    const rule = tabsRules().find(
      (r) =>
        r.media === null &&
        r.selectors.includes(`${PING}[hidden]`) &&
        r.selectors.includes(`${TOGGLE}[hidden]`),
    );
    expect(rule?.declarations.map((d) => [d.property, valueOf(d)])).toEqual(
      expected([["display", "none"]]),
    );
  });

  it("in the tab fold the group takes column 4 of row 1 and hides the ping", () => {
    expect(declared(TABS_END, FOLD)).toEqual(
      expected([
        ["grid-row", "1"],
        ["grid-column", "4"],
      ]),
    );
    expect(declared(`${TABS_END} > .deck-ping`, FOLD)).toEqual(expected([["display", "none"]]));
    // The old connection rule stays for a group that failed to build.
    expect(
      declared("html.layout-deck .deck-top-bar.has-server-tabs > .deck-connection", FOLD),
    ).toEqual(
      expected([
        ["grid-row", "1"],
        ["grid-column", "4"],
      ]),
    );
  });

  it("adds no grid template rule for the group", () => {
    const templates = tabsRules().filter((r) =>
      r.declarations.some((d) => d.property.startsWith("grid-template")),
    );
    expect(templates.flatMap((r) => r.selectors).filter((s) => s.includes("deck-top-end"))).toEqual(
      [],
    );
  });
});

describe("server-tabs.css: the top bar on a phone", () => {
  const BTN = "html.layout-deck .deck-top-bar.has-server-tabs > .deck-servers-btn";
  const NAME = "html.layout-deck .deck-servers-name";
  const DISCONNECT =
    'html.layout-deck .deck-top-bar.has-server-tabs ~ .deck-status-bar .user-bar [data-testid="disconnect-btn"]';
  /** Every selector the phone block names. */
  const phoneSelectors = (): string[] =>
    tabsRules()
      .filter((r) => r.media === PHONE)
      .flatMap((r) => r.selectors);

  it("the fold's prelude ends with the phone query, and the phone block is last", () => {
    expect(FOLD.endsWith(PHONE)).toBe(true);
    expect(preludesOf("app/server-tabs.css").at(-1)).toBe(PHONE);
    const rules = tabsRules();
    const lastNarrow = rules.map((r) => r.media).lastIndexOf(NARROW);
    for (const r of rules.filter((x) => x.media === PHONE)) {
      expect(rules.indexOf(r)).toBeGreaterThan(lastNarrow);
    }
  });

  it("the name span is hidden at the top level and shown, truncating, only on a phone", () => {
    expect(valueOf(exactDeclaration(NAME, "display", null))).toBe(parsedValue("display", "none"));
    const shown = "html.layout-deck .deck-servers-btn .deck-servers-name";
    expect(valueOf(exactDeclaration(shown, "display", PHONE))).toBe(
      parsedValue("display", "block"),
    );
    expect(valueOf(exactDeclaration(shown, "text-overflow", PHONE))).toBe(
      parsedValue("text-overflow", "ellipsis"),
    );
    expect(exactRules(shown, null)).toEqual([]);
    expect(valueOf(exactDeclaration("html.layout-deck .deck-servers-text", "display", PHONE))).toBe(
      parsedValue("display", "none"),
    );
  });

  it("the Servers button is at least 44 px and never 28 px wide on a phone", () => {
    expect(valueOf(exactDeclaration(BTN, "min-width", PHONE))).toBe(
      parsedValue("min-width", "44px"),
    );
    expect(valueOf(exactDeclaration(BTN, "height", PHONE))).toBe(parsedValue("height", "44px"));
    expect(valueOf(exactDeclaration(BTN, "width", PHONE))).toBe(parsedValue("width", "auto"));
    expect(valueOf(exactDeclaration(BTN, "grid-column", PHONE))).toBe(
      parsedValue("grid-column", "1"),
    );
    const widths = tabsRules()
      .filter((r) => r.media === PHONE)
      .flatMap((r) => r.declarations)
      .filter((d) => d.property === "width")
      .map(valueOf);
    expect(widths).not.toContain(parsedValue("width", "28px"));
    expect(
      valueOf(
        exactDeclaration(
          "html.layout-deck .deck-servers-btn .server-tab-chevron",
          "display",
          PHONE,
        ),
      ),
    ).toBe(parsedValue("display", "inline-block"));
  });

  it("--deck-direct-size is 44 px only on a phone", () => {
    const sizes = tabsRules()
      .filter((r) => r.selectors.includes("html.layout-deck"))
      .flatMap((r) =>
        r.declarations
          .filter((d) => d.property === "--deck-direct-size")
          .map((d) => [r.media, JSON.stringify(d.value)] as const),
      );
    const big = sizes.filter(([, v]) => v.includes("44"));
    expect(big.map(([m]) => m)).toEqual([PHONE]);
    expect(sizes.filter(([m]) => m === null)).toHaveLength(1);
    expect(sizes.find(([m]) => m === null)?.[1]).not.toContain("44");
  });

  it("names each phone grid rule by its exact selector and value", () => {
    const columns: Array<[string, string]> = [
      [DIRECT_GRID, "minmax(0, 1fr) auto auto auto"],
      ["html.layout-deck .deck-top-bar.has-server-tabs", "minmax(0, 1fr) auto auto"],
      [TABS_DIRECT, "minmax(0, 1fr) auto auto auto"],
    ];
    for (const [selector, value] of columns) {
      expect(valueOf(exactDeclaration(selector, "grid-template-columns", PHONE)), selector).toBe(
        parsedValue("grid-template-columns", value),
      );
    }
    const cells: Array<[string, string]> = [
      ["html.layout-deck .deck-top-bar.has-server-tabs > .deck-search", "2"],
      [
        "html.layout-deck .deck-top-bar.has-server-tabs > :is(.deck-connection, .deck-top-end)",
        "3",
      ],
      [`${TABS_DIRECT} > .deck-direct`, "4"],
    ];
    for (const [selector, value] of cells) {
      expect(valueOf(exactDeclaration(selector, "grid-column", PHONE)), selector).toBe(
        parsedValue("grid-column", value),
      );
    }
  });

  it("hides the plain name only beside the Servers button, so a browser keeps it", () => {
    const hiders = tabsRules().filter(
      (r) =>
        r.selectors.some((x) => x.endsWith(".deck-top-name")) &&
        r.declarations.some((d) => d.property === "display"),
    );
    expect(hiders.flatMap((r) => r.selectors)).toEqual([
      "html.layout-deck .deck-top-bar.has-server-tabs > .deck-top-name",
    ]);
    expect(hiders.map((r) => r.media)).toEqual([PHONE]);
  });

  it("hides Switch server on a phone only where the tabs are, so a browser keeps Sign out", () => {
    expect(valueOf(exactDeclaration(DISCONNECT, "display", PHONE))).toBe(
      parsedValue("display", "none"),
    );
    const onPhone = phoneSelectors().filter((x) => x.includes("disconnect-btn"));
    expect(onPhone).toEqual([DISCONNECT]);
    expect(onPhone.every((x) => x.includes(".has-server-tabs"))).toBe(true);
  });
});
