// jsdom applies no stylesheets, so Buddies' sizes and its colour policy are
// pinned from the Lightning CSS parse of buddies.css (tests/helpers/deck-css.ts).
// The rows' real heights are measured in tests/browser/buddies-rows.test.ts.
import { describe, expect, it } from "vitest";
import {
  colourPolicyBreaches,
  parseDeckCss,
  type ColourPolicy,
  type DeckDeclaration,
} from "../../helpers/deck-css";
import { appCssLines, sheetRules, unscopedSelectors } from "../../helpers/deckSheet";
import { PHONE_LAYOUT_QUERY } from "../../../src/lib/ui/phoneLayout";

const POLICY: ColourPolicy = {
  colourVars: new Set(["--text-normal", "--text-muted", "--bg-secondary", "--bg-hover"]),
  fillOnlyVars: new Set(),
  fillProperties: new Set(["background", "background-color", "fill"]),
  keywords: new Set(["none", "transparent", "currentcolor"]),
  layoutVar: /^--(deck-radius|font-size|font-size-[a-z]+|space-[0-9])$/,
  allowOutlineOffset: true,
  exempt: [],
};

const rules = () => sheetRules("app/buddies.css");
const P = "html.layout-deck";
const ROW_HEIGHT = "max(40px, calc(var(--font-size, 16px) * 2.5))";
const LINE_HEIGHT = "max(18px, calc(var(--font-size, 16px) * 1.125))";

/** Every declaration of `property` in a rule listing `selector`. */
function declarations(selector: string, property: string): DeckDeclaration[] {
  return rules()
    .filter((r) => r.selectors.includes(selector))
    .flatMap((r) => r.declarations.filter((d) => d.property === property));
}

/** The one declaration of `property` for `selector`, as its parsed value. */
function valueOf(selector: string, property: string): string {
  const found = declarations(selector, property);
  expect(found, `${selector} { ${property} }`).toHaveLength(1);
  return JSON.stringify(found[0]!.value);
}

/** The parse of `property: value` in a one-rule fixture. */
function parsed(property: string, value: string): string {
  const rule = parseDeckCss(`${P} .x { ${property}: ${value}; }`)[0]!;
  return JSON.stringify(rule.declarations[0]!.value);
}

describe("buddies.css: policy", () => {
  it("is parsed (the scan is not empty)", () => {
    expect(rules().length).toBeGreaterThan(8);
  });

  it("scopes every selector to Command Deck", () => {
    expect(unscopedSelectors(rules())).toEqual([]);
  });

  it("reads only its four colour tokens, with no motion but the row's transition: none", () => {
    const breaches = colourPolicyBreaches(rules(), POLICY);
    const rowTransition = `${P} .buddy-row { transition }: outline, transition or animation`;
    expect(breaches).toEqual([rowTransition]);
    expect(valueOf(`${P} .buddy-row`, "transition")).toBe(parsed("transition", "none"));
    const motion = rules().flatMap((r) =>
      r.declarations.filter((d) => /^(transition|animation|outline(?!-offset))/.test(d.property)),
    );
    expect(motion).toHaveLength(1);
  });

  it("the policy catches a colour off the list and a transition", () => {
    const fixture = parseDeckCss(
      `${P} .a { color: var(--text-link); } ${P} .b { transition: color 1s; } ${P} .c { color: red; }`,
    );
    expect(colourPolicyBreaches(fixture, POLICY)).toHaveLength(3);
  });

  // A deliberate exception to Client/CLAUDE.md ("never on its source text"):
  // the @import order is not a rule any parse shows, so it is read as text.
  it("is imported on the line directly before server-tabs.css", () => {
    const lines = appCssLines();
    const tabs = lines.indexOf('@import "./app/server-tabs.css";');
    expect(tabs).toBeGreaterThan(0);
    expect(lines[tabs - 1]).toBe('@import "./app/buddies.css";');
  });
});

describe("buddies.css: sizes", () => {
  it("fixes the strips, the scroll padding and the headers in px", () => {
    expect(valueOf(`${P} .buddies-title`, "height")).toBe(parsed("height", "32px"));
    expect(valueOf(`${P} .buddies-title`, "position")).toBe(parsed("position", "sticky"));
    expect(valueOf(`${P} .buddies-title`, "top")).toBe(parsed("top", "0"));
    const search = `${P} .member-column .member-search-wrap`;
    expect(valueOf(search, "height")).toBe(parsed("height", "32px"));
    expect(valueOf(search, "top")).toBe(parsed("top", "32px"));
    expect(valueOf(search, "margin-top")).toBe(parsed("margin-top", "0"));
    expect(valueOf(search, "box-shadow")).toBe(parsed("box-shadow", "none"));
    expect(valueOf(`${P} .member-column-body`, "scroll-padding-top")).toBe(
      parsed("scroll-padding-top", "64px"),
    );
    expect(valueOf(`${P} .buddies-group`, "height")).toBe(parsed("height", "28px"));
    expect(valueOf(`${P} .buddies-group`, "align-items")).toBe(parsed("align-items", "flex-end"));
  });

  it("gives the row and both lines a height, never a min-height, from the text size", () => {
    expect(valueOf(`${P} .buddy-row`, "height")).toBe(parsed("height", ROW_HEIGHT));
    for (const line of [`${P} .buddy-line1`, `${P} .buddy-line2`]) {
      expect(valueOf(line, "height")).toBe(parsed("height", LINE_HEIGHT));
      expect(valueOf(line, "line-height")).toBe(parsed("line-height", LINE_HEIGHT));
    }
    const minHeights = rules().flatMap((r) =>
      r.declarations.filter((d) => d.property === "min-height"),
    );
    expect(minHeights).toEqual([]);
  });

  it("sets the row's margin, padding and radius over Classic's", () => {
    expect(valueOf(`${P} .buddy-row`, "margin")).toBe(parsed("margin", "1px var(--space-1)"));
    expect(valueOf(`${P} .buddy-row`, "padding")).toBe(parsed("padding", "0 var(--space-2)"));
    expect(valueOf(`${P} .buddy-row`, "border-radius")).toBe(
      parsed("border-radius", "var(--deck-radius)"),
    );
    expect(declarations(`${P} .buddy-row:hover`, "background")[0]?.vars).toEqual(["--bg-hover"]);
  });

  it("draws line 2 at the small size in the muted colour", () => {
    for (const selector of [`${P} .buddy-row .mi-activity`, `${P} .buddy-row .mi-custom-status`]) {
      expect(valueOf(selector, "font-size")).toBe(parsed("font-size", "var(--font-size-sm)"));
      expect(declarations(selector, "color")[0]?.vars).toEqual(["--text-muted"]);
      expect(valueOf(selector, "min-width")).toBe(parsed("min-width", "0"));
    }
  });

  it("hides a hidden voice icon whatever its display, and never shrinks the icons", () => {
    expect(valueOf(`${P} .buddy-voice[hidden]`, "display")).toBe(parsed("display", "none"));
    expect(valueOf(`${P} .buddy-voice`, "flex")).toBe(parsed("flex", "none"));
    expect(valueOf(`${P} .buddy-row .mi-activity-icon`, "flex")).toBe(parsed("flex", "none"));
    expect(declarations(`${P} .buddy-voice`, "color")[0]?.vars).toEqual(["--text-muted"]);
  });

  it("lets the name and the lines shrink", () => {
    expect(valueOf(`${P} .buddy-lines`, "min-width")).toBe(parsed("min-width", "0"));
    expect(valueOf(`${P} .buddy-row .mi-name`, "min-width")).toBe(parsed("min-width", "0"));
    expect(valueOf(`${P} .buddy-row .mi-name`, "text-overflow")).toBe(
      parsed("text-overflow", "ellipsis"),
    );
    expect(valueOf(`${P} .buddies-group-text`, "text-overflow")).toBe(
      parsed("text-overflow", "ellipsis"),
    );
  });
});

describe("buddies.css: foldable headers", () => {
  it("points the cursor only at a foldable header", () => {
    expect(valueOf(`${P} .buddies-group[role="button"]`, "cursor")).toBe(
      parsed("cursor", "pointer"),
    );
    expect(declarations(`${P} .buddies-group`, "cursor")).toEqual([]);
  });

  it("turns the chevron -90deg when the group is folded, and keeps it whole", () => {
    expect(valueOf(`${P} .buddies-group-chevron.collapsed`, "transform")).toBe(
      parsed("transform", "rotate(-90deg)"),
    );
    expect(declarations(`${P} .buddies-group-chevron`, "transform")).toEqual([]);
    expect(valueOf(`${P} .buddies-group-chevron`, "flex")).toBe(parsed("flex", "none"));
    expect(valueOf(`${P} .buddies-group-chevron`, "margin-right")).toBe(
      parsed("margin-right", "var(--space-1)"),
    );
  });

  it("draws the shared focus ring inside the header, with no outline of its own", () => {
    expect(valueOf(`${P} .buddies-group:focus-visible`, "outline-offset")).toBe(
      parsed("outline-offset", "-2px"),
    );
    const outlines = rules().flatMap((r) =>
      r.declarations.filter((d) => d.property.startsWith("outline")),
    );
    expect(outlines.map((d) => d.property)).toEqual(["outline-offset"]);
  });
});

describe("buddies.css: on a phone", () => {
  const FOLDABLE = `${P} .buddies-group[role="button"]`;

  it("gives a foldable header a 44 px height only inside the phone query, and no min-height", () => {
    const heights = rules().filter((r) =>
      r.declarations.some((d) => d.property === "height" && r.selectors.includes(FOLDABLE)),
    );
    expect(heights.map((r) => r.media)).toEqual([PHONE_LAYOUT_QUERY]);
    expect(valueOf(FOLDABLE, "height")).toBe(parsed("height", "44px"));
    const phone = rules().filter((r) => r.media === PHONE_LAYOUT_QUERY);
    expect(phone.flatMap((r) => r.selectors)).toEqual([FOLDABLE]);
    expect(phone.flatMap((r) => r.declarations.map((d) => d.property))).toEqual(["height"]);
  });
});
