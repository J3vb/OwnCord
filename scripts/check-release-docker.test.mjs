// OC-0448: structural checks plus execution of the REAL release shell steps.
// Like check-release-environment, use the workflow's indentation contract, not
// a second YAML dependency. actionlint owns YAML/expression validation. The
// fake registry owns only external responses: verification/promotion logic is
// extracted from release.yml so a regression is exercised before tag time.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { splitJobs } from "./check-release-environment.mjs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const jobs = splitJobs(workflow);
const job = jobs.find((j) => j.name === "release-server-docker").body;
const steps = job
  .split(/(?=^      - )/m)
  .slice(1)
  .map((body) => body.replace(/^\s*#.*$/gm, ""));
const step = (id) => {
  const found = steps.find((s) => s.includes(`        id: ${id}\n`));
  assert.ok(found, `missing release step: ${id}`);
  return found;
};
const script = (body) => {
  const match = body.match(/^        run: (.*)\n?([\s\S]*)/m);
  assert.ok(match, "expected a run step");
  return match[1] === "|"
    ? match[2]
        .split("\n")
        .filter((l) => l.startsWith("          "))
        .map((l) => l.slice(10))
        .join("\n")
    : match[1];
};

test("release uploads only by digest and promotes once, after every verification", () => {
  const build = step("build");
  assert.match(
    build,
    /outputs: type=image,name=ghcr\.io\/\$\{\{ steps\.owner\.outputs\.lower \}\}\/owncord-server,push-by-digest=true,name-canonical=true\s*$/m,
  );
  assert.match(build, /^          push: true$/m);
  assert.doesNotMatch(build, /^          tags:/m, "build must not assign release tags");
  assert.match(build, /^          sbom: true$/m);
  assert.match(build, /^          provenance: mode=max$/m);
  assert.match(build, /platforms: linux\/amd64,linux\/arm64/);
  assert.equal(steps.filter((s) => s.includes("uses: docker/build-push-action@")).length, 1);

  const attest = steps.find((s) => s.includes("uses: actions/attest-build-provenance@"));
  assert.ok(attest, "provenance signing must remain");
  assert.match(attest, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(attest, /push-to-registry: true/);
  const ordered = [
    build,
    step("verify-manifest"),
    step("verify-configs"),
    attest,
    step("verify-attestation"),
    step("promote-tags"),
  ];
  const positions = ordered.map((s) => steps.indexOf(s));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.equal(steps.at(-1), step("promote-tags"), "no verification may follow a tag write");
  assert.equal(steps.filter((s) => /imagetools create/.test(s)).length, 1);
  assert.doesNotMatch(
    job.replace(/^\s*#.*$/gm, ""),
    /^\s*(?:if|continue-on-error):/m,
    "verification and promotion must retain default success-only execution",
  );

  for (const id of ["verify-manifest", "verify-configs", "promote-tags"]) {
    assert.match(
      step(id),
      /IMAGE: ghcr\.io\/\$\{\{ steps\.owner\.outputs\.lower \}\}\/owncord-server/,
    );
    assert.match(step(id), /DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
    assert.match(script(step(id)), /"\$IMAGE@\$DIGEST"/);
  }
  assert.match(
    step("verify-configs"),
    /SMOKED_AMD64: \$\{\{ needs\.smoke-server-docker\.outputs\.imageid-amd64 \}\}/,
  );
  assert.match(
    step("verify-configs"),
    /SMOKED_ARM64: \$\{\{ needs\.smoke-server-docker\.outputs\.imageid-arm64 \}\}/,
  );
  assert.match(
    step("verify-attestation"),
    /STEPS_BUILD_OUTPUTS_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/,
  );
  assert.match(
    step("verify-attestation"),
    /STEPS_OWNER_OUTPUTS_LOWER: \$\{\{ steps\.owner\.outputs\.lower \}\}/,
  );
  assert.match(step("promote-tags"), /TAGS: \$\{\{ steps\.meta\.outputs\.tags \}\}/);
});

test("native smokes, upgrade rehearsal, approval and downstream release remain gates", () => {
  assert.match(job, /needs: \[smoke-server-docker, upgrade-rehearsal\]/);
  assert.match(job, /^    environment: release$/m);
  const smoke = jobs.find((j) => j.name === "smoke-server-docker").body;
  assert.match(smoke, /os: ubuntu-latest\n\s+arch: amd64/);
  assert.match(smoke, /os: ubuntu-22\.04-arm\n\s+arch: arm64/);
  assert.match(smoke, /bash Server\/scripts\/docker-smoke\.sh owncord-smoke:candidate/);
  assert.match(
    jobs.find((j) => j.name === "upgrade-rehearsal").body,
    /uses: \.\/\.github\/workflows\/upgrade-rehearsal\.yml/,
  );
  assert.match(jobs.find((j) => j.name === "publish").body, /release-server-docker,/);
});

const image = "ghcr.io/j3vb/owncord-server";
const digest = `sha256:${"a".repeat(64)}`;
const tags = ["1.2.3", "1.2", "latest"].map((t) => `${image}:${t}`);
const oldTags = Object.fromEntries(tags.map((t, i) => [t, `old-${i}`]));

// Fail closed on unexpected commands/references. In particular, an inspect of
// :latest instead of the candidate digest cannot accidentally pass this fake.
const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const { STATE, EVENTS, CASE, IMAGE, DIGEST } = process.env;
const tool = path.basename(process.argv[1]);
fs.appendFileSync(EVENTS, JSON.stringify([tool, ...args]) + "\\n");
if (tool === "gh") {
  assert.deepEqual(args, ["attestation", "verify", "oci://" + IMAGE + "@" + DIGEST, "--repo", "J3vb/OwnCord"]);
  process.exit(CASE === "attestation" ? 1 : 0);
}
assert.deepEqual(args.slice(0, 2), ["buildx", "imagetools"]);
if (args[2] === "create") {
  assert.equal(args.at(-1), IMAGE + "@" + DIGEST);
  const state = JSON.parse(fs.readFileSync(STATE));
  for (let i = 3; i < args.length - 1; i += 2) {
    assert.equal(args[i], "--tag");
    assert.ok(Object.hasOwn(state, args[i + 1]));
    state[args[i + 1]] = DIGEST;
  }
  fs.writeFileSync(STATE, JSON.stringify(state));
} else {
  assert.equal(args[2], "inspect");
  if (CASE === "inspect-error") process.exit(1);
  if (args.includes("--raw")) {
    const arch = args[3].split("@sha256:platform-")[1];
    assert.ok(["amd64", "arm64"].includes(arch));
    console.log(JSON.stringify({config: {digest: CASE === "mismatch-" + arch ? "different" : "sha256:config-" + arch}}));
  } else {
    assert.equal(args[3], IMAGE + "@" + DIGEST);
    if (args.includes("--format")) {
      const arch = args.at(-1).includes('"amd64"') ? "amd64" : "arm64";
      console.log(CASE === "missing-image-" + arch ? "" : "sha256:platform-" + arch);
    } else {
      console.log(["amd64", "arm64"].filter((a) => CASE !== "missing-arch-" + a).map((a) => "linux/" + a).join("\\n"));
    }
  }
}
`;

function runPublication(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "owncord-release-"));
  try {
    for (const tool of ["docker", "gh"]) writeFileSync(join(dir, tool), fake, { mode: 0o755 });
    const state = join(dir, "tags.json");
    const events = join(dir, "events.jsonl");
    writeFileSync(state, JSON.stringify(oldTags));
    writeFileSync(events, "");
    const env = {
      ...process.env,
      PATH: dir + delimiter + process.env.PATH,
      STATE: state,
      EVENTS: events,
      CASE: scenario,
      IMAGE: image,
      DIGEST: digest,
      TAGS: scenario === "empty-tags" ? "" : tags.join("\n"),
      SMOKED_AMD64: scenario === "empty-smoke-amd64" ? "" : "sha256:config-amd64",
      SMOKED_ARM64: scenario === "empty-smoke-arm64" ? "" : "sha256:config-arm64",
      STEPS_OWNER_OUTPUTS_LOWER: "j3vb",
      STEPS_BUILD_OUTPUTS_DIGEST: digest,
      GITHUB_REPOSITORY: "J3vb/OwnCord",
      GH_TOKEN: "test-only",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      DRY_RUN: scenario === "dry-run" ? "true" : "false",
    };
    let status = 0;
    let output = "";
    // Actual file order, not a second copy of the intended order. Stop just as
    // Actions does on a failed step; the structural test forbids bypass flags.
    for (const body of steps.filter((s) => /id: (verify-|promote-tags)/.test(s))) {
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script(body)],
        { env, encoding: "utf8" },
      );
      assert.ifError(result.error);
      status = result.status;
      output += result.stdout + result.stderr;
      if (status !== 0) break;
    }
    return {
      status,
      output,
      tags: JSON.parse(readFileSync(state)),
      events: readFileSync(events, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("success promotes all release tags in one command from the verified index", () => {
  const result = runPublication("success");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.tags, Object.fromEntries(tags.map((t) => [t, digest])));
  const creates = result.events.filter((e) => e[3] === "create");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], [
    "docker",
    "buildx",
    "imagetools",
    "create",
    ...tags.flatMap((t) => ["--tag", t]),
    `${image}@${digest}`,
  ]);
  assert.equal(result.events.at(-2)[0], "gh", "attestation must verify before promotion");
  assert.deepEqual(result.events.at(-1), creates[0]);
});

test("dry-run verifies everything, then leaves every release tag unchanged", () => {
  const result = runPublication("dry-run");
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.tags, oldTags);
  assert.ok(!result.events.some((e) => e[3] === "create"), "a dry run may not write a tag");
  assert.equal(result.events.at(-1)[0], "gh", "a dry run still verifies the attestation");
  assert.match(result.output, /Dry run: would promote/);
});

for (const scenario of [
  "missing-arch-amd64",
  "missing-arch-arm64",
  "inspect-error",
  "empty-smoke-amd64",
  "empty-smoke-arm64",
  "missing-image-amd64",
  "missing-image-arm64",
  "mismatch-amd64",
  "mismatch-arm64",
  "attestation",
  "empty-tags",
]) {
  test(`${scenario}: failure leaves every release tag unchanged`, () => {
    const result = runPublication(scenario);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.tags, oldTags);
    assert.ok(!result.events.some((e) => e[3] === "create"), "no tag write may be attempted");
  });
}
