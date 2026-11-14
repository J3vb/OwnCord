import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/repoRoot";
import { normalizeLinkUrl } from "../../src/features/messaging/content/serverPreviews";

/** The table Server/linkpreview/url_test.go reads too: the two spellings cannot drift. */
const fixture = JSON.parse(
  readFileSync(join(repoRoot, "protocol/fixtures/link-url-normalisation.json"), "utf8"),
) as { cases: { name: string; in: string; want: string | null }[] };

describe("normalizeLinkUrl matches the server's NormalizeURL", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(30);
  });
  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(normalizeLinkUrl(c.in)).toBe(c.want);
  });
});
