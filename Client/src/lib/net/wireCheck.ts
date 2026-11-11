// Checks a decoded server value against a shape table: wireShapes.ts for frames,
// restShapes.ts for REST replies (generated from the payload types; the table
// format is described there).
//
// The check answers one question, "does this value have the shape its type
// promises?", and is deliberately forgiving about everything a newer server
// may add: extra fields pass, and a string or number field accepts any string
// or number (a literal union in the type is checked as its base type).
//
// A fault names the field, never the value: frames carry chat text and the
// fault ends up in logs. A path is field names joined by dots, with `[]` for
// the items of an array and `{}` for the values of a map, for example
// `members[].avatar`.
//
// The success path allocates nothing: `matches` only returns a boolean. Only
// when it fails does `locate` walk the same value again to find the field.

import type { Shape } from "./wireShapes";
import type { RestReplyShapes } from "./restReplies";

export interface WireFault {
  /** The failing field, by name only. Empty for the payload itself. */
  readonly path: string;
  /** What the field should have been, for example `string` or `string (missing)`. */
  readonly expected: string;
}

const STRING = 0;
const NUMBER = 1;
const BOOLEAN = 2;
const NULL = 3;

type Table = readonly Shape[];
type ObjectShape = Extract<Shape, readonly [2, ...unknown[]]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesPrimitive(value: unknown, kind: number): boolean {
  switch (kind) {
    case STRING:
      return typeof value === "string";
    case NUMBER:
      return typeof value === "number";
    case BOOLEAN:
      return typeof value === "boolean";
    case NULL:
      return value === null;
    default:
      return true;
  }
}

function matchesFields(
  table: Table,
  obj: Record<string, unknown>,
  names: readonly string[],
  refs: readonly number[],
  mustExist: boolean,
): boolean {
  for (let i = 0; i < names.length; i++) {
    const field = obj[names[i] as string];
    if (field === undefined) {
      if (mustExist) return false;
      continue;
    }
    if (!matches(table, field, refs[i] as number)) return false;
  }
  return true;
}

function matchesItems(table: Table, value: unknown, item: number): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!matches(table, value[i], item)) return false;
  }
  return true;
}

function matchesValues(table: Table, value: unknown, item: number): boolean {
  if (!isObject(value)) return false;
  for (const key in value) {
    if (!matches(table, value[key], item)) return false;
  }
  return true;
}

function matchesAny(table: Table, value: unknown, alternatives: readonly number[]): boolean {
  for (let i = 1; i < alternatives.length; i++) {
    if (matches(table, value, alternatives[i] as number)) return true;
  }
  return false;
}

/** Whether `value` has shape number `ref`. Allocation free. */
export function matches(table: Table, value: unknown, ref: number): boolean {
  const shape = table[ref];
  if (shape === undefined) return true;
  if (typeof shape === "number") return matchesPrimitive(value, shape);
  switch (shape[0]) {
    case 0:
      return matchesItems(table, value, shape[1]);
    case 1:
      return matchesValues(table, value, shape[1]);
    case 2:
      return (
        isObject(value) &&
        matchesFields(table, value, shape[1], shape[2], true) &&
        (shape[3] === undefined || matchesFields(table, value, shape[3], shape[4] ?? [], false))
      );
    case 3:
      return matchesAny(table, value, shape);
    default:
      return value === null || matches(table, value, shape[1]);
  }
}

const PRIMITIVE_NAMES = ["string", "number", "boolean", "null", "unknown"];

/** A short description of what shape `ref` expects, for a fault's `expected`. */
function describe(table: Table, ref: number, depth: number): string {
  const shape = table[ref];
  if (shape === undefined) return "unknown";
  if (typeof shape === "number") return PRIMITIVE_NAMES[shape] ?? "unknown";
  switch (shape[0]) {
    case 0:
      return "array";
    case 1:
    case 2:
      return "object";
    case 3: {
      if (depth > 1) return "union";
      const names = new Set<string>();
      for (let i = 1; i < shape.length; i++)
        names.add(describe(table, shape[i] as number, depth + 1));
      return [...names].join(" | ");
    }
    default:
      return `${describe(table, shape[1], depth + 1)} | null`;
  }
}

function join(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function jsKind(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** The one alternative of a union that could have accepted `value`'s JS kind, if exactly one. */
function onlyAlternativeFor(table: Table, value: unknown, alternatives: readonly number[]): number {
  const kind = jsKind(value);
  let found = -1;
  for (const ref of alternatives) {
    const shape = table[ref];
    const alt =
      shape === undefined
        ? "unknown"
        : typeof shape === "number"
          ? (PRIMITIVE_NAMES[shape] ?? "unknown")
          : shape[0] === 0
            ? "array"
            : "object";
    if (alt === kind) {
      if (found !== -1) return -1;
      found = ref;
    }
  }
  return found;
}

function locateField(
  table: Table,
  obj: Record<string, unknown>,
  names: readonly string[],
  refs: readonly number[],
  mustExist: boolean,
  path: string,
): WireFault | null {
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    const ref = refs[i] as number;
    const field = obj[name];
    if (field === undefined) {
      if (mustExist)
        return { path: join(path, name), expected: `${describe(table, ref, 0)} (missing)` };
      continue;
    }
    const fault = locate(table, field, ref, join(path, name));
    if (fault !== null) return fault;
  }
  return null;
}

function locateItems(table: Table, value: unknown, item: number, path: string): WireFault | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const fault = locate(table, entry, item, `${path}[]`);
    if (fault !== null) return fault;
  }
  return null;
}

function locateValues(table: Table, value: unknown, item: number, path: string): WireFault | null {
  if (!isObject(value)) return null;
  for (const key in value) {
    const fault = locate(table, value[key], item, `${path}{}`);
    if (fault !== null) return fault;
  }
  return null;
}

function locateObject(
  table: Table,
  value: unknown,
  shape: ObjectShape,
  path: string,
): WireFault | null {
  if (!isObject(value)) return null;
  return (
    locateField(table, value, shape[1], shape[2], true, path) ??
    locateField(table, value, shape[3] ?? [], shape[4] ?? [], false, path)
  );
}

/** The first fault of `value` against shape `ref`, or null when it matches. */
function locate(table: Table, value: unknown, ref: number, path: string): WireFault | null {
  if (matches(table, value, ref)) return null;
  const shape = table[ref];
  const here: WireFault = { path, expected: describe(table, ref, 0) };
  if (shape === undefined || typeof shape === "number") return here;
  switch (shape[0]) {
    case 0:
      return locateItems(table, value, shape[1], path) ?? here;
    case 1:
      return locateValues(table, value, shape[1], path) ?? here;
    case 2:
      return locateObject(table, value, shape, path) ?? here;
    case 3: {
      const only = onlyAlternativeFor(table, value, shape.slice(1));
      return only === -1 ? here : (locate(table, value, only, path) ?? here);
    }
    default:
      return value === null ? here : (locate(table, value, shape[1], path) ?? here);
  }
}

/** Checks `value` against shape number `ref` of `table`. Exposed for tests with their own table. */
export function checkAgainst(table: Table, ref: number, value: unknown): WireFault | null {
  return matches(table, value, ref) ? null : locate(table, value, ref, "");
}

/**
 * The frame table (the exports of wireShapes.ts). It loads with the signed-in
 * session code, not at startup: app/sessionDispatcher.ts installs it before
 * the first dial.
 */
export interface FrameTable {
  readonly SHAPES: readonly Shape[];
  readonly FRAME_SHAPES: Readonly<Record<string, number>>;
}

let frameTable: FrameTable | null = null;

/** Installs the frame table. Called once per load, before any socket dials. */
export function installFrameShapes(table: FrameTable): void {
  frameTable = table;
}

/** The fault for a frame read before the table is installed. */
const NO_TABLE: WireFault = { path: "", expected: "a loaded shape table" }; // i18n-exempt: log-only fault text, never rendered

/**
 * Checks the payload of a server frame of wire type `type`. A type the client
 * has no shape for passes: nothing listens for it. Without the table every
 * frame fails, so nothing is let through unchecked.
 */
export function checkFrame(type: string, payload: unknown): WireFault | null {
  if (frameTable === null) return NO_TABLE;
  if (!Object.hasOwn(frameTable.FRAME_SHAPES, type)) return null;
  return checkAgainst(frameTable.SHAPES, frameTable.FRAME_SHAPES[type] as number, payload);
}

/**
 * The REST table (the exports of restShapes.ts). The caller supplies it so
 * this module, which the REST path loads at startup, never imports it.
 */
export interface RestTable {
  readonly SHAPES: readonly Shape[];
  readonly REST_SHAPES: Readonly<Record<keyof RestReplyShapes, number>>;
}

/** Checks the body of the REST reply registered as `name` in `RestReplyShapes`. */
export function checkRest(
  name: keyof RestReplyShapes,
  value: unknown,
  table: RestTable,
): WireFault | null {
  return checkAgainst(table.SHAPES, table.REST_SHAPES[name], value);
}
