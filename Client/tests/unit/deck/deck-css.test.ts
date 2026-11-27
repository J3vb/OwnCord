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
  type DeckDeclaration,
  type DeckRule,
} from "../../helpers/deck-css";
import { PHONE_LAYOUT_QUERY } from "../../../src/lib/ui/phoneLayout";

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
const PHONE = PHONE_LAYOUT_QUERY;
const NARROW_BAR = `(max-width: 800px), ${PHONE_LAYOUT_QUERY}`;

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

  it("only the normal Secured state is hidden at 800 px and on a phone, without display", () => {
    const hidden = deckRules().filter((r) => r.selectors.some((s) => s.includes(".vw-secured")));
    expect(hidden).toHaveLength(1);
    const rule = hidden[0]!;
    expect(rule.selectors).toEqual([`${BAR} .vw-secured:not(.vw-secured--degraded)`]);
    expect(rule.media).toBe(NARROW_BAR);
    const props = rule.declarations.map((d) => d.property);
    expect(props).not.toContain("display");
    expect(props).toEqual(
      expect.arrayContaining(["position", "clip", "overflow", "width", "height"]),
    );
    expect(keywordOf(declarationOf(`${BAR} .vw-channel`, "display", NARROW_BAR))).toBe("none");
  });

  describe("the status bar on a phone", () => {
    const HIDDEN_COPIES = [
      'html.layout-deck [data-testid="pcb-mute"]',
      'html.layout-deck [data-testid="pcb-leave"]',
      "html.layout-deck .phone-call-bar .talk-btn--bar",
      'html.layout-deck .video-grid__controls [data-call-control="mute"]',
      'html.layout-deck .video-grid__controls [data-call-control="leave"]',
      "html.layout-deck .video-grid__controls .talk-btn--call",
      'html.layout-deck [data-testid="dcp-mute"]',
      'html.layout-deck [data-testid="dcp-leave"]',
      'html.layout-deck [data-testid="dcp-leave-call"]',
      'html.layout-deck [data-testid="dm-call-panel"] .talk-btn--bar',
    ];
    const phoneRules = (): DeckRule[] => deckRules().filter((r) => r.media === PHONE);
    const phoneDecl = (selector: string, property: string): DeckDeclaration | undefined =>
      declarationOf(selector, property, PHONE);
    const text = (d: DeckDeclaration | undefined): string => JSON.stringify(d?.value ?? null);
    /** The declaration as Lightning CSS parses `property: value`, to compare whole values. */
    const parsed = (property: string, value: string): string =>
      JSON.stringify(
        parseDeckCss(`html.layout-deck .x { ${property}: ${value}; }`)[0]!.declarations[0]!.value,
      );
    const is = (selector: string, property: string, value: string): void => {
      expect(text(phoneDecl(selector, property)), `${selector} { ${property} }`).toBe(
        parsed(property, value),
      );
    };

    /** The rule that hides the other copies, found by its selectors (later phone blocks may add rules). */
    const hideRule = (): DeckRule => {
      const found = deckRules().filter((r) =>
        r.selectors.includes('html.layout-deck [data-testid="pcb-mute"]'),
      );
      expect(found).toHaveLength(1);
      return found[0]!;
    };

    it("the hide rule is under the phone query, after the min-width: 801px block", () => {
      const rules = deckRules();
      const rule = hideRule();
      expect(rule.media).toBe(PHONE);
      const lastWide = rules.map((r) => r.media).lastIndexOf("(min-width: 801px)");
      expect(lastWide).toBeGreaterThan(-1);
      expect(rules.indexOf(rule)).toBeGreaterThan(lastWide);
    });

    it("hides exactly the other copies of Mute, hold-to-talk and Leave, with display: none only", () => {
      const rule = hideRule();
      expect([...rule.selectors].sort()).toEqual([...HIDDEN_COPIES].sort());
      expect(rule.declarations.map((d) => d.property)).toEqual(["display"]);
      expect(keywordOf(rule.declarations[0])).toBe("none");
    });

    it("no coarse-pointer rule hides the status bar's Mute, hold-to-talk or Leave", () => {
      const coarse = deckRules().filter((r) => r.media?.includes("pointer: coarse") === true);
      const hiders = coarse.filter((r) =>
        r.declarations.some(
          (d) =>
            (d.property === "display" && keywordOf(d) === "none") ||
            d.property === "visibility" ||
            d.property === "clip",
        ),
      );
      const selectors = hiders.flatMap((r) => r.selectors);
      for (const own of ["ub-mute", "talk-btn--user", ".disconnect"]) {
        expect(
          selectors.filter((x) => x.includes(own)),
          own,
        ).toEqual([]);
      }
    });

    it("wraps the bar and puts the unclipped widget on its own row above yours", () => {
      is(BAR, "flex-wrap", "wrap");
      const widget = `${BAR} .voice-widget.visible`;
      is(widget, "order", "-1");
      is(widget, "flex", "1 0 100%");
      is(widget, "max-height", "none");
      is(widget, "overflow", "visible");
      is(`${BAR} .user-bar`, "flex", "1 1 100%");
    });

    it("caps each widget panel at 20vh and lets it scroll", () => {
      const panels = phoneRules().find((r) =>
        r.selectors.some((x) => x.includes(".vw-stats.visible")),
      );
      expect(panels).toBeDefined();
      for (const panel of [".vw-listening", ".vw-grant-mic", ".vw-mic-notice", ".vw-stream-card"])
        expect(panels!.selectors[0]).toContain(panel);
      const value = (property: string): string =>
        text(panels!.declarations.find((d) => d.property === property));
      expect(value("max-height")).toBe(parsed("max-height", "20vh"));
      expect(value("overflow-y")).toBe(parsed("overflow-y", "auto"));
    });

    it("makes the bar's buttons, signal and noise suppression 44 px", () => {
      for (const sel of [`${BAR} .vw-controls button`, `${BAR} .user-bar .ub-controls button`]) {
        is(sel, "width", "44px");
        is(sel, "height", "44px");
      }
      const both = `${BAR} :is(.vw-signal, .vw-ns)`;
      is(both, "min-width", "44px");
      is(both, "min-height", "44px");
    });

    it("shows your name and status", () => {
      is(`${BAR} .ub-info`, "display", "flex");
    });

    it("the 800 px block's prelude ends with the phone query", () => {
      expect(NARROW_BAR.endsWith(PHONE_LAYOUT_QUERY)).toBe(true);
      expect(preludesOf("app/deck.css")).toContain(NARROW_BAR);
    });

    it("the status bar's padding names both side insets", () => {
      const padding = text(declarationOf(BAR, "padding", null));
      expect(padding).toContain("safe-area-inset-left");
      expect(padding).toContain("safe-area-inset-right");
      expect(padding).toContain("safe-bottom");
    });
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
