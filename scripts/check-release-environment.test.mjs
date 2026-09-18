import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditArtifactPathLists, auditReleaseEnvironment } from "./check-release-environment.mjs";

const realReleaseWorkflow = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".github/workflows/release.yml"),
  "utf8",
);

const workflow = (jobsSrc) => `name: X\n\non:\n  push:\n    tags: ["v*"]\n\njobs:\n${jobsSrc}`;

test("a guarded push job reports nothing", () => {
  const guardedScalar = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    environment: release",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: docker build",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert.equal(auditReleaseEnvironment(guardedScalar).length, 0);
});

test("an unguarded push: true job is caught by name", () => {
  const unguardedScalar = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  const missingScalar = auditReleaseEnvironment(unguardedScalar);
  assert.equal(missingScalar.length, 1);
  assert.equal(missingScalar[0].name, "release-server-docker");
});

// Task 3 of B6-12: `push-to-registry: true` publishes an attestation into the
// public registry for the image the job just pushed, so a job carrying only
// that marker publishes something and must be gated exactly as `push: true` is.
test("an unguarded push-to-registry: true job is caught by name", () => {
  const unguardedRegistryPush = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/attest-build-provenance@v4",
      "        with:",
      "          push-to-registry: true",
    ].join("\n"),
  );
  const missing = auditReleaseEnvironment(unguardedRegistryPush);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, "release-server-docker");
});

test("an unguarded gh release create job is caught", () => {
  const unguardedGhRelease = workflow(
    [
      "  publish:",
      "    needs: [release-server-docker]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gh release create ${{ github.ref_name }} assets/*",
    ].join("\n"),
  );
  assert.ok(
    auditReleaseEnvironment(unguardedGhRelease)
      .map((j) => j.name)
      .includes("publish"),
  );
});

// Item (d) from the review: the audit must derive gated jobs from the file,
// not from a hardcoded job-name list, so a THIRD, never-before-seen
// publishing job is caught by its content alone.
test("a newly-added publishing job with no environment is caught, not just the two known job names", () => {
  const newPublishJob = workflow(
    [
      "  release-npm-package:",
      "    needs: [verify-versions]",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm publish",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert.ok(
    auditReleaseEnvironment(newPublishJob)
      .map((j) => j.name)
      .includes("release-npm-package"),
  );
});

// Item (e): the mapping form (`environment:` / `  name: release`) must not
// false-positive just because a later reviewer adds a `url:` under it.
test("the mapping environment form is accepted", () => {
  const mappingForm = workflow(
    [
      "  release-server-docker:",
      "    needs: verify-versions",
      "    environment:",
      "      name: release",
      "      url: https://ghcr.io",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: docker/build-push-action@v6",
      "        with:",
      "          push: true",
    ].join("\n"),
  );
  assert.equal(auditReleaseEnvironment(mappingForm).length, 0);
});

// A job that neither pushes nor releases (e.g. release-server, which only
// uploads a build artifact) is never gated — it has nothing to approve.
test("a job that only uploads a build artifact is not gated", () => {
  const nonPublishJob = workflow(
    [
      "  release-server:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/upload-artifact@v4",
    ].join("\n"),
  );
  assert.equal(auditReleaseEnvironment(nonPublishJob).length, 0);
});

// Proof this check would have caught the collateral damage from the
// rejected first attempt: a duplicated `environment:` key is still exactly
// one gate per job, so the audit reports it fine — the failure that patch
// caused is a YAML syntax error, which is actionlint's job, not this
// script's. This assertion documents that boundary rather than pretending
// to cover it.
test("a duplicated environment key still reads as present here — actionlint's syntax-check catches the duplicate, not this content-level audit", () => {
  const duplicateEnvironmentKey = workflow(
    [
      "  publish:",
      "    needs: [release-server-docker]",
      "    environment: release",
      "    environment: release",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: gh release create ${{ github.ref_name }} assets/*",
    ].join("\n"),
  );
  assert.equal(auditReleaseEnvironment(duplicateEnvironmentKey).length, 0);
});

// The B6-12 regression. `release-server` tarred its asset at the repository
// root but generated the SBOM under `Server/`, and listed both in one upload.
// upload-artifact roots the artifact at the least common ancestor of the
// search paths and strips exactly that prefix, so the SBOM arrived as
// `Server/chatserver-linux-amd64.tar.gz.cdx.json` while the checksum and
// `attest-sbom` steps looked for it at the artifact root — the `publish` job
// would have aborted on the first tag run. A list whose entries share a parent
// is uploadable; one that does not is the bug.
const pathList = (entries) =>
  [
    "    steps:",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: x",
    "          path: |",
  ].concat(entries.map((e) => `            ${e}`));

test("a path list mixing a repository-root entry with a nested one is caught", () => {
  const mixedParents = pathList([
    "chatserver-linux-amd64.tar.gz",
    "Server/chatserver-linux-amd64.tar.gz.cdx.json",
  ]).join("\n");
  const found = auditArtifactPathLists(mixedParents);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].paths, [
    "chatserver-linux-amd64.tar.gz",
    "Server/chatserver-linux-amd64.tar.gz.cdx.json",
  ]);
});

// Locks the parser pitfall: a root-level entry has no "/", so slicing at the
// last one would read "Server/foo" and "bar" as sharing the parent "bar"...
// and "foo" as its own parent ("fo"). The two belong to different parents.
test("a root-level entry is never mistaken for its own parent", () => {
  const rootAndNested = pathList(["foo", "Server/bar"]).join("\n");
  assert.equal(auditArtifactPathLists(rootAndNested).length, 1);
});

test("a path list whose entries share the Server parent passes", () => {
  const siblings = pathList(["Server/chatserver.exe", "Server/chatserver.exe.cdx.json"]).join("\n");
  assert.equal(auditArtifactPathLists(siblings).length, 0);
});

test("a single-entry path list is never mixed", () => {
  const single = pathList(["Server/chatserver.exe"]).join("\n");
  assert.equal(auditArtifactPathLists(single).length, 0);
});

// `subject-path: |` (release.yml's attest step) is not an `upload-artifact`
// list and gets no least-common-ancestor rooting, so this check deliberately
// skips it — it must neither be read as a `path:` list nor crash the parser.
test("a subject-path block is skipped, not parsed as a path list", () => {
  const underSubjectPath = [
    "    steps:",
    "      - uses: actions/attest-build-provenance@v4",
    "        with:",
    "          subject-path: |",
    "            windows/foo",
    "            bar",
  ].join("\n");
  assert.deepEqual(auditArtifactPathLists(underSubjectPath), []);
});

// The live file is the real fixture: after the fix, release.yml must report
// clean. Reads release.yml through the module under test, so a future edit
// that reintroduces a mixed list fails here, not on the tag run.
test("release.yml itself has no mixed path list", () => {
  assert.deepEqual(auditArtifactPathLists(realReleaseWorkflow), []);
});
