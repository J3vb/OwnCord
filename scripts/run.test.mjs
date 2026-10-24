import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
