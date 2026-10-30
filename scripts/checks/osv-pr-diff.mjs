#!/usr/bin/env node
// Pull-request half of ci.yml's Supply-chain Scan: fail only on advisories the
// PR's own lockfile changes bring in.
//
//   node scripts/checks/osv-pr-diff.mjs <base-sha>
//   node --test scripts/checks/osv-pr-diff.test.mjs
//
// The plain osv-scanner step fails on every known advisory, so a new advisory
// published against a package already on dev turns every PR that touches a
// lockfile red until someone bumps or baselines it on dev. That is dev's
// problem, not the PR's: the daily dev scan and dev's own push run catch it.
// On a PR the plain step therefore only warns, and this script decides: it
// scans the PR's lockfiles and the base commit's lockfiles with the same
// config (the PR's osv-scanner.toml, so a baseline the PR adds counts) and
// fails when the PR has an advisory group, for a package, that the base does
// not. A version bump that keeps an old advisory is not new; a new package
// with an old advisory is.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The -L list of ci.yml's osv-scanner step; osv-pr-diff.test.mjs keeps them equal.
export const LOCKFILES = [
  "Server/go.mod",
  "Client/package-lock.json",
  "Client/src-tauri/Cargo.lock",
  "tools/mcp-introspect/package-lock.json",
  "package-lock.json",
];

/**
 * Advisory groups per package in an osv-scanner JSON report, keyed
 * `ecosystem|name|first id`. A group holds an advisory and its aliases, so one
 * advisory listed under two ids counts once.
 * @param {{ results?: { packages?: { package: { name: string, ecosystem: string, version?: string }, groups?: { ids: string[] }[], vulnerabilities?: { id: string }[] }[] }[] }} report
 * @returns {Map<string, { ecosystem: string, name: string, version: string, ids: string[] }>}
 */
export function advisoryKeys(report) {
  const keys = new Map();
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const groups =
        pkg.groups && pkg.groups.length > 0
          ? pkg.groups.map((g) => [...g.ids].sort())
          : (pkg.vulnerabilities ?? []).map((v) => [v.id]);
      for (const ids of groups) {
        const { ecosystem, name, version = "" } = pkg.package;
        keys.set(`${ecosystem}|${name}|${ids[0]}`, { ecosystem, name, version, ids });
      }
    }
  }
  return keys;
}

/** Entries of head's report whose key the base report lacks. */
export function newAdvisories(headReport, baseReport) {
  const base = advisoryKeys(baseReport);
  return [...advisoryKeys(headReport)].filter(([key]) => !base.has(key)).map(([, v]) => v);
}

// osv-scanner exits 1 when it found advisories and 0 when it found none; any
// other exit is a failure to scan, never a verdict.
function scan(lockfiles) {
  const args = ["scan", "source", "--config", "osv-scanner.toml", "--format", "json"];
  for (const file of lockfiles) args.push("-L", file);
  try {
    return JSON.parse(
      execFileSync("osv-scanner", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
    );
  } catch (err) {
    if (err?.status === 1 && err.stdout) return JSON.parse(err.stdout);
    throw new Error(
      `osv-scanner failed to scan: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }
}

// The base commit's lockfiles, written under a temp dir at the same relative
// paths. One the base does not have yet (a new component) is left out, so all
// of its advisories count as new.
function baseLockfiles(baseSha) {
  const dir = mkdtempSync(join(tmpdir(), "osv-base-"));
  const out = [];
  for (const file of LOCKFILES) {
    let text;
    try {
      text = execFileSync("git", ["show", `${baseSha}:${file}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    out.push(path);
  }
  return out;
}

function main() {
  const baseSha = process.argv[2];
  if (!baseSha) {
    process.stderr.write("usage: node scripts/checks/osv-pr-diff.mjs <base-sha>\n");
    process.exit(2);
  }
  const head = scan(LOCKFILES);
  const basePaths = baseLockfiles(baseSha);
  const base = basePaths.length > 0 ? scan(basePaths) : { results: [] };
  const added = newAdvisories(head, base);
  const known = advisoryKeys(head).size - added.length;
  if (known > 0) {
    process.stdout.write(
      `${known} advisory group(s) are already on the base commit and are not this PR's to fix; the daily dev scan reports them.\n`,
    );
  }
  if (added.length === 0) {
    process.stdout.write("No advisory introduced by this PR's lockfile changes.\n");
    return;
  }
  process.stdout.write("Advisories this PR's lockfile changes introduce:\n");
  for (const a of added) {
    process.stdout.write(`  ${a.ecosystem} ${a.name} ${a.version}: ${a.ids.join(", ")}\n`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
