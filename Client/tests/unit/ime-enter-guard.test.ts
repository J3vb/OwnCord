// MX-5: Enter in a text field must not submit while an input method composes.
//
// A Chinese, Japanese or Korean IME commits its candidate with Enter. A keydown
// handler that submits on Enter without checking `isImeCommit(e)` sends the
// half-typed value (a ban with a half-typed reason, a login with a half-typed
// code). This test reads every function in `src/` that compares a key to
// "Enter" and fails on one that neither calls `isImeCommit` nor is an Enter/Space
// button activation. Exceptions are exact (file + function) and shrink-only.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  comparedKeyWith,
  fnName,
  isFn,
  listSourceFiles,
  srcDir,
  type Exempt,
  type FnNode,
} from "../helpers/srcAst";

const sourceFiles = listSourceFiles();

// Handlers that compare a key to "Enter" but never take text input.
const EXEMPT: readonly Exempt[] = [
  {
    file: "features/voice/miniPlayer.ts",
    fn: "(anonymous)",
    reason: "keyboard move/return on the floating player root, which has no text field",
  },
];

function isKeyAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "key";
}

const comparedKey = (node: ts.Node): string | undefined =>
  comparedKeyWith(node, isKeyAccess, [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);

interface Facts {
  enter: boolean;
  space: boolean;
  guarded: boolean;
}

/** Enter handlers, keyed `file :: fn`, that do not call `isImeCommit`. */
function unguardedEnterHandlers(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    if (!text.includes('"Enter"')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const facts = new Map<FnNode, Facts>();
    const visit = (node: ts.Node, owner: FnNode | undefined): void => {
      const next = isFn(node) ? node : owner;
      if (next !== undefined) {
        let f = facts.get(next);
        if (f === undefined) {
          f = { enter: false, space: false, guarded: false };
          facts.set(next, f);
        }
        const key = comparedKey(node);
        if (key === "Enter") f.enter = true;
        if (key === " ") f.space = true;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "isImeCommit"
        ) {
          f.guarded = true;
        }
      }
      ts.forEachChild(node, (child) => visit(child, next));
    };
    visit(sf, undefined);
    for (const [fn, f] of facts) {
      // Enter together with Space is button activation on a non-text element.
      if (f.enter && !f.space && !f.guarded) out.push(`${file} :: ${fnName(fn)}`);
    }
  }
  return out.toSorted();
}

describe("Enter handlers respect IME composition", () => {
  const found = unguardedEnterHandlers();
  const exempt = new Set(EXEMPT.map((e) => `${e.file} :: ${e.fn}`));

  it("every Enter handler calls isImeCommit or is an exact exemption", () => {
    expect(found.filter((key) => !exempt.has(key))).toEqual([]);
  });

  it("every exemption still exists (shrink-only)", () => {
    expect([...exempt].filter((key) => !found.includes(key))).toEqual([]);
  });

  it("the guard is not copied inline outside lib/text/ime.ts", () => {
    const copies = sourceFiles.filter(
      (file) =>
        file !== "lib/text/ime.ts" &&
        /isComposing\s*\|\|\s*\w+\.keyCode\s*===\s*229/.test(
          readFileSync(path.join(srcDir, file), "utf8"),
        ),
    );
    expect(copies).toEqual([]);
  });
});
