import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  TOTAL_CAP,
  compare,
  comments,
  countTree,
  idsIn,
  scopeFiles,
  testFiles,
  titleIdsIn,
} from "./check-comment-ids.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ids = (src, lang) => idsIn(src, lang).map((h) => h.id);

test("ids in TypeScript comments are found, ids in strings and regexes are not", () => {
  const src = [
    'const a = "WP 7.4b"; // the reason (WP 7.4b)',
    "const b = 'OC-0395';",
    "const c = `B7-15 ${x /* OC-0001 */ + `nested B3-5`} tail OC-0002`;",
    "const d = /https?:\\/\\/OC-1234/; // after a regex, B5-9",
    "const e = x / 2; // division, then Codex review round 2",
    "/**",
    " * Owner decision on #2805.",
    " */",
  ].join("\n");
  assert.deepEqual(ids(src, "ts"), [
    "WP 7.4b",
    "OC-0001",
    "B5-9",
    "Codex",
    "round 2",
    "#2805",
    "Owner decision",
  ]);
  assert.equal(idsIn(src, "ts").find((h) => h.id === "#2805").line, 7);
});

test("Go raw strings and runes are skipped", () => {
  const src = [
    "package p",
    "var s = `WP 1 // OC-0001`",
    "var r = '\"' // OC-0002",
    "// decision 3, B4-12",
  ].join("\n");
  assert.deepEqual(ids(src, "go"), ["OC-0002", "B4-12", "decision 3"]);
});

test("Rust lifetimes, chars, raw strings and nested block comments", () => {
  const src = [
    "fn f<'a>(x: &'a str) -> char { '\"' } // OC-0001",
    'let s = r#"OC-0002 // "#; /* outer /* inner B9-14 */ still RT-12 */',
    "/// LP-7 doc comment",
  ].join("\n");
  assert.deepEqual(ids(src, "rs"), ["OC-0001", "B9-14", "RT-12", "LP-7"]);
});

test("a bare roadmap item counts once, and versions do not", () => {
  const src = "// sidebar rows (5.4c-2, 6.13d); WP 6.9c; v2.5.0, 1.5x faster, 0.5 s";
  assert.deepEqual(ids(src, "ts"), ["WP 6.9c", "5.4c-2", "6.13d"]);
});

test("phase-letter work packages count whole, and a UI action named Owner call does not", () => {
  const src = "// WP 3B-11a and WP 1B-5; the owner's call; the Make Owner call button";
  assert.deepEqual(ids(src, "ts"), ["WP 3B-11a", "WP 1B-5", "owner's call"]);
});

test("technical names that look like ids are not counted", () => {
  const src =
    "// UTF-8, SHA-256, AES-128, P-256, RFC-6455, TEST-NET-1 and HTTP-2 are not plan ids; #fff is a colour";
  assert.deepEqual(ids(src, "go"), []);
});

test("comment text keeps its line numbers across block comments", () => {
  const got = comments("x\n/* a\nb */\ny // c", "ts");
  assert.deepEqual(
    got.map((c) => c.line),
    [2, 3, 4],
  );
});

test("test titles are checked, the test body is not", () => {
  const src = [
    'describe("channel categories (WP 6.5a)", () => {',
    "  it(`restores the last channel (UX-8)`, () => {",
    '    expect(x).toBe("OC-0001"); // B5-7',
    "  });",
    '  it.each([1])("drops %s (B9-14)", () => {});',
    "});",
  ].join("\n");
  assert.deepEqual(
    titleIdsIn(src).map((h) => [h.line, h.id]),
    [
      [1, "WP 6.5a"],
      [2, "UX-8"],
      [5, "B9-14"],
    ],
  );
  assert.deepEqual(
    testFiles([
      "Client/tests/unit/a.test.ts",
      "Client/src/b.test.ts",
      "Client/tests/e2e/c.spec.ts",
      "Client/src/d.ts",
      "Server/e_test.go",
    ]),
    ["Client/tests/unit/a.test.ts", "Client/src/b.test.ts", "Client/tests/e2e/c.spec.ts"],
  );
});

test("scope is production code only", () => {
  assert.deepEqual(
    scopeFiles([
      "Client/src/lib/a.ts",
      "Client/src/lib/a.test.ts",
      "Client/src/lib/protocolTypes.ts",
      "Client/tests/unit/b.test.ts",
      "Server/ws/hub.go",
      "Server/ws/hub_test.go",
      "Server/ws/message_types.go",
      "Server/db/dbgen/q.go",
      "Client/src-tauri/src/lib.rs",
      "Client/src-tauri/src/voice/tests.rs",
      "Client/src-tauri/vendor/livekit/src/x.rs",
      "docs/plan.md",
    ]),
    ["Client/src/lib/a.ts", "Server/ws/hub.go", "Client/src-tauri/src/lib.rs"],
  );
});

test("a file may not gain ids, a file that lost some must be lowered, and the cap tracks the total", () => {
  assert.deepEqual(compare({ a: 2 }, { a: 2 }, 2), []);
  assert.match(compare({ a: 3 }, { a: 2 }, 2)[0], /a: 3 .* allows 2/);
  assert.match(compare({ b: 1 }, {}, 0)[0], /b: 1 .* allows 0/);
  assert.match(compare({ a: 1 }, { a: 2 }, 2)[0], /Lower the row/);
  assert.match(compare({ a: 2 }, { a: 2 }, 1)[0], /above TOTAL_CAP/);
  assert.match(compare({ a: 2 }, { a: 2 }, 3)[0], /lower TOTAL_CAP to 2/);
});

test("the tree matches the committed baseline", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "Client/src", "Client/src-tauri/src", "Client/tests", "Server"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  assert.deepEqual(compare(countTree(ROOT, files), baseline, TOTAL_CAP), []);
});
