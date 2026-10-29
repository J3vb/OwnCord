// MX-11: Escape must not close a dialog or popover while an input method composes.
//
// A Chinese, Japanese or Korean IME cancels its candidate with Escape. A keydown
// handler that closes on Escape without checking `isImeCommit(e)` also drops
// what was typed. This test reads every function in `src/` that compares a key
// to "Escape" and fails on one that does not call `isImeCommit`, and fails on a
// `closeOnEscape: false` dialog that wires its own Escape listener instead of
// `createModal`'s `onEscape`. Exceptions are exact (file + function) and
// shrink-only.
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

// Key-capture handlers that rebind a shortcut. Focus is on a button, so no
// input method composes there; letting a composing Escape fall through would
// record it as the new binding instead.
const CAPTURE = "key capture on a focused button, no text field; Escape cancels the capture";
const EXEMPT: readonly Exempt[] = [
  { file: "components/settings/KeybindsTab.ts", fn: "onKey", reason: CAPTURE },
  { file: "components/settings/comboCapture.ts", fn: "onKey", reason: CAPTURE },
  { file: "components/settings/pttControls.ts", fn: "onKey", reason: CAPTURE },
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
  return (
    ts.isPropertyAccessExpression(node) && (node.name.text === "key" || node.name.text === "code")
  );
}

/** The literal a `.key`/`.code` comparison or `case` checks against, if any. */
function comparedKey(node: ts.Node): string | undefined {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      op !== ts.SyntaxKind.EqualsEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsToken
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

function keysIn(node: ts.Node): Set<string> {
  const keys = new Set<string>();
  const walk = (n: ts.Node): void => {
    const key = comparedKey(n);
    if (key !== undefined) keys.add(key);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return keys;
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
}

/**
 * The branch an `isImeCommit` call is limited to: the body of the nearest
 * enclosing `if`/`case` that tests other keys but not Escape (an Enter-only
 * guard does not cover the Escape branch next to it). Undefined when the call
 * covers the whole function.
 */
function guardScope(call: ts.Node, fn: FnNode): ts.Node | undefined {
  let child: ts.Node = call;
  for (let node = call.parent; node !== fn; child = node, node = node.parent) {
    if (ts.isIfStatement(node) && child === node.thenStatement) {
      const keys = keysIn(node.expression);
      if (keys.size > 0 && !keys.has("Escape")) return node.thenStatement;
    }
    if (ts.isCaseClause(node)) {
      const key = comparedKey(node);
      if (key !== undefined && key !== "Escape") return node;
    }
  }
  return undefined;
}

/** Escape handlers, keyed `file :: fn`, with an Escape test no `isImeCommit` covers. */
function unguardedIn(file: string, text: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const facts = new Map<FnNode, { escapes: ts.Node[]; guards: ts.Node[] }>();
  const visit = (node: ts.Node, owner: FnNode | undefined): void => {
    const next = isFn(node) ? node : owner;
    if (next !== undefined) {
      let f = facts.get(next);
      if (f === undefined) {
        f = { escapes: [], guards: [] };
        facts.set(next, f);
      }
      if (comparedKey(node) === "Escape") f.escapes.push(node);
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "isImeCommit"
      ) {
        f.guards.push(node);
      }
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, undefined);
  for (const [fn, f] of facts) {
    const scopes = f.guards.map((g) => guardScope(g, fn));
    const covered = (esc: ts.Node): boolean =>
      scopes.some((scope) => scope === undefined || contains(scope, esc));
    if (!f.escapes.every(covered)) out.push(`${file} :: ${fnName(fn)}`);
  }
  return out;
}

function unguardedEscapeHandlers(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    if (text.includes('"Escape"')) out.push(...unguardedIn(file, text));
  }
  return out.toSorted();
}

describe("the Escape guard scan", () => {
  const scan = (body: string): string[] => unguardedIn("x.ts", `const h = (e) => {${body}};`);

  it("flags an unguarded Escape test, by key or code, in any comparison form", () => {
    expect(scan('if (e.key === "Escape") close();')).toEqual(["x.ts :: h"]);
    expect(scan('if (e.code == "Escape") close();')).toEqual(["x.ts :: h"]);
    expect(scan('switch (e.key) { case "Escape": close(); }')).toEqual(["x.ts :: h"]);
  });

  it("does not count a guard that only covers the Enter branch", () => {
    expect(
      scan(
        'if (e.key === "Enter") { if (isImeCommit(e)) return; send(); } if (e.key === "Escape") close();',
      ),
    ).toEqual(["x.ts :: h"]);
    expect(
      scan(
        'switch (e.key) { case "Enter": if (isImeCommit(e)) return; send(); break; case "Escape": close(); }',
      ),
    ).toEqual(["x.ts :: h"]);
  });

  it("accepts a guard up front, in the condition, or inside the Escape branch", () => {
    expect(scan('if (isImeCommit(e)) return; if (e.key === "Escape") close();')).toEqual([]);
    expect(scan('if (e.key === "Escape" && !isImeCommit(e)) close();')).toEqual([]);
    expect(scan('if (e.key === "Escape") { if (isImeCommit(e)) return; close(); }')).toEqual([]);
  });
});

describe("Escape handlers respect IME composition", () => {
  const found = unguardedEscapeHandlers();
  const exempt = new Set(EXEMPT.map((e) => `${e.file} :: ${e.fn}`));

  it("every Escape handler calls isImeCommit or is an exact exemption", () => {
    expect(found.filter((key) => !exempt.has(key))).toEqual([]);
  });

  it("every exemption still exists (shrink-only)", () => {
    expect([...exempt].filter((key) => !found.includes(key))).toEqual([]);
  });

  it("no dialog opts out of createModal's Escape handling", () => {
    const optOuts = sourceFiles.filter((file) =>
      /closeOnEscape\s*:\s*false/.test(readFileSync(path.join(srcDir, file), "utf8")),
    );
    expect(optOuts).toEqual([]);
  });
});
