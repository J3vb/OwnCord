import { join } from "node:path";
import { bundle } from "lightningcss";
import { describe, expect, it } from "vitest";
import { cascadedDeclaration, hasRule } from "../helpers/app-css";

const PAGE_ROOTS = new Set(["body", "html", ":root", ".app", "#app"]);

/** Every selector in app.css, including the ones inside media queries. */
function allSelectors(): string[] {
  const out: string[] = [];
  bundle({
    filename: join(process.cwd(), "src/styles/app.css"),
    visitor: {
      Selector(selector) {
        out.push(JSON.stringify(selector));
        return undefined;
      },
    },
  });
  return out;
}

describe("page-wide :has() rules", () => {
  it("no selector asks :has() on body, html, :root, .app or #app", () => {
    const offenders = allSelectors().filter((json) => {
      const parts = JSON.parse(json) as Array<{ type: string; name?: string; kind?: string }>;
      // A compound ends at a combinator: look at each compound on its own.
      const compounds: (typeof parts)[] = [[]];
      for (const c of parts) {
        if (c.type === "combinator") compounds.push([]);
        else compounds[compounds.length - 1]!.push(c);
      }
      return compounds.some((compound) => {
        const hasHas = compound.some((c) => c.type === "pseudo-class" && c.kind === "has");
        const anchor = compound.some(
          (c) =>
            (c.type === "type" && c.name !== undefined && PAGE_ROOTS.has(c.name)) ||
            (c.type === "class" && c.name === "app") ||
            (c.type === "id" && c.name === "app") ||
            (c.type === "pseudo-class" && c.kind === "root"),
        );
        return hasHas && anchor;
      });
    });
    expect(offenders).toEqual([]);
  });
});

describe("toast and forum class rules", () => {
  it("lifts the stack to the window edge under a dialog", () => {
    const sel = "body .toast-container.toast-container--under-dialog";
    expect(hasRule(sel)).toBe(true);
    for (const prop of ["bottom", "left", "width"]) {
      expect(cascadedDeclaration(sel, prop)).toBeDefined();
    }
  });

  it("keeps the four forum split rules on the shell class", () => {
    const base = ".app.thread-open.app--forum-split";
    expect(cascadedDeclaration(`${base} > .chat-area`, "flex")).toBeDefined();
    expect(cascadedDeclaration(`${base} > .thread-panel-slot.open`, "flex")).toBeDefined();
    expect(cascadedDeclaration(`${base} .thread-panel`, "width")).toBeDefined();
    expect(cascadedDeclaration(`${base} .thread-panel-resize`, "display")).toBeDefined();
  });
});
