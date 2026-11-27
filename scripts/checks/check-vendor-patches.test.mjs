import { strict as assert } from "node:assert";
import { test } from "node:test";
import { check, compare, documentedTags, markersIn } from "./check-vendor-patches.mjs";

const DOC = [
  "# Doc",
  "",
  "## Marker index",
  "",
  "- `OWNCORD-PATCH (alpha)`",
  "  - Where: here",
  "- `OWNCORD-PATCH (beta)`",
  "",
  "## Other",
  "- `OWNCORD-PATCH (gamma)`",
].join("\n");

test("markers are read by tag, and a bare marker is reported", () => {
  const src = [
    "// OWNCORD-PATCH (alpha): why",
    "x(); // OWNCORD-PATCH (beta)",
    "// See OWNCORD-PATCH.md.",
    "// OWNCORD-PATCH without a tag",
  ].join("\n");
  const { tags, bare } = markersIn(src, "a.rs");
  assert.deepEqual([...tags].sort(), ["alpha", "beta"]);
  assert.deepEqual(bare, ["a.rs:4"]);
});

test("only the Marker index section counts as documentation", () => {
  assert.deepEqual(documentedTags(DOC), ["alpha", "beta"]);
  assert.equal(documentedTags("# no index"), null);
});

test("a marker with no entry fails", () => {
  const out = compare(new Set(["alpha", "beta", "new"]), [], ["alpha", "beta"]);
  assert.deepEqual(out, ['marker "new" is in the source but not in OWNCORD-PATCH.md']);
});

test("an entry whose marker is gone fails", () => {
  const out = compare(new Set(["alpha"]), [], ["alpha", "beta"]);
  assert.deepEqual(out, ['"beta" is in OWNCORD-PATCH.md but no marker is left']);
});

test("a duplicate entry, a tagless marker and a missing index fail", () => {
  assert.equal(compare(new Set(["a"]), [], ["a", "a"]).length, 1);
  assert.equal(compare(new Set(["a"]), ["x.rs:1"], ["a"]).length, 1);
  assert.equal(compare(new Set(), [], null).length, 1);
});

test("every marker in the vendored livekit source is documented, and the reverse", () => {
  const { tags, problems } = check();
  assert.ok(tags.size > 0, "no markers found: the scan path is wrong");
  assert.deepEqual(problems, []);
});
