import { strict as assert } from "node:assert";
import { test } from "node:test";
import { auditReleaseEnvironment } from "./check-release-environment.mjs";

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
