// MX-16: a server error code is spelt as its generated constant
// (`RestErrorCode.X` / `WsErrorCode.X` from @lib/protocolTypes), never as a
// bare string. A misspelt literal compiles against `err.code: string` and the
// branch for it silently never runs; the constants come from the same schema
// the server's replies are generated from. The i18n catalogs are exempt: their
// strings are display text that can read like a code ("BANNED").
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RestErrorCode, WsErrorCode } from "@lib/protocolTypes";
import { repoRoot } from "../helpers/repoRoot";

const srcDir = path.join(repoRoot, "Client", "src");
const codes = new Set<string>([...Object.values(RestErrorCode), ...Object.values(WsErrorCode)]);
// A file with no quoted code-shaped word cannot hold one; skipping its parse
// keeps the whole-tree scan fast under coverage.
const maybeCode = /["'`][A-Za-z_]+["'`]/;

function isExempt(rel: string): boolean {
  return rel === "lib/protocolTypes.ts" || rel.startsWith("i18n/") || /\.(test|d)\.ts$/.test(rel);
}

/** Every string literal in `text` equal to a server error code, as "line: CODE". */
function codeLiterals(fileName: string, text: string): string[] {
  if (!maybeCode.test(text)) return [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      codes.has(node.text)
    ) {
      out.push(`${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("server error codes are spelt as generated constants", () => {
  it("knows the generated code set", () => {
    expect(codes.has("BAD_REQUEST")).toBe(true);
    expect(codes.has("INTERNAL_ERROR")).toBe(true);
    expect(codes.has("protocol_epoch_unsupported")).toBe(true);
  });

  it("flags a bare code in a comparison, a case label and a set, and nothing else", () => {
    const src = [
      'if (err.code === "GIF_DISABLED") {}',
      'switch (code) { case "SLOW_MODE": break; }',
      'const s = new Set(["CHANNEL_FULL", "OFFLINE"]);',
      'const key = "createError.BAD_REQUEST";',
      "if (err.code === RestErrorCode.GIF_DISABLED) {}",
    ].join("\n");
    expect(codeLiterals("x.ts", src)).toEqual([
      "1: GIF_DISABLED",
      "2: SLOW_MODE",
      "3: CHANNEL_FULL",
    ]);
  });

  it("no source file compares against a bare server code", () => {
    const found: string[] = [];
    for (const rel of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      const posix = rel.split(path.sep).join("/");
      if (!posix.endsWith(".ts") || isExempt(posix)) continue;
      for (const hit of codeLiterals(posix, readFileSync(path.join(srcDir, rel), "utf8"))) {
        found.push(`${posix}:${hit}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);
});
