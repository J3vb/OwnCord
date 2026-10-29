// MX-5: Enter in a text field must not submit while an input method composes.
//
// A Chinese, Japanese or Korean IME commits its candidate with Enter. A keydown
// handler that submits on Enter without checking `isImeCommit(e)` sends the
// half-typed value (a ban with a half-typed reason, a login with a half-typed
// code). This test reads every function in `src/` that compares a key to
// "Enter" and fails on one that neither calls `isImeCommit` nor is an Enter/Space
// button activation. Exceptions are exact (file + function) and shrink-only.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "../../src");

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"),
  )
  .map((entry) => entry.split(path.sep).join("/"))
  .toSorted();

interface Exempt {
  file: string;
  fn: string;
  reason: string;
}

// Handlers that compare a key to "Enter" but never take text input.
const EXEMPT: readonly Exempt[] = [
  {
    file: "features/voice/miniPlayer.ts",
    fn: "(anonymous)",
    reason: "keyboard move/return on the floating player root, which has no text field",
  },
];

type FnNode =
  ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

function isFn(node: ts.Node): node is FnNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

function fnName(fn: FnNode): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return fn.name.getText();
  }
  if (ts.isVariableDeclaration(fn.parent)) return fn.parent.name.getText();
  return "(anonymous)";
}

function isKeyAccess(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "key";
}

/** The literal a `.key` comparison or `case` checks against, if any. */
function comparedKey(node: ts.Node): string | undefined {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return undefined;
    }
    if (isKeyAccess(node.left) && ts.isStringLiteral(node.right)) return node.right.text;
    if (isKeyAccess(node.right) && ts.isStringLiteral(node.left)) return node.left.text;
    return undefined;
  }
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
    const sw = node.parent.parent;
    if (ts.isSwitchStatement(sw) && isKeyAccess(sw.expression)) return node.expression.text;
  }
  return undefined;
}

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

describe("Enter handlers respect IME composition (MX-5)", () => {
  const found = unguardedEnterHandlers();
  const exempt = new Set(EXEMPT.map((e) => `${e.file} :: ${e.fn}`));

  it("every Enter handler calls isImeCommit or is an exact exemption", () => {
    expect(found.filter((key) => !exempt.has(key))).toEqual([]);
  });

  it("every exemption still exists (shrink-only)", () => {
    expect([...exempt].filter((key) => !found.includes(key))).toEqual([]);
  });

  it("the guard is not copied inline outside lib/ime.ts", () => {
    const copies = sourceFiles.filter(
      (file) =>
        file !== "lib/ime.ts" &&
        /isComposing\s*\|\|\s*\w+\.keyCode\s*===\s*229/.test(
          readFileSync(path.join(srcDir, file), "utf8"),
        ),
    );
    expect(copies).toEqual([]);
  });
});
