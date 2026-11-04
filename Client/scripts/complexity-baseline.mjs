// Functions that were over the complexity or nesting limit before
// local/complexity-ratchet and local/max-depth-ratchet existed. The baseline
// only shrinks: tests/unit/complexity-baseline.test.ts fails when it lists a
// function that has since got simpler, and lint fails on a new one.
//
//   node scripts/complexity-baseline.mjs           # report what changed
//   node scripts/complexity-baseline.mjs --update  # write the lower baseline
//
// --update refuses to add a function or raise a value. After a rename or a
// move, re-key the entry in scripts/complexity-baseline.json by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import localRules from "../eslint-rules.js";

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = resolve(CLIENT, "scripts/complexity-baseline.json");

/** Limits shared with eslint.config.js. */
export const LIMITS = { complexity: 15, depth: 4 };

const RULES = {
  complexity: "local/complexity-ratchet",
  depth: "local/max-depth-ratchet",
};

const REPORT = /^(\S+) (.+): (?:complexity|nesting depth) (\d+), the limit is \d+\./;

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Every over-limit function in src/, as `{ complexity, depth }` sections. */
export async function measureTree() {
  const eslint = new ESLint({
    cwd: CLIENT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["src/**/*.ts"],
        ignores: ["src/**/*.test.ts"],
        languageOptions: { parser: tseslint.parser },
        linterOptions: { reportUnusedDisableDirectives: "off" },
        plugins: { local: localRules },
        rules: {
          [RULES.complexity]: ["error", { max: LIMITS.complexity }],
          [RULES.depth]: ["error", { max: LIMITS.depth }],
        },
      },
    ],
  });
  const results = await eslint.lintFiles(["src/**/*.ts"]);
  const tree = { complexity: {}, depth: {} };
  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal) throw new Error(`${result.filePath}: ${message.message}`);
      const section = Object.keys(RULES).find((s) => RULES[s] === message.ruleId);
      if (!section) continue;
      const match = REPORT.exec(message.message);
      if (!match) throw new Error(`unparsed report: ${message.message}`);
      const [, file, key, value] = match;
      tree[section][file] ??= {};
      (tree[section][file][key] ??= []).push(Number(value));
    }
  }
  return sortSections(tree);
}

/** Same shape, keys sorted and values highest first, so the file diffs cleanly. */
export function sortSections(sections) {
  const out = {};
  for (const [name, files] of Object.entries(sections)) {
    out[name] = {};
    for (const file of Object.keys(files).sort()) {
      out[name][file] = {};
      for (const key of Object.keys(files[file]).sort()) {
        out[name][file][key] = [...files[file][key]].sort((a, b) => b - a);
      }
    }
  }
  return out;
}

/** `grown`: the tree is over what the baseline allows. `stale`: the baseline
 *  allows more than the tree needs, so it should be lowered. */
export function compareSections(tree, baseline) {
  const grown = [];
  const stale = [];
  for (const name of Object.keys(LIMITS)) {
    const have = tree[name] ?? {};
    const want = baseline[name] ?? {};
    const files = new Set([...Object.keys(have), ...Object.keys(want)]);
    for (const file of files) {
      const keys = new Set([...Object.keys(have[file] ?? {}), ...Object.keys(want[file] ?? {})]);
      for (const key of keys) {
        const actual = [...(have[file]?.[key] ?? [])].sort((a, b) => b - a);
        const allowed = [...(want[file]?.[key] ?? [])].sort((a, b) => b - a);
        const label = `${name} ${file} ${key}`;
        if (actual.some((v, i) => i >= allowed.length || v > allowed[i])) {
          grown.push(`${label}: tree [${actual}], baseline [${allowed}]`);
        } else if (actual.length < allowed.length || actual.some((v, i) => v < allowed[i])) {
          stale.push(`${label}: tree [${actual}], baseline [${allowed}]`);
        }
      }
    }
  }
  return { grown, stale };
}

export function countFunctions(section) {
  return Object.values(section).reduce(
    (sum, keys) => sum + Object.values(keys).reduce((n, list) => n + list.length, 0),
    0,
  );
}

async function main() {
  const tree = await measureTree();
  const { grown, stale } = compareSections(tree, readBaseline());
  for (const line of grown) console.log(`over baseline  ${line}`);
  for (const line of stale) console.log(`can be lowered ${line}`);
  console.log(
    `over the limit: ${countFunctions(tree.complexity)} functions (complexity > ${LIMITS.complexity}), ${countFunctions(tree.depth)} blocks (depth > ${LIMITS.depth})`,
  );
  if (!process.argv.includes("--update")) return;
  if (grown.length > 0) {
    console.error(
      "not updated: the baseline never grows. Simplify the code, or re-key a renamed entry by hand.",
    );
    process.exitCode = 1;
    return;
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(tree, null, 2)}\n`);
  console.log(
    `wrote ${BASELINE_PATH}; lower the caps in tests/unit/complexity-baseline.test.ts to match`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
