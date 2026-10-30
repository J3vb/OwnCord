import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCKFILES, advisoryKeys, newAdvisories } from "./osv-pr-diff.mjs";

const CI = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const SELECT = fileURLToPath(new URL("../ci-select.mjs", import.meta.url));

const pkg = (ecosystem, name, version, ...groups) => ({
  package: { ecosystem, name, version },
  vulnerabilities: groups.flat().map((id) => ({ id })),
  groups: groups.map((ids) => ({ ids })),
});
const report = (...packages) => ({ results: [{ source: { path: "x" }, packages }] });

test("an advisory already on the base is not new", () => {
  const base = report(pkg("crates.io", "block-buffer", "0.10.4", ["GHSA-qwgh-2vcv-g2f7"]));
  const head = report(pkg("crates.io", "block-buffer", "0.10.4", ["GHSA-qwgh-2vcv-g2f7"]));
  assert.deepEqual(newAdvisories(head, base), []);
});

test("a version bump that keeps the same advisory is not new", () => {
  const base = report(pkg("npm", "undici", "6.1.0", ["GHSA-aaaa", "CVE-1"]));
  const head = report(pkg("npm", "undici", "6.2.0", ["CVE-1", "GHSA-aaaa"]));
  assert.deepEqual(newAdvisories(head, base), []);
});

test("a package the PR adds brings its advisories in as new", () => {
  const base = report(pkg("npm", "undici", "6.1.0", ["GHSA-aaaa"]));
  const head = report(
    pkg("npm", "undici", "6.1.0", ["GHSA-aaaa"]),
    pkg("npm", "left-pad", "1.0.0", ["GHSA-bbbb"]),
  );
  assert.deepEqual(newAdvisories(head, base), [
    { ecosystem: "npm", name: "left-pad", version: "1.0.0", ids: ["GHSA-bbbb"] },
  ]);
});

test("a bump into a version with another advisory is new", () => {
  const base = report(pkg("Go", "golang.org/x/net", "0.30.0", ["GO-1"]));
  const head = report(pkg("Go", "golang.org/x/net", "0.31.0", ["GO-1"], ["GO-2"]));
  assert.deepEqual(
    newAdvisories(head, base).map((a) => a.ids),
    [["GO-2"]],
  );
});

test("the same advisory id on another package is new", () => {
  const base = report(pkg("npm", "a", "1.0.0", ["GHSA-cccc"]));
  const head = report(
    pkg("npm", "a", "1.0.0", ["GHSA-cccc"]),
    pkg("npm", "b", "1.0.0", ["GHSA-cccc"]),
  );
  assert.equal(newAdvisories(head, base).length, 1);
});

test("a report without groups falls back to one key per vulnerability", () => {
  const keys = advisoryKeys({
    results: [
      {
        packages: [
          { package: { ecosystem: "npm", name: "a" }, vulnerabilities: [{ id: "X" }, { id: "Y" }] },
        ],
      },
    ],
  });
  assert.deepEqual([...keys.keys()], ["npm|a|X", "npm|a|Y"]);
});

test("an empty report has no advisories", () => {
  assert.equal(advisoryKeys({}).size, 0);
  assert.equal(advisoryKeys({ results: [{ packages: [] }] }).size, 0);
});

test("the lockfile list matches ci.yml's osv-scanner step", () => {
  const ci = readFileSync(CI, "utf8");
  const job = ci.slice(ci.indexOf("\n  supply-chain:"));
  const step = job.slice(job.indexOf("osv-scanner scan source"));
  const listed = [...step.slice(0, step.indexOf("\n\n")).matchAll(/-L (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(listed, LOCKFILES);
});

test("a change to this script selects the Supply-chain Scan", () => {
  assert.match(readFileSync(SELECT, "utf8"), /"scripts\/checks\/osv-pr-diff\.mjs"/);
});
