// 5.2c: per-server module state must register a session reset (ARCH-012).
//
// The registry only fixes today's list if the next cache cannot be added
// without it. This test reads every src file's syntax tree and flags top-level
// state that looks per-server (a store, a Map, Set, WeakMap or WeakSet, an empty
// array literal, an object literal holding one of those, a mutable `let`
// collection or timer handle) in a file with no TOP-LEVEL call to
// `registerSessionReset` or `onAuthCleared`. A call inside a function (a
// page-scoped hook with a disposer) does not count: it resets nothing at load.
// A flagged binding is either registered or allowlisted with a category and a
// reason in tests/session-state-allowlist.json.
//
// Limits, stated plainly: scalar `let`s (ids, hosts, handles), factory or class
// instances (`new Foo()`, `makeCache()`) and destructured bindings are not
// detected. A file with one top-level registration is exempt as a whole, so
// state beside it is not checked individually. This is a ratchet against the
// common shapes, not a proof.
//
// The allowlist is exact and shrink-only, like lifecycle-ownership.test.ts: an
// entry whose binding no longer exists, or whose file now registers a reset,
// fails with "remove this entry".
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isInstrumented } from "../helpers/instrumented";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

interface AllowEntry {
  file: string;
  binding: string;
  category:
    "app-lifetime" | "host-keyed" | "dom-owned" | "pure-cache" | "transient" | "reset-elsewhere";
  reason: string;
}
const CATEGORIES: ReadonlySet<string> = new Set([
  "app-lifetime",
  "host-keyed",
  "dom-owned",
  "pure-cache",
  "transient",
  "reset-elsewhere",
]);
const allowlist: readonly AllowEntry[] = JSON.parse(
  readFileSync(path.join(clientRoot, "tests/session-state-allowlist.json"), "utf8"),
).entries;

const REGISTRARS = new Set(["registerSessionReset", "onAuthCleared"]);
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
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

/** The two scan tests walk the same tree; parse each file once and share it. */
const parsed = new Map<string, { readonly text: string; readonly sf: ts.SourceFile }>();

function parse(rel: string, text: string): ts.SourceFile {
  const hit = parsed.get(rel);
  if (hit !== undefined && hit.text === text) return hit.sf;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  parsed.set(rel, { text, sf });
  return sf;
}

/** Parsing the whole tree is CPU-bound and slow on a loaded CI runner. */
const SCAN_TIMEOUT_MS = 30_000;

function isRegistrarCall(node: ts.Node | undefined): boolean {
  let n = node;
  while (
    n !== undefined &&
    (ts.isVoidExpression(n) || ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))
  ) {
    n = n.expression;
  }
  return (
    n !== undefined &&
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    REGISTRARS.has(n.expression.text)
  );
}

/** A registrar call at module scope: `void registerSessionReset(...)`, or bound to a const. */
function callsRegistrar(sf: ts.SourceFile): boolean {
  return sf.statements.some((stmt) => {
    if (ts.isExpressionStatement(stmt)) return isRegistrarCall(stmt.expression);
    if (ts.isVariableStatement(stmt)) {
      return stmt.declarationList.declarations.some((d) => isRegistrarCall(d.initializer));
    }
    return false;
  });
}

/** Top-level bindings that look like per-server state. Statements only, never nested. */
function candidates(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const isLet = !isConst;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (ALL_CAPS.test(name)) continue;
      const type = decl.type?.getText(sf) ?? "";
      if (isConst && /\bReadonly(Map|Set|Array)\b/.test(type)) continue;
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
      const isEmptyArray =
        unwrapped !== undefined &&
        ts.isArrayLiteralExpression(unwrapped) &&
        unwrapped.elements.length === 0;
      const isObjectOfCollections =
        unwrapped !== undefined &&
        ts.isObjectLiteralExpression(unwrapped) &&
        unwrapped.properties.some(
          (prop) =>
            ts.isPropertyAssignment(prop) &&
            ts.isNewExpression(prop.initializer) &&
            ts.isIdentifier(prop.initializer.expression) &&
            COLLECTIONS.has(prop.initializer.expression.text),
        );
      const isMutableHolder = isLet && HOLDS_STATE.test(`${type} ${init?.getText(sf) ?? ""}`);
      if (isCollection || isStore || isEmptyArray || isObjectOfCollections || isMutableHolder)
        out.push(name);
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

const texts = sourceFiles.map(
  (rel) => [rel, readFileSync(path.join(srcDir, rel), "utf8")] as const,
);
const skipped = new Set(texts.filter(([, text]) => isInstrumented(text)).map(([rel]) => rel));
const real = new Map(texts.filter(([rel]) => !skipped.has(rel)));

describe("session state ownership", () => {
  it("scans the tree it claims to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(sourceFiles).toContain("stores/auth.store.ts");
  });

  it(
    "every per-server looking top-level binding registers a reset or is allowlisted",
    () => {
      const flags = scan(real);
      const key = (f: Flag): string => `${f.file}|${f.binding}`;
      const allowed = new Set(allowlist.map((e) => `${e.file}|${e.binding}`));
      const unowned = flags
        .filter((f) => !allowed.has(key(f)))
        .map((f) => `${f.file}: ${f.binding}`);
      expect(
        unowned,
        "register a reset with registerSessionReset (lib/net/sessionRegistry.ts), or add the binding to tests/session-state-allowlist.json with a reason",
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "the allowlist only shrinks: every entry still names an unregistered binding",
    () => {
      const flagged = new Set(scan(real).map((f) => `${f.file}|${f.binding}`));
      const stale = allowlist
        .filter((e) => !skipped.has(e.file) && !flagged.has(`${e.file}|${e.binding}`))
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
        expect(CATEGORIES.has(e.category), `${e.file} ${e.binding}: unknown category`).toBe(true);
      for (const e of allowlist)
        expect(e.reason.length, `${e.file} ${e.binding}`).toBeGreaterThan(10);
    },
    SCAN_TIMEOUT_MS,
  );

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
    expect(flagged("const cache = new Map(); void onAuthCleared(() => cache.clear());")).toEqual(
      [],
    );
    // A registrar call inside a function does not reset anything at load.
    expect(
      flagged("const cache = new Map(); function mount() { return onAuthCleared(() => {}); }"),
    ).toEqual(["cache"]);
    expect(
      flagged(
        "const cache = new Map(); const f = () => { registerSessionReset('a:b', () => {}); };",
      ),
    ).toEqual(["cache"]);
    // Readonly exempts a const only.
    expect(flagged("let seen: ReadonlySet<string> = new Set();")).toEqual(["seen"]);
    expect(flagged("const rows: Row[] = [];")).toEqual(["rows"]);
    expect(flagged("const rows = [];")).toEqual(["rows"]);
    expect(flagged("const FIXED = [1, 2];")).toEqual([]);
    expect(flagged("const state = { byId: new Map<number, string>(), n: 0 };")).toEqual(["state"]);
    expect(flagged("const weak = new WeakMap<object, string>();")).toEqual(["weak"]);
    expect(flagged("const weakSet = new WeakSet<object>();")).toEqual(["weakSet"]);
  });
});
