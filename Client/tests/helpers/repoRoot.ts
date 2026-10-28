// Tests that read files outside Client/ (docs, protocol fixtures, the admin
// panel) find the repository root by walking up to protocol/schema.json rather
// than counting "../". Stryker runs the suite from a copy of Client/ inside
// Client/.stryker-tmp/sandbox-*, where a fixed "../../.." lands in the temp dir.
import { existsSync } from "node:fs";
import path from "node:path";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "protocol", "schema.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no repository root above ${start}`);
    dir = parent;
  }
}

export const repoRoot = findRepoRoot(__dirname);
