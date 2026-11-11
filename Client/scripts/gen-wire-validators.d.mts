// Types for tests/unit/wireShapesGen.test.ts, which imports the generator so
// the drift check and the `npm run gen:wire` command build the same table.

/** One table entry: a primitive shape number, or `[kind, ...]` as wireShapes.ts describes. */
export type TableEntry = number | readonly unknown[] | null;

export interface WireTables {
  /** Entry n describes shape number n. */
  shapes: TableEntry[];
  /** Wire frame type to the shape number of its payload. */
  frames: Record<string, number>;
  /** The REST table: entry n describes shape number n of `rest`. */
  restShapes: TableEntry[];
  /** REST reply name to the shape number of its body, in `restShapes`. */
  rest: Record<string, number>;
}

export interface GenerateOptions {
  unionsFile?: string;
  restFile?: string;
  outFile?: string;
}

export const UNIONS_FILE: string;
export const REST_FILE: string;
export const OUT_FILE: string;
export const REST_OUT_FILE: string;
export function buildTables(options?: GenerateOptions): WireTables;
export function renderModule(tables: WireTables): Promise<string>;
export function renderRestModule(tables: WireTables): Promise<string>;
export function generate(options?: GenerateOptions): Promise<string>;
export function generateRest(options?: GenerateOptions): Promise<string>;
