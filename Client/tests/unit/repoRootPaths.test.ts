/**
 * A unit test that reads a file outside Client/ (docs/, protocol/, Server/)
 * finds the repository root through tests/helpers/repoRoot.ts.
 *
 * The nightly run copies Client/ into Client/.stryker-tmp/sandbox-* and runs
 * the suite there, so "Client/.." or a counted "../../.." lands in the temp
 * folder and the read fails with ENOENT. The helper walks up to
 * protocol/schema.json instead, which works from both places.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CLIENT = resolve(__dirname, "../..");
const OUTSIDE_PATH = /(?:join|resolve)\([^)]*["'](?:\.\.\/)*(?:docs|Server|protocol)["'/]/;
const USES_HELPER =
  /from\s+["'](?:\.{1,2}\/)+(?:tests\/)?helpers\/repoRoot["']|from\s+["']\.\/repoRoot["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "e2e"].includes(entry.name) ? [] : sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("paths outside Client/ in unit tests", () => {
  const files = [...sourceFiles(join(CLIENT, "src")), ...sourceFiles(join(CLIENT, "tests"))].filter(
    (path) => path.endsWith(".test.ts") || path.includes(`${join("tests", "helpers")}`),
  );

  it("finds the files it is meant to read", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("reaches docs/, protocol/ and Server/ only through the repoRoot helper", () => {
    const offenders = files
      .filter((path) => !path.endsWith(join("helpers", "repoRoot.ts")))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return OUTSIDE_PATH.test(text) && !USES_HELPER.test(text);
      })
      .map((path) => relative(CLIENT, path));
    expect(offenders).toEqual([]);
  });

  it("flags a root found by stepping up from Client/", () => {
    const text =
      'const repoRoot = join(process.cwd(), "..");\nconst dir = join(repoRoot, "Server", "admin");';
    expect(OUTSIDE_PATH.test(text) && !USES_HELPER.test(text)).toBe(true);
  });

  it("accepts the helper import", () => {
    const text =
      'import { repoRoot } from "../../../tests/helpers/repoRoot";\nconst dir = join(repoRoot, "Server", "admin");';
    expect(USES_HELPER.test(text)).toBe(true);
  });
});
