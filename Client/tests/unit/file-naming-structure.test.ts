/**
 * Source file names under src/ use one style: camelCase for modules and
 * PascalCase for components and classes. A hyphenated name is the third
 * style the tree used to mix in.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.m?ts$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => relative(SRC, path).split("\\").join("/"));

describe("source file naming", () => {
  it("names every TypeScript file in camelCase or PascalCase", () => {
    const hyphenated = files.filter((file) => {
      const name = file.split("/").pop()!;
      return name.includes("-");
    });
    expect(hyphenated).toEqual([]);
  });
});
