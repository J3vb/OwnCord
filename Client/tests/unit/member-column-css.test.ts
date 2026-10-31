// The member list used to be a right-hand column, and its leftovers (a fixed
// width, and a 1200px rule that collapsed it to width 0) would hide the new
// column's panel. jsdom never applies app.css, so these assert the parsed
// stylesheet (tests/helpers/app-css.ts, plus a walk of the @media rules the
// helper leaves out).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundle } from "lightningcss";
import type { Rule } from "lightningcss";
import { describe, it, expect } from "vitest";
import { cascadedDeclaration, hasRule, keyword } from "../helpers/app-css";

/** Every style rule, including those nested in @media, with its selectors as
 *  written by Lightning CSS and the properties it declares. */
function allStyleRules(): Array<{ selectors: string[]; properties: string[]; media: boolean }> {
  let sheetRules: Rule[] = [];
  bundle({
    filename: join(process.cwd(), "src/styles/app.css"),
    visitor: {
      StyleSheet(s) {
        sheetRules = s.rules;
      },
    },
  });
  const out: Array<{ selectors: string[]; properties: string[]; media: boolean }> = [];
  const walk = (rules: Rule[], media: boolean): void => {
    for (const rule of rules) {
      if (rule.type === "media") walk(rule.value.rules, true);
      else if (rule.type === "style") {
        const decls = [
          ...(rule.value.declarations?.declarations ?? []),
          ...(rule.value.declarations?.importantDeclarations ?? []),
        ];
        out.push({
          selectors: rule.value.selectors.map((sel) =>
            sel.map((c) => (c.type === "class" ? `.${c.name}` : c.type)).join(" "),
          ),
          properties: decls.map((d) => d.property),
          media,
        });
      }
    }
  };
  walk(sheetRules, false);
  return out;
}

describe("member column CSS (3C-6b)", () => {
  it("no width-0 rule targets .member-list at any width", () => {
    const widthRules = allStyleRules().filter(
      (r) => r.selectors.includes(".member-list") && r.properties.includes("width"),
    );
    expect(widthRules).toEqual([]);
    expect(cascadedDeclaration(".member-list", "width")).toBeUndefined();
    expect(cascadedDeclaration(".member-list", "transition")).toBeUndefined();
  });

  it("the old .member-list.hidden rule is gone", () => {
    expect(hasRule(".member-list.hidden")).toBe(false);
  });

  it(".member-column[hidden] is display: none", () => {
    expect(keyword(cascadedDeclaration(".member-column[hidden]", "display"))).toBe("none");
  });

  it("the column is a fixed-width flex column; its body is the scroller", () => {
    expect(JSON.stringify(cascadedDeclaration(".member-column", "display")?.value)).toContain(
      '"flex"',
    );
    expect(keyword(cascadedDeclaration(".member-column", "flex-direction"))).toBe("column");
    expect(cascadedDeclaration(".member-column", "width")).toBeDefined();
    expect(keyword(cascadedDeclaration(".member-column-body", "overflow-y"))).toBe("auto");
    expect(cascadedDeclaration(".member-column .member-list", "width")).toBeDefined();
  });

  it("the column's search row is as tall as the chat header beside it", () => {
    expect(
      JSON.stringify(cascadedDeclaration(".member-column .member-search-wrap", "height")?.value),
    ).toContain("48");
    expect(JSON.stringify(cascadedDeclaration(".chat-header", "height")?.value)).toContain("48");
  });

  it("the narrow overlay starts below the chat header, leaving its toggle clickable", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/app/member-list.css"), "utf8");
    const block =
      /@media \(max-width: 899px\)(?:,[^{]*)?\{\s*\.member-column\s*\{([^}]*)\}/.exec(css)?.[1] ??
      "";
    expect(block).toMatch(/position:\s*fixed/);
    // Plus the notch inset the shell now pads above the header (6.13f1).
    expect(block).toMatch(
      /top:\s*calc\(var\(--header-height, 48px\) \+ env\(safe-area-inset-top\)\)/,
    );
  });

  it("the pinned panel drops below the chat header, so the pin button can close it", () => {
    expect(JSON.stringify(cascadedDeclaration(".pinned-panel", "top")?.value)).toContain(
      "header-height",
    );
  });

  it("the sidebar copy keeps filling its section", () => {
    expect(cascadedDeclaration(".sidebar-members-section .member-list", "width")).toBeDefined();
  });

  it("the header toggle's hidden attribute wins over the tools' display: flex", () => {
    expect(keyword(cascadedDeclaration(".chat-header .ch-tools button[hidden]", "display"))).toBe(
      "none",
    );
  });
});
