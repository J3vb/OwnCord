// @ts-check
import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import base from "../../vitest.config.ts";

// The permissions mutation step's own suite. Stryker's dry run executes every
// test its Vitest config includes, so the full suite made a one-file mutation
// run take minutes. Only the test files that import permissions.ts run here,
// found by scanning, so a new one joins without editing this file.
const root = resolve(import.meta.dirname, "../..");
const IMPORTS_PERMISSIONS = /from\s+["'][^"']*stores\/permissions(\.ts)?["']/;

/** @param {string} dir @returns {string[]} */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "e2e" ? [] : testFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const include = ["src", "tests"]
  .flatMap((dir) => testFiles(join(root, dir)))
  .filter((file) => IMPORTS_PERMISSIONS.test(readFileSync(file, "utf8")))
  .map((file) => relative(root, file).replaceAll("\\", "/"));

if (include.length === 0) throw new Error("no test imports stores/permissions");

export default defineConfig({
  ...base,
  root,
  test: {
    ...base.test,
    projects: undefined,
    include,
    exclude: [...configDefaults.exclude],
  },
});
