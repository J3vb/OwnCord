// jsdom applies no stylesheets, so the room Info block's sizes and its colour
// policy are pinned from the Lightning CSS parse of room-info.css
// (tests/helpers/deck-css.ts). The real heights and widths are measured in
// tests/browser/room-info-rows.test.ts.
import { describe, expect, it } from "vitest";
import { colourPolicyBreaches, parseDeckCss, type ColourPolicy } from "../../helpers/deck-css";
import { appCssLines, sheetRules, unscopedSelectors } from "../../helpers/deckSheet";
import { sheetValues } from "../../helpers/sheetValues";

const POLICY: ColourPolicy = {
  colourVars: new Set([
    "--bg-secondary",
    "--border",
    "--text-normal",
    "--text-muted",
    "--green",
    "--yellow",
    "--red",
  ]),
  fillOnlyVars: new Set(["--green", "--yellow", "--red"]),
  fillProperties: new Set(["background", "background-color"]),
  keywords: new Set(["none", "transparent", "currentcolor", "solid"]),
  layoutVar: /^--(font-mono|font-size|font-size-[a-z]+|space-[0-9])$/,
  allowOutlineOffset: false,
  exempt: [],
};

const rules = () => sheetRules("app/room-info.css");
const P = "html.layout-deck";
const SHORT = "(max-height: 600px)";
const ROW_HEIGHT = "max(22px, calc(var(--font-size, 16px) * 1.375))";
const SUMMARY_HEIGHT = `calc(${ROW_HEIGHT} + 2 * var(--space-1))`;

const { declarations, valueOf, parsed } = sheetValues(rules);

describe("room-info.css: policy", () => {
  it("is parsed (the scan is not empty)", () => {
    expect(rules().length).toBeGreaterThan(10);
  });

  it("scopes every selector to Command Deck", () => {
    expect(unscopedSelectors(rules())).toEqual([]);
  });

  it("reads only its colour tokens, with green, yellow and red as fills only", () => {
    expect(colourPolicyBreaches(rules(), POLICY)).toEqual([]);
  });

  it("has no transition, animation or outline", () => {
    const motion = rules().flatMap((r) =>
      r.declarations.filter((d) => /^(transition|animation|outline)/.test(d.property)),
    );
    expect(motion).toEqual([]);
  });

  it("the policy catches a fill colour used as text, a colour off the list and an outline", () => {
    const fixture = parseDeckCss(
      `${P} .a { color: var(--green); } ${P} .b { color: var(--text-link); } ${P} .c { outline: none; }`,
    );
    expect(colourPolicyBreaches(fixture, POLICY)).toHaveLength(3);
  });

  // A deliberate exception to Client/CLAUDE.md ("never on its source text"):
  // the @import order is not a rule any parse shows, so it is read as text.
  it("is imported on the line directly before buddies.css", () => {
    const lines = appCssLines();
    const buddies = lines.indexOf('@import "./app/buddies.css";');
    expect(buddies).toBeGreaterThan(0);
    expect(lines[buddies - 1]).toBe('@import "./app/room-info.css";');
  });
});

describe("room-info.css: boxes", () => {
  it("keeps a hidden block, and one set aside for the call view, out of the layout", () => {
    expect(valueOf(`${P} .room-info[hidden]`, "display")).toBe(parsed("display", "none"));
    expect(valueOf(`${P} .room-info.room-info--aside`, "display")).toBe(parsed("display", "none"));
    expect(valueOf(`${P} .room-info`, "flex")).toBe(parsed("flex", "none"));
    expect(declarations(`${P} .room-info`, "border-top")[0]?.vars).toEqual(["--border"]);
  });

  it("gives the header, the rows and the summary a height, never a min-height", () => {
    expect(valueOf(`${P} .room-info-head`, "height")).toBe(parsed("height", "32px"));
    for (const cell of [`${P} .room-info-row > dt`, `${P} .room-info-row > dd`]) {
      expect(valueOf(cell, "height")).toBe(parsed("height", ROW_HEIGHT));
    }
    expect(valueOf(`${P} .room-info-summary`, "height", SHORT)).toBe(
      parsed("height", SUMMARY_HEIGHT),
    );
    const minHeights = rules().flatMap((r) =>
      r.declarations.filter((d) => d.property === "min-height"),
    );
    expect(minHeights).toEqual([]);
  });

  it("lays the rows out on the label column and the value column", () => {
    expect(valueOf(`${P} .room-info-rows`, "grid-template-columns")).toBe(
      parsed(
        "grid-template-columns",
        "minmax(0, calc(var(--font-size-xs) * 5.5)) minmax(min-content, 1fr)",
      ),
    );
    expect(valueOf(`${P} .room-info-row`, "display")).toBe(parsed("display", "contents"));
    expect(valueOf(`${P} .room-info-rows`, "margin")).toBe(parsed("margin", "0"));
  });

  it("never cuts the word, cuts the detail first, and lets the label give way", () => {
    expect(valueOf(`${P} .room-info-word`, "flex")).toBe(parsed("flex", "none"));
    expect(valueOf(`${P} .room-info-detail`, "width")).toBe(parsed("width", "0"));
    expect(valueOf(`${P} .room-info-detail`, "flex")).toBe(parsed("flex", "1 1 0"));
    expect(valueOf(`${P} .room-info-detail`, "text-overflow")).toBe(
      parsed("text-overflow", "ellipsis"),
    );
    expect(valueOf(`${P} .room-info-label`, "text-overflow")).toBe(
      parsed("text-overflow", "ellipsis"),
    );
    expect(valueOf(`${P} .room-info-label`, "min-width")).toBe(parsed("min-width", "0"));
    expect(valueOf(`${P} .room-info-label`, "font-family")).toBe(
      parsed("font-family", "var(--font-mono)"),
    );
  });

  it("fills the dot and the light by level, grey with --text-muted", () => {
    const fills: Array<[string, string]> = [
      ["ok", "--green"],
      ["warn", "--yellow"],
      ["bad", "--red"],
      ["none", "--text-muted"],
    ];
    for (const [level, token] of fills) {
      for (const part of ["dot", "light"]) {
        const selector = `${P} .room-info-${part}[data-level="${level}"]`;
        expect(declarations(selector, "background")[0]?.vars, selector).toEqual([token]);
      }
    }
  });
});

describe("room-info.css: the short-window form", () => {
  it("hides the summary at the top level", () => {
    expect(valueOf(`${P} .room-info-summary`, "display")).toBe(parsed("display", "none"));
  });

  it("at 600 px tall or less hides the rows, hides the title's prefix from sight only, and shows the summary", () => {
    expect(valueOf(`${P} .room-info-rows`, "display", SHORT)).toBe(parsed("display", "none"));
    // Still read: the region's name keeps "Info · ".
    expect(declarations(`${P} .room-info-prefix`, "display", SHORT)).toEqual([]);
    expect(valueOf(`${P} .room-info-prefix`, "position", SHORT)).toBe(
      parsed("position", "absolute"),
    );
    expect(valueOf(`${P} .room-info-prefix`, "clip", SHORT)).toBe(
      parsed("clip", "rect(0, 0, 0, 0)"),
    );
    expect(declarations(`${P} .room-info-prefix`, "width", SHORT)).toEqual([]);
    expect(valueOf(`${P} .room-info-summary`, "display", SHORT)).toBe(parsed("display", "flex"));
    const media = [...new Set(rules().map((r) => r.media))];
    expect(media).toEqual([null, SHORT]);
  });

  it("cuts the ping first and keeps the users and the Security word whole", () => {
    expect(valueOf(`${P} .room-info-sum-ping`, "flex")).toBe(parsed("flex", "0 1 auto"));
    expect(valueOf(`${P} .room-info-sum-ping`, "min-width")).toBe(parsed("min-width", "0"));
    expect(valueOf(`${P} .room-info-sum-ping`, "text-overflow")).toBe(
      parsed("text-overflow", "ellipsis"),
    );
    for (const part of ["sum-users", "sum-security"]) {
      expect(valueOf(`${P} .room-info-${part}`, "flex")).toBe(parsed("flex", "none"));
    }
  });
});
