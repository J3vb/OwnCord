// jsdom applies no stylesheets, so what the Deck mounts add to the top bar is
// pinned from the Lightning CSS parse of server-tabs.css
// (tests/helpers/deck-css.ts). Its colour policy widens deck.css's for the
// Ember top line, the count badge and the folder glyph.
import { describe, expect, it } from "vitest";
import { colourPolicyBreaches, parseDeckCss, type ColourPolicy } from "../../helpers/deck-css";
import { appCssLines, sheetRules, unscopedSelectors as stray } from "../../helpers/deckSheet";

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
