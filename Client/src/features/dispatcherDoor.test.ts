// The dispatcher is the only door server events enter the stores through.
// `local/no-store-write-in-ws-on` enforces it lexically: a store mutator
// called inside a ws.on(...) callback anywhere but lib/dispatcher.ts fails
// lint. The handler bodies live in features/*/wsHandlers.ts as plain
// functions, which the lexical rule cannot follow — so this test pins the
// other half: only dispatcher.ts may call them, they never subscribe to the
// socket themselves, and the rule's single exemption has not grown.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(__dirname, "../..");
const srcDir = path.join(clientRoot, "src");

const aliases: Record<string, string> = {
  "@lib/": "src/lib/",
  "@stores/": "src/stores/",
  "@components/": "src/components/",
  "@pages/": "src/pages/",
};

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => path.join(srcDir, entry));

const handlerFiles = sourceFiles.filter((file) =>
  /^features\/[^/]+\/wsHandlers\.ts$/.test(path.relative(srcDir, file).split(path.sep).join("/")),
);

/** Absolute paths of every module `file` imports, statically or dynamically. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g),
  ].map((m) => m[1]!);
  return specifiers.flatMap((spec) => {
    const alias = Object.keys(aliases).find((prefix) => spec.startsWith(prefix));
    const base = alias
      ? path.join(clientRoot, aliases[alias]!, spec.slice(alias.length))
      : spec.startsWith(".")
        ? path.resolve(path.dirname(file), spec)
        : null;
    return base === null ? [] : [base.endsWith(".ts") ? base : `${base}.ts`];
  });
}

describe("the dispatcher door", () => {
  it("finds the handler modules it guards", () => {
    expect(handlerFiles.length).toBeGreaterThan(0);
  });

  it("every wsHandlers module is imported by lib/dispatcher.ts and by nothing else", () => {
    for (const handler of handlerFiles) {
      const importers = sourceFiles.filter((file) => importsOf(file).includes(handler));
      expect(importers.map((file) => path.relative(srcDir, file))).toEqual(["lib/dispatcher.ts"]);
    }
  });

  it("no wsHandlers module subscribes to the socket itself", () => {
    for (const handler of handlerFiles) {
      const text = readFileSync(handler, "utf8");
      expect(text, path.relative(srcDir, handler)).not.toMatch(
        /\bws\.on\(|\.onStateChange\(|\.onSendFailure\(/,
      );
    }
  });

  it("local/no-store-write-in-ws-on still exempts only lib/dispatcher.ts", async () => {
    const eslint = new ESLint({ cwd: clientRoot });
    const severity = async (file: string) =>
      (await eslint.calculateConfigForFile(file))?.rules?.["local/no-store-write-in-ws-on"];

    expect(await severity(path.join(srcDir, "lib/dispatcher.ts"))).toBeUndefined();
    const others = sourceFiles.filter((f) => !f.endsWith(`lib${path.sep}dispatcher.ts`));
    const severities = await Promise.all(others.map(severity));
    others.forEach((file, i) => {
      expect(severities[i], path.relative(srcDir, file)).toEqual([2]);
    });
  });
});
