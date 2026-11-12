// The generated shape table must match the payload types, and the generator
// must read every kind of type the wire types use. Fixtures here are small TS
// files written to a temp directory and run through the same generator.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OUT_FILE,
  REST_FILE,
  UNIONS_FILE,
  REST_OUT_FILE,
  buildTables,
  generate,
  generateRest,
  renderModule,
  renderRestModule,
} from "../../scripts/gen-wire-validators.mjs";
import { checkAgainst } from "../../src/lib/net/wireCheck";
import { isInstrumented, withoutSandboxHeader } from "../helpers/instrumented";
import type { Shape } from "../../src/lib/net/wireShapes";

// Loading the TypeScript program takes a second or two.
const SLOW = 30_000;

const read = (file: string): string => withoutSandboxHeader(readFileSync(file, "utf8"));
/** The nightly test-depth run rewrites some sources; the committed table is judged against the originals only. */
const inputsAreOriginal = [OUT_FILE, UNIONS_FILE, REST_FILE].every(
  (file) => !isInstrumented(read(file)),
);

describe("generated wireShapes.ts", () => {
  it.runIf(inputsAreOriginal)(
    "matches what the generator writes now",
    async () => {
      const expected = await generate();
      const committed = read(OUT_FILE);
      expect(
        committed === expected,
        "src/lib/net/wireShapes.ts is out of date: run `npm run gen:wire` in Client/ and commit the result",
      ).toBe(true);
    },
    SLOW,
  );

  it.runIf(inputsAreOriginal && !isInstrumented(read(REST_OUT_FILE)))(
    "matches what the generator writes now for restShapes.ts",
    async () => {
      const expected = await generateRest();
      const committed = read(REST_OUT_FILE);
      expect(
        committed === expected,
        "src/lib/net/restShapes.ts is out of date: run `npm run gen:wire` in Client/ and commit the result",
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "is stable: generating twice gives the same text",
    async () => {
      expect(await generate()).toBe(await generate());
      expect(await generateRest()).toBe(await generateRest());
    },
    SLOW,
  );
});

const dir = mkdtempSync(path.join(tmpdir(), "wire-gen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
/** Generates tables from one fixture: `payloads` become frames f0, f1, ...; `rest` is the body of RestReplyShapes. */
function tablesFor(decls: string, payloads: string[], rest = ""): ReturnType<typeof buildTables> {
  count += 1;
  const unionsFile = path.join(dir, `unions${count}.ts`);
  const restFile = path.join(dir, `rest${count}.ts`);
  const members = payloads
    .map((p, i) => `  | { readonly type: "f${i}"; readonly payload: ${p} }`)
    .join("\n");
  writeFileSync(
    unionsFile,
    `${decls}\nexport type ServerMessage =\n${members || '  | { readonly type: "none"; readonly payload: string }'};\n`,
  );
  writeFileSync(restFile, `${decls}\nexport interface RestReplyShapes {\n${rest}\n}\n`);
  return buildTables({ unionsFile, restFile });
}

function frame(decls: string, payload: string, value: unknown) {
  const t = tablesFor(decls, [payload]);
  return checkAgainst(t.shapes as Shape[], t.frames["f0"] as number, value);
}

describe("generator: type kinds", () => {
  it(
    "reads primitives, optional fields and nullable fields",
    () => {
      const decl = `interface P { readonly a: string; readonly b?: number; readonly c: boolean | null; readonly d: string | undefined }`;
      expect(frame(decl, "P", { a: "x", c: null })).toBeNull();
      expect(frame(decl, "P", { a: "x", b: 1, c: true, d: "y" })).toBeNull();
      expect(frame(decl, "P", { c: true })).toEqual({ path: "a", expected: "string (missing)" });
      expect(frame(decl, "P", { a: "x" })).toEqual({
        path: "c",
        expected: "boolean | null (missing)",
      });
      expect(frame(decl, "P", { a: "x", c: 1 })?.path).toBe("c");
      expect(frame(decl, "P", { a: "x", c: null, b: "1" })?.path).toBe("b");
    },
    SLOW,
  );

  it(
    "checks a literal union as its base type",
    () => {
      const decl = `interface P { readonly kind: "a" | "b"; readonly n: 1 | 2; readonly flag: true; readonly mixed: "x" | string }`;
      expect(frame(decl, "P", { kind: "z", n: 9, flag: false, mixed: "q" })).toBeNull();
      expect(frame(decl, "P", { kind: 1, n: 9, flag: false, mixed: "q" })?.path).toBe("kind");
      expect(frame(decl, "P", { kind: "z", n: "9", flag: false, mixed: "q" })?.path).toBe("n");
      expect(frame(decl, "P", { kind: "z", n: 9, flag: "no", mixed: "q" })?.path).toBe("flag");
    },
    SLOW,
  );

  it(
    "reads arrays, readonly arrays, tuples and records",
    () => {
      const decl = `interface P { readonly xs: readonly string[]; readonly ys: Array<{ id: number }>; readonly t: readonly [string, number]; readonly m: Record<string, number>; readonly i: { [k: string]: string } }`;
      const good = { xs: ["a"], ys: [{ id: 1 }], t: ["a", 1], m: { q: 1 }, i: { z: "s" } };
      expect(frame(decl, "P", good)).toBeNull();
      expect(frame(decl, "P", { ...good, xs: [1] })).toEqual({ path: "xs[]", expected: "string" });
      expect(frame(decl, "P", { ...good, ys: [{ id: "1" }] })?.path).toBe("ys[].id");
      expect(frame(decl, "P", { ...good, t: ["a", "b"] })).toBeNull(); // tuple: array of string | number
      expect(frame(decl, "P", { ...good, t: [true] })?.path).toBe("t[]");
      expect(frame(decl, "P", { ...good, m: { q: "x" } })?.path).toBe("m{}");
      expect(frame(decl, "P", { ...good, i: [] })?.path).toBe("i");
    },
    SLOW,
  );

  it(
    "reads unions of objects, intersections and unknown fields",
    () => {
      const decl = `
        interface A { readonly kind: "a"; readonly x: number }
        interface B { readonly kind: "b"; readonly y: string }
        interface Base { readonly id: number }
        type P = Base & { readonly extra: string; readonly u: unknown; readonly any: any; readonly ab: A | B };`;
      const good = { id: 1, extra: "e", ab: { kind: "a", x: 1 } };
      expect(frame(decl, "P", good)).toBeNull();
      expect(frame(decl, "P", { ...good, ab: { kind: "b", y: "s" } })).toBeNull();
      expect(frame(decl, "P", { ...good, u: { deep: [1] }, any: 5 })).toBeNull();
      expect(frame(decl, "P", { ...good, ab: 3 })?.path).toBe("ab");
      expect(frame(decl, "P", { ...good, extra: undefined })?.path).toBe("extra");
      expect(frame(decl, "P", { extra: "e", ab: good.ab })?.path).toBe("id");
    },
    SLOW,
  );

  it(
    "handles a type that contains itself",
    () => {
      const decl = `interface Node { readonly name: string; readonly kids: readonly Node[] }`;
      expect(frame(decl, "Node", { name: "a", kids: [{ name: "b", kids: [] }] })).toBeNull();
      expect(frame(decl, "Node", { name: "a", kids: [{ name: 1, kids: [] }] })?.path).toBe(
        "kids[].name",
      );
    },
    SLOW,
  );

  it(
    "shares one entry between reused types and frames with the same payload",
    () => {
      const decl = `interface Item { readonly id: number; readonly label: string }`;
      const t = tablesFor(decl, ["Item", "Item", "{ readonly items: Item[]; readonly one: Item }"]);
      expect(t.frames["f0"]).toBe(t.frames["f1"]);
      const copies = t.shapes.filter(
        (s) => Array.isArray(s) && s[0] === 2 && (s[1] as string[]).join() === "id,label",
      );
      expect(copies).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "fills the REST table from RestReplyShapes, and an empty interface gives an empty table",
    () => {
      const decl = `interface Health { readonly ok: boolean }`;
      const withRest = tablesFor(
        decl,
        [],
        "  readonly health: Health;\n  readonly names: string[];",
      );
      expect(Object.keys(withRest.rest)).toEqual(["health", "names"]);
      expect(
        checkAgainst(withRest.restShapes as Shape[], withRest.rest["health"] as number, { ok: 1 }),
      ).toEqual({ path: "ok", expected: "boolean" });
      expect(tablesFor(decl, [], "").rest).toEqual({});
    },
    SLOW,
  );

  it(
    "renders a module that names the generator and its command",
    async () => {
      const text = await renderModule(tablesFor("interface P { readonly a: string }", ["P"]));
      expect(text).toContain("Generated by `npm run gen:wire`");
      expect(text).toContain('"f0": ');
      expect(text).not.toContain("REST_SHAPES");
      const rest = await renderRestModule(
        tablesFor("interface P { readonly a: string }", ["P"], "  readonly p: P;"),
      );
      expect(rest).toContain('"p": ');
      expect(rest).not.toContain("FRAME_SHAPES");
    },
    SLOW,
  );

  it(
    "rejects a function or method in a payload with a message naming the spot",
    () => {
      expect(() => tablesFor("interface P { readonly go: () => void }", ["P"])).toThrow(
        /f0\.go: a function type/,
      );
      expect(() => tablesFor("interface P { go(): void }", ["P"])).toThrow(/f0\.go: a method/);
    },
    SLOW,
  );

  it(
    "rejects a bigint",
    () => {
      expect(() => tablesFor("interface P { readonly n: bigint }", ["P"])).toThrow(/bigint/);
    },
    SLOW,
  );
});
