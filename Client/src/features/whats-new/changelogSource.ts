/**
 * Loads the bundled release notes. The repository's CHANGELOG.md is built in
 * as text (`changelogModule` in vite.config.ts), in its own lazy chunk, so it
 * costs nothing at startup and nothing is fetched at runtime.
 */

import { parseChangelog } from "./changelog";
import type { ChangelogVersion } from "./changelog";

let cached: Promise<readonly ChangelogVersion[]> | null = null;

export function loadChangelog(): Promise<readonly ChangelogVersion[]> {
  cached ??= import("virtual:owncord-changelog").then(
    (mod) => parseChangelog(mod.default),
    (err: unknown) => {
      cached = null;
      throw err;
    },
  );
  return cached;
}
