// The phone layout is decided twice: in TypeScript by isPhoneLayout() and in
// CSS by media queries that cannot import the TypeScript constant. They must
// never disagree, or a phone gets the drawer's script with the desktop's
// layout. This reads every stylesheet's @media preludes and fails when a phone
// query differs from PHONE_LAYOUT_QUERY.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_LAYOUT_QUERY } from "../../src/lib/ui/bottomSheet";

const STYLES = join(process.cwd(), "src/styles");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? cssFiles(join(dir, entry.name))
      : entry.name.endsWith(".css")
        ? [join(dir, entry.name)]
        : [],
  );
}

interface Prelude {
  readonly file: string;
  readonly text: string;
}

/** Every `@media` prelude in the stylesheets, comments dropped, spaces collapsed. */
function preludes(): Prelude[] {
  return cssFiles(STYLES).flatMap((file) => {
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...source.matchAll(/@media([^{]+)\{/g)].map((m) => ({
      file: file.slice(STYLES.length + 1),
      text: m[1]!.replace(/\s+/g, " ").trim(),
    }));
  });
}

const PARTS = PHONE_LAYOUT_QUERY.split(",").map((q) => q.trim());
const all = preludes();
const queriesOf = (p: Prelude): string[] => p.text.split(",").map((q) => q.trim());
const isPhoneShaped = (q: string): boolean =>
  q.includes("pointer: coarse") && /max-(width|height)/.test(q);

describe("the phone media queries in CSS", () => {
  it("are found (the scan is not empty)", () => {
    expect(all.filter((p) => queriesOf(p).some(isPhoneShaped)).length).toBeGreaterThanOrEqual(8);
  });

  it("have two halves: a coarse pointer and a narrow window, or a coarse pointer and a short one", () => {
    expect(PARTS).toEqual([
      "(pointer: coarse) and (max-width: 899px)",
      "(pointer: coarse) and (max-height: 499px)",
    ]);
  });

  it("never combine a coarse pointer with a size other than the TypeScript constant's", () => {
    const stray = all.flatMap((p) =>
      queriesOf(p)
        .filter((q) => isPhoneShaped(q) && !PARTS.includes(q))
        .map((q) => `${p.file}: ${q}`),
    );
    expect(stray).toEqual([]);
  });

  it("always list both halves, as the whole TypeScript constant", () => {
    const partial = all
      .filter((p) => queriesOf(p).some((q) => PARTS.includes(q)))
      .filter((p) => p.text !== PHONE_LAYOUT_QUERY && !p.text.endsWith(`, ${PHONE_LAYOUT_QUERY}`))
      .map((p) => `${p.file}: ${p.text}`);
    expect(partial).toEqual([]);
  });

  it("add the phone layout to the rules that collapse the sidebar below 800 px", () => {
    for (const file of ["app/responsive.css", "app/server-rail.css"]) {
      const narrow = all.filter((p) => p.file === file && p.text.startsWith("(max-width: 800px)"));
      expect(narrow.length, file).toBeGreaterThan(0);
      for (const p of narrow)
        expect(p.text, file).toBe(`(max-width: 800px), ${PHONE_LAYOUT_QUERY}`);
    }
  });
});
