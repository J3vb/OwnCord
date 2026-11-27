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

    it("caps each widget panel at 12vh and lets it scroll", () => {
      const panels = phoneRules().find((r) =>
        r.selectors.some((x) => x.includes(".vw-stats.visible")),
      );
      expect(panels).toBeDefined();
      for (const panel of [".vw-listening", ".vw-grant-mic", ".vw-mic-notice", ".vw-stream-card"])
        expect(panels!.selectors[0]).toContain(panel);
      const value = (property: string): string =>
        text(panels!.declarations.find((d) => d.property === property));
      expect(value("max-height")).toBe(parsed("max-height", "12vh"));
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

    describe("while typing", () => {
      const TYPING = "body.composer-typing";
      const OUT_OF_CALL = `html.layout-deck ${TYPING} .deck-status-bar:not(:has(.voice-widget.visible))`;
      const CALL_BAR = `html.layout-deck ${TYPING} .phone-call-bar`;
      const TALL = `html.layout-deck ${TYPING} .deck-status-bar :is(.vw-stats.visible, .vw-listening, .vw-mic-notice, .vw-stream-card)`;
      const SMALL = `${BAR} :is(.vw-grant-mic, .vw-listening__stop, .vw-stream-card button)`;
      const SHORT = "(max-height: 499px) and (orientation: landscape)";
      const WIDGET = `${BAR} .voice-widget`;
      const VISIBLE = `${BAR} .voice-widget.visible`;
      const USER = `${BAR} .user-bar`;

      /** Every rule that names the typing class. */
      const typingRules = (): DeckRule[] =>
        deckRules().filter((r) => r.selectors.some((x) => x.includes(TYPING)));
      /** The only rule listing `selector`. */
      const only = (selector: string): DeckRule => {
        const found = rulesFor(selector);
        expect(found, selector).toHaveLength(1);
        return found[0]!;
      };
      const shortRules = (): DeckRule[] => deckRules().filter((r) => r.media === SHORT);

      it("the typing block's rules are under exactly the phone query, after the hide rule", () => {
        const rules = deckRules();
        const phoneOnes = typingRules().filter((r) => r.media !== SHORT);
        expect(phoneOnes.length).toBeGreaterThan(0);
        for (const r of [...phoneOnes, only(SMALL)]) {
          expect(r.media, r.selectors.join()).toBe(PHONE);
          expect(rules.indexOf(r)).toBeGreaterThan(rules.indexOf(hideRule()));
        }
      });

      it("out of a call, hides the bar's contents, not the bar, and drops its min-height", () => {
        expect(keywordOf(declarationOf(`${OUT_OF_CALL} > *`, "display", PHONE))).toBe("none");
        is(OUT_OF_CALL, "min-height", "0");
        const onBar = deckRules().filter((r) =>
          r.declarations.some((d) => d.property === "display" && keywordOf(d) === "none"),
        );
        const barItself = onBar.flatMap((r) =>
          r.selectors.filter((x) => /\.deck-status-bar(:[^ >]+)?$/.test(x)),
        );
        expect(barItself).toEqual([]);
      });

      it("hides the call bar only while typing", () => {
        const rule = only(CALL_BAR);
        expect(rule.media).toBe(PHONE);
        expect(keywordOf(declarationOf(CALL_BAR, "display", PHONE))).toBe("none");
        const others = deckRules().filter(
          (r) => r.selectors.some((x) => x.endsWith(" .phone-call-bar")) && r !== rule,
        );
        expect(others).toEqual([]);
      });

      it("hides exactly the tall panels while typing, and keeps Grant mic", () => {
        const rule = only(TALL);
        expect(rule.selectors).toEqual([TALL]);
        expect(keywordOf(declarationOf(TALL, "display", PHONE))).toBe("none");
        for (const panel of [
          ".vw-stats.visible",
          ".vw-listening",
          ".vw-mic-notice",
          ".vw-stream-card",
        ])
          expect(TALL).toContain(panel);
        const hiders = typingRules().filter((r) =>
          r.declarations.some((d) => d.property === "display" && keywordOf(d) === "none"),
        );
        expect(
          hiders.flatMap((r) => r.selectors).filter((x) => x.includes("vw-grant-mic")),
        ).toEqual([]);
      });

      it("in a call, shrinks the bar to one row only under the phone query and the typing class", () => {
        const IN_CALL = `html.layout-deck ${TYPING} .deck-status-bar:has(.voice-widget.visible)`;
        const HIDE = `${IN_CALL} :is(.vw-connected, .vw-ns, .vw-controls > :not(:last-child), .ub-self, [data-testid="ub-deafen"], [data-testid="ub-deafen"] ~ *)`;
        const ROW = [
          `${IN_CALL} .user-bar`,
          `html.layout-deck ${TYPING} .deck-status-bar .voice-widget.visible`,
          `html.layout-deck ${TYPING} .deck-status-bar .vw-header`,
          HIDE,
        ];
        for (const sel of ROW) expect(only(sel).media, sel).toBe(PHONE);
        expect(keywordOf(declarationOf(HIDE, "display", PHONE))).toBe("none");
        is(`${IN_CALL} .user-bar`, "flex", "none");
        is(`html.layout-deck ${TYPING} .deck-status-bar .vw-header`, "flex-direction", "row");
        // Mute and Leave are covered by the coarse-pointer test above.
        for (const kept of ["vw-timer", "vw-secured", "vw-signal", "vw-header"])
          expect(HIDE).not.toContain(kept);
        const hidesRowParts = deckRules().filter(
          (r) =>
            r.selectors.some((x) => /\.(ub-self|vw-connected|vw-ns)\b/.test(x)) &&
            keywordOf(r.declarations.find((d) => d.property === "display")) === "none",
        );
        expect(hidesRowParts.length).toBeGreaterThan(0);
        for (const r of hidesRowParts)
          expect(
            r.selectors.every((x) => x.includes(TYPING)),
            r.selectors.join(),
          ).toBe(true);
      });

      it("makes Grant mic, the listening Stop button and the stream-card buttons 44 px tall", () => {
        is(SMALL, "min-height", "44px");
      });

      it("the short-window block is exactly (max-height: 499px) and (orientation: landscape), after the typing block", () => {
        const rules = deckRules();
        const short = shortRules();
        expect(short.length).toBeGreaterThan(0);
        expect(preludesOf("app/deck.css")).toContain(SHORT);
        const lastTyping = Math.max(
          ...typingRules()
            .filter((r) => r.media === PHONE)
            .map((r) => rules.indexOf(r)),
        );
        for (const r of short) expect(rules.indexOf(r)).toBeGreaterThan(lastTyping);
      });

      it("puts your row beside the call row with the desktop values, so desktop cannot drift", () => {
        const flexText = (selector: string, media: string | null): string =>
          text(declarationOf(selector, "flex", media));
        expect(flexText(VISIBLE, SHORT)).toBe(flexText(WIDGET, null));
        expect(flexText(USER, SHORT)).toBe(flexText(USER, null));
        expect(flexText(WIDGET, null)).not.toBe("null");
        expect(flexText(USER, null)).not.toBe("null");
      });

      it("every other short-window rule needs the typing class", () => {
        const rest = shortRules().flatMap((r) =>
          r.selectors.filter((x) => x !== VISIBLE && x !== USER),
        );
        expect(rest.length).toBeGreaterThan(0);
        expect(rest.filter((x) => !x.includes(TYPING))).toEqual([]);
        // The top bar keeps only its inset, and the chat header goes.
        expect(
          keywordOf(
            declarationOf(`html.layout-deck ${TYPING} .deck-top-bar > *`, "display", SHORT),
          ),
        ).toBe("none");
        expect(
          keywordOf(declarationOf(`html.layout-deck ${TYPING} .chat-header`, "display", SHORT)),
        ).toBe("none");
      });

      it("no typing or short-window rule sets padding-bottom", () => {
        const padders = [...typingRules(), ...shortRules(), only(SMALL)].filter((r) =>
          r.declarations.some((d) => d.property === "padding-bottom" || d.property === "padding"),
        );
        expect(padders.map((r) => r.selectors)).toEqual([]);
      });

      it("no :has() in the file sits on the page or the frame root (#app)", () => {
        const ROOTS = /(^|[\s>~+])(body|html|:root|\.app|#app)[^\s]*:has\(/;
        const onRoot = deckRules().flatMap((r) =>
          r.selectors.filter((x) => x.includes(":has(") && ROOTS.test(x)),
        );
        expect(onRoot).toEqual([]);
        expect(deckRules().some((r) => r.selectors.some((x) => x.includes(":has(")))).toBe(true);
      });
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

describe("deck.css: the top bar on a phone", () => {
  const PHONE_RULES = (): DeckRule[] => deckRules().filter((r) => r.media === PHONE);
  const valueText = (d: DeckDeclaration | undefined): string => JSON.stringify(d?.value ?? null);
  const parsedText = (property: string, value: string): string =>
    JSON.stringify(
      parseDeckCss(`html.layout-deck .x { ${property}: ${value}; }`)[0]!.declarations[0]!.value,
    );
  const SEARCH = "html.layout-deck .deck-search";
  const CONNECTION_TEXT = "html.layout-deck .deck-connection-text";

  it("--deck-top-min is 44 px only on a phone", () => {
    const tops = deckRules()
      .filter((r) => r.selectors.includes("html.layout-deck"))
      .flatMap((r) =>
        r.declarations
          .filter((d) => d.property === "--deck-top-min")
          .map((d) => [r.media, JSON.stringify(d.value)] as const),
      );
    expect(tops.filter(([, v]) => v.includes("44")).map(([m]) => m)).toEqual([PHONE]);
    expect(tops.filter(([m]) => m === null)).toHaveLength(1);
    expect(tops.find(([m]) => m === null)?.[1]).toContain("36");
  });

  it("search is a 44 px icon on a phone, at the end of its cell", () => {
    expect(valueText(declarationOf(SEARCH, "width", PHONE))).toBe(parsedText("width", "44px"));
    expect(valueText(declarationOf(SEARCH, "height", PHONE))).toBe(parsedText("height", "44px"));
    expect(valueText(declarationOf(SEARCH, "justify-self", PHONE))).toBe(
      parsedText("justify-self", "end"),
    );
    expect(keywordOf(declarationOf("html.layout-deck .deck-search-text", "display", PHONE))).toBe(
      "none",
    );
    expect(
      valueText(declarationOf("html.layout-deck .deck-top-bar", "grid-template-columns", PHONE)),
    ).toBe(parsedText("grid-template-columns", "minmax(0, 1fr) auto auto"));
  });

  it("the connection's words stay for a screen reader: never display none", () => {
    const hidden = deckRules().filter(
      (r) =>
        r.selectors.includes(CONNECTION_TEXT) &&
        r.declarations.some((d) => d.property === "display"),
    );
    expect(hidden).toEqual([]);
    expect(valueText(declarationOf(CONNECTION_TEXT, "position", PHONE))).toBe(
      parsedText("position", "absolute"),
    );
    expect(declarationOf(CONNECTION_TEXT, "clip", PHONE)).toBeDefined();
  });

  it("adds no ping rule on a phone, and its block is the file's last", () => {
    expect(PHONE_RULES().filter((r) => r.selectors.some((x) => x.includes(".deck-ping")))).toEqual(
      [],
    );
    const rules = deckRules();
    const top = rules.findIndex((r) => r.media === PHONE && r.selectors.includes(SEARCH));
    expect(top).toBeGreaterThan(-1);
    const lastShort = rules
      .map((r) => r.media)
      .lastIndexOf("(max-height: 499px) and (orientation: landscape)");
    expect(top).toBeGreaterThan(lastShort);
    expect(rules.at(-1)?.media).toBe(PHONE);
  });
});

describe("the Buddies drawer on a phone", () => {
  const MEMBER = "html.layout-deck .member-column";
  const drawer = (): DeckRule => {
    const found = rulesFor(MEMBER).filter((r) => r.media === PHONE_LAYOUT_QUERY);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const decl = (property: string): DeckDeclaration | undefined =>
    drawer().declarations.find((d) => d.property === property);

  it("is the last member column rule, from below the top bar to the status bar", () => {
    const rules = deckRules();
    expect(rules.indexOf(drawer())).toBe(
      Math.max(...rulesFor(MEMBER).map((r) => rules.indexOf(r))),
    );
    expect(decl("top")?.vars).toEqual(["--deck-above-header"]);
    expect(decl("bottom")?.vars).toEqual(["--deck-below", "--safe-bottom"]);
  });

  it("reads the overlay sizes without declaring them, and drops the bottom padding", () => {
    const props = drawer().declarations.map((d) => d.property);
    expect(props).not.toContain("--deck-above-header");
    expect(props).not.toContain("--deck-below");
    const zero = parseDeckCss("html.layout-deck .x { padding-bottom: 0; }")[0]!.declarations[0]!;
    expect(JSON.stringify(decl("padding-bottom")?.value)).toBe(JSON.stringify(zero.value));
  });

  it("is min(320px, 88vw) wide", () => {
    const want = parseDeckCss("html.layout-deck .x { width: min(320px, 88vw) !important; }")[0]!
      .declarations[0]!;
    expect(JSON.stringify(decl("width")?.value)).toBe(JSON.stringify(want.value));
  });
});
