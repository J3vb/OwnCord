// Self-test for scripts/claude-hook.mjs `pre-bash` and cloud `session-start`: spawns the hook the way
// Claude Code does (JSON on stdin) and checks the exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./claude-hook.mjs", import.meta.url));

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

test("runs the real hook from a checkout path containing spaces, # and %", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hook spaces # %-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(new URL("./claude-hook.mjs", import.meta.url), join(dir, "claude-hook.mjs"));
  const suite = join(dir, "claude-hook.test.mjs");
  copyFileSync(new URL(import.meta.url), suite);
  // Reuse every policy case without recursively running this fixture or the cloud setup.
  // The nested runner must report its own results rather than inherit the parent test IPC.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern=^(blocks:|allows:)", suite],
    { cwd: dir, env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, new RegExp(`# tests ${blocked.length + allowed.length}\\b`));
});

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
  const ledgerDriver = spawnSync("git", ["config", "merge.findings-ledger.driver"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  rmSync(dir, { recursive: true, force: true });
  return { ...run, hooksPath, ledgerDriver };
}

test("cloud session-start installs the git hooks", () => {
  const run = cloudStart();
  assert.equal(run.status, 0);
  assert.equal(run.hooksPath, ".githooks");
  assert.equal(run.ledgerDriver, "node scripts/merge-ledger.mjs %O %A %B %P");
  assert.doesNotMatch(run.stdout, /hooks are not installed/);
});

test("cloud session-start warns, not fails, when npm ci fails", () => {
  const run = cloudStart((dir) => writeFileSync(join(dir, "package-lock.json"), "not json"));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /npm ci failed in \./);
});
