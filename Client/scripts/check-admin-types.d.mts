// Types for tests/contract/server-admin-static-types.test.ts, which drives the
// admin-panel type-check ratchet directly.

export interface TypeDiagnostic {
  /** Path relative to Server/, e.g. admin/static/js/core.js. */
  file: string;
  /** TypeScript diagnostic code, e.g. 2339. */
  code: number;
  message: string;
}
export interface Scan {
  diagnostics: TypeDiagnostic[];
  /** Config-level errors (no file): the program could not be built. */
  configErrors: string[];
}
/** Per-file identity counts, the baseline's shape. */
export type Baseline = { _doc?: string; files: Record<string, Record<string, number>> };

export const CONFIG_PATH: string;
export const BASELINE_PATH: string;
export function scanTree(): Scan;
export function identity(d: TypeDiagnostic): string;
export function counts(diagnostics: TypeDiagnostic[]): Record<string, Record<string, number>>;
export function loadBaseline(): Baseline | null;
export function compare(
  scan: Scan,
  baseline: Baseline | null,
): {
  added: { file: string; identity: string; actual: number; baseline: number }[];
  stale: { file: string; identity: string; baseline: number; actual: number }[];
};
export function shrink(scan: Scan, baseline: Baseline | null): Baseline;
