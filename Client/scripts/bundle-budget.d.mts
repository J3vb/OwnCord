// Types for tests/unit/bundle-budget.test.ts, which drives the pure closure
// helpers directly. The CLI half stays untyped — it only runs as a program.

/** A subset of Vite's manifest entry shape the helpers read. */
export interface ManifestNode {
  file?: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
  name?: string;
}

export type Manifest = Record<string, ManifestNode>;

/** The JS files statically reachable from the entry (`index.html`). Throws on
 *  an import edge with no manifest node. */
export function startupClosureFiles(manifest: Manifest): Set<string>;

/** Every emitted stylesheet, deduplicated by file. */
export function allCssFiles(manifest: Manifest): Set<string>;
