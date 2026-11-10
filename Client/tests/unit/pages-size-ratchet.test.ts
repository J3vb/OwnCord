// src/pages/ holds wiring only: it mounts and connects features, it does not
// own screens. New screen code goes in features/<area>/ (shared UI in lib/ui/).
// This caps the total hand-written line count of src/pages/ and only shrinks.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInstrumented, withoutSandboxHeader } from "../helpers/instrumented";

const pagesDir = path.resolve(__dirname, "../../src/pages");

/** Lower this when pages/ shrinks (round the new total up to the next 50); it never rises. */
const PAGES_LINE_CAP = 14750;

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/** Total lines over the files the nightly run did not rewrite (those are judged on the originals). */
function pagesTotal(): number {
  return pageFiles(pagesDir)
    .map((file) => withoutSandboxHeader(readFileSync(file, "utf8")))
    .filter((text) => !isInstrumented(text))
    .reduce((sum, text) => sum + lineCount(text), 0);
}

describe("src/pages size", () => {
  it("stays at or below the cap: new screen code goes in features/", () => {
    expect(pagesTotal()).toBeLessThanOrEqual(PAGES_LINE_CAP);
  });
});
