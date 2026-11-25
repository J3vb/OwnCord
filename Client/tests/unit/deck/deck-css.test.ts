// jsdom applies no stylesheets, so Command Deck's CSS is pinned from the
// Lightning CSS parse of deck.css (tests/helpers/deck-css.ts). The colour rule
// is what lets High Contrast and reduced motion (accessibility.css, loaded
// earlier) keep winning: deck.css decides no colour of its own.
import { describe, expect, it } from "vitest";
import {
  COLOUR_PROPERTIES,
  colourPolicyBreaches,
  declarationOf,
  deckRules,
  keywordOf,
  parseDeckCss,
  preludesOf,
  rulesFor,
  type ColourPolicy,
  type DeckRule,
} from "../../helpers/deck-css";

const COLOUR_VARS = new Set([
  "--bg-primary",
  "--bg-secondary",
  "--bg-tertiary",
  "--bg-input",
  "--border",
  "--border-control",
  "--text-normal",
  "--text-muted",
  "--header-primary",
  "--red",
  "--green",
  "--yellow",
]);
const FILL_ONLY_VARS = new Set(["--red", "--green", "--yellow"]);
const FILL_PROPERTIES = new Set(["background", "background-color", "fill"]);
const KEYWORDS = new Set(["none", "transparent", "currentcolor"]);
// A border shorthand's own words, which are not colours.
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "hidden"]);
const LAYOUT_VAR = /^--(deck-[a-z-]+|header-height|safe-bottom|radius-[a-z]+|font-size-[a-z]+)$/;

const DECK_POLICY: ColourPolicy = {
  colourVars: COLOUR_VARS,
  fillOnlyVars: FILL_ONLY_VARS,
  fillProperties: FILL_PROPERTIES,
  keywords: new Set([...KEYWORDS, ...BORDER_STYLES]),
  layoutVar: LAYOUT_VAR,
  allowOutlineOffset: false,
  exempt: [],
};

/** Every breach of the colour rule in `rules`, as readable lines. */
function colourRuleBreaches(rules: readonly DeckRule[]): string[] {
  return colourPolicyBreaches(rules, DECK_POLICY);
}

const SIDEBAR = "html.layout-deck .app > .unified-sidebar";
const MEMBER = "html.layout-deck .member-column";
const SIDE_PANEL = "html.layout-deck .side-panel";
const OVERLAYS = "html.layout-deck :is(.member-column, .side-panel)";
const BAR = "html.layout-deck .deck-status-bar";

describe("deck.css", () => {
  it("is parsed (the scan is not empty)", () => {
    expect(deckRules().length).toBeGreaterThan(20);
  });

  it("every selector starts with html.layout-deck", () => {
    const stray = deckRules().flatMap((r) =>
      r.selectors.filter((s) => s !== "html.layout-deck" && !s.startsWith("html.layout-deck ")),
    );
    expect(stray).toEqual([]);
  });

  describe("the colour rule", () => {
    it("holds for every rule", () => {
      expect(colourRuleBreaches(deckRules())).toEqual([]);
    });

    it("reads the listed colour properties", () => {
      const used = new Set(deckRules().flatMap((r) => r.declarations.map((d) => d.property)));
      for (const p of ["background", "border", "color"])
        expect(COLOUR_PROPERTIES.has(p), p).toBe(true);
      expect(used.has("background")).toBe(true);
      expect(used.has("border")).toBe(true);
    });

    it("fails on a literal colour, an unlisted token, a fill-only colour and motion", () => {
      const bad = parseDeckCss(`
        html.layout-deck .a { color: #fff; }
        html.layout-deck .b { background: var(--accent); }
        html.layout-deck .c { color: var(--green); }
        html.layout-deck .d { border: 1px solid red; }
        html.layout-deck .e { transition: opacity 1s; }
        html.layout-deck .f { padding: var(--space-2); }
        html.layout-deck .g { background: rgb(1, 2, 3); }
        html.layout-deck .h { outline: 1px solid var(--border); }
      `);
      const breaches = colourRuleBreaches(bad).join("\n");
      expect(breaches).toContain(".a { color }: literal colour");
      expect(breaches).toContain("--accent is not allow-listed");
      expect(breaches).toContain("--green is a fill only");
      expect(breaches).toContain(".d { border }");
      expect(breaches).toContain(".e { transition");
      expect(breaches).toContain("--space-2 is not a layout token");
      expect(breaches).toContain(".g { background }: literal colour");
      expect(breaches).toContain(".h { outline");
    });

    it("lets a shorthand's expanded defaults through", () => {
      const ok = parseDeckCss(`
        html.layout-deck .a { border: 0; background: none; color: var(--text-muted); }
        html.layout-deck .b { background: var(--green); border-color: transparent; }
      `);
      expect(colourRuleBreaches(ok)).toEqual([]);
    });
  });

  it("--deck-above-header and --deck-below are declared only on the overlays", () => {
    const declaring = deckRules().filter((r) =>
      r.declarations.some(
        (d) => d.property === "--deck-above-header" || d.property === "--deck-below",
      ),
    );
    expect(declaring.map((r) => r.selectors)).toEqual([[OVERLAYS]]);
    // The measured sizes are written on the page root, never read from <html>.
    const onHtml = rulesFor("html.layout-deck").flatMap((r) =>
      r.declarations.map((d) => d.property),
    );
    expect(onHtml.filter((p) => p.endsWith("-measured"))).toEqual([]);
  });

  it("the slots are display: contents in the status bar", () => {
    expect(keywordOf(declarationOf(`${BAR} > .deck-slot`, "display"))).toBe("contents");
  });

  it("the Switch-server rule is inside min-width: 801px", () => {
    const rules = deckRules().filter((r) =>
      r.selectors.some((s) => s.includes('[data-testid="disconnect-btn"]')),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.media).toBe("(min-width: 801px)");
    expect(keywordOf(rules[0]!.declarations.find((d) => d.property === "display"))).toBe("none");
  });

  it("the narrow sidebar block's query equals responsive.css's", () => {
    const rule = rulesFor(SIDEBAR).find((r) => r.media !== null);
    const sidebar = preludesOf("app/responsive.css").find((p) =>
      p.startsWith("(max-width: 800px)"),
    );
    expect(sidebar).toBeDefined();
    expect(rule?.media).toBe(sidebar);
  });

  it("the member overlay block's query equals member-list.css's", () => {
    const rule = rulesFor(MEMBER)[0];
    const member = preludesOf("app/member-list.css").find((p) =>
      p.startsWith("(max-width: 899px)"),
    );
    expect(member).toBeDefined();
    expect(rule?.media).toBe(member);
  });

  it("the member overlay and side panel use the overlay sizes, and the side panel is capped", () => {
    const sizeVars = (selector: string, property: string): readonly string[] =>
      declarationOf(selector, property)?.vars ?? [];
    expect(sizeVars(MEMBER, "top")).toEqual(["--deck-above-header", "--header-height"]);
    expect(sizeVars(MEMBER, "bottom")).toEqual(["--deck-below"]);
    expect(sizeVars(SIDE_PANEL, "top")).toEqual(["--deck-above-header", "--header-height"]);
    expect(sizeVars(SIDE_PANEL, "max-height")).toContain("--deck-overlay-max");
    expect(sizeVars("html.layout-deck .media-gallery.side-panel", "height")).toContain(
      "--deck-overlay-max",
    );
    const cap = sizeVars(SIDE_PANEL, "--deck-overlay-max");
    expect(cap).toEqual(
      expect.arrayContaining([
        "--deck-above-header",
        "--header-height",
        "--deck-below",
        "--deck-gap",
      ]),
    );
    // Phones' full-height panel stops at the status bar.
    expect(declarationOf(SIDE_PANEL, "bottom", "(max-width: 600px)")?.vars).toEqual([
      "--deck-below",
    ]);
  });

  it("only the normal Secured state is hidden at 800 px, without display", () => {
    const hidden = deckRules().filter((r) => r.selectors.some((s) => s.includes(".vw-secured")));
    expect(hidden).toHaveLength(1);
    const rule = hidden[0]!;
    expect(rule.selectors).toEqual([`${BAR} .vw-secured:not(.vw-secured--degraded)`]);
    expect(rule.media).toBe("(max-width: 800px)");
    const props = rule.declarations.map((d) => d.property);
    expect(props).not.toContain("display");
    expect(props).toEqual(
      expect.arrayContaining(["position", "clip", "overflow", "width", "height"]),
    );
    expect(keywordOf(declarationOf(`${BAR} .vw-channel`, "display", "(max-width: 800px)"))).toBe(
      "none",
    );
  });
  it("the LED colours are allow-listed fills", () => {
    const led = deckRules().filter((r) =>
      r.selectors.some((x) => x.includes(".deck-led") && x.includes("[data-state")),
    );
    const fills = led.map((r) => {
      const d = r.declarations.filter((x) => COLOUR_PROPERTIES.has(x.property));
      // Each state rule sets one background and no other colour property.
      expect(d.map((x) => x.property)).toEqual(["background"]);
      return d[0]!.vars;
    });
    expect(fills).toEqual([["--green"], ["--yellow"], ["--red"]]);
    for (const v of fills.flat()) {
      expect(COLOUR_VARS.has(v), v).toBe(true);
      expect(FILL_ONLY_VARS.has(v), v).toBe(true);
    }
    // The three-colour set covers all five states the label can take.
    const states = led.flatMap((r) => r.selectors.flatMap((x) => x.match(/"([a-z]+)"/g) ?? []));
    expect(states.sort()).toEqual(
      ['"connected"', '"elsewhere"', '"offline"', '"reconnecting"', '"unreachable"'].sort(),
    );
    expect(colourRuleBreaches(led)).toEqual([]);
  });
  describe("the fold", () => {
    const FOLD =
      "(max-width: 1200px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 499px)";
    const NARROW =
      "(max-width: 899px), (pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 499px)";

    it("is one block, directly after the 899 px block, with the 1200 px prelude", () => {
      const preludes = preludesOf("app/deck.css");
      expect(preludes.filter((p) => p === FOLD)).toHaveLength(1);
      expect(preludes.indexOf(FOLD)).toBe(preludes.indexOf(NARROW) + 1);
      const rules = deckRules();
      const lastNarrow = rules.map((r) => r.media).lastIndexOf(NARROW);
      expect(rules[lastNarrow + 1]?.media).toBe(FOLD);
    });

    it("fixes the column under the chat header and above the status bar, with no shadow", () => {
      const rule = rulesFor(MEMBER).find((r) => r.media === FOLD);
      expect(rule).toBeDefined();
      const fixed = parseDeckCss("html.layout-deck .x { position: fixed; }")[0]!.declarations[0]!;
      expect(JSON.stringify(declarationOf(MEMBER, "position", FOLD)?.value)).toBe(
        JSON.stringify(fixed.value),
      );
      expect(declarationOf(MEMBER, "top", FOLD)?.vars).toEqual([
        "--deck-above-header",
        "--header-height",
      ]);
      expect(declarationOf(MEMBER, "bottom", FOLD)?.vars).toEqual(["--deck-below"]);
      expect(declarationOf(MEMBER, "width", FOLD)).toBeDefined();
      expect(rule!.declarations.map((d) => d.property)).not.toContain("box-shadow");
      expect(
        keywordOf(declarationOf("html.layout-deck .member-column-resize", "display", FOLD)),
      ).toBe("none");
      expect(colourRuleBreaches(rulesFor(MEMBER))).toEqual([]);
    });

    it("the 899 px block hides the top bar's ping", () => {
      expect(keywordOf(declarationOf("html.layout-deck .deck-ping", "display", NARROW))).toBe(
        "none",
      );
      expect(rulesFor("html.layout-deck .deck-ping").map((r) => r.media)).toEqual([NARROW]);
    });
  });
});
