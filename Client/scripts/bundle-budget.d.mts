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

/** Relative paths of emitted .js files under `dir` that contain `marker`. */
export function findEmbeddedWasm(dir: string, marker: string): string[];

/** Longest a budget `note` may be. */
export const MAX_NOTE_LENGTH: number;

/** The base64 WASM magic the embedded-WASM check searches for. */
export const WASM_MARKER: string;

/** Problems with the shape of bundle-budgets.json; empty when well formed. */
export function validateBudgets(budgets: unknown): string[];
