import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invocation, configuration, verifyArchive, run, RELEASE } from "./no-mistakes-cloud.mjs";

test("shipping always targets dev and transports intent as a literal file argument", () => {
  const result = invocation(["--intent-file", "intent $(not-a-command).md"]);
  assert.deepEqual(result.args.slice(0, 5), [
    "axi",
    "run",
    "--base-branch",
    "dev",
    "--intent-file",
  ]);
  assert.ok(result.args[5].endsWith("intent $(not-a-command).md"));
  assert.equal(result.args.includes("--skip"), false);
  assert.equal(result.args.includes("--yes"), false);
  assert.equal(result.args.includes("--no-publish-intent"), true);
});
test("the cloud profile preserves bounded review/repair and fresh repair validation", () => {
  const profile = JSON.parse(JSON.stringify(configuration()));
  assert.deepEqual(profile.agent, ["claude"]);
  assert.equal(profile.auto_fix.review, 3);
  assert.equal(profile.auto_fix.ci, 3);
  assert.equal(profile.ci.revalidate_repairs, true);
  assert.deepEqual(Object.keys(profile.ci).sort(), ["rerun_transient", "revalidate_repairs"]);
});
test("unsupported platforms and bypass flags cause no installation or execution", async () => {
  let called = false;
  await assert.rejects(
    run(["--setup"], {
      platform: "win32",
      remote: "true",
      execute: () => {
        called = true;
      },
    }),
    /cloud sessions/,
  );
  assert.equal(called, false);
  assert.throws(() => invocation(["--skip", "review"]));
  assert.throws(() => invocation(["--intent-file", "x", "--yes"]));
  assert.throws(() => verifyArchive(Buffer.from("unverified archive")), /digest mismatch/);
});
test("eligible fixes use the selected finding IDs without an approval override", () => {
  const command = invocation(["--fix-findings", "f1,f2"]);
  assert.deepEqual(command.args.slice(0, 6), [
    "axi",
    "respond",
    "--action",
    "fix",
    "--findings",
    "f1,f2",
  ]);
  assert.equal(command.args.includes("approve"), false);
  assert.equal(command.args.includes("--yes"), false);
  assert.equal(invocation(["--reattach"]).args.includes("--yes"), false);
  assert.throws(() => invocation(["--fix-findings", "f1; command"]));
});
test("setup validates the archive before extracting or initializing the gate", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  const calls = [];
  try {
    await assert.rejects(
      run(["--setup"], {
        platform: "linux",
        arch: "x64",
        remote: "true",
        home,
        fetcher: async () => ({ ok: true, arrayBuffer: async () => Buffer.from("bad") }),
        extract: () => calls.push("extract"),
        execute: () => calls.push("execute"),
      }),
      /digest mismatch/,
    );
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(home, "config.yaml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("setup uses isolated state, checks agent availability, then initializes", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  const calls = [];
  try {
    await run(["--setup"], {
      platform: "linux",
      arch: "x64",
      remote: "true",
      home,
      root: home,
      fetcher: async (url) => {
        assert.equal(url, RELEASE.url);
        return { ok: true, arrayBuffer: async () => Buffer.from("fixture") };
      },
      verify: () => calls.push("verified"),
      extract: () => calls.push("extracted"),
      probe: (cmd, args) => {
        assert.equal(cmd, "claude");
        assert.deepEqual(args, ["auth", "status"]);
        return true;
      },
      execute: (cmd, args, opts) => {
        calls.push(args[0]);
        assert.equal(opts.env.NM_HOME, home);
      },
    });
    assert.deepEqual(calls, ["verified", "extracted", "auth", "doctor", "init"]);
    assert.equal(
      JSON.parse(readFileSync(join(home, "config.yaml"), "utf8")).ci.revalidate_repairs,
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("a changed existing profile is never overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  try {
    writeFileSync(join(home, "config.yaml"), "custom");
    await assert.rejects(
      run(["--setup"], { platform: "linux", arch: "x64", remote: "true", home }),
      /refusing to overwrite/,
    );
    assert.equal(readFileSync(join(home, "config.yaml"), "utf8"), "custom");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("provider failure propagates instead of reporting successful validation", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  try {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "no-mistakes"), "");
    writeFileSync(join(home, "config.yaml"), JSON.stringify(configuration(), null, 2) + "\n");
    await assert.rejects(
      run(["--intent-file", "intent.md"], {
        platform: "linux",
        arch: "x64",
        remote: "true",
        home,
        execute: (cmd, args) => {
          assert.equal(args[0], "axi");
          throw new Error("provider unavailable");
        },
      }),
      /provider unavailable/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("Codex availability cannot compensate for signed-out Claude", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  const calls = [];
  try {
    await assert.rejects(
      run(["--setup"], {
        platform: "linux",
        arch: "x64",
        remote: "true",
        home,
        fetcher: async () => ({ ok: true, arrayBuffer: async () => Buffer.from("fixture") }),
        verify: () => {},
        extract: () => {},
        probe: (cmd, args) => {
          calls.push([cmd, ...args]);
          return cmd === "codex";
        },
        execute: () => {
          throw new Error("must not initialize");
        },
      }),
      /No authenticated/,
    );
    assert.deepEqual(calls, [["claude", "auth", "status"]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("all run commands reject an older Codex-enabled cloud profile before execution", async () => {
  const home = mkdtempSync(join(tmpdir(), "nm-cloud-test-"));
  try {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "no-mistakes"), "");
    writeFileSync(
      join(home, "config.yaml"),
      JSON.stringify({ ...configuration(), agent: ["codex", "claude"] }, null, 2) + "\n",
    );
    for (const argv of [
      ["--status"],
      ["--reattach"],
      ["--intent-file", "intent.md"],
      ["--fix-findings", "f1"],
    ]) {
      let executed = false;
      await assert.rejects(
        run(argv, {
          platform: "linux",
          arch: "x64",
          remote: "true",
          home,
          execute: () => {
            executed = true;
          },
        }),
        /start a fresh cloud session/,
      );
      assert.equal(executed, false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
