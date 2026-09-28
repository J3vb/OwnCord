#!/usr/bin/env node
// Fail when the RE-05 load-baseline weekly schedule loses a guard (O8).
//
//   node scripts/check-load-baseline-schedule.mjs
//   node --test scripts/check-load-baseline-schedule.test.mjs
//
// load-baseline.yml is the only published capacity measurement. It became a
// weekly `schedule:` on dev, and three properties are what make that safe and
// meaningful rather than three lines nobody verifies:
//
//   * a cron exists, so the schedule is real and not just a comment;
//   * the job is guarded to the canonical repository, so a fork that mirrors
//     this file does not spend runner minutes measuring its own copy;
//   * the scheduled checkout pins `dev`, so the weekly run measures the
//     integration branch (the same choice the other nightlies make) and never
//     the default branch's tip, which would poison release gate-evidence.
//
// Deliberately text-level like scripts/check-workflow-guards.mjs: no YAML
// parser exists in the root devDependencies, and the honest limit of a
// substring check is "these guards are present and shaped right", not "the
// workflow parses". actionlint (also in check:hygiene) owns syntax.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/load-baseline.yml";

export const CHECKS = [
  {
    name: "weekly schedule",
    test: (src) =>
      /^on:\s*$/m.test(src) && /^\s*schedule:\s*$/m.test(src) && /- cron:\s*"/.test(src),
    why: "the load baseline must carry an actual `schedule:` with a quoted cron, or the weekly RE-05 run never fires",
  },
  {
    name: "canonical-repository guard",
    test: (src) => /github\.repository\s*==/.test(src),
    why: "a scheduled run must be guarded to the canonical repository (`github.repository == '...'`), or a fork mirroring this file spends its own runner minutes measuring a copy",
  },
  {
    name: "scheduled checkout pins dev",
    test: (src) =>
      /github\.event_name\s*==\s*'schedule'\s*&&\s*'dev'/.test(src) && /ref:\s*\$\{\{/.test(src),
    why: "the scheduled checkout must pin dev (`github.event_name == 'schedule' && 'dev'`), so the weekly run measures the integration branch and not the default branch's tip",
  },
];

export function auditLoadBaseline(src) {
  return CHECKS.filter((c) => !c.test(src)).map((c) => ({ name: c.name, why: c.why }));
}

function main() {
  const p = join(ROOT, WORKFLOW);
  if (!existsSync(p)) {
    console.error(`${WORKFLOW}: missing — it is the file this check exists for`);
    process.exit(1);
  }
  const failures = auditLoadBaseline(readFileSync(p, "utf8"));
  if (failures.length) {
    console.error(`\n${failures.length} load-baseline schedule guard(s) missing:\n`);
    for (const f of failures) console.error(`  ${f.name} — ${f.why}`);
    process.exit(1);
  }
  console.log(`${CHECKS.length} load-baseline schedule guard(s) present in ${WORKFLOW}`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
