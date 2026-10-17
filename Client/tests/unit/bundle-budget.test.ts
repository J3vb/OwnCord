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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allCssFiles,
  findEmbeddedWasm,
  MAX_NOTE_LENGTH,
  startupClosureFiles,
  validateBudgets,
  WASM_MARKER,
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

describe("bundle-budgets.json shape", () => {
  const real = JSON.parse(
    readFileSync(join(__dirname, "../../bundle-budgets.json"), "utf8"),
  ) as Record<string, unknown>;
  const valid = {
    startup: { budget: 1000, note: "entry" },
    css: { budget: 500 },
    chunks: { MainPage: { budget: 2000, note: "page" } },
    forbidEmbeddedWasm: { marker: WASM_MARKER },
  };

  it("accepts the checked-in budgets", () => {
    expect(validateBudgets(real)).toEqual([]);
  });

  it("rejects a note that carries raise history", () => {
    const budgets = {
      ...valid,
      chunks: { MainPage: { budget: 2000, note: "x".repeat(MAX_NOTE_LENGTH + 1) } },
    };
    expect(validateBudgets(budgets)).toEqual([expect.stringContaining("chunks.MainPage.note is")]);
  });

  it("rejects text appended to the WASM marker", () => {
    const budgets = { ...valid, forbidEmbeddedWasm: { marker: `${WASM_MARKER} Raised 1 -> 2 B` } };
    expect(validateBudgets(budgets)).toEqual([
      `forbidEmbeddedWasm.marker must be exactly '${WASM_MARKER}'`,
    ]);
  });

  it("rejects history in a top-level text field or a new key", () => {
    const budgets = {
      ...valid,
      ratchet: "x".repeat(MAX_NOTE_LENGTH + 1),
      startup: { budget: 1000, rebaseline: "measured 1 B" },
    };
    expect(validateBudgets(budgets)).toEqual([
      expect.stringContaining("ratchet is"),
      "startup: unknown key 'rebaseline'",
    ]);
  });

  it("rejects a missing or non-integer budget", () => {
    const budgets = { ...valid, css: { budget: 12.5 } };
    expect(validateBudgets(budgets)).toEqual(["css: budget must be a positive integer"]);
  });
});
