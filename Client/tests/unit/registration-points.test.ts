// The app's wiring files: every feature used to edit them, which made them the
// most fixed files in the repo. Features now register through their own files
// (route tables, page feature lists), so these caps only go down. Lower a cap
// when a file shrinks; never raise one to fit a new feature.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "../../src");

const lineCaps: Record<string, number> = {
  "lib/dispatcher.ts": 341,
  "pages/MainPage.ts": 482,
};

/** Subscriptions written in the dispatcher: the ordered auth_ok, ready and
 *  error chains, plus the one `subscribe` the route tables go through. */
const dispatcherOnCap = 4;

function source(file: string): string {
  return readFileSync(path.join(srcDir, file), "utf8");
}

describe("registration points", () => {
  it.each(Object.entries(lineCaps))("%s stays under its line cap", (file, cap) => {
    expect(source(file).split("\n").length - 1).toBeLessThanOrEqual(cap);
  });

  it("the dispatcher subscribes features through their route tables", () => {
    const calls = source("lib/dispatcher.ts").match(/\.on\(/g) ?? [];
    expect(calls.length).toBeLessThanOrEqual(dispatcherOnCap);
  });
});
