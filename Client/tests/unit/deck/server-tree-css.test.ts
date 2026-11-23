// jsdom applies no stylesheets, so the server tree's CSS is pinned from the
// Lightning CSS parse of server-tree.css (tests/helpers/deck-css.ts). The tree
// policy is deck.css's colour rule widened for the tree: more tokens, outline
// offsets, and one named declaration that may use the accent and color-mix().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  colourPolicyBreaches,
  parseDeckCss,
  type ColourPolicy,
  type DeckRule,
} from "../../helpers/deck-css";

const STYLES = join(process.cwd(), "src/styles");

const EXEMPT_RULE = `html.layout-deck .server-tree [role=treeitem][aria-current="page"] {
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%);
}`;
const HIGH_CONTRAST_RULE = `html.layout-deck.high-contrast .server-tree [role=treeitem][aria-current="page"] {
  background: linear-gradient(90deg, var(--bg-active), transparent 70%);
}`;

// The exempt selector as the parse prints it: Lightning CSS may print the
// attribute quotes differently from the source.
const EXEMPT_SELECTOR = parseDeckCss(EXEMPT_RULE)[0]!.selectors[0]!;

const POLICY: ColourPolicy = {
  colourVars: new Set([
    "--bg-secondary",
    "--bg-hover",
    "--bg-active",
    "--border",
    "--border-strong",
    "--text-normal",
    "--text-muted",
    "--header-primary",
    "--channel-icon",
    "--accent-text",
    "--danger-fill",
    "--on-fill",
  ]),
  fillOnlyVars: new Set(),
  fillProperties: new Set(["background", "background-color", "fill"]),
  keywords: new Set([
    "none",
    "transparent",
    "currentcolor",
    "inset",
    "solid",
    "dashed",
    "dotted",
    "hidden",
  ]),
  layoutVar: /^--(deck-[a-z-]+|header-height|safe-bottom|radius-[a-z]+|font-size-[a-z]+)$/,
  allowOutlineOffset: true,
  exempt: [
    {
      selector: EXEMPT_SELECTOR,
      property: "background",
      vars: ["--accent"],
      literalColours: ["color-mix()"],
    },
  ],
};

const breaches = (css: string): string[] => colourPolicyBreaches(parseDeckCss(css), POLICY);

/** The three selector forms the stylesheet may use. */
const selectorAllowed = (s: string): boolean =>
  s === "html.layout-deck" ||
  s.startsWith("html.layout-deck ") ||
  s.startsWith("html.layout-deck.high-contrast ");

const stray = (rules: readonly DeckRule[]): string[] =>
  rules.flatMap((r) => r.selectors.filter((s) => !selectorAllowed(s)));

const treeRules = (): readonly DeckRule[] =>
  parseDeckCss(readFileSync(join(STYLES, "app/server-tree.css"), "utf8"));

describe("server-tree.css", () => {
  it("is parsed (the scan is not empty)", () => {
    expect(treeRules().length).toBeGreaterThan(5);
  });

  it("holds the tree policy for every rule", () => {
    expect(colourPolicyBreaches(treeRules(), POLICY)).toEqual([]);
  });

  it("every selector is one of the three allowed forms", () => {
    expect(stray(treeRules())).toEqual([]);
    const ok = parseDeckCss(`
      html.layout-deck { --deck-gap: 6px; }
      html.layout-deck .a { margin: 0; }
      html.layout-deck.high-contrast .b { margin: 0; }
    `);
    expect(stray(ok)).toEqual([]);
    expect(stray(parseDeckCss("html.layout-deckx .x { margin: 0; }"))).toEqual([
      "html.layout-deckx .x",
    ]);
    expect(stray(parseDeckCss(".x { margin: 0; }"))).toEqual([".x"]);
  });

  // A deliberate exception to Client/CLAUDE.md ("never on its source text"):
  // that rule is about pinning CSS rules through the Lightning CSS parse. The
  // @import order is not a rule any parse shows, so it is read as text.
  it("is imported on the line directly before deck.css", () => {
    const lines = readFileSync(join(STYLES, "app.css"), "utf8").split("\n");
    const deck = lines.indexOf('@import "./app/deck.css";');
    expect(deck).toBeGreaterThan(0);
    expect(lines[deck - 1]).toBe('@import "./app/server-tree.css";');
  });
});

describe("the tree policy", () => {
  it("lets the opt-A1 tint and the High Contrast tint through", () => {
    expect(breaches(EXEMPT_RULE)).toEqual([]);
    expect(breaches(HIGH_CONTRAST_RULE)).toEqual([]);
  });

  it("sees color-mix as a colour function inside a value that holds a var()", () => {
    // Without the function-token fix in the helper this list is empty, and the
    // exempt declaration above would not match its exact ["color-mix()"].
    const d = parseDeckCss(EXEMPT_RULE)[0]!.declarations[0]!;
    expect(d.literalColours).toEqual(["color-mix()"]);
    expect(d.vars).toEqual(["--accent"]);
  });

  it("allows outline-offset and nothing else about outlines", () => {
    expect(breaches("html.layout-deck .a { outline-offset: -2px; }")).toEqual([]);
    expect(breaches("html.layout-deck .a { outline: 1px solid; }").join("\n")).toContain(
      ".a { outline }",
    );
  });

  it("allows the listed tokens, keywords and border styles", () => {
    expect(
      breaches(`
        html.layout-deck .a { color: var(--text-muted); border-left: 1px dotted var(--border-strong); }
        html.layout-deck .b { background: var(--danger-fill); color: var(--on-fill); }
        html.layout-deck .c { box-shadow: inset 2px 0 0 var(--accent-text); }
        html.layout-deck .d { fill: currentcolor; background: none; }
      `),
    ).toEqual([]);
  });

  it.each([
    ["color: var(--accent) on any selector", "html.layout-deck .a { color: var(--accent); }"],
    [
      "the exempt selector with another property",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"] { color: color-mix(in srgb, var(--accent) 16%, transparent); }`,
    ],
    [
      "the exempt value on another selector",
      "html.layout-deck .x { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%); }",
    ],
    [
      "the exempt declaration with --accent-text in place of --accent",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"] { background: linear-gradient(90deg, color-mix(in srgb, var(--accent-text) 16%, transparent), transparent 70%); }`,
    ],
    [
      "the exempt declaration with a second var",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"] { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, var(--bg-hover)), transparent 70%); }`,
    ],
    [
      "the exempt declaration in a grouped selector",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"], html.layout-deck .y { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%); }`,
    ],
    [
      "the exempt declaration with a fallback colour on the accent",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"] { background: linear-gradient(90deg, color-mix(in srgb, var(--accent, red) 16%, transparent), transparent 70%); }`,
    ],
    [
      "the exempt declaration with a bare word beyond in, srgb and transparent",
      `html.layout-deck .server-tree [role=treeitem][aria-current="page"] { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, red), transparent 70%); }`,
    ],
    [
      "color-mix with a hash",
      "html.layout-deck .a { background: color-mix(in srgb, #fff 16%, transparent); }",
    ],
    [
      "a gradient ending in rgb()",
      "html.layout-deck .a { background: linear-gradient(90deg, var(--bg-hover), rgb(1 2 3)); }",
    ],
    ["rgb()", "html.layout-deck .a { color: rgb(0 0 0); }"],
    ["a named colour", "html.layout-deck .a { color: red; }"],
    ["an outline", "html.layout-deck .a { outline: 1px solid; }"],
    ["a transition", "html.layout-deck .a { transition: color 1s; }"],
    ["an animation", "html.layout-deck .a { animation: spin 1s; }"],
    ["a token off the list", "html.layout-deck .a { color: var(--text-link); }"],
    ["a non-layout var in a layout property", "html.layout-deck .a { padding: var(--space-2); }"],
  ])("fails on %s", (_name, css) => {
    expect(breaches(css).length).toBeGreaterThan(0);
  });

  it("names a colour function in a gradient that also holds a var()", () => {
    // color-mix() arrives as a function token here, which only the helper's
    // `value.name` branch sees. (rgb() arrives as a typed colour instead.)
    const out = breaches(
      "html.layout-deck .a { background: linear-gradient(90deg, color-mix(in srgb, var(--bg-hover) 16%, transparent), transparent); }",
    ).join("\n");
    expect(out).toContain("literal colour color-mix()");
    expect(
      breaches(
        "html.layout-deck .a { background: linear-gradient(90deg, var(--bg-hover), rgb(1 2 3)); }",
      ).join("\n"),
    ).toContain("literal colour rgb");
  });
});
