import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatLedger, mergeLedgers, parseLedger } from "./merge-ledger.mjs";

const LEDGER = fileURLToPath(new URL("../.superpowers/findings-ledger.json", import.meta.url));
const DRIVER = fileURLToPath(new URL("./merge-ledger.mjs", import.meta.url));

const entry = (n, extra = {}) =>
  JSON.stringify(
    {
      id: `OC-${String(n).padStart(4, "0")}`,
      title: `finding ${n} — dash`,
      status: "open",
      ...extra,
    },
    null,
    2,
  ).replaceAll("\n", "\n    ");
const ledger = (nextId, ...entries) =>
  formatLedger({ nextId, entries: entries.map((text) => ({ text })) });
const ids = (text) => JSON.parse(text).findings.map((f) => f.id);

test("the real ledger round-trips byte for byte", () => {
  const text = readFileSync(LEDGER, "utf8");
  assert.equal(formatLedger(parseLedger(text)), text);
});

test("entries added on both sides with different ids are all kept", () => {
  const base = ledger(3, entry(1), entry(2));
  const ours = ledger(4, entry(1), entry(2), entry(3, { title: "ours" }));
  const theirs = ledger(5, entry(1), entry(2), entry(3, { title: "theirs" }), entry(4));
  const upstream = new Set(parseLedger(theirs).entries.map((e) => e.text));
  const result = mergeLedgers(base, ours, theirs, upstream);
  assert.ok("text" in result);
  assert.deepEqual(ids(result.text), ["OC-0001", "OC-0002", "OC-0003", "OC-0004", "OC-0005"]);
  assert.equal(JSON.parse(result.text).nextId, 6);
  assert.equal(JSON.parse(result.text).findings[2].title, "theirs");
  assert.equal(JSON.parse(result.text).findings[4].title, "ours");
  assert.deepEqual(result.renames, [["OC-0003", "OC-0005"]]);
});

test("in a rebase the upstream side is ours and keeps its id", () => {
  const base = ledger(2, entry(1));
  const ours = ledger(3, entry(1), entry(2, { title: "dev" }));
  const theirs = ledger(3, entry(1), entry(2, { title: "replayed" }));
  const upstream = new Set(parseLedger(ours).entries.map((e) => e.text));
  const result = mergeLedgers(base, ours, theirs, upstream);
  assert.ok("text" in result);
  const findings = JSON.parse(result.text).findings;
  assert.equal(findings[1].title, "dev");
  assert.equal(findings[2].title, "replayed");
  assert.deepEqual(result.renames, [["OC-0002", "OC-0003"]]);
});

test("a status flip on one side and an append on the other merge cleanly", () => {
  const base = ledger(3, entry(1), entry(2));
  const ours = ledger(3, entry(1, { status: "fixed" }), entry(2));
  const theirs = ledger(4, entry(1), entry(2), entry(3));
  const result = mergeLedgers(base, ours, theirs, null);
  assert.ok("text" in result);
  assert.equal(JSON.parse(result.text).findings[0].status, "fixed");
  assert.deepEqual(ids(result.text), ["OC-0001", "OC-0002", "OC-0003"]);
  assert.deepEqual(result.renames, []);
});

test("the same entry changed differently on both sides is a conflict", () => {
  const base = ledger(2, entry(1));
  const ours = ledger(2, entry(1, { status: "fixed" }));
  const theirs = ledger(2, entry(1, { status: "declined" }));
  assert.deepEqual(mergeLedgers(base, ours, theirs, null), {
    conflict: "OC-0001 was changed differently on both sides",
  });
});

test("git uses the driver: two branches appending entries merge without conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-ledger-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "merge.findings-ledger.driver", `node ${DRIVER} %O %A %B %P`);
  writeFileSync(join(dir, ".gitattributes"), "ledger.json merge=findings-ledger\n");
  writeFileSync(join(dir, "ledger.json"), ledger(2, entry(1)));
  git("add", ".");
  git("commit", "-qm", "base");
  git("switch", "-qc", "lane");
  writeFileSync(join(dir, "ledger.json"), ledger(3, entry(1), entry(2, { title: "lane" })));
  git("commit", "-qam", "lane");
  git("switch", "-q", "dev");
  writeFileSync(join(dir, "ledger.json"), ledger(3, entry(1), entry(2, { title: "dev" })));
  git("commit", "-qam", "dev");
  git("switch", "-q", "lane");
  git("merge", "-q", "--no-edit", "dev");
  const merged = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
  assert.deepEqual(
    merged.findings.map((f) => [f.id, f.title]),
    [
      ["OC-0001", "finding 1 — dash"],
      ["OC-0002", "dev"],
      ["OC-0003", "lane"],
    ],
  );
  assert.equal(merged.nextId, 4);
});

test("a removal on either side against a change on the other is a conflict", () => {
  const base = ledger(3, entry(1), entry(2));
  const removed = ledger(3, entry(1));
  const changed = ledger(3, entry(1), entry(2, { status: "fixed" }));
  const conflict = { conflict: "OC-0002 was changed on one side and removed on the other" };
  assert.deepEqual(mergeLedgers(base, removed, changed, null), conflict);
  assert.deepEqual(mergeLedgers(base, changed, removed, null), conflict);
});
