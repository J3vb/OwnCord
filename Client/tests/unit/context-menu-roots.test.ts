/**
 * Every right-click menu opens through `openMenuShell` in `lib/ui/contextMenu.ts`
 * (MX-6), which is what closes the menu already open, keeps the new one inside
 * the window and wires its dismissal. A component that builds its own
 * `.context-menu` root skips all three. Shrink-only: an entry may only go down,
 * and an entry no longer needed must be deleted.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../../src");
const SHELL = "lib/ui/contextMenu.ts";

/** A `.context-menu` root built by hand: the bare class, alone or first. */
const ROOT = /(?:class:\s*|className\s*=\s*|classList\.add\(\s*)["'`]context-menu["'` ]/g;

/** File -> hand-built roots still allowed. Started at 7 in 6 files; now empty. */
const ALLOWED: Readonly<Record<string, number>> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function handBuiltRoots(): Map<string, number> {
  const found = new Map<string, number>();
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).replaceAll("\\", "/");
    if (file === SHELL) continue;
    const count = readFileSync(path, "utf8").match(ROOT)?.length ?? 0;
    if (count > 0) found.set(file, count);
  }
  return found;
}

describe("context menu roots", () => {
  it("are built only by the shared shell", () => {
    const over = [...handBuiltRoots()]
      .filter(([file, count]) => count > (ALLOWED[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} (allowed ${ALLOWED[file] ?? 0})`);
    expect(over, "open the menu with openMenuShell or showContextMenu").toEqual([]);
  });

  it("allow no more than they still need", () => {
    const found = handBuiltRoots();
    const stale = Object.entries(ALLOWED)
      .filter(([file, count]) => (found.get(file) ?? 0) < count)
      .map(([file, count]) => `${file}: allowed ${count}, found ${found.get(file) ?? 0}`);
    expect(stale, "lower or delete the entry").toEqual([]);
  });

  it("still recognises a hand-built root", () => {
    const sample = 'createElement("div", { class: "context-menu user-vol-menu" });';
    expect(sample.match(ROOT)).toHaveLength(1);
    expect('{ class: "context-menu-item" }'.match(ROOT)).toBeNull();
  });
});
