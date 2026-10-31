// WP 7.4b: the layer-direction baseline is a shrink-only ratchet.
//
// `local/layer-direction` (eslint-rules.js) stops a lower layer importing a
// higher one. scripts/layer-baseline.json lists the upward imports that already
// existed, as `{ sanctioned, debt }`, each `importer -> { target: site count }`.
// Lint fails on a site beyond the listed count (a new upward import). This file
// fails the other way: an entry whose import is gone or whose count is now too
// high (delete or lower it), an entry naming a file that no longer exists, a
// total debt above the cap, and a config that stops enabling the rule.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- no type declarations for the plain-JS rules module
import localRules, { LAYER_ALIASES, LAYER_RANK } from "../../eslint-rules.js";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

type Counts = Record<string, Record<string, number>>;
interface Baseline {
  sanctioned: Counts;
  debt: Counts;
}

const baseline = JSON.parse(
  readFileSync(path.join(clientRoot, "scripts/layer-baseline.json"), "utf8"),
) as Baseline;

/** Upward value-import sites that may remain. Lower this in every change that
 *  removes one; it never rises. */
const DEBT_SITE_CAP = 74;

/** The upward imports a written rule requires (Client/CLAUDE.md: the
 *  dispatcher door, and messages.store over its reducer modules). */
const SANCTIONED_PAIRS = [
  "lib/dispatcher.ts -> features/channels/wsHandlers.ts",
  "lib/dispatcher.ts -> features/connection/dispatchContext.ts",
  "lib/dispatcher.ts -> features/connection/wsHandlers.ts",
  "lib/dispatcher.ts -> features/direct-messages/wsHandlers.ts",
  "lib/dispatcher.ts -> features/message-requests/wsHandlers.ts",
  "lib/dispatcher.ts -> features/messaging/wsHandlers.ts",
  "lib/dispatcher.ts -> features/moderation/wsHandlers.ts",
  "lib/dispatcher.ts -> features/safety/wsHandlers.ts",
  "lib/dispatcher.ts -> features/voice/wsHandlers.ts",
  "stores/messages.store.ts -> features/messaging/historyWindows.ts",
  "stores/messages.store.ts -> features/messaging/liveMessages.ts",
  "stores/messages.store.ts -> features/messaging/messageEdits.ts",
  "stores/messages.store.ts -> features/messaging/messageModel.ts",
  "stores/messages.store.ts -> features/messaging/reactionState.ts",
];

const merge = (...sections: Counts[]): Counts => {
  const out: Counts = {};
  for (const section of sections) {
    for (const [importer, targets] of Object.entries(section)) {
      for (const [target, n] of Object.entries(targets)) {
        out[importer] ??= {};
        out[importer][target] = (out[importer][target] ?? 0) + n;
      }
    }
  }
  return out;
};

const flatten = (counts: Counts): Map<string, number> =>
  new Map(
    Object.entries(counts).flatMap(([importer, targets]) =>
      Object.entries(targets).map(([target, n]) => [`${importer} -> ${target}`, n] as const),
    ),
  );

/** Compare the sites the tree has against the baseline, by `importer -> target`. */
function compare(actual: Counts, listed: Counts): { added: string[]; stale: string[] } {
  const have = flatten(actual);
  const want = flatten(listed);
  const added: string[] = [];
  const stale: string[] = [];
  for (const [pair, n] of have) {
    const allowed = want.get(pair) ?? 0;
    if (n > allowed) added.push(`${pair}: ${n} site(s), baseline allows ${allowed}`);
  }
  for (const [pair, n] of want) {
    const found = have.get(pair) ?? 0;
    if (found < n) stale.push(`${pair}: baseline lists ${n}, tree has ${found}`);
  }
  return { added, stale };
}

const sites = (counts: Counts): number =>
  [...flatten(counts).values()].reduce((sum, n) => sum + n, 0);

/** Lint src/ with only this rule, no type information and an empty baseline, so
 *  every upward site is reported; fold the reports into `importer -> target`
 *  counts. */
async function upwardSitesInTree(): Promise<Counts> {
  const eslint = new ESLint({
    cwd: clientRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["src/**/*.ts"],
        ignores: ["src/**/*.test.ts"],
        languageOptions: { parser: tseslint.parser },
        // Only this rule runs, so every `eslint-disable` for another rule looks unused.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        plugins: { local: localRules },
        rules: { "local/layer-direction": ["error", { baseline: {} }] },
      },
    ],
  });
  const results = await eslint.lintFiles(["src/**/*.ts"]);
  const found: Counts = {};
  for (const result of results) {
    for (const message of result.messages) {
      // A directive naming a rule this run does not load is not a finding; a
      // parse failure is.
      expect(message.fatal, `${result.filePath}: ${message.message}`).toBeUndefined();
      if (message.ruleId !== "local/layer-direction") continue;
      const match = /^(\S+) -> (\S+):/.exec(message.message);
      expect(match, message.message).not.toBeNull();
      const [, importer = "", target = ""] = match as RegExpExecArray;
      found[importer] ??= {};
      found[importer][target] = (found[importer][target] ?? 0) + 1;
    }
  }
  return found;
}

describe("layer-direction baseline", () => {
  it("matches the upward imports in src/ exactly: no new one, no stale entry", async () => {
    const { added, stale } = compare(
      await upwardSitesInTree(),
      merge(baseline.sanctioned, baseline.debt),
    );
    expect(
      added,
      "a new upward import: import from the same layer or below, or move the shared piece down. Do not add a baseline entry",
    ).toEqual([]);
    expect(
      stale,
      "the upward import is gone: delete or lower this entry in scripts/layer-baseline.json and lower DEBT_SITE_CAP",
    ).toEqual([]);
  }, 120_000);

  it("names an existing importer and target file in every entry", () => {
    for (const [importer, targets] of Object.entries(merge(baseline.sanctioned, baseline.debt))) {
      expect(existsSync(path.join(srcDir, importer)), `${importer} no longer exists`).toBe(true);
      for (const target of Object.keys(targets)) {
        expect(
          existsSync(path.join(srcDir, target)),
          `${importer} -> ${target}: target no longer exists; re-key the entry to its new path`,
        ).toBe(true);
      }
    }
  });

  it("keeps debt under the cap and sanctioned edges to the documented pairs", () => {
    expect(sites(baseline.debt)).toBeLessThanOrEqual(DEBT_SITE_CAP);
    expect([...flatten(baseline.sanctioned).keys()].sort()).toEqual(SANCTIONED_PAIRS);
    for (const n of flatten(baseline.sanctioned).values()) expect(n).toBe(1);
    // An edge is sanctioned or debt, never both.
    const sanctioned = new Set(flatten(baseline.sanctioned).keys());
    for (const pair of flatten(baseline.debt).keys())
      expect(sanctioned.has(pair), pair).toBe(false);
  });

  it("holds only upward edges between known layers", () => {
    const rank = (rel: string): number | undefined =>
      (LAYER_RANK as Map<string, number>).get(
        rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "main",
      );
    for (const pair of flatten(merge(baseline.sanctioned, baseline.debt)).keys()) {
      const [importer = "", target = ""] = pair.split(" -> ");
      expect(rank(importer), importer).toBeDefined();
      expect(rank(target), target).toBeGreaterThan(rank(importer) as number);
    }
  });
});

describe("the comparison", () => {
  it("flags a stale entry, an over-counted entry and a new edge", () => {
    const listed: Counts = { "lib/a.ts": { "stores/x.ts": 2, "stores/gone.ts": 1 } };
    const actual: Counts = { "lib/a.ts": { "stores/x.ts": 1 }, "lib/b.ts": { "stores/y.ts": 1 } };
    const { added, stale } = compare(actual, listed);
    expect(stale).toEqual([
      "lib/a.ts -> stores/x.ts: baseline lists 2, tree has 1",
      "lib/a.ts -> stores/gone.ts: baseline lists 1, tree has 0",
    ]);
    expect(added).toEqual(["lib/b.ts -> stores/y.ts: 1 site(s), baseline allows 0"]);
  });

  it("reports a second site of a listed pair", () => {
    const { added } = compare(
      { "lib/a.ts": { "stores/x.ts": 2 } },
      { "lib/a.ts": { "stores/x.ts": 1 } },
    );
    expect(added).toEqual(["lib/a.ts -> stores/x.ts: 2 site(s), baseline allows 1"]);
  });
});

describe("the rule's scope", () => {
  const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(srcDir, entry));

  it("is an error on every non-test src/**/*.ts file and off for test files", async () => {
    const eslint = new ESLint({ cwd: clientRoot });
    const configured = async (file: string) =>
      (await eslint.calculateConfigForFile(file))?.rules?.["local/layer-direction"];
    const isTest = (file: string) => file.endsWith(".test.ts");
    const sources = sourceFiles.filter((f) => !isTest(f));
    const tests = sourceFiles.filter(isTest);
    expect(tests.length).toBeGreaterThan(0);
    const [onSources, onTests] = await Promise.all([
      Promise.all(sources.map(configured)),
      Promise.all(tests.map(configured)),
    ]);
    sources.forEach((file, i) => {
      expect(onSources[i]?.[0], path.relative(srcDir, file)).toBe(2);
      expect(onSources[i]?.[1]?.baseline, path.relative(srcDir, file)).toBeDefined();
    });
    tests.forEach((file, i) => {
      expect(onTests[i], path.relative(srcDir, file)).toBeUndefined();
    });
  }, 120_000);

  it("maps the five tsconfig and vite aliases, and every top-level src/ entry has a layer", () => {
    const tsconfig = readFileSync(path.join(clientRoot, "tsconfig.json"), "utf8");
    const fromTsconfig = new Map(
      [...tsconfig.matchAll(/"(@[a-z]+)\/\*":\s*\[\s*"\.\/src\/([a-z]+)\/\*"\s*\]/g)].map(
        (m) => [m[1], m[2]] as const,
      ),
    );
    expect(fromTsconfig.size).toBe(5);
    expect(new Map(LAYER_ALIASES as Map<string, string>)).toEqual(fromTsconfig);
    const vite = readFileSync(path.join(clientRoot, "vite.config.ts"), "utf8");
    for (const [alias, dir] of fromTsconfig) {
      expect(vite).toContain(`"${alias}": resolve(import.meta.dirname, "src/${dir}")`);
    }
    const layers = LAYER_RANK as Map<string, number>;
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === "vite-env.d.ts") continue;
      const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.ts$/, "");
      expect(layers.has(name), `src/${entry.name} has no layer in eslint-rules.js`).toBe(true);
    }
  });
});
