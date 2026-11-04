// Types for tests/unit/complexity-baseline.test.ts, which imports the .mjs
// module so the test and the update script measure the tree the same way.

/** `{ "<file under src/>": { "<function key>": [values, highest first] } }`. */
export type Section = Record<string, Record<string, number[]>>;

export interface Sections {
  complexity: Section;
  depth: Section;
}

export const BASELINE_PATH: string;
export const LIMITS: { complexity: number; depth: number };
export function readBaseline(): Sections;
export function measureTree(): Promise<Sections>;
export function sortSections(sections: Sections): Sections;
export function compareSections(
  tree: Sections,
  baseline: Sections,
): { grown: string[]; stale: string[] };
export function countFunctions(section: Section): number;
