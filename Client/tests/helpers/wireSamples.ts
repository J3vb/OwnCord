// A smallest valid value for a shape of the generated shape table
// (src/lib/net/wireShapes.ts): required fields only, lists and maps empty.

import { FRAME_SHAPES, SHAPES, type Shape } from "../../src/lib/net/wireShapes";

const PRIMITIVES: readonly unknown[] = ["x", 1, true, null, null];

function sample(table: readonly Shape[], ref: number): unknown {
  const shape = table[ref]!;
  if (typeof shape === "number") return PRIMITIVES[shape];
  switch (shape[0]) {
    case 0:
      return [];
    case 1:
      return {};
    case 2:
      return Object.fromEntries(shape[1].map((name, i) => [name, sample(table, shape[2][i]!)]));
    case 3:
      return sample(table, shape[1]!);
    default:
      return null;
  }
}

/** The server frame types the shape table checks. */
export const SHAPED_FRAME_TYPES = Object.keys(FRAME_SHAPES);

/** A smallest payload that passes the shape check for `type`. */
export function samplePayload(type: string): Record<string, unknown> {
  return sample(SHAPES, FRAME_SHAPES[type] as number) as Record<string, unknown>;
}
