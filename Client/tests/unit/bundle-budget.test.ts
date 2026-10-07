// D5/PERF-07: the startup budget must measure the JS chain only, with CSS on
// its own line.
//
// The startup budget is the entry's static closure. It used to include every
// linked stylesheet, and `cssCodeSplit: false` merges the whole app UI
// stylesheet into one eagerly-linked file — so a UI PR that only added CSS
// moved the startup number, and the budget was raised almost daily. PERF-07 is
// scoped to the JS chain, so the closure now counts JS only and every emitted
// stylesheet is budgeted separately (`css-total`).
//
// This drives the pure helpers the CLI calls, so it needs no build: feed a
// fixture manifest and assert the split.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allCssFiles,
  findEmbeddedWasm,
  startupClosureFiles,
} from "../../scripts/bundle-budget.mjs";

/** A manifest shaped like Vite's: an entry linking a JS chunk and a stylesheet,
 *  a lazy chunk with its own stylesheet, and the standalone `style.css`. */
const MANIFEST = {
  "index.html": {
    file: "assets/index-aaa.js",
    isEntry: true,
    imports: ["_chunk-bbb.js"],
    css: ["assets/index-aaa.css"],
  },
  "_chunk-bbb.js": { file: "assets/chunk-bbb.js" },
  "style.css": { file: "assets/style-ccc.css" },
  "src/components/SettingsOverlay.ts": {
    file: "assets/SettingsOverlay-ddd.js",
    css: ["assets/SettingsOverlay-ddd.css"],
  },
  "src/components/SettingsOverlay-eee.css": { file: "assets/SettingsOverlay-ddd.css" },
};

describe("bundle budget closure split (D5)", () => {
  it("counts only JS in the startup closure", () => {
    const files = startupClosureFiles(MANIFEST);
    expect([...files].every((f) => f.endsWith(".js"))).toBe(true);
    expect(files).toContain("assets/index-aaa.js");
    expect(files).toContain("assets/chunk-bbb.js");
    expect(files).not.toContain("assets/index-aaa.css");
    expect(files).not.toContain("assets/SettingsOverlay-ddd.css");
  });

  it("collects every emitted stylesheet exactly once", () => {
    const files = allCssFiles(MANIFEST);
    expect([...files].toSorted()).toEqual([
      "assets/SettingsOverlay-ddd.css",
      "assets/index-aaa.css",
      "assets/style-ccc.css",
    ]);
  });
});

describe("embedded WASM scan", () => {
  it("finds the marker in a nested JS file that no manifest entry names", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-wasm-"));
    try {
      mkdirSync(join(dir, "workers"));
      writeFileSync(join(dir, "ok.js"), "clean");
      writeFileSync(join(dir, "workers", "vad-worklet.js"), "x=AGFzbQ;");
      writeFileSync(join(dir, "note.txt"), "AGFzbQ");
      expect(findEmbeddedWasm(dir, "AGFzbQ")).toEqual([join("workers", "vad-worklet.js")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
