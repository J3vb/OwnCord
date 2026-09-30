// Quarantine policy and mechanism (D1 of the check-reliability pain-points
// report). A known-flaky browser test lives in `tests/e2e/quarantine.json` and
// is excluded from the required run by a Playwright `grepInvert`, so it cannot
// turn a required check red while the real fix is pending.
//
//   node scripts/check-quarantine.mjs          # the guard (CI, and locally)
//   node --test scripts/check-quarantine.test.mjs
//
// Why exclusion rather than retries: `failOnFlakyTests` stays on in every
// config, so a required run means what it says. A test that is known not to do
// so is removed from the required run and tracked here instead. The entries
// carry an `expires` date, so the quarantine cannot silently become permanent;
// `OWNCORD_FLAKES=1` runs the quarantined tests anyway, to confirm a fix or to
// watch a recovery. The policy text is docs/testing-behavior.md ("Failure
// policy").
//
// Pure and dependency-free: the pattern builder and the audit are exported for
// the test and used by the Playwright configs (via tests/e2e/support/quarantine.ts,
// which re-exports them with types).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Client/ — the manifest paths are relative to it. */
const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const QUARANTINE_PATH = resolve(CLIENT, "tests/e2e/quarantine.json");

/** Fields every entry must carry, with a one-line reason for each. */
export const REQUIRED_FIELDS = {
  file: "the spec path relative to Client/",
  title: "the test title exactly as the spec spells it",
  reason: "why it is quarantined and what removing the entry waits on",
  owner: "who owns the follow-up (a lane or a GitHub login)",
  added: "the ISO date the entry was added",
  expires: "the ISO date after which the entry must be renewed or removed",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** RegExp matching every quarantined test, by `file` then `title`. */
export function quarantinePattern(entries) {
  if (!entries || entries.length === 0) return undefined;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(entries.map((e) => `${escape(e.file)}.*${escape(e.title)}`).join("|"));
}

/**
 * Value for a Playwright config's `grepInvert`: the quarantined tests, or
 * undefined when `OWNCORD_FLAKES=1` asks to run everything (confirming a fix,
 * or watching a recovery).
 */
export function quarantineGrepInvert(env = process.env) {
  if (env.OWNCORD_FLAKES === "1") return undefined;
  try {
    const { quarantine } = JSON.parse(readFileSync(QUARANTINE_PATH, "utf8"));
    return quarantinePattern(quarantine ?? []);
  } catch {
    // A missing or malformed manifest must not hide tests: returning undefined
    // here runs everything, and scripts/check-quarantine.mjs — which fails CI on
    // the same file — is what reports the real error.
    return undefined;
  }
}

/**
 * Audit the manifest. `readFile(path)` returns the spec's text, or undefined
 * when the path does not exist; it is injected so the test needs no fixture
 * tree. Returns a list of failure strings (empty = pass).
 */
export function auditQuarantine({ entries, today = new Date(), readFile }) {
  const failures = [];
  const seen = new Set();

  entries.forEach((entry, i) => {
    const at = `quarantine[${i}]`;

    for (const [field, why] of Object.entries(REQUIRED_FIELDS)) {
      const value = entry[field];
      if (typeof value !== "string" || value.trim() === "")
        failures.push(`${at}: missing ${field} — ${why}`);
    }

    for (const field of ["added", "expires"]) {
      const value = entry[field];
      if (typeof value === "string" && value.trim() !== "" && !ISO_DATE.test(value))
        failures.push(`${at}: ${field} is ${JSON.stringify(value)}, expected YYYY-MM-DD`);
    }

    if (typeof entry.file === "string" && typeof entry.title === "string") {
      const key = `${entry.file}\u0000${entry.title}`;
      if (seen.has(key)) failures.push(`${at}: duplicate entry for ${entry.file} — ${entry.title}`);
      seen.add(key);

      const src = readFile(entry.file);
      if (src === undefined) {
        failures.push(`${at}: ${entry.file} does not exist — remove the entry or fix the path`);
      } else if (!src.includes(entry.title)) {
        failures.push(
          `${at}: ${entry.file} does not contain a test titled ${JSON.stringify(entry.title)} — ` +
            "the test was renamed or removed, so remove the entry",
        );
      }
    }

    if (typeof entry.expires === "string" && ISO_DATE.test(entry.expires)) {
      const expires = new Date(`${entry.expires}T23:59:59Z`);
      if (expires < today)
        failures.push(
          `${at}: expired on ${entry.expires} — fix the flake and remove the entry, or renew it with a new reason`,
        );
    }
  });

  return failures;
}

function main() {
  const entries = JSON.parse(readFileSync(QUARANTINE_PATH, "utf8")).quarantine ?? [];
  const failures = auditQuarantine({
    entries,
    readFile: (rel) => {
      try {
        return readFileSync(resolve(CLIENT, rel), "utf8");
      } catch {
        return undefined;
      }
    },
  });

  if (failures.length) {
    console.error(`\n${failures.length} quarantine problem(s):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("\nSee docs/testing-behavior.md (Failure policy).");
    process.exit(1);
  }
  console.log(`quarantine: ${entries.length} tracked entry(ies), all current`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
