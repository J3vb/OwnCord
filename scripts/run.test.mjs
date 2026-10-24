import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
// Use Node's absolute path, but leave build tools (and git) unavailable.
// Listing must not execute a task or require a prepared checkout.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
env.PATH = "";

function list(...args) {
  return spawnSync(process.execPath, [runner, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function taskNames(stdout) {
  return stdout.split("\n").filter((line) => line.length > 0 && !/^\s/.test(line));
}

test("bare invocation and --list retain the full task listing", () => {
  const bare = list();
  const all = list("--list");
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(bare.stdout, all.stdout);
  assert.ok(taskNames(all.stdout).includes("check:server"));
  assert.ok(taskNames(all.stdout).includes("check:rust"));
});

test("--list check:rust prints only that task without installed build tools", () => {
  const result = list("--list", "check:rust");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(taskNames(result.stdout), ["check:rust"]);
  assert.match(result.stdout, /cargo test --lib\s+\(in Client\/src-tauri\)/);
  assert.doesNotMatch(result.stdout, /go build|npm ci|passed|FAILED/);
});

test("filtered output matches the task's section in the full listing", () => {
  const all = list("--list");
  const selected = list("--list", "check:client");
  assert.equal(all.status, 0, all.stderr);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(taskNames(selected.stdout), ["check:client"]);
  const section = all.stdout.split("\ncheck:client\n")[1]?.split("\ncheck:rust\n")[0];
  assert.ok(section, "full listing contains the client section");
  assert.equal(selected.stdout.trim(), ("check:client\n" + section).trim());
});

test("--list rejects an unknown task instead of printing unrelated commands", () => {
  const result = list("--list", "check:typo");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown task: check:typo/);
  assert.match(result.stderr, /known:.*check:rust/);
});

test("--list rejects inherited object properties as task names", () => {
  for (const name of ["toString", "__proto__"]) {
    const result = list("--list", name);
    assert.equal(result.status, 2, name);
    assert.equal(result.stdout, "", name);
    assert.match(result.stderr, /unknown task:/);
  }
});

test("--list rejects extra arguments rather than silently ignoring them", () => {
  const result = list("--list", "check:rust", "check:client");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /usage:.*--list.*task/);
});

test("a missing executable reports the command and working directory", () => {
  const fixture = mkdtempSync(join(tmpdir(), "owncord-runner-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "Server"));
    mkdirSync(join(fixture, "Client", "src-tauri"), { recursive: true });
    copyFileSync(runner, join(fixture, "scripts", "run.mjs"));
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts", "run.mjs"), "check:rust"],
      {
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAILED: cargo fmt --all -- --check\s+\[in Client\/src-tauri\]/);
    assert.match(result.stderr, /not installed or not on PATH/);
    assert.doesNotMatch(result.stderr, /working directory does not exist/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a missing working directory is not reported as a missing executable", () => {
  const fixture = mkdtempSync(join(tmpdir(), "owncord-runner-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "Server"));
    mkdirSync(join(fixture, "Client"));
    copyFileSync(runner, join(fixture, "scripts", "run.mjs"));
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts", "run.mjs"), "check:rust"],
      {
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAILED: cargo fmt --all -- --check\s+\[in Client\/src-tauri\]/);
    assert.match(result.stderr, /working directory does not exist/);
    assert.doesNotMatch(result.stderr, /not installed or not on PATH/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("--help is short and works without build tools", () => {
  for (const flag of ["--help", "-h"]) {
    const result = list(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /usage:/);
    assert.match(result.stdout, /--list.*--json/);
    assert.match(result.stdout, /check:rust/);
    assert.doesNotMatch(result.stdout, /cargo clippy|passed|FAILED/);
  }
});

test("JSON listings expose command arguments and directories without terminal text", () => {
  for (const args of [
    ["--list", "check:rust", "--json"],
    ["--list", "--json", "check:rust"],
  ]) {
    const result = list(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(plan), ["check:rust"]);
    assert.deepEqual(plan["check:rust"][1], {
      cmd: "cargo",
      args: ["test", "--lib"],
      cwd: "Client/src-tauri",
      label: "",
    });
  }
});

test("full JSON listings retain optional-tool metadata", () => {
  const result = list("--list", "--json");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan["check:server"].some((step) => step.probe === "sqlc" && step.why));
  assert.ok(plan["check:client"].length > 0);
});

test("invalid execution arguments fail before checking the environment or running tools", () => {
  for (const args of [["check:rust", "extra"], ["--json"], ["--help", "extra"]]) {
    const result = list(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage:/);
    assert.doesNotMatch(result.stderr, /run this from|FAILED|TypeError/);
  }
  for (const name of ["check:typo", "toString", "__proto__"]) {
    const result = list(name);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown task:/);
    assert.doesNotMatch(result.stderr, /run this from|TypeError/);
  }
});

test("JSON listing rejects duplicate or unknown options without partial output", () => {
  for (const args of [
    ["--list", "--json", "--json"],
    ["--list", "check:rust", "--typo"],
  ]) {
    const result = list(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
});

test("piped JSON, help and validation errors finish writing before exit", () => {
  // Pipes may write asynchronously. Defer writes deterministically so this
  // regression is portable instead of depending on pipe capacity or the OS.
  const delayedOutput =
    "data:text/javascript," +
    encodeURIComponent(
      "for (const stream of [process.stdout, process.stderr]) {" +
        " const write = stream.write.bind(stream);" +
        " stream.write = (...args) => { setTimeout(() => write(...args), 10); return true; };" +
        "}",
    );
  for (const args of [["--list", "check:rust", "--json"], ["--help"], ["--list", "check:typo"]]) {
    const result = spawnSync(process.execPath, ["--import", delayedOutput, runner, ...args], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (args.includes("--json")) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["check:rust"]);
    } else if (args.includes("--help")) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /usage:/);
      assert.match(result.stdout, /Tasks:.*check:rust/);
    } else {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /unknown task: check:typo/);
      assert.match(result.stderr, /known:.*check:rust/);
    }
  }
});

test("a failing check preserves its exit code and stops later steps", () => {
  const fixture = mkdtempSync(join(tmpdir(), "owncord-runner-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "Server"));
    mkdirSync(join(fixture, "Client"));
    copyFileSync(runner, join(fixture, "scripts", "run.mjs"));
    writeFileSync(join(fixture, "scripts", "check-doc-counts.mjs"), "process.exitCode = 7;");
    const marker = join(fixture, "unexpected-next-step");
    writeFileSync(
      join(fixture, "scripts", "check-doc-citations.test.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
    );
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts", "run.mjs"), "check:docs"],
      {
        env: { ...env, PATH: dirname(process.execPath) },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stderr, /FAILED: node scripts\/check-doc-counts.mjs exited 7/);
    assert.equal(existsSync(marker), false, "later check did not run");
    assert.doesNotMatch(result.stdout, /check:docs: passed/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
