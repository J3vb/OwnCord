// Types for tests/unit/ui-strings.test.ts, which drives the scanner directly.

export interface Finding {
  line: number;
  text: string;
  category: "text" | "accessible-name" | "toast" | "error" | "other";
}
export interface Scan {
  files: Record<string, Finding[]>;
  errors: string[];
}
export type Baseline = Record<string, { owner: string; strings: Record<string, number> }>;

export const BASELINE_PATH: string;
export function excludedReason(file: string): string | null;
export function ownerOf(file: string): string;
export function looksLikeProse(text: string): boolean;
export function scanSource(file: string, source: string): { findings: Finding[]; errors: string[] };
export function scanTree(): Scan;
export function loadBaseline(): Baseline | null;
export function compare(
  scan: Scan,
  baseline: Baseline | null,
): {
  added: (Finding & { file: string })[];
  stale: { file: string; text: string; baseline: number; actual: number }[];
};
export function shrink(scan: Scan, baseline: Baseline | null): Baseline;
