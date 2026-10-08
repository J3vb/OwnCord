// B7-11a: the ownership inventory (R1-R4).
//
// A grep counts `addEventListener` calls; it cannot tell an owned listener from
// a leak. The three fixed findings that motivated this milestone (OC-0335,
// OC-0336, OC-0365) each passed a "does it pass a signal" check while being
// registered on a signal that lived longer than the thing it served. So this
// test classifies every site from the syntax tree and fails on a site that is
// not owned and not on an exact allowlist.
//
// The allowlists are exact and shrink-only: an allowlisted site that no longer
// exists fails with "remove this entry", the same ratchet as the cycle ceiling.
// Entries are keyed by file + receiver + event (R1) or file + enclosing
// function (R3, R4), never by line number, so an unrelated edit does not churn
// them. `b7-11-lifecycle-ownership-long-session.plan.md` owns the category of
// each entry; 11b empties the component/per-render entries, 11c the findings.
//
// The runtime soak (tests/e2e/support/lifecycle-probe.ts) is the proof this
// lexical inventory is only the ratchet for.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

// R1's long-lived targets, matched by name. A MediaQueryList or a store-held
// target is out of scope; the soak's listener counter is what would see one.
const LONG_LIVED = /^(window|document|document\.body|document\.documentElement|navigator\..*)$/;

// The two lifecycle primitives. R4 exempts them by rule, not by allowlist.
const PRIMITIVE_FILES = new Set(["lib/disposable.ts", "lib/sessionScope.ts"]);

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter(
    (entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"),
  )
  .map((entry) => entry.split(path.sep).join("/"))
  .toSorted();

interface R1Entry {
  file: string;
  receiver: string;
  event: string;
  category: "app-lifetime" | "per-mount";
  reason: string;
}
interface R3Entry {
  file: string;
  fn: string;
  reason: string;
}
interface R4Entry {
  file: string;
  fn: string;
  category: "component-lifetime" | "per-render-child" | "cancellation-token";
  reason: string;
}

// R1: long-lived-target listeners without `signal`/`once: true`.
const R1_ALLOWLIST: readonly R1Entry[] = [
  {
    file: "components/message-list/attachments.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/formatting.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "components/message-list/media.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "components/message-list/renderers.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/channel-mutes.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/channel-mutes.ts",
    receiver: "window",
    event: "storage",
    category: "app-lifetime",
    reason: "app-lifetime cross-tab storage listener installed once at module load",
  },
  {
    file: "lib/deviceManager.ts",
    receiver: "navigator.mediaDevices",
    event: "devicechange",
    category: "per-mount",
    reason:
      "device-change listener with a start/stop pair (startDeviceChangeListener); stays hand-paired because device-manager.test.ts pins the bare add/remove call shape and no assertion is edited. Not a leak: stop removes it, and the soak's listener count is flat across voice joins. Kept by firstmate decision during 11c (B1): hand-paired per-mount site; moving it would require editing device-manager.test.ts assertions. R1 therefore ends at 17, a deviation from the plan's floor of 16",
  },
  {
    file: "lib/logger.ts",
    receiver: "window",
    event: "owncord:pref-change",
    category: "app-lifetime",
    reason: "app-lifetime preference listener installed once at module load",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "document",
    event: "visibilitychange",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "window",
    event: "blur",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/media-visibility.ts",
    receiver: "window",
    event: "focus",
    category: "app-lifetime",
    reason: "once-guarded app-lifetime visibility listener (ensureVisibilityListener)",
  },
  {
    file: "lib/safe-render.ts",
    receiver: "window",
    event: "error",
    category: "app-lifetime",
    reason: "global error handler installed once at startup (installGlobalErrorHandlers)",
  },
  {
    file: "lib/safe-render.ts",
    receiver: "window",
    event: "unhandledrejection",
    category: "app-lifetime",
    reason: "global rejection handler installed once at startup (installGlobalErrorHandlers)",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "contextmenu",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "keydown",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "document",
    event: "click",
    category: "app-lifetime",
    reason: "app-bootstrap singleton at module load",
  },
  {
    file: "main.ts",
    receiver: "window",
    event: "beforeunload",
    category: "app-lifetime",
    reason: "app-bootstrap best-effort voice_leave at module load",
  },
];
// R3: discarded `setTimeout` handles (expression statement or `void`).
const R3_ALLOWLIST: readonly R3Entry[] = [
  {
    file: "components/Toast.ts",
    fn: "removeToast",
    reason: "self-bounded: fallback removal after transitionend; touches only the node it removes",
  },
  {
    file: "components/message-list/content-parser.ts",
    fn: "renderParsedCodeBlock",
    reason:
      "self-bounded: copy-button label reset on a node the code block owns; renderMessageContent takes no owner to clear it from",
  },
  {
    file: "components/message-list/content-parser.ts",
    fn: "renderParsedCodeBlock",
    reason:
      "self-bounded: copy-button label reset on a node the code block owns; renderMessageContent takes no owner to clear it from",
  },
];
// R4: every `new AbortController` outside the two primitives.
const R4_ALLOWLIST: readonly R4Entry[] = [
  {
    file: "components/SearchOverlay.ts",
    fn: "executeSearch",
    category: "cancellation-token",
    reason: "owner: the next search (query, scope or Load more), which aborts this one",
  },
  {
    file: "components/settings/ConnectionDiagnosticsPanel.ts",
    fn: "createConnectionDiagnosticsPanel",
    category: "cancellation-token",
    reason: "owner: stop() and the next test run, which abort this attempt",
  },
  {
    file: "lib/api.ts",
    fn: "doFetch",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/api.ts",
    fn: "getHealth",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/api.ts",
    fn: "getServerInfo",
    category: "cancellation-token",
    reason: "owner: the SessionScope that aborts the transport (api.ts owner.addCleanup)",
  },
  {
    file: "lib/profiles.ts",
    fn: "pingHost",
    category: "cancellation-token",
    reason: "owner: the per-attempt HEALTH_TIMEOUT_MS timer that aborts it",
  },
  {
    file: "lib/roomEventHandlers.ts",
    fn: "handleDisconnected",
    category: "cancellation-token",
    reason: "owner: the next attempt, which aborts this one",
  },
  {
    file: "pages/main-page/ChannelController.ts",
    fn: "mountChannel",
    category: "cancellation-token",
    reason:
      "owner: the next channel switch (destroyChannel), which aborts the previous channel's work. Not forked from the SessionScope in 11b: a fork would also cancel in-flight channel loads at logout, where today they run to a guarded no-op. Not a leak: MainPage teardown aborts it right after logout and the soak's AbortController count is flat. Kept a token by firstmate decision during 11c (C1)",
  },
];

/** A found site: its allowlist key and a readable `file:line` descriptor. */
type Site = readonly [key: string, where: string];

/** The name of the nearest enclosing function or arrow assigned to a binding. */
function enclosingFunction(sf: ts.SourceFile, node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.getText(sf);
    if (
      ts.isVariableDeclaration(current) &&
      current.name &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    )
      return current.name.getText(sf);
    if (
      ts.isPropertyAssignment(current) &&
      current.name &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    )
      return current.name.getText(sf);
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sf);
    current = current.parent;
  }
  return "<top>";
}

function calleeName(node: ts.CallExpression): string {
  const c = node.expression;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isIdentifier(c)) return c.text;
  return "";
}

/**
 * R2: a `setInterval` handle must be kept and cleared in its own file. The
 * handle is the declared variable, the assigned target (`this.x = …`), or the
 * receiver of `map.set(k, setInterval(…))`; the site passes only when some
 * `clearInterval(<arg>)` in the file mentions that exact expression text
 * (`clearInterval(this.x)`, `clearInterval(map.get(k))`), so a bare `x` does
 * not clear `this.x`. Any other shape (discarded, returned, passed on) fails.
 */
function r2Violations(sf: ts.SourceFile): Site[] {
  const rel = sf.fileName;
  const cleared = new Set<string>();
  const intervals: ts.CallExpression[] = [];
  const mentions = (n: ts.Node): void => {
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) cleared.add(n.getText(sf));
    ts.forEachChild(n, mentions);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "setInterval") intervals.push(node);
      if (name === "clearInterval" && node.arguments[0]) mentions(node.arguments[0]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const out: Site[] = [];
  for (const node of intervals) {
    const p = node.parent;
    let handle: string | undefined;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) handle = p.name.text;
    else if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === node
    )
      handle = p.left.getText(sf);
    else if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      p.expression.name.text === "set" &&
      p.arguments[1] === node
    )
      handle = p.expression.expression.getText(sf);
    if (handle !== undefined && cleared.has(handle)) continue;
    const fn = enclosingFunction(sf, node);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push([
      `${rel}|${fn}`,
      `${rel}:${line} setInterval ${handle === undefined ? "handle not kept" : `${handle} never cleared in file`}`,
    ]);
  }
  return out;
}

const r1Found: Site[] = [];
const r2Found: Site[] = [];
const r3Found: Site[] = [];
const r4Found: Site[] = [];
let bareListeners = 0;
const bareListenerFiles = new Set<string>();
let rafCount = 0;
let cancelRafCount = 0;
const observerFiles = new Set<string>();
const nativeListen: string[] = [];

for (const rel of sourceFiles) {
  const sf = ts.createSourceFile(
    rel,
    readFileSync(path.join(srcDir, rel), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === "addEventListener") {
        const opts = node.arguments[2] ? node.arguments[2].getText(sf) : "";
        if (!/\bsignal\b/.test(opts) && !/\bonce\s*:\s*true/.test(opts)) {
          bareListeners++;
          bareListenerFiles.add(rel);
          const target = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText(sf)
            : "";
          if (LONG_LIVED.test(target)) {
            const eventArg = node.arguments[0]!;
            const event = ts.isStringLiteralLike(eventArg) ? eventArg.text : eventArg.getText(sf);
            r1Found.push([
              `${rel}|${target}|${event}`,
              `${rel}:${line(node)} ${target} "${event}"`,
            ]);
          }
        }
      }
      if (name === "setTimeout" || name === "setInterval") {
        const discarded = ts.isExpressionStatement(node.parent) || ts.isVoidExpression(node.parent);
        if (name === "setTimeout" && discarded) {
          r3Found.push([
            `${rel}|${enclosingFunction(sf, node)}`,
            `${rel}:${line(node)} discarded setTimeout in ${enclosingFunction(sf, node)}`,
          ]);
        }
      }
      if (name === "requestAnimationFrame") rafCount++;
      if (name === "cancelAnimationFrame") cancelRafCount++;
      if (name === "listen" && rel.startsWith("platform/"))
        nativeListen.push(`${rel}:${line(node)}`);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "AbortController" &&
      !PRIMITIVE_FILES.has(rel)
    ) {
      const fn = enclosingFunction(sf, node);
      r4Found.push([`${rel}|${fn}`, `${rel}:${line(node)} new AbortController() in ${fn}`]);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["IntersectionObserver", "ResizeObserver", "MutationObserver"].includes(node.expression.text)
    ) {
      observerFiles.add(rel);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  r2Found.push(...r2Violations(sf));
}

/**
 * Multiset compare: every found site must be covered by an entry, and every
 * entry must be used by a site. A duplicate site needs a duplicate entry, so
 * the lists cannot silently under- or over-count.
 */
function compare(label: string, found: readonly Site[], allowed: readonly string[]): void {
  const remaining = new Map<string, number>();
  for (const key of allowed) remaining.set(key, (remaining.get(key) ?? 0) + 1);

  const unowned: string[] = [];
  for (const [key, where] of found) {
    const left = remaining.get(key) ?? 0;
    if (left === 0) unowned.push(where);
    else remaining.set(key, left - 1);
  }
  expect(unowned, `${label}: add these sites to the allowlist or own them`).toEqual([]);

  const stale = [...remaining]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} (${count} unused)`);
  expect(stale, `${label}: remove these allowlist entries — the sites are gone`).toEqual([]);
}

const keys = (entries: readonly { file: string; fn: string }[]) =>
  entries.map((e) => `${e.file}|${e.fn}`);

const check = (src: string) =>
  r2Violations(ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true)).map((v) => v[1]);

describe("lifecycle ownership inventory (R1-R4)", () => {
  it("scans the tree it claims to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(200);
    expect(sourceFiles).toContain("main.ts");
  });

  it("R1: every long-lived-target listener carries a signal or once, or is allowlisted", () => {
    compare(
      "R1",
      r1Found,
      R1_ALLOWLIST.map((e) => `${e.file}|${e.receiver}|${e.event}`),
    );
  });

  it("R2: every setInterval keeps its handle and is cleared in its own file", () => {
    compare("R2", r2Found, []);
  });

  it("R2 flags an uncleared interval in a file that clears a different one", () => {
    expect(
      check("let a = setInterval(f, 1);\nconst b = setInterval(g, 1);\nclearInterval(a);"),
    ).toEqual(["x.ts:2 setInterval b never cleared in file"]);
    expect(check("setInterval(f, 1);\nclearInterval(a);")).toEqual([
      "x.ts:1 setInterval handle not kept",
    ]);
    expect(check("const h = setInterval(f, 1); addCleanup(() => clearInterval(h));")).toEqual([]);
    expect(
      check(
        "class C { go() { this.timers.set(id, setInterval(f, 1)); } stop() { clearInterval(this.timers.get(id)); } }",
      ),
    ).toEqual([]);
    expect(
      check("class C { s() { this.t = setInterval(f, 1); } e() { clearInterval(this.t); } }"),
    ).toEqual([]);
    // a bare `t` is a different binding from the `this.t` property
    expect(check("let t; function s() { this.t = setInterval(f, 1); } clearInterval(t);")).toEqual([
      "x.ts:1 setInterval this.t never cleared in file",
    ]);
    // a handle that is only passed on is not owned, even if the receiver is mentioned
    expect(check("owner.enqueue(setInterval(f, 1)); clearInterval(owner.current);")).toEqual([
      "x.ts:1 setInterval handle not kept",
    ]);
    // the handle must be the stored value (2nd argument of set), not the key
    expect(check("m.set(setInterval(f, 1), 1); clearInterval(m.get(k));")).toEqual([
      "x.ts:1 setInterval handle not kept",
    ]);
  });

  it("R3: every setTimeout handle is kept, or the site is allowlisted", () => {
    compare("R3", r3Found, keys(R3_ALLOWLIST));
  });

  it("R4: every AbortController is a primitive or allowlisted", () => {
    compare("R4", r4Found, keys(R4_ALLOWLIST));
  });

  it("the allowlist categories are at their 11b floors (16 app-lifetime, 1 per-mount)", () => {
    expect(R1_ALLOWLIST.filter((e) => e.category === "app-lifetime")).toHaveLength(16);
    expect(R1_ALLOWLIST.filter((e) => e.category === "per-mount")).toHaveLength(1);
    expect(R4_ALLOWLIST.filter((e) => e.category === "cancellation-token")).toHaveLength(8);
  });

  it("prints the informational counts", () => {
    const report = {
      bareListeners,
      bareListenerFiles: bareListenerFiles.size,
      rafCount,
      cancelRafCount,
      observerFiles: [...observerFiles].toSorted(),
      nativeListen,
    };
    // console.log is not guarded (only warn/error are); this is a record, not a
    // failure signal.
    console.log("lifecycle inventory counts:", JSON.stringify(report));
    expect(report.bareListeners).toBeGreaterThan(0);
  });
});
