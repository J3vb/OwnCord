// The UI layer is pages/ (wiring) over features/. A components/ folder is gone
// for good: shared UI lives in lib/ui/ and a feature owns its screens. This pins
// the top level of src/ so a new layer is a deliberate, reviewed change.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "../../src");

const KNOWN_ENTRIES = [
  "app",
  "assets",
  "features",
  "i18n",
  "lib",
  "main.ts",
  "pages",
  "platform",
  "stores",
  "styles",
  "vite-env.d.ts",
];

describe("src/ top level", () => {
  it("has no components/ folder", () => {
    expect(existsSync(path.join(srcDir, "components"))).toBe(false);
  });

  it("holds exactly the known layers and entry files", () => {
    expect(readdirSync(srcDir).sort()).toEqual([...KNOWN_ENTRIES].sort());
  });
});
