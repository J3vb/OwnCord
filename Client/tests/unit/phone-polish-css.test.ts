// The phone polish is mostly CSS, which jsdom never applies, so these read the
// parsed stylesheet (Lightning CSS, as tests/helpers/app-css.ts does) and walk
// its @media rules too.
import type { Declaration } from "lightningcss";
import { describe, expect, it } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { flatMediaRules, px } from "../helpers/appCssMedia";

const rules = flatMediaRules();
type FlatRule = (typeof rules)[number];

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

describe("the phone call view's one round control row", () => {
  it("shows View options in place of the square view toggles", () => {
    expect(keyword(cascadedDeclaration(".video-fs-btn--views", "display"))).toBe("none");
    expect(declared(phoneRule(".video-fs-btn--views"), "display")).toContain('"outside":"inline"');
    expect(declared(phoneRule(".video-grid .video-grid__views"), "display")).toContain("none");
  });

  it("keeps every control 44 px", () => {
    expect(declared(phoneRule(".video-fs-btn"), "width")).toContain(FORTY_FOUR);
    expect(declared(phoneRule(".video-fs-btn"), "height")).toContain(FORTY_FOUR);
    // Leave stays a pill, and seven controls still fit a 360 px screen.
    expect(declared(phoneRule(".video-fs-btn--leave"), "width")).toContain('"value":56');
  });
});

describe("44 px touch targets in the drawer, pickers and lists", () => {
  it("the drawer header's actions, the emoji categories and People's Message button", () => {
    for (const selector of [".sidebar-header-action", ".people-msg"]) {
      expect(declared(phoneRule(selector), "min-width")).toContain(FORTY_FOUR);
      expect(declared(phoneRule(selector), "min-height")).toContain(FORTY_FOUR);
    }
    expect(declared(phoneRule(".ep-category-btn"), "width")).toContain(FORTY_FOUR);
    expect(declared(phoneRule(".ep-category-btn"), "height")).toContain(FORTY_FOUR);
    // The rail holds the wider button: 44 plus its 6 px padding each side.
    expect(declared(phoneRule(".ep-categories"), "width")).toContain('"value":56');
  });

  it("member rows, Settings buttons and a message request's actions", () => {
    for (const selector of [".member-item", ".ac-btn", ".requests-actions button"]) {
      expect(declared(phoneRule(selector), "min-height")).toContain(FORTY_FOUR);
    }
  });

  it("leave the desktop sizes alone", () => {
    expect(px(cascadedDeclaration(".sidebar-header-action", "width"))).toBe(24);
    expect(px(cascadedDeclaration(".ep-category-btn", "width"))).toBe(32);
    for (const selector of [".member-item", ".ac-btn", ".people-msg"]) {
      expect(cascadedDeclaration(selector, "min-height")).toBeUndefined();
    }
  });
});

describe("room for names at 320 px", () => {
  it("the user bar wraps its controls under a name that keeps about ten letters", () => {
    // The parsed selector names `:not(.layout-deck)` as a pseudo-class.
    const bar = "html<pseudo-class> .user-bar";
    expect(declared(phoneRule(bar), "flex-wrap")).toContain("wrap");
    expect(declared(phoneRule(bar), "height")).toContain("auto");
    // `flex: 1 0 120px`: the name column never shrinks below its basis.
    const self = declared(phoneRule(`${bar} .ub-self`), "flex");
    expect(self).toContain('"shrink":0');
    expect(self).toContain('"value":120');
  });

  it("leaves Command Deck's status bar out of the user bar wrap", () => {
    for (const selector of [".user-bar", ".user-bar .ub-self", ".user-bar .ub-controls"]) {
      expect(phoneRule(selector)).toBeUndefined();
    }
  });

  it("the chat header folds Threads and Start video call into More, and tightens", () => {
    for (const selector of [
      ".chat-header .ch-tools .threads-btn",
      ".chat-header .ch-tools .video-call-btn",
    ]) {
      expect(declared(phoneRule(selector), "display")).toContain("none");
    }
    expect(declared(phoneRule(".chat-header .ch-tools"), "gap")).toContain('"value":0');
    expect(declared(phoneRule(".chat-header"), "padding")).toContain('"value":4');
  });

  it("the composer gives its side gutters to the text", () => {
    expect(declared(phoneRule(".message-input-wrap"), "padding-left")).toContain('"value":6');
    expect(declared(phoneRule(".message-input-wrap"), "padding-right")).toContain('"value":6');
    expect(declared(phoneRule(".msg-textarea"), "padding-left")).toContain('"value":0');
    // The desktop keeps its 16 px gutters.
    expect(JSON.stringify(cascadedDeclaration(".message-input-wrap", "padding"))).toContain(
      '"value":16',
    );
  });

  it("a toast under a bottom sheet sits below the sheet's backdrop", () => {
    const sheet = rules.find((r) => r.selector === ".bottom-sheet-overlay" && r.media === "");
    expect(declared(sheet, "z-index")).toContain('"value":350');
    // The narrow-window block (responsive.css), which takes in the phone queries.
    const toast = rules.find(
      (r) =>
        r.selector === "body .toast-container.toast-container--under-sheet" &&
        r.queries.some((q) => q.includes('"coarse"')),
    );
    expect(declared(toast, "z-index")).toContain('"value":340');
  });
});
