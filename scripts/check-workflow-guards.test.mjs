import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  auditWorkflow,
  autoConfirmEnablers,
  autoConfirmIsDefault,
  gstreamerBuildDepsMissing,
  signingKeyHolders,
} from "./check-workflow-guards.mjs";

const good = [
  "name: X",
  "jobs:",
  "  j:",
  "    concurrency:",
  "      group: x-${{ github.event.issue.number }}",
  "      cancel-in-progress: true",
  "    if: |",
  "      contains(fromJSON('[\"someone\"]'), github.actor) && true",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 30",
].join("\n");

const missing = (src) => auditWorkflow(src).map((f) => f.name);

test("a fully guarded workflow reports nothing", () => {
  assert.equal(auditWorkflow(good).length, 0);
});

test("a missing timeout-minutes is caught", () => {
  assert.ok(missing(good.replace("    timeout-minutes: 30", "")).includes("timeout-minutes"));
});

test("a missing concurrency group is caught", () => {
  assert.ok(missing(good.replace("concurrency:", "# concurrency:")).includes("concurrency group"));
});

test("concurrency on a different job or at workflow level does not count", () => {
  const body = good.split("\n").slice(3, 6);
  const bare = good.replace(body.join("\n") + "\n", "");
  const other = (extra) => bare.replace("jobs:\n", "jobs:\n" + extra);
  assert.ok(missing(other("  other:\n" + body.join("\n") + "\n")).includes("concurrency group"));
  assert.ok(
    missing("concurrency:\n  group: g\n  cancel-in-progress: true\n" + bare).includes(
      "concurrency group",
    ),
  );
});

test("concurrency keys outside the gated job's own concurrency block do not count", () => {
  const bare = good.replace(/    concurrency:\n.*\n.*\n/, "");
  const other = "\n  other:\n    concurrency:\n      group: g\n      cancel-in-progress: true\n";
  // concurrency only on an unrelated job, which sits after the gated one
  assert.ok(missing(bare + other).includes("concurrency group"));
  assert.ok(missing(bare + other).includes("cancel-in-progress"));
  // keys elsewhere in the gated job, with a concurrency block that lacks them
  const stray = bare.replace(
    "    runs-on",
    "    concurrency:\n      queue: x\n    env:\n      group: g\n      cancel-in-progress: true\n    runs-on",
  );
  assert.ok(missing(stray).includes("concurrency group"));
  assert.ok(missing(stray).includes("cancel-in-progress"));
});

test("every actor-gated job needs its own concurrency block", () => {
  const second = "\n  second:\n    if: github.actor == 'x'\n    runs-on: ubuntu-latest";
  assert.ok(missing(good + second).includes("concurrency group"));
  assert.ok(missing(good + second).includes("cancel-in-progress"));
});

test("a gated job header with a trailing comment or quoted key still splits", () => {
  for (const header of ["  second: # metered job", '  "second":', "  'second': # x"]) {
    const second = `\n${header}\n    if: github.actor == 'x'\n    runs-on: ubuntu-latest`;
    assert.ok(missing(good + second).includes("concurrency group"), header);
  }
});

test("cancel-in-progress: false is caught", () => {
  assert.ok(
    missing(good.replace("  cancel-in-progress: true", "  cancel-in-progress: false")).includes(
      "cancel-in-progress",
    ),
  );
});

test("a condition with no actor term is caught", () => {
  assert.ok(
    missing(good.replace("contains(fromJSON('[\"someone\"]'), github.actor) && ", "")).includes(
      "actor allowlist",
    ),
  );
});

// The shapes that must NOT trip it.
test("any positive timeout satisfies the check, not one specific value", () => {
  assert.equal(auditWorkflow(good.replace("timeout-minutes: 30", "timeout-minutes: 5")).length, 0);
});

test("the concurrency key is not prescribed, only its presence", () => {
  assert.equal(auditWorkflow(good.replace("github.event.issue.number", "github.ref")).length, 0);
});

// A commented-out guard is not a guard.
test("a commented-out timeout does not count", () => {
  assert.ok(
    missing(good.replace("    timeout-minutes: 30", "    # timeout-minutes: 30")).includes(
      "timeout-minutes",
    ),
  );
});

// The updater signing key is released to release.yml only.
test("the signing key referenced outside release.yml is caught", () => {
  const ref = "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}";
  assert.deepEqual(
    signingKeyHolders([
      { name: "release.yml", src: ref },
      { name: "ci.yml", src: ref },
      { name: "nightly.yml", src: "run: npm run tauri build" },
    ]),
    ["ci.yml"],
  );
});

test("the signing key password counts as the key", () => {
  assert.deepEqual(
    signingKeyHolders([
      { name: "ci.yml", src: "p: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}" },
    ]),
    ["ci.yml"],
  );
});

test("the signing key read by bracket or set as an env var from another secret is caught", () => {
  assert.deepEqual(
    signingKeyHolders([
      { name: "a.yml", src: "k: ${{ secrets['TAURI_SIGNING_PRIVATE_KEY'] }}" },
      { name: "b.yml", src: "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.OTHER_ALIAS }}" },
    ]),
    ["a.yml", "b.yml"],
  );
});

// e2e-auto-confirm skips the native cert-pin dialog; only ci.yml's E2E build may enable it.
test("e2e-auto-confirm enabled outside ci.yml is caught", () => {
  const on = "run: npm run tauri build -- --features e2e-auto-confirm";
  assert.deepEqual(
    autoConfirmEnablers([
      { name: "ci.yml", src: on },
      { name: "release.yml", src: on },
      { name: "nightly.yml", src: "run: npm run tauri build" },
    ]),
    ["release.yml"],
  );
});

test("e2e-auto-confirm in the default features is caught", () => {
  assert.equal(
    autoConfirmIsDefault('[features]\ndefault = ["devtools", "e2e-auto-confirm"]\n'),
    true,
  );
  assert.equal(autoConfirmIsDefault("[features]\ndefault = []\ne2e-auto-confirm = []\n"), false);
});

// The Linux client links gstreamer-rs (native camera), so every apt install that
// sets up a Tauri build (it carries libwebkit2gtk-4.1-dev) needs the GStreamer
// dev packages too, or gstreamer-sys's pkg-config probe fails the build.
test("a Tauri build install without the GStreamer dev packages is caught", () => {
  const install = (...pkgs) =>
    ["      - run: |", "          sudo apt-get update", "          sudo apt-get install -y \\"]
      .concat(pkgs.map((p, i) => `            ${p}${i < pkgs.length - 1 ? " \\" : ""}`))
      .join("\n");
  assert.deepEqual(
    gstreamerBuildDepsMissing([
      {
        name: "full.yml",
        src: install(
          "libwebkit2gtk-4.1-dev",
          "libgstreamer1.0-dev",
          "libgstreamer-plugins-base1.0-dev",
        ),
      },
      { name: "bare.yml", src: install("libwebkit2gtk-4.1-dev", "libgtk-3-dev") },
      {
        name: "half.yml",
        src: `${install("libwebkit2gtk-4.1-dev", "libgstreamer1.0-dev")}\n${install("k6")}`,
      },
      { name: "driver.yml", src: install("webkit2gtk-driver", "xvfb") },
    ]),
    ["bare.yml", "half.yml"],
  );
});
