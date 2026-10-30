// Shrink-only ratchet: a hand-written `signature` passed to reconcileChildren
// is a stale-row hazard. New row lists use reconcileModels (src/lib/net/reconcile.ts),
// which derives the signature from a row model. Migrate a file, then delete its entry.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(__dirname, "../../src");

const HAND_WRITTEN_SIGNATURE: Readonly<Record<string, number>> = {
  "components/DmSidebar.ts": 1,
  "pages/main-page/SidebarDmSection.ts": 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

// Source of every `reconcileChildren(` call's argument list, by paren matching.
function callArguments(text: string): string[] {
  const calls: string[] = [];
  const re = /\breconcileChildren\s*(?:<[^>(]*>)?\s*\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    calls.push(text.slice(re.lastIndex, i - 1));
  }
  return calls;
}

function countHandWrittenSignatures(text: string): number {
  return callArguments(text).filter((args) => /\bsignature\b/.test(args)).length;
}

function hasHandWrittenSignature(text: string): boolean {
  return countHandWrittenSignatures(text) > 0;
}

function offenders(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(srcRoot)) {
    const count = countHandWrittenSignatures(readFileSync(file, "utf8"));
    if (count > 0) found[path.relative(srcRoot, file).split(path.sep).join("/")] = count;
  }
  return found;
}

describe("reconcileChildren hand-written signature ratchet", () => {
  it("matches the shrink-only call-site counts exactly (a new call fails; a stale entry fails)", () => {
    expect(offenders()).toEqual(HAND_WRITTEN_SIGNATURE);
  });

  it("detects a hand-written signature and ignores a call without one", () => {
    expect(
      hasHandWrittenSignature(`reconcileChildren(list, items, { key, signature: sig, create });`),
    ).toBe(true);
    expect(hasHandWrittenSignature(`reconcileChildren(list, items, { key, create });`)).toBe(false);
    expect(
      countHandWrittenSignatures(
        `reconcileChildren(a, b, { signature: x }); reconcileChildren(c, d, { signature: y });`,
      ),
    ).toBe(2);
    expect(hasHandWrittenSignature(`const signature = 1; reconcileModels(a, b, { key });`)).toBe(
      false,
    );
  });
});
