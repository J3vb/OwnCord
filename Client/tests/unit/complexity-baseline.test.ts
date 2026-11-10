// The complexity and nesting caps are a shrink-only ratchet.
//
// local/complexity-ratchet and local/max-depth-ratchet (eslint-rules.js) fail
// lint on a function over the limit unless scripts/complexity-baseline.json
// lists it at that value or higher. This file fails the other way: a listed
// function that got simpler (lower the entry with
// `node scripts/complexity-baseline.mjs --update`), an entry for a file that
// is gone, totals above the caps below, and a config that stops enabling the
// rules.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ESLint, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- no type declarations for the plain-JS rules module
import localRules from "../../eslint-rules.js";
import {
  LIMITS,
  compareSections,
  countFunctions,
  measureTree,
  readBaseline,
  type Section,
  type Sections,
} from "../../scripts/complexity-baseline.mjs";
import { isInstrumented } from "../helpers/instrumented";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");
const baseline = readBaseline();

/** Over-limit functions and blocks that may remain. Lower these with every
 *  change that removes one; they never rise. */
const COMPLEXITY_CAP = 89;
const DEPTH_CAP = 7;
const WORST_COMPLEXITY_CAP = 36;

function rewritten(file: string): boolean {
  const full = path.join(srcDir, file);
  return existsSync(full) && isInstrumented(readFileSync(full, "utf8"));
}

function keepOriginal(section: Section): Section {
  return Object.fromEntries(Object.entries(section).filter(([file]) => !rewritten(file)));
}

/** The nightly test-depth run rewrites the files it exercises, which inflates
 *  their measures; those files are judged in the original tree only. */
function withoutRewritten(sections: Sections): Sections {
  return { complexity: keepOriginal(sections.complexity), depth: keepOriginal(sections.depth) };
}

const highest = (sections: Sections["complexity"]): number =>
  Math.max(0, ...Object.values(sections).flatMap((keys) => Object.values(keys).flat()));

describe("complexity baseline", () => {
  it("matches the tree exactly: nothing over it, nothing it can lose", async () => {
    const { grown, stale } = compareSections(
      withoutRewritten(await measureTree()),
      withoutRewritten(baseline),
    );
    expect(grown, "simplify the function; never raise or add a baseline entry").toEqual([]);
    expect(
      stale,
      "run `node scripts/complexity-baseline.mjs --update` and lower the caps in this file",
    ).toEqual([]);
  }, 120_000);

  it("stays under the caps", () => {
    expect(countFunctions(baseline.complexity)).toBeLessThanOrEqual(COMPLEXITY_CAP);
    expect(countFunctions(baseline.depth)).toBeLessThanOrEqual(DEPTH_CAP);
    expect(highest(baseline.complexity)).toBeLessThanOrEqual(WORST_COMPLEXITY_CAP);
  });

  it("lists only existing files and values over the limit", () => {
    for (const name of ["complexity", "depth"] as const) {
      for (const [file, keys] of Object.entries(baseline[name])) {
        expect(existsSync(path.join(srcDir, file)), `${file} no longer exists`).toBe(true);
        for (const [key, values] of Object.entries(keys)) {
          expect(values.length, `${file} ${key}`).toBeGreaterThan(0);
          for (const value of values) {
            expect(value, `${name} ${file} ${key}`).toBeGreaterThan(LIMITS[name]);
          }
        }
      }
    }
  });

  it("is not switched off in src/ with a directive", () => {
    const directive = /eslint-disable[^\n]*(complexity|max-depth)/;
    const offenders = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => directive.test(readFileSync(path.join(srcDir, entry), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is on, with the shared limits, for source files and off for tests", async () => {
    const eslint = new ESLint({ cwd: clientRoot });
    const source = await eslint.calculateConfigForFile(path.join(srcDir, "main.ts"));
    for (const [rule, max] of [
      ["local/complexity-ratchet", LIMITS.complexity],
      ["local/max-depth-ratchet", LIMITS.depth],
    ] as const) {
      expect(source?.rules?.[rule]?.[0], rule).toBe(2);
      expect(source?.rules?.[rule]?.[1]?.max, rule).toBe(max);
      expect(source?.rules?.[rule]?.[1]?.baseline, rule).toBeDefined();
    }
    const testFile = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).find((entry) =>
      entry.endsWith(".test.ts"),
    );
    expect(testFile).toBeDefined();
    const onTest = await eslint.calculateConfigForFile(path.join(srcDir, testFile as string));
    expect(onTest?.rules?.["local/complexity-ratchet"]).toBeUndefined();
  }, 60_000);
});

describe("compareSections", () => {
  const empty = { complexity: {}, depth: {} };

  it("flags a new function, a second one under a listed key, and a higher value", () => {
    const listed: Sections = { ...empty, complexity: { "lib/a.ts": { f: [20] } } };
    const tree: Sections = {
      ...empty,
      complexity: { "lib/a.ts": { f: [21] }, "lib/b.ts": { g: [16] } },
    };
    expect(compareSections(tree, listed).grown).toEqual([
      "complexity lib/a.ts f: tree [21], baseline [20]",
      "complexity lib/b.ts g: tree [16], baseline []",
    ]);
    const twice: Sections = { ...empty, complexity: { "lib/a.ts": { f: [20, 17] } } };
    expect(compareSections(twice, listed).grown).toHaveLength(1);
  });

  it("flags an entry the tree no longer needs", () => {
    const listed: Sections = { complexity: { "lib/a.ts": { f: [20, 18] } }, depth: {} };
    const tree: Sections = { complexity: { "lib/a.ts": { f: [19] } }, depth: {} };
    const { grown, stale } = compareSections(tree, listed);
    expect(grown).toEqual([]);
    expect(stale).toEqual(["complexity lib/a.ts f: tree [19], baseline [20,18]"]);
  });
});

const branches = (n: number) =>
  Array.from({ length: n }, (_, i) => `if (a === ${i}) n++;`).join("\n");

describe("the ratchet rules", () => {
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  });
  const filename = path.join(srcDir, "lib/fixture.ts");
  // Complexity 1 + 4 branches = 5.
  const complex = `function f(a) { let n = 0; ${branches(4)} return n; }`;
  const nested = `function g(a) { if (a) { if (a) { if (a) { n++; } } } }`;

  it("local/complexity-ratchet reports only past the listed value", () => {
    ruleTester.run("complexity-ratchet", localRules.rules["complexity-ratchet"], {
      valid: [
        { code: complex, filename, options: [{ max: 5 }] },
        {
          code: complex,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { f: [5] } } }],
        },
        {
          code: `class C { m(a) { let n = 0; ${branches(4)} return n; } }`,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { "C > m": [5] } } }],
        },
      ],
      invalid: [
        {
          code: complex,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { f: [4] } } }],
          errors: [{ messageId: "overLimit" }],
        },
        {
          code: `${complex}\nconst h = (a) => { let n = 0; ${branches(3)} return n; };`,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { f: [5] } } }],
          errors: [
            {
              messageId: "overLimit",
              data: { file: "lib/fixture.ts", key: "h", value: 4, max: 2 },
            },
          ],
        },
      ],
    });
  });

  it("local/max-depth-ratchet keys a block by its function", () => {
    ruleTester.run("max-depth-ratchet", localRules.rules["max-depth-ratchet"], {
      valid: [
        { code: nested, filename, options: [{ max: 3 }] },
        {
          code: nested,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { g: [3] } } }],
        },
      ],
      invalid: [
        {
          code: nested,
          filename,
          options: [{ max: 2, baseline: { "lib/fixture.ts": { other: [3] } } }],
          errors: [
            {
              messageId: "overLimit",
              data: { file: "lib/fixture.ts", key: "g", value: 3, max: 2 },
            },
          ],
        },
      ],
    });
  });
});
