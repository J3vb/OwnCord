#!/usr/bin/env node
// One documented Node major, checked in every place that states it.
//
// `engine-strict=true` makes `engines` a hard failure instead of a warning,
// but it does not narrow an open-ended range: `>=24` admits any future major.
// That is how the "pin" drifted — the owner's machine ran 26 while CI ran 24,
// and nothing failed. This check is what makes "one major" true.
//
// `Client/.nvmrc` is the source of truth; every other statement is compared
// against it rather than against a second hard-coded number.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MANIFESTS = ["package.json", "Client/package.json", "tools/mcp-introspect/package.json"];
const NPMRCS = [".npmrc", "Client/.npmrc", "tools/mcp-introspect/.npmrc"];

// Anchored to a line so a commented-out directive cannot pass the check.
const ENGINE_STRICT = /^\s*engine-strict\s*=\s*true\s*$/m;
const WORKFLOW_PIN = /^\s*node-version:\s*(\S+)/;
// The npm major is deliberately not hard-coded: the failure this check exists
// for is one root drifting from the others, not the owner choosing a new npm.
const NPM_RANGE = /^\^\d+$/;
// A job that installs a deliberately unsupported Node to prove the refusal has
// to say so in a trailing comment; counting that pin as drift would make the
// proof itself a build failure.
const DELIBERATE_REFUSAL = "deliberately NOT the supported major";

export function checkNodePolicy({ nvmrc, manifests, npmrcs, workflows }) {
  const major = String(nvmrc).trim().replace(/^v/, "").split(".")[0];
  if (!/^\d+$/.test(major))
    throw new Error(`Client/.nvmrc does not name a Node major: ${JSON.stringify(nvmrc)}`);

  const mismatches = [];

  for (const { path, json } of manifests) {
    const node = json?.engines?.node;
    if (node !== `^${major}`)
      mismatches.push(`${path}: engines.node is ${JSON.stringify(node)}, expected "^${major}"`);
  }

  const npmRanges = manifests.map(({ json }) => json?.engines?.npm);
  npmRanges.forEach((range, index) => {
    if (typeof range !== "string" || !NPM_RANGE.test(range))
      mismatches.push(
        `${manifests[index].path}: engines.npm is ${JSON.stringify(range)}, expected a ^<major> range`,
      );
  });
  if (new Set(npmRanges).size > 1)
    mismatches.push(
      `engines.npm disagrees across roots: ${manifests
        .map(({ path }, index) => `${path} ${JSON.stringify(npmRanges[index])}`)
        .join(", ")}`,
    );

  for (const { path, text } of npmrcs) {
    if (!ENGINE_STRICT.test(text))
      mismatches.push(`${path}: no engine-strict=true, so engines is only a warning here`);
  }

  let pins = 0;
  for (const { path, text } of workflows) {
    text.split(/\r?\n/).forEach((line, index) => {
      const match = WORKFLOW_PIN.exec(line);
      if (!match || line.includes(DELIBERATE_REFUSAL)) return;
      pins++;
      // YAML lets the value be quoted; the quotes are not part of the major.
      const value = match[1].replace(/^["']|["']$/g, "");
      if (value !== major)
        mismatches.push(`${path}:${index + 1}: node-version is ${match[1]}, expected ${major}`);
    });
  }
  // Fail closed. No pins means the enumeration broke, which would silently
  // retire the rule most likely to drift.
  if (!pins) throw new Error("No node-version pins found in .github/workflows");

  const types = manifests.find(({ path }) => path === "Client/package.json")?.json
    ?.devDependencies?.["@types/node"];
  if (typeof types !== "string" || !types.startsWith(`^${major}.`))
    mismatches.push(
      `Client/package.json: @types/node is ${JSON.stringify(types)}, expected a ^${major}. range`,
    );

  return { major, pins, mismatches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkNodePolicy({
      nvmrc: readFileSync(join(ROOT, "Client/.nvmrc"), "utf8"),
      manifests: MANIFESTS.map((path) => ({
        path,
        json: JSON.parse(readFileSync(join(ROOT, path), "utf8")),
      })),
      npmrcs: NPMRCS.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") })),
      // `git ls-files`, not a filesystem glob: the check must see tracked
      // workflows, and a directory walk would also read scratch files.
      workflows: execFileSync(
        "git",
        ["ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
        { cwd: ROOT, encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean)
        .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") })),
    });
    if (result.mismatches.length) {
      console.error(
        `Every place that states the Node version must agree with Client/.nvmrc:\n${result.mismatches.join("\n")}`,
      );
      process.exitCode = 1;
    } else {
      console.log(`Node policy: Node ${result.major} agreed across ${result.pins} CI pin(s)`);
    }
  } catch (error) {
    console.error(`Node policy: ${error.message}`);
    process.exitCode = 1;
  }
}
