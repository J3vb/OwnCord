import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, classify, parseNameStatus } from "./ci-select.mjs";

// A path list is the only input; everything below goes through the same
// `git diff --name-status -M` shape the workflow feeds it, so the parser and
// the classifier are exercised together rather than only in isolation.
const picked = (nameStatus) => classify(parseNameStatus(nameStatus));
const runs = (nameStatus, cap) => picked(nameStatus)[cap];

test("a documentation-only change runs no application job", () => {
  const sel = picked(
    [
      "M\tdocs/plans/b7-plan-2026-09-20.md",
      "A\tdocs/architecture/diagnostics.md",
      "M\tREADME.md",
      "M\tCHANGELOG.md",
    ].join("\n"),
  );
  for (const cap of CAPABILITIES) {
    assert.equal(sel[cap], false, `${cap} must not run for a prose-only change`);
  }
});

test("a prose change still leaves the two always-on jobs alone", () => {
  // Hygiene and Docs & Ledger Consistency are not capabilities: they are
  // unconditional jobs in ci.yml. This test records that the classifier
  // deliberately has no say over them, so a future edit does not "helpfully"
  // gate the formatting gate away from the changes that most need it.
  assert.equal(CAPABILITIES.includes("hygiene"), false);
  assert.equal(CAPABILITIES.includes("docs"), false);
});

test("a plan-only change runs no application job", () => {
  // The shape of most planning PRs here: a plan document under .claude/plans/.
  // Before this rule it reached the unrecognised-path fallback and selected
  // every job, which is the opposite of what the selection is for.
  const sel = picked(
    ["A\t.claude/plans/b7-7-something.plan.md", "M\tdocs/plans/README.md"].join("\n"),
  );
  for (const cap of CAPABILITIES) {
    assert.equal(sel[cap], false, `${cap} must not run for a plan-only change`);
  }
});

test("the agent and skill directories are note-keeping, not build inputs", () => {
  for (const path of [
    ".claude/skills/ci-check/SKILL.md",
    ".claude/rules/gendocs.md",
    ".codex/config.toml",
    ".agents/skills/OwnCord/SKILL.md",
  ]) {
    const sel = picked(`M\t${path}`);
    for (const cap of CAPABILITIES) assert.equal(sel[cap], false, `${cap} after ${path}`);
  }
});

test(".github and .githooks are still CI inputs, not note-keeping", () => {
  // The rule above must not swallow the two dot-directories that ARE inputs.
  for (const path of [".github/workflows/ci.yml", ".githooks/pre-push"]) {
    const sel = picked(`M\t${path}`);
    for (const cap of CAPABILITIES) assert.equal(sel[cap], true, `${cap} after ${path}`);
  }
});

test("an added server file runs the server job", () => {
  assert.equal(runs("A\tServer/service/new_thing.go", "server"), true);
});

test("a modified client file runs the client, browser and native jobs", () => {
  const sel = picked("M\tClient/src/pages/MainPage.ts");
  assert.equal(sel.client, true);
  assert.equal(sel.browser, true);
  assert.equal(sel.native, true, "the native job builds this bundle and drives this UI");
  assert.equal(sel.server, false, "a client-only change must not spend the server legs");
});

test("a deleted client file is treated like any other client change", () => {
  assert.equal(runs("D\tClient/src/components/Old.ts", "browser"), true);
});

test("a rename selects both the component that lost the file and the one that gained it", () => {
  const sel = picked("R100\tServer/service/moved.go\tClient/src/lib/moved.ts");
  assert.equal(sel.server, true, "Server/ lost a file and must be re-tested");
  assert.equal(sel.client, true, "Client/ gained a file and must be re-tested");
});

test("a rename that stays inside one component selects that component once", () => {
  const sel = picked("R090\tClient/src/lib/a.ts\tClient/src/lib/b.ts");
  assert.equal(sel.client, true);
  assert.equal(sel.server, false);
});

test("a mixed change is the union of its parts", () => {
  const sel = picked(
    ["A\tClient/src/lib/x.ts", "M\tServer/ws/hub.go", "M\tdocs/protocol.md"].join("\n"),
  );
  assert.equal(sel.server, true);
  assert.equal(sel.client, true);
  assert.equal(sel.rust, false, "nothing Rust-related moved");
});

// ─── The traced cross-boundary dependencies. Each of these is a real read in
// the tree, cited in ci-select.mjs. They are the cases a plain
// "docs/ is prose" or "only Server/ affects Server" rule gets wrong.

test("docs/schema.md runs the server job, because a Go test reads it", () => {
  assert.equal(runs("M\tdocs/schema.md", "server"), true);
});

test("docs/api.md runs both the server job and the client unit suite", () => {
  const sel = picked("M\tdocs/api.md");
  assert.equal(sel.server, true, "make docs-verify compares the generated blocks in it");
  assert.equal(sel.client, true, "tests/contract/api-profile-route.test.ts reads it");
});

test("the two architecture docs the Go gates read are not treated as prose", () => {
  assert.equal(runs("M\tdocs/architecture/server-boundaries.md", "server"), true);
  assert.equal(runs("M\tdocs/architecture/community-services.md", "server"), true);
});

test("Client/src/lib/types.ts runs the server job, though it lives under Client/", () => {
  const sel = picked("M\tClient/src/lib/types.ts");
  assert.equal(sel.server, true, "permissions/schema_doc_test.go reads it");
  assert.equal(sel.client, true);
});

test("the admin panel HTML runs the client unit suite, though it lives under Server/", () => {
  const sel = picked("M\tServer/admin/static/index.html");
  assert.equal(sel.client, true, "five tests/contract specs read it");
  assert.equal(sel.server, true);
});

test("the findings ledger runs the server job, because the smoke drill reads it", () => {
  assert.equal(runs("M\t.superpowers/findings-ledger.json", "server"), true);
});

test("all three gendocs targets run the server job, not just two of them", () => {
  // cmd/gendocs declares apiDoc, schemaDoc and configDoc. Missing any one of
  // them meant a hand-edit to it merged without `make docs-verify` ever running
  // — which is precisely the drift that gate exists to catch.
  for (const doc of ["docs/api.md", "docs/schema.md", "docs/server-configuration.md"]) {
    assert.equal(runs(`M\t${doc}`, "server"), true, `${doc} is a gendocs target`);
  }
});

test("tauri.conf.json runs the server job, because a Go test reads it", () => {
  // Server/updater/tauri_key_contract_test.go asserts the Tauri updater key
  // differs from the server's default signature key, by reading this file.
  const sel = picked("M\tClient/src-tauri/tauri.conf.json");
  assert.equal(sel.server, true, "updater/tauri_key_contract_test.go reads it");
  assert.equal(sel.rust, true);
  assert.equal(sel.native, true);
});

test("the shared classifier corpus runs the Rust suite as well as the server", () => {
  // Server/safefetch/classify_test.go and Client/src-tauri/src/external_content.rs
  // both read it; a server-only PR that adds a vector must not merge with the
  // Rust side never run against it.
  const sel = picked("M\tServer/safefetch/testdata/classify_vectors.json");
  assert.equal(sel.server, true, "classify_test.go reads it");
  assert.equal(sel.rust, true, "external_content.rs's tests read it");
});

test("the platform-contracts document runs the client unit suite", () => {
  // Client/tests/unit/platform-contracts-counts.test.ts reads it and asserts
  // its counts against the source tree.
  const sel = picked("M\tdocs/architecture/platform-contracts.md");
  assert.equal(sel.client, true, "platform-contracts-counts.test.ts reads it");
  assert.equal(sel.browser, true);
});

test("a server change also runs the native job, which builds and drives that server", () => {
  // The native job runs `npm run test:e2e:build-server` and then exercises the
  // result through the real Rust/WebView2 transport.
  const sel = picked("M\tServer/updater/verify.go");
  assert.equal(sel.server, true);
  assert.equal(sel.native, true, "the native journey builds this server and tests it");
});

test("the generated TypeScript protocol file selects the server job", () => {
  // `make protocol-verify` regenerates Server/ws/message_types.go AND this file,
  // then fails on drift — so a change here has to run the server job even though
  // the path lives under Client/.
  const sel = picked("M\tClient/src/lib/protocolTypes.ts");
  assert.equal(sel.server, true, "protocol-verify regenerates and compares this file");
  // ...and the client-side selections it already had are preserved.
  assert.equal(sel.client, true);
  assert.equal(sel.browser, true);
  assert.equal(sel.native, true);
});

test("deleting the generated TypeScript protocol file selects the server job", () => {
  assert.equal(runs("D\tClient/src/lib/protocolTypes.ts", "server"), true);
});

test("renaming the generated TypeScript protocol file away from that path selects the server job", () => {
  // A rename reports BOTH paths, which is the point: the OLD path is the one
  // protocol-verify still expects to regenerate.
  const sel = picked("R100\tClient/src/lib/protocolTypes.ts\tClient/src/lib/protocolTypes.old.ts");
  assert.equal(sel.server, true, "the file left the path protocol-verify writes");
  assert.equal(sel.client, true);
});

test("renaming a file INTO the generated path selects the server job too", () => {
  const sel = picked("R100\tClient/src/lib/other.ts\tClient/src/lib/protocolTypes.ts");
  assert.equal(sel.server, true, "something now occupies the path protocol-verify writes");
});

test("a protocol schema change runs every component that consumes the generated types", () => {
  const sel = picked("M\tprotocol/schema.json");
  assert.equal(sel.server, true, "ws/message_types.go is generated from it");
  assert.equal(sel.client, true, "src/lib/protocolTypes.ts is generated from it");
  assert.equal(sel.browser, true);
  assert.equal(sel.native, true);
});

// ─── Conservative expansion: the paths whose blast radius is unbounded.

test("a workflow file selects every capability", () => {
  const sel = picked("M\t.github/workflows/ci.yml");
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true, `${cap} after a ci.yml edit`);
});

test("a shared script selects every capability", () => {
  const sel = picked("M\tscripts/check-tauri-versions.mjs");
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true);
});

test("the root lockfile selects every capability", () => {
  const sel = picked("M\tpackage-lock.json");
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true, `${cap} after the root lockfile`);
});

test("the client lockfile selects the components that consume the client npm tree, and no others", () => {
  // Deliberately not "everything": the Rust crate and the Go server do not
  // resolve through Client/package-lock.json, so spending their jobs on it
  // would be cost without coverage. It IS a harness change — a vite or
  // Playwright bump moves the ground under the smoke run — which is why the
  // development browser run widens to full.
  const sel = picked("M\tClient/package-lock.json");
  for (const cap of ["client", "browser", "integration", "native", "harness"]) {
    assert.equal(sel[cap], true, `${cap} after the client lockfile`);
  }
  for (const cap of ["server", "rust"]) {
    assert.equal(sel[cap], false, `${cap} does not resolve through the client npm tree`);
  }
});

// ─── The supply-chain and workflow-lint jobs (2026-09-21).

test("a workflow change runs the workflow linter as well as the hygiene gate", () => {
  const sel = picked("M\t.github/workflows/ci.yml");
  assert.equal(sel.workflows, true, "zizmor audits .github/workflows/");
  assert.equal(sel.server, true, "a workflow file is still a shared CI input");
});

test("any .github file runs the workflow linter, because .github is a shared CI input", () => {
  // `.github/` is already in the unbounded-blast-radius rule below — a
  // Dependabot config or an issue template is a change to how the repository
  // itself is driven, so every capability is selected conservatively. The
  // workflow-lint job therefore runs for a non-workflow .github file too; that
  // is the existing rule, not a new one, and it is recorded here so a future
  // "helpfully" narrowed .github rule has to confront it.
  const sel = picked("M\t.github/dependabot.yml");
  assert.equal(sel.workflows, true);
  assert.equal(sel.server, true, "still the shared-input rule");
});

test("every lockfile and manifest in the repository runs the supply-chain scan", () => {
  // Named one by one: the scan's file list in ci.yml is explicit, and this test
  // is what fails when a new component's lockfile is left out of both.
  for (const path of [
    "Server/go.mod",
    "Server/go.sum",
    "Client/package.json",
    "Client/package-lock.json",
    "Client/src-tauri/Cargo.toml",
    "Client/src-tauri/Cargo.lock",
    "tools/mcp-introspect/package.json",
    "tools/mcp-introspect/package-lock.json",
  ]) {
    assert.equal(runs(`M\t${path}`, "deps"), true, `${path} moves a dependency`);
  }
});

test("the scanner baselines run the supply-chain scan, because editing them changes its verdict", () => {
  assert.equal(runs("M\tosv-scanner.toml", "deps"), true);
  assert.equal(runs("M\tClient/src-tauri/deny.toml", "deps"), true);
});

test("the scanner baselines do not run every job", () => {
  // They are not build inputs and not read by any test: a one-line exception
  // edit must reach the fallback-free `deps`-only path, not select everything.
  const sel = picked("M\tosv-scanner.toml");
  for (const cap of CAPABILITIES) {
    assert.equal(sel[cap], cap === "deps", `${cap} after osv-scanner.toml`);
  }
});

test("an ordinary source change runs no supply-chain scan", () => {
  // Source cannot move a version. Gating here is what keeps the two new jobs
  // off the overwhelming majority of PRs.
  assert.equal(runs("M\tServer/ws/hub.go", "deps"), false);
  assert.equal(runs("M\tClient/src/pages/MainPage.ts", "deps"), false);
  assert.equal(runs("M\tClient/src-tauri/src/lib.rs", "deps"), false);
});

test("a server change runs the server job but not the workflow linter or the scan", () => {
  const sel = picked("M\tServer/service/new_thing.go");
  assert.equal(sel.server, true);
  assert.equal(sel.workflows, false);
  assert.equal(sel.deps, false);
});

test("a path the classifier has never been taught selects everything", () => {
  const sel = picked("A\tsome/new/top-level-thing.bin");
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true);
});

test("an empty diff selects everything rather than nothing", () => {
  // The shape of a failed or truncated diff: the safe answer is the full run.
  const sel = classify([]);
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true);
});

// ─── The command line itself. A wrong flag name or a broken --out write would
// surface as every job silently skipping rather than as a red build, so the
// entry point is exercised rather than trusted. It is also the only place the
// `key=value` shape $GITHUB_OUTPUT requires is asserted.

const CLI = fileURLToPath(new URL("./ci-select.mjs", import.meta.url));

function runCli(args, pathsFile) {
  const dir = mkdtempSync(join(tmpdir(), "ci-select-"));
  const out = join(dir, "out.txt");
  const full = [...args, "--out", out];
  if (pathsFile !== undefined) {
    const file = join(dir, "changed.txt");
    writeFileSync(file, pathsFile);
    full.push("--paths-file", file);
  }
  execFileSync(process.execPath, [CLI, ...full], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

test("--all writes every capability true, one key=value line each", () => {
  const text = runCli(["--all"]);
  const rows = text.trimEnd().split("\n");
  assert.equal(rows.length, CAPABILITIES.length);
  for (const cap of CAPABILITIES) assert.match(text, new RegExp(`^${cap}=true$`, "m"));
});

test("a --paths-file run selects from the rows and writes the same shape", () => {
  const text = runCli([], "M\tServer/ws/hub.go\n");
  assert.match(text, /^server=true$/m);
  assert.match(text, /^client=false$/m);
  assert.equal(text.trimEnd().split("\n").length, CAPABILITIES.length);
});

test("--all with no --paths-file still succeeds, because a selection is never a check", () => {
  // The workflow relies on this exiting 0: a non-zero exit here would skip
  // every job that consumes the outputs.
  const text = runCli(["--all", "--reason", "not a pull request into dev"]);
  assert.match(text, /^native=true$/m);
});

// ─── The smoke/full split for the development browser run.

test("editing the e2e specs widens the development browser run to full", () => {
  assert.equal(runs("M\tClient/tests/e2e/connect-page.spec.ts", "harness"), true);
});

test("editing a spec fixture widens it too", () => {
  assert.equal(runs("A\tClient/tests/e2e/support/helpers.ts", "harness"), true);
});

test("an ordinary application change does not widen it", () => {
  assert.equal(runs("M\tClient/src/pages/MainPage.ts", "harness"), false);
});

test("a Rust change reaches rust-tests and the native job, not the browser jobs", () => {
  const sel = picked("M\tClient/src-tauri/src/lib.rs");
  assert.equal(sel.rust, true);
  assert.equal(sel.native, true);
  assert.equal(sel.browser, false);
});

// ─── Parser shape.

test("the parser ignores anything that is not a name-status row", () => {
  assert.deepEqual(parseNameStatus(""), []);
  assert.deepEqual(parseNameStatus("not a status row"), []);
  assert.deepEqual(parseNameStatus("M\tone.go"), ["one.go"]);
  assert.deepEqual(parseNameStatus("R100\told.go\tnew.go"), ["old.go", "new.go"]);
});

test("a path that escapes the repository is not silently accepted", () => {
  // normalise() rejects these, and classify() then takes the conservative
  // branch rather than guessing which component "../../etc/passwd" belongs to.
  const sel = classify(["../../etc/passwd"]);
  for (const cap of CAPABILITIES) assert.equal(sel[cap], true);
});

test("every capability is a key of the result, so a missing output cannot skip a job", () => {
  const sel = picked("M\tdocs/protocol.md");
  for (const cap of CAPABILITIES) {
    assert.equal(typeof sel[cap], "boolean", `${cap} must be present and boolean`);
  }
});
