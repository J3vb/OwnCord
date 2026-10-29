// lib/preferences.ts is the only door to `localStorage`. Its helpers are
// guarded: storage that is missing, blocked or full reads as absent and a
// failed write returns false, so no caller can throw on it. This test pins
// that no other module reaches `localStorage` itself. The two browser-platform
// files are the browser's settings and credential stores, which own their own
// guards and report failure through the platform contract.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "..");

/** Shrink-only: remove an entry once its file no longer needs it. */
const ALLOWED = [
  "lib/preferences.ts",
  "platform/browser/credentials.ts",
  "platform/browser/settings.ts",
];

function withoutComments(text: string): string {
  // `//` after a `:` is a URL in a string, not a comment.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const touching = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"))
  .filter((entry) =>
    /\blocalStorage\b/.test(withoutComments(readFileSync(path.join(srcDir, entry), "utf8"))),
  );

describe("the storage door", () => {
  it("only the allowlisted modules touch localStorage", () => {
    expect(touching.filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });

  it("every allowlisted module still touches it (the list only shrinks)", () => {
    expect(ALLOWED.filter((file) => !touching.includes(file))).toEqual([]);
  });
});
