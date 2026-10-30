// Every dialog closes on its backdrop through closeOnBackdropClick in
// lib/ui/modalFactory.ts. A hand-written `e.target === overlay` click check closes
// on a drag-select that starts inside the dialog and is released on the
// backdrop (OC-0520), so this test fails on a new one. The allowlist is
// shrink-only: an entry that no longer matches must be removed, and a new
// entry needs a reason it is not a backdrop close.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "..");

const HELPER = "lib/ui/modalFactory.ts";

const ALLOWLIST: Readonly<Record<string, string>> = {
  "features/voice/miniPlayer.ts": "keydown guard on the player itself, not a backdrop",
};

const BACKDROP_CHECK =
  /\.target\s*[!=]==\s*[\w?.]*(?:overlay|backdrop|root|scrim)\b|\b[\w?.]*(?:overlay|backdrop|root|scrim)\s*[!=]==\s*\w+\.target\b/i;

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"));

const matching = sourceFiles.filter((file) =>
  BACKDROP_CHECK.test(readFileSync(path.join(srcDir, file), "utf8")),
);

describe("the dialog backdrop door", () => {
  it("recognises a hand-written backdrop check", () => {
    expect(BACKDROP_CHECK.test("if (e.target === overlay) close();")).toBe(true);
    expect(BACKDROP_CHECK.test("if (e.target === modal?.overlay) close();")).toBe(true);
    expect(BACKDROP_CHECK.test("if (ev.target !== root) return;")).toBe(true);
    expect(BACKDROP_CHECK.test("if (backdrop === event.target) hide();")).toBe(true);
    expect(BACKDROP_CHECK.test("if (e.target !== input) return;")).toBe(false);
  });

  it("finds the shared guard itself", () => {
    expect(matching).toContain(HELPER);
  });

  it("no file outside the allowlist hand-writes a backdrop check", () => {
    const offenders = matching.filter((file) => file !== HELPER && !(file in ALLOWLIST));
    expect(offenders, "use closeOnBackdropClick from lib/ui/modalFactory.ts").toEqual([]);
  });

  it("every allowlist entry still matches (the list only shrinks)", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(matching, file).toContain(file);
    }
  });
});
