import assert from "node:assert/strict";
import test from "node:test";
import { FUZZ_TAGS, buildPlan, isTaggedFuzzFile, parseFuzzList } from "./fuzz-ci.mjs";

const listing = [
  "FuzzA",
  "FuzzB",
  "ok  \tgithub.com/J3vb/OwnCord/Server/api\t0.051s",
  "ok  \tgithub.com/J3vb/OwnCord/Server/config\t0.010s",
  "?   \tgithub.com/J3vb/OwnCord/Server/cmd/x\t[no test files]",
  "FuzzC",
  "ok  \tgithub.com/J3vb/OwnCord/Server/ws\t0.2s",
].join("\n");

test("groups targets under the package line that follows them", () => {
  assert.deepEqual(
    [...parseFuzzList(listing)],
    [
      ["github.com/J3vb/OwnCord/Server/api", ["FuzzA", "FuzzB"]],
      ["github.com/J3vb/OwnCord/Server/ws", ["FuzzC"]],
    ],
  );
});

test("a package with no targets is left out, and stray targets fail closed", () => {
  assert.equal(parseFuzzList("ok  \tx/config\t0.1s\n").size, 0);
  assert.throws(() => parseFuzzList("FuzzLost\n"), /no package line/);
});

test("tagged targets run once, with tags, only when the default build lacks them", () => {
  const plain = new Map([["p", ["FuzzA"]]]);
  const tagged = new Map([["p", ["FuzzA", "FuzzOtel"]]]);
  assert.deepEqual(buildPlan(plain, tagged), [
    { pkg: "p", target: "FuzzA", tags: "" },
    { pkg: "p", target: "FuzzOtel", tags: FUZZ_TAGS },
  ]);
});

test("an empty plan fails closed", () => {
  assert.throws(() => buildPlan(new Map(), new Map()), /No fuzz targets/);
});

test("spots a fuzz file behind a build constraint", () => {
  assert.equal(
    isTaggedFuzzFile("//go:build otel\n\npackage x\n\nfunc FuzzX(f *testing.F) {}\n"),
    true,
  );
  assert.equal(isTaggedFuzzFile("package x\n\nfunc FuzzX(f *testing.F) {}\n"), false);
  assert.equal(
    isTaggedFuzzFile("//go:build otel\n\npackage x\n\nfunc TestX(t *testing.T) {}\n"),
    false,
  );
});
