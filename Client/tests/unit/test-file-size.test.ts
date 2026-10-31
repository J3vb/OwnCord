/**
 * No test file under Client/src or Client/tests is longer than 1,500 lines.
 *
 * The cap exists so that a reader, or an agent, can load one test file whole:
 * past that size the setup at the top and the assertion at the bottom stop
 * fitting in one view, and a change is made against a part of the file that
 * was never read. When a file grows past the cap, split it by feature into a
 * folder named after it in camelCase and move the shared setup into
 * tests/helpers. There is no allowlist: the cap is not raised and a file is
 * not exempted.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CLIENT = resolve(__dirname, "../..");
const MAX_LINES = 1500;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function lineCount(path: string): number {
  const text = readFileSync(path, "utf8");
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

describe("test file size", () => {
  const files = [...testFiles(join(CLIENT, "src")), ...testFiles(join(CLIENT, "tests"))];

  it("finds the test files it is meant to measure", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it(`keeps every *.test.ts at ${MAX_LINES} lines or fewer`, () => {
    const tooLong = files
      .map((path) => ({
        file: relative(CLIENT, path).split("\\").join("/"),
        lines: lineCount(path),
      }))
      .filter((entry) => entry.lines > MAX_LINES)
      .map((entry) => `${entry.file} (${entry.lines} lines)`);
    expect(tooLong).toEqual([]);
  });
});
