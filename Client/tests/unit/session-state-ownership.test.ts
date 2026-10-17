// 5.2c: per-server module state must register a session reset (ARCH-012).
//
// The registry only fixes today's list if the next cache cannot be added
// without it. This test reads every src file's syntax tree and flags top-level
// state that looks per-server (a store, a Map or Set, a mutable collection or
// timer handle) in a file that never calls `registerSessionReset` or
// `onAuthCleared`. A flagged binding is either registered or allowlisted with a
// reason in tests/session-state-allowlist.json.
//
// The allowlist is exact and shrink-only, like lifecycle-ownership.test.ts: an
// entry whose binding no longer exists, or whose file now registers a reset,
// fails with "remove this entry".
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

interface AllowEntry {
  file: string;
  binding: string;
  category:
    "app-lifetime" | "host-keyed" | "dom-owned" | "pure-cache" | "transient" | "reset-elsewhere";
  reason: string;
}
const allowlist: readonly AllowEntry[] = JSON.parse(
  readFileSync(path.join(clientRoot, "tests/session-state-allowlist.json"), "utf8"),
).entries;

const REGISTRARS = new Set(["registerSessionReset", "onAuthCleared"]);
const COLLECTIONS = new Set(["Map", "Set"]);
const ALL_CAPS = /^[A-Z][A-Z0-9_]*$/;
// A mutable `let` is per-server when its type or initializer says it holds a
// collection or a timer.
const HOLDS_STATE = /\b(Map|Set|Array|Timeout|Interval)\b|\[\]|setTimeout|setInterval/;

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"),
  )
  .map((entry) => entry.split(path.sep).join("/"))
  .toSorted();

function parse(rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
}

function callsRegistrar(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      REGISTRARS.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Top-level bindings that look like per-server state. Statements only, never nested. */
function candidates(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isLet = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0;
    const isVar = (stmt.declarationList.flags & ts.NodeFlags.Const) === 0 && !isLet;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ALL_CAPS.test(name)) continue;
      const type = decl.type?.getText(sf) ?? "";
      if (/\bReadonly(Map|Set|Array)\b/.test(type)) continue;
      const init = decl.initializer;
      let unwrapped = init;
      while (
        unwrapped !== undefined &&
        (ts.isAsExpression(unwrapped) ||
          ts.isParenthesizedExpression(unwrapped) ||
          ts.isSatisfiesExpression(unwrapped))
      ) {
        unwrapped = unwrapped.expression;
      }
      const isCollection =
        unwrapped !== undefined &&
        ts.isNewExpression(unwrapped) &&
        ts.isIdentifier(unwrapped.expression) &&
        COLLECTIONS.has(unwrapped.expression.text);
      const isStore =
        unwrapped !== undefined &&
        ts.isCallExpression(unwrapped) &&
        ts.isIdentifier(unwrapped.expression) &&
        unwrapped.expression.text === "createStore";
      const isMutableHolder =
        (isLet || isVar) && HOLDS_STATE.test(`${type} ${init?.getText(sf) ?? ""}`);
      if (isCollection || isStore || isMutableHolder) out.push(name);
    }
  }
  return out;
}

interface Flag {
  file: string;
  binding: string;
}

function scan(files: ReadonlyMap<string, string>): Flag[] {
  const flags: Flag[] = [];
  for (const [rel, text] of files) {
    const sf = parse(rel, text);
    if (callsRegistrar(sf)) continue;
    for (const binding of candidates(sf)) flags.push({ file: rel, binding });
  }
  return flags;
}

const real = new Map(
  sourceFiles.map((rel) => [rel, readFileSync(path.join(srcDir, rel), "utf8")] as const),
);

describe("session state ownership", () => {
  it("scans the tree it claims to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(sourceFiles).toContain("stores/auth.store.ts");
  });

  it("every per-server looking top-level binding registers a reset or is allowlisted", () => {
    const flags = scan(real);
    const key = (f: Flag): string => `${f.file}|${f.binding}`;
    const allowed = new Set(allowlist.map((e) => `${e.file}|${e.binding}`));
    const unowned = flags.filter((f) => !allowed.has(key(f))).map((f) => `${f.file}: ${f.binding}`);
    expect(
      unowned,
      "register a reset with registerSessionReset (lib/sessionRegistry.ts), or add the binding to tests/session-state-allowlist.json with a reason",
    ).toEqual([]);
  });

  it("the allowlist only shrinks: every entry still names an unregistered binding", () => {
    const flagged = new Set(scan(real).map((f) => `${f.file}|${f.binding}`));
    const stale = allowlist
      .filter((e) => !flagged.has(`${e.file}|${e.binding}`))
      .map((e) => {
        const text = real.get(e.file);
        const why =
          text === undefined
            ? "file is gone"
            : callsRegistrar(parse(e.file, text))
              ? "file now registers a reset"
              : "binding is gone";
        return `${e.file}: ${e.binding} (${why}); remove this entry`;
      });
    expect(stale).toEqual([]);
    for (const e of allowlist)
      expect(e.reason.length, `${e.file} ${e.binding}`).toBeGreaterThan(10);
  });

  it("flags an unregistered cache and passes a registered one", () => {
    const flagged = (src: string): string[] => scan(new Map([["x.ts", src]])).map((f) => f.binding);
    expect(flagged("const cache = new Map<number, string>();")).toEqual(["cache"]);
    expect(flagged("export const s = createStore<number>(0);")).toEqual(["s"]);
    expect(flagged("let timer: ReturnType<typeof setTimeout> | null = null;")).toEqual(["timer"]);
    expect(flagged("let items: string[] = [];")).toEqual(["items"]);
    expect(flagged("const LIMITS = new Map<string, number>();")).toEqual([]);
    expect(flagged("const seen: ReadonlySet<string> = new Set();")).toEqual([]);
    expect(flagged("function f() { const local = new Map(); return local; }")).toEqual([]);
    expect(
      flagged(
        'const cache = new Map(); registerSessionReset("m:cache", () => { cache.clear(); });',
      ),
    ).toEqual([]);
    expect(flagged("const cache = new Map(); onAuthCleared(() => cache.clear());")).toEqual([]);
  });
});
