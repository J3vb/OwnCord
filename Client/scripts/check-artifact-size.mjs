// Size budget for the shipped desktop installers.
//
//   node scripts/check-artifact-size.mjs <staged-dir> <platform>-<arch> [--summary <md>]
//
// <staged-dir> is stage-release-assets.sh's output for one target. Every
// pattern in artifact-size-budget.json for that target must match exactly one
// file, and that file must not be larger than its budget. Runs in the desktop
// artifact smoke, so the nightly build and the release build both check it.
import { appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `*` in a budget pattern matches any run of characters; nothing else is special. */
export function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Checks `files` ({ name, size }[]) against one target's budgets
 * ({ pattern: bytes }). Returns the failures and a markdown table.
 */
export function checkSizes(files, budgets) {
  const failures = [];
  const rows = ["| File | Size | Budget | Headroom |", "| --- | --- | --- | --- |"];
  for (const [pattern, budget] of Object.entries(budgets)) {
    const re = globToRegExp(pattern);
    const matches = files.filter((f) => re.test(f.name));
    if (matches.length !== 1) {
      failures.push(`${pattern}: expected one file, found ${matches.length}`);
      continue;
    }
    const { name, size } = matches[0];
    rows.push(
      `| ${name} | ${size.toLocaleString("en")} B | ${budget.toLocaleString("en")} B | ${(budget - size).toLocaleString("en")} B |`,
    );
    if (size > budget) {
      failures.push(`${name}: ${size} B is over its ${budget} B budget by ${size - budget} B`);
    }
  }
  return { failures, table: rows.join("\n") };
}

function main(argv) {
  const [dir, target] = argv;
  if (!dir || !target) {
    console.error("usage: check-artifact-size.mjs <staged-dir> <platform>-<arch> [--summary <md>]");
    return 2;
  }
  const config = JSON.parse(
    readFileSync(new URL("../artifact-size-budget.json", import.meta.url), "utf8"),
  );
  const budgets = config.targets[target];
  if (!budgets) {
    console.error(`artifact-size-budget.json has no target ${target}`);
    return 2;
  }
  const files = readdirSync(dir).map((name) => ({ name, size: statSync(join(dir, name)).size }));
  const { failures, table } = checkSizes(files, budgets);
  const report = [
    `### Installer size (${target})`,
    "",
    table,
    "",
    ...failures.map((f) => `- **over budget:** ${f}`),
  ].join("\n");
  console.log(report);
  const i = argv.indexOf("--summary");
  if (i >= 0 && argv[i + 1]) appendFileSync(argv[i + 1], `${report}\n`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) process.exitCode = main(process.argv.slice(2));
