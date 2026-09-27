// ARCH-06: the client dependency direction is one-way — `lib/`, `stores/`,
// `features/` and `platform/` are lower layers and must not import the UI
// (`components/`, `pages/`). When they did, a `lib/` module pulled a component
// file (and whatever it statically reaches) into the startup closure, and a
// store writer could live in `pages/` where the single-writer rule cannot see
// it. `SidebarDmHelpers`' DM mutator and `components/settings/helpers`'
// preferences/theme helpers were moved down for exactly this reason.
//
// The check is lexical: an `import type` has no runtime edge, and a dynamic
// `import()` is the sanctioned lazy seam (a feature may lazily land a modal's
// UI), so neither is a violation. A remaining static value import is listed
// below with its reason, and the list is exact and shrink-only: a stale entry
// fails.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

// Lower layers that must not statically reach the UI layer at runtime.
const LOWER_LAYERS = new Set(["lib", "stores", "features", "platform"]);
// The UI layer they must not import.
const UI_LAYERS = new Set(["components", "pages"]);

const ALIASES: Record<string, string> = {
  "@lib/": "src/lib/",
  "@stores/": "src/stores/",
  "@components/": "src/components/",
  "@pages/": "src/pages/",
};

interface AllowedEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

// Static value imports of a UI module from a lower layer that survive
// ARCH-06's three moves (preferences, formatting, the DM mutator) and are
// deliberate. Exact and shrink-only: a stale entry fails.
const ALLOWED: readonly AllowedEdge[] = [
  {
    from: "lib/avatar.ts",
    to: "components/message-list/attachments",
    reason:
      "attachments.ts is the leaf every renderer imports; it owns the authenticated image fetch (fetchImageAsDataUrl), resolveServerUrl and isSafeUrl that avatar needs. Breaking this edge is the eager notifications->avatar->attachments startup chain PERF-07 cuts, not a layering fix ARCH-06 owns.",
  },
  {
    from: "features/messaging/wsHandlers.ts",
    to: "components/message-list/reaction-tooltip",
    reason:
      "invalidateReactionUsers is the reaction-tooltip's cache invalidator; the messaging WS handler calls it on reaction_update. Moving it down is a messaging-component extraction, out of ARCH-06's scope.",
  },
];

/** Every static value import of `file`: `import … from "m"` and
 *  `export … from "m"` (a re-export is still a runtime edge), where the
 *  clause is not `import type`/`export type`. Dynamic `import("m")` is not a
 *  top-level statement, so it is naturally excluded. */
function staticValueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const typeOnly =
      ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true;
    const exportTypeOnly = ts.isExportDeclaration(statement) && statement.isTypeOnly === true;
    if (typeOnly || exportTypeOnly) continue;
    const { moduleSpecifier } = statement;
    if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Resolve a specifier to a `src/`-relative module path, or null if it is a
 *  package or something this check does not own. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const alias = Object.keys(ALIASES).find((prefix) => spec.startsWith(prefix));
  const abs = alias
    ? path.join(clientRoot, ALIASES[alias]!, spec.slice(alias.length))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : null;
  if (abs === null) return null;
  return path.relative(srcDir, abs.replace(/\.ts$/, "")).split(path.sep).join("/");
}

function layerOf(relPath: string): string {
  return relPath.split("/")[0]!;
}

interface Edge {
  readonly from: string;
  readonly to: string;
}

// Parse once: the coverage run makes per-test module walks slow enough to time
// out, and both assertions read the same edge list.
const EDGES: readonly Edge[] = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .flatMap((entry) => {
    const file = path.join(srcDir, entry);
    const from = entry.split(path.sep).join("/");
    return staticValueImports(file).flatMap((spec) => {
      const to = resolveSpecifier(file, spec);
      return to === null ? [] : [{ from, to }];
    });
  });

describe("client import direction (ARCH-06)", () => {
  it("a lower layer imports no UI module (static runtime import)", () => {
    const violations = EDGES.filter(
      ({ from, to }) =>
        LOWER_LAYERS.has(layerOf(from)) &&
        UI_LAYERS.has(layerOf(to)) &&
        !ALLOWED.some((e) => e.from === from && e.to === to),
    ).map(({ from, to }) => `${from} -> ${to}`);
    expect(violations.toSorted()).toEqual([]);
  });

  it("every allowlisted edge still exists (shrink-only)", () => {
    const present = new Set(EDGES.map(({ from, to }) => `${from} -> ${to}`));
    const stale = ALLOWED.map((e) => `${e.from} -> ${e.to}`).filter((edge) => !present.has(edge));
    expect(stale, `remove these stale allowlist entries: ${stale.join(", ")}`).toEqual([]);
  });
});
