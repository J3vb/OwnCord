// Self-test for scripts/claude-hook.mjs `pre-bash` and cloud `session-start`: spawns the hook the way
// Claude Code does (JSON on stdin) and checks the exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hook = new URL("./claude-hook.mjs", import.meta.url).pathname;

function exitCode(command) {
  return spawnSync("node", [hook, "pre-bash"], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  }).status;
}

const blocked = [
  "cd Client",
  "ls && cd Client",
  "if test -d Client; then cd Client; fi",
  "{ cd Client; npm test; }",
  "for d in a; do cd $d; done",
  "if false; then :; else cd x; fi",
  "true & cd x",
  "echo hi | cd x",
  "cat Server/.env",
  "cat .env",
  "sed -n 1p .env",
  `python3 -c "open('.env')"`,
  "case x in x) cd Client;; esac",
  "cat<.env",
  "cat .env>out",
  "cat<./.env>out",
];

const allowed = [
  "( cd Client && npm test )",
  "git -C Client status",
  "cat .env.example",
  "ls",
  'echo "cdrom"',
  "grep -rn foo docs/.envoy",
];

for (const command of blocked) {
  test(`blocks: ${command}`, () => assert.equal(exitCode(command), 2));
}
for (const command of allowed) {
  test(`allows: ${command}`, () => assert.equal(exitCode(command), 0));
}

// session-start in a Claude Code cloud session, run in a throwaway git repo.
function cloudStart(setup) {
  const dir = mkdtempSync(join(tmpdir(), "claude-hook-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  setup?.(dir);
  const env = { ...process.env, CLAUDE_CODE_REMOTE: "true", HOME: dir };
  delete env.CLAUDE_ENV_FILE;
  const run = spawnSync("node", [hook, "session-start"], { cwd: dir, env, encoding: "utf8" });
  const hooksPath = spawnSync("git", ["config", "core.hooksPath"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  rmSync(dir, { recursive: true, force: true });
  return { ...run, hooksPath };
}

test("cloud session-start installs the git hooks", () => {
  const run = cloudStart();
  assert.equal(run.status, 0);
  assert.equal(run.hooksPath, ".githooks");
  assert.doesNotMatch(run.stdout, /hooks are not installed/);
});

test("cloud session-start warns, not fails, when npm ci fails", () => {
  const run = cloudStart((dir) => writeFileSync(join(dir, "package-lock.json"), "not json"));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /npm ci failed in \./);
});
