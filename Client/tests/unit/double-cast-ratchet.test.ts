// `x as unknown as T` tells the compiler nothing about x: it skips every check
// a plain `as` still makes. Production code may not have one: the list below
// is empty, and a new entry is not the way to add one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInstrumented, withoutSandboxHeader } from "../helpers/instrumented";

const srcDir = path.resolve(__dirname, "../../src");

const allowed: Record<string, number> = {};

const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(full);
    const isSource = entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name);
    return isSource ? [full] : [];
  });
}

/** Counts per file, and the files the nightly run rewrote (judged on the originals only). */
function doubleCasts(): { counts: Record<string, number>; rewritten: Set<string> } {
  const counts: Record<string, number> = {};
  const rewritten = new Set<string>();
  for (const file of productionFiles(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join("/");
    const text = withoutSandboxHeader(readFileSync(file, "utf8"));
    if (isInstrumented(text)) {
      rewritten.add(rel);
      continue;
    }
    const found = text.match(DOUBLE_CAST)?.length ?? 0;
    if (found > 0) counts[rel] = found;
  }
  return { counts, rewritten };
}

describe("double casts in production code", () => {
  it("are only the listed ones, and every listed one is still there", () => {
    const { counts, rewritten } = doubleCasts();
    const expected = Object.fromEntries(
      Object.entries(allowed).filter(([file]) => !rewritten.has(file)),
    );
    expect(counts).toEqual(expected);
  });
});
