import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const srcDir = path.resolve(__dirname, "../../src");

/** Every non-test, non-declaration `.ts` file under `src/`, as sorted `/`-joined relative paths. */
export function listSourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"),
    )
    .map((entry) => entry.split(path.sep).join("/"))
    .toSorted();
}

export interface Exempt {
  file: string;
  fn: string;
  reason: string;
}

export type FnNode =
  ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;

export function isFn(node: ts.Node): node is FnNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

export function fnName(fn: FnNode): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return fn.name.getText();
  }
  if (ts.isVariableDeclaration(fn.parent)) return fn.parent.name.getText();
  return "(anonymous)";
}

/**
 * The literal a comparison (using one of `operators`) or `case` checks a key
 * access against, if any. `isKeyAccess` says which property reads count.
 */
export function comparedKeyWith(
  node: ts.Node,
  isKeyAccess: (node: ts.Node) => boolean,
  operators: readonly ts.SyntaxKind[],
): string | undefined {
  if (ts.isBinaryExpression(node)) {
    if (!operators.includes(node.operatorToken.kind)) return undefined;
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
