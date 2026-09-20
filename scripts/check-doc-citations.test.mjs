import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANNED_PATHS, WATCHED, citedPaths, evaluate, repoPath } from "./check-doc-citations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const realDoc = () => readFileSync(join(ROOT, WATCHED[0]), "utf8");
const onDisk = (p) => existsSync(join(ROOT, p));

// ── the shape of a citation ─────────────────────────────────────────────────

test("a backticked repository path is a citation", () => {
  const cited = citedPaths("See `Server/api/router.go` and `Client/src/lib/ws.ts`.");
  assert.deepEqual(cited, ["Server/api/router.go", "Client/src/lib/ws.ts"]);
});

test("prose, commands and identifiers in backticks are not citations", () => {
  const cited = citedPaths(
    "Run `npm run check:docs`, set `engine-strict=true`, call `AssetHandler`, see `G-05`.",
  );
  assert.deepEqual(cited, []);
});

test("a path outside the known top-level directories is not a citation", () => {
  // `data/` is runtime state on a server, not a path in a checkout.
  assert.equal(repoPath.test("data/erasure.key"), false);
  assert.deepEqual(citedPaths("`data/erasure.key`"), []);
});

test("a path is counted once however often it is cited", () => {
  assert.deepEqual(citedPaths("`docs/api.md` … `docs/api.md` again"), ["docs/api.md"]);
});

// ── the two directions of the exemption ─────────────────────────────────────

test("a cited path that exists is not a problem", () => {
  assert.deepEqual(
    evaluate("d.md", ["Server/api/router.go"], () => true),
    [],
  );
});

test("a cited path that does not exist fails", () => {
  const problems = evaluate("d.md", ["Server/api/gone.go"], () => false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cites `Server\/api\/gone\.go`, which does not exist/);
});

test("a missing path that is exempted as planned does not fail", () => {
  const problems = evaluate("d.md", ["Server/owed.go"], () => false, { "Server/owed.go": "B9-2" });
  assert.deepEqual(problems, []);
});

test("an exemption for a path that now exists fails, so a stale exemption cannot linger", () => {
  const problems = evaluate("d.md", ["Server/owed.go"], () => true, { "Server/owed.go": "B9-2" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /exempts `Server\/owed\.go` as owed by B9-2, but it exists now/);
});

test("an exemption for a path the document no longer cites fails", () => {
  const problems = evaluate("d.md", [], () => false, { "Server/owed.go": "B9-2" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not cite it any more; drop the entry/);
});

test("a directory citation is stat'd without its trailing slash", () => {
  const asked = [];
  evaluate(
    "d.md",
    ["Client/"],
    (p) => {
      asked.push(p);
      return true;
    },
    {},
  );
  assert.deepEqual(asked, ["Client"]);
});

// ── regression: the hole this check was moved out of the Go test to close ────
//
// Both cases are the rename experiments that reproduced the escape while the
// check still lived in Server/migrations/community_services_doc_test.go. There
// a Client-only or docs-only pull request selected no `server` capability, so
// the leg that ran the gate was skipped and the dangling citation merged green.
// Here they are asserted against the REAL document, so the cases stay honest:
// if the document stops citing these paths the assertions below fail and say so
// rather than passing vacuously.

test("regression: renaming a cited Client/ file is caught (ci-select selects no server job for it)", () => {
  const cited = citedPaths(realDoc());
  const renamed = "Client/src/lib/nsfw-gate.ts";
  assert.ok(
    cited.includes(renamed),
    `${WATCHED[0]} no longer cites ${renamed}; point this regression at a path it does cite`,
  );

  const problems = evaluate(WATCHED[0], cited, (p) => p !== renamed && onDisk(p), {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cites `Client\/src\/lib\/nsfw-gate\.ts`, which does not exist/);
});

test("regression: renaming a cited docs/ file is caught (a docs-only diff selects nothing at all)", () => {
  const cited = citedPaths(realDoc());
  const renamed = "docs/trust-model.md";
  assert.ok(
    cited.includes(renamed),
    `${WATCHED[0]} no longer cites ${renamed}; point this regression at a path it does cite`,
  );

  const problems = evaluate(WATCHED[0], cited, (p) => p !== renamed && onDisk(p), {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cites `docs\/trust-model\.md`, which does not exist/);
});

// ── the live tree ───────────────────────────────────────────────────────────

test("every watched document exists and cites at least one path", () => {
  for (const rel of WATCHED) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is watched but does not exist`);
    const cited = citedPaths(readFileSync(join(ROOT, rel), "utf8"));
    assert.ok(cited.length > 0, `${rel} cites no repository path; is it the right document?`);
  }
});

test("the checked-in tree passes, so the check is green for the right reason", () => {
  for (const rel of WATCHED) {
    const cited = citedPaths(readFileSync(join(ROOT, rel), "utf8"));
    assert.deepEqual(evaluate(rel, cited, onDisk, PLANNED_PATHS[rel] ?? {}), []);
  }
});
