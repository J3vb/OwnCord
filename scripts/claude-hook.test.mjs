// Self-test for scripts/claude-hook.mjs `pre-bash`: spawns the hook the way
// Claude Code does (JSON on stdin) and checks the exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
