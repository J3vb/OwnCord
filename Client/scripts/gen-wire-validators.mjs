#!/usr/bin/env node
// Generates two self-contained tables, read from the TypeScript types the
// client already uses: src/lib/net/wireShapes.ts describes the payload of every
// server to client WebSocket frame, and src/lib/net/restShapes.ts describes
// every checked REST reply. The two are separate files so the REST table can
// load on demand while the frame table stays in the startup code; a shape both
// use is simply written into both. The checker in src/lib/net/wireCheck.ts
// walks a value against a table.
//
// Run `npm run gen:wire` from Client/ after changing a payload type in
// src/lib/wire*.ts or the list in src/lib/net/restReplies.ts. A unit test
// regenerates the table in memory and fails on any difference.
//
// Rules the walk applies to a type:
//   - `readonly` is ignored.
//   - A property is optional when it is declared with `?`, or its type admits
//     `undefined`, or its type is `unknown`/`any` (JSON cannot carry
//     `undefined`, so an absent key is the only way to be missing).
//   - `T | null` allows null.
//   - A union of string literals (with or without `string`) is `string`; a
//     union of number literals is `number`; `true`/`false` is `boolean`. A
//     newer server may send a literal this client does not know, and the
//     consumer decides what to do with it.
//   - Any other union is `anyOf` its members.
//   - A tuple is an array of the union of its element types.
//   - A function or method anywhere in a payload type fails the run.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const UNIONS_FILE = path.join(CLIENT_DIR, "src/lib/wireUnions.ts");
export const REST_FILE = path.join(CLIENT_DIR, "src/lib/net/restReplies.ts");
export const OUT_FILE = path.join(CLIENT_DIR, "src/lib/net/wireShapes.ts");
export const REST_OUT_FILE = path.join(CLIENT_DIR, "src/lib/net/restShapes.ts");

/** Shape numbers 0..4 are the primitives; every other shape is an array entry. */
const STRING = 0;
const NUMBER = 1;
const BOOLEAN = 2;
const NULL = 3;
const UNKNOWN = 4;
const PRIMITIVE_COUNT = 5;

const K_ARRAY = 0;
const K_RECORD = 1;
const K_OBJECT = 2;
const K_ANYOF = 3;
const K_NULLABLE = 4;

function readCompilerOptions(rootNames) {
  const configPath = path.join(CLIENT_DIR, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, CLIENT_DIR);
  return { options: { ...parsed.options, noEmit: true }, rootNames };
}

class ShapeBuilder {
  constructor(checker) {
    this.checker = checker;
    /** shapes[i] is the table entry for shape number i; 0..4 stand for themselves. */
    this.shapes = [STRING, NUMBER, BOOLEAN, NULL, UNKNOWN];
    this.byKey = new Map();
    this.done = new Map();
    this.inProgress = new Set();
    this.reserved = new Map();
  }

  intern(entry) {
    const key = JSON.stringify(entry);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const index = this.shapes.length;
    this.shapes.push(entry);
    this.byKey.set(key, index);
    return index;
  }

  /** The shape number for `type`; `where` names the spot for error messages. */
  shapeOf(type, where) {
    const f = type.flags;
    const F = ts.TypeFlags;
    if (f & (F.Any | F.Unknown | F.Never | F.Void | F.Undefined)) return UNKNOWN;
    if (f & F.Boolean || f & F.BooleanLiteral) return BOOLEAN;
    if (f & (F.String | F.StringLiteral | F.TemplateLiteral | F.StringMapping)) return STRING;
    if (f & (F.Number | F.NumberLiteral)) return NUMBER;
    if (f & F.Null) return NULL;
    if (f & (F.BigInt | F.BigIntLiteral | F.ESSymbol | F.UniqueESSymbol)) {
      throw new Error(`${where}: a bigint or symbol cannot appear on the wire`);
    }
    if (f & F.TypeParameter) throw new Error(`${where}: unresolved type parameter`);
    if (f & F.NonPrimitive) return UNKNOWN;
    if (type.isUnion()) return this.unionOf(type, where);
    if (f & (F.Object | F.Intersection)) return this.objectOf(type, where);
    throw new Error(`${where}: unsupported type ${this.checker.typeToString(type)}`);
  }

  unionOf(type, where) {
    const F = ts.TypeFlags;
    const refs = new Set();
    let nullable = false;
    for (const member of type.types) {
      if (member.flags & F.Undefined) continue;
      if (member.flags & F.Null) {
        nullable = true;
        continue;
      }
      refs.add(this.shapeOf(member, where));
    }
    if (refs.has(UNKNOWN)) return UNKNOWN;
    const list = [...refs].sort((a, b) => a - b);
    if (list.length === 0) return nullable ? NULL : UNKNOWN;
    if (list.length === 1) return nullable ? this.intern([K_NULLABLE, list[0]]) : list[0];
    return this.intern([K_ANYOF, ...list, ...(nullable ? [NULL] : [])]);
  }

  objectOf(type, where) {
    const known = this.done.get(type);
    if (known !== undefined) return known;
    if (this.inProgress.has(type)) {
      // A type that contains itself: hand out a slot now and fill it after.
      let slot = this.reserved.get(type);
      if (slot === undefined) {
        slot = this.shapes.length;
        this.shapes.push(null);
        this.reserved.set(type, slot);
      }
      return slot;
    }
    this.inProgress.add(type);
    const entry = this.objectEntry(type, where);
    this.inProgress.delete(type);
    const slot = this.reserved.get(type);
    let ref;
    if (slot === undefined) {
      ref = this.intern(entry);
    } else {
      this.shapes[slot] = entry;
      ref = slot;
    }
    this.done.set(type, ref);
    return ref;
  }

  objectEntry(type, where) {
    const checker = this.checker;
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      throw new Error(`${where}: a function type cannot appear in a wire payload`);
    }
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type);
      return [K_ARRAY, element === undefined ? UNKNOWN : this.shapeOf(element, `${where}[]`)];
    }
    if (checker.isTupleType(type)) {
      const refs = new Set(
        checker.getTypeArguments(type).map((t) => this.shapeOf(t, `${where}[]`)),
      );
      const list = [...refs].sort((a, b) => a - b);
      if (list.length === 0 || refs.has(UNKNOWN)) return [K_ARRAY, UNKNOWN];
      return [K_ARRAY, list.length === 1 ? list[0] : this.intern([K_ANYOF, ...list])];
    }
    const props = checker.getPropertiesOfType(type);
    const indexInfos = checker.getIndexInfosOfType(type);
    if (props.length === 0 && indexInfos.length > 0) {
      const refs = new Set(indexInfos.map((info) => this.shapeOf(info.type, `${where}{}`)));
      const list = [...refs].sort((a, b) => a - b);
      const ref = refs.has(UNKNOWN)
        ? UNKNOWN
        : list.length === 1
          ? list[0]
          : this.intern([K_ANYOF, ...list]);
      return [K_RECORD, ref];
    }
    const required = { names: [], refs: [] };
    const optional = { names: [], refs: [] };
    for (const prop of props) {
      const name = prop.getName();
      const at = `${where}.${name}`;
      if (prop.flags & ts.SymbolFlags.Method) {
        throw new Error(`${at}: a method cannot appear in a wire payload`);
      }
      const propType = checker.getTypeOfSymbol(prop);
      const ref = this.shapeOf(propType, at);
      const admitsUndefined =
        propType.isUnion() && propType.types.some((t) => t.flags & ts.TypeFlags.Undefined);
      const side =
        prop.flags & ts.SymbolFlags.Optional || admitsUndefined || ref === UNKNOWN
          ? optional
          : required;
      side.names.push(name);
      side.refs.push(ref);
    }
    const entry = [K_OBJECT, required.names, required.refs];
    if (optional.names.length > 0) entry.push(optional.names, optional.refs);
    return entry;
  }
}

function findDeclaredType(program, checker, file, name, kind) {
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`cannot load ${file}`);
  const decl = source.statements.find(
    (s) =>
      (kind === "alias" ? ts.isTypeAliasDeclaration(s) : ts.isInterfaceDeclaration(s)) &&
      s.name.text === name,
  );
  if (decl === undefined) throw new Error(`${path.basename(file)} has no ${kind} named ${name}`);
  return checker.getTypeAtLocation(decl.name);
}

/**
 * Walks the types and returns the table as plain data:
 * `{ shapes, frames, restShapes, rest }`: `frames` maps a frame type to a shape
 * number of `shapes`, and `rest` maps a reply name to a shape number of the
 * separate `restShapes` table.
 */
// Parsed declaration files (.d.ts: the lib and DOM types, dependencies), kept
// so a process that builds many tables parses them once, not once per call.
const declarationCache = new Map();

function cachingHost(options) {
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) return read(fileName, languageVersion, onError, shouldCreate);
    let file = declarationCache.get(fileName);
    if (file === undefined) {
      file = read(fileName, languageVersion, onError, shouldCreate);
      if (file !== undefined) declarationCache.set(fileName, file);
    }
    return file;
  };
  return host;
}

export function buildTables({ unionsFile = UNIONS_FILE, restFile = REST_FILE } = {}) {
  const { options, rootNames } = readCompilerOptions([unionsFile, restFile]);
  const program = ts.createProgram({ rootNames, options, host: cachingHost(options) });
  const checker = program.getTypeChecker();
  const builder = new ShapeBuilder(checker);

  const union = findDeclaredType(program, checker, unionsFile, "ServerMessage", "alias");
  const members = union.isUnion() ? union.types : [union];
  const frames = {};
  for (const member of members) {
    const typeProp = checker.getPropertyOfType(member, "type");
    const payloadProp = checker.getPropertyOfType(member, "payload");
    const typeType = typeProp === undefined ? undefined : checker.getTypeOfSymbol(typeProp);
    if (typeType === undefined || !typeType.isStringLiteral()) {
      throw new Error(
        `a ServerMessage member has no literal type: ${checker.typeToString(member)}`,
      );
    }
    const wireType = typeType.value;
    if (payloadProp === undefined) throw new Error(`${wireType}: no payload property`);
    const ref = builder.shapeOf(checker.getTypeOfSymbol(payloadProp), wireType);
    if (frames[wireType] !== undefined && frames[wireType] !== ref) {
      throw new Error(`${wireType}: two union members disagree about the payload`);
    }
    frames[wireType] = ref;
  }

  const restBuilder = new ShapeBuilder(checker);
  const rest = {};
  const replies = findDeclaredType(program, checker, restFile, "RestReplyShapes", "interface");
  for (const prop of checker.getPropertiesOfType(replies)) {
    rest[prop.getName()] = restBuilder.shapeOf(
      checker.getTypeOfSymbol(prop),
      `REST ${prop.getName()}`,
    );
  }
  return { shapes: builder.shapes, frames, restShapes: restBuilder.shapes, rest };
}

const LEGEND = `// SHAPES[n] describes one kind of value. Shapes 0 to 4 are the primitives and
// stand for themselves: 0 string, 1 number, 2 boolean, 3 null, 4 unknown.
// Every other entry is an array whose first element is its kind:
//   [0, of]                       array of shape \`of\`
//   [1, of]                       object used as a map, every value of shape \`of\`
//   [2, names, shapes, optNames?, optShapes?]
//                                 object with these required, then optional, fields
//   [3, a, b, ...]                any one of these shapes
//   [4, of]                       shape \`of\`, or null
`;

const FRAME_HEADER = `// Generated by \`npm run gen:wire\` (node scripts/gen-wire-validators.mjs) from the
// payload types in src/lib/wire*.ts.
// Do not edit by hand: a unit test regenerates it and fails on any difference.
//
${LEGEND}// FRAME_SHAPES maps a wire frame type to the shape of its payload. The REST
// replies have their own table in restShapes.ts, loaded on demand.
`;

const REST_HEADER = `// Generated by \`npm run gen:wire\` (node scripts/gen-wire-validators.mjs) from the
// list in src/lib/net/restReplies.ts.
// Do not edit by hand: a unit test regenerates it and fails on any difference.
//
${LEGEND}// REST_SHAPES maps a REST reply name to the shape of its body. This table is
// self-contained (a shape the frame table also holds is written again here) so
// it can load on demand.
`;

const SHAPE_TYPE = `type OptionalFields = readonly [] | readonly [readonly string[], readonly number[]];

export type Shape =
  | number
  | readonly [0, number]
  | readonly [1, number]
  | readonly [2, readonly string[], readonly number[], ...OptionalFields]
  | readonly [3, ...number[]]
  | readonly [4, number];
`;

function renderMap(map) {
  const rows = Object.entries(map).map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`);
  return rows.length === 0 ? "{}" : `{\n${rows.join("\n")}\n}`;
}

function renderShapes(shapes) {
  return shapes.map((s) => `  ${JSON.stringify(s)},`).join("\n");
}

/**
 * The text of wireShapes.ts for `tables`: one shape per line, so a type change
 * shows as a small diff. Not run through prettier (the file is in
 * .prettierignore like protocolTypes.ts), so the generator needs only
 * TypeScript and works from Client/ alone.
 */
export async function renderModule(tables) {
  return `${FRAME_HEADER}
${SHAPE_TYPE}
export const SHAPES: readonly Shape[] = [
${renderShapes(tables.shapes)}
];

export const FRAME_SHAPES: Readonly<Record<string, number>> = ${renderMap(tables.frames)};
`;
}

/** The text of restShapes.ts for `tables`. */
export async function renderRestModule(tables) {
  return `${REST_HEADER}
import type { RestReplyShapes } from "./restReplies";
import type { Shape } from "./wireShapes";

export const SHAPES: readonly Shape[] = [
${renderShapes(tables.restShapes)}
];

export const REST_SHAPES: Readonly<Record<keyof RestReplyShapes, number>> = ${renderMap(tables.rest)};
`;
}

/** The full generated text, from the committed type files. */
export async function generate(options = {}) {
  return renderModule(buildTables(options));
}

/** The full generated text of restShapes.ts. */
export async function generateRest(options = {}) {
  return renderRestModule(buildTables(options));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const tables = buildTables();
  writeFileSync(OUT_FILE, await renderModule(tables));
  writeFileSync(REST_OUT_FILE, await renderRestModule(tables));
  for (const file of [OUT_FILE, REST_OUT_FILE]) {
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}
