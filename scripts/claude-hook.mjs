// Claude Code hooks for this repository, wired in .claude/settings.json.
//
//   session-start  warn when the repo git hooks are not installed, so a clone
//                  or a new machine cannot silently run without them.
//   pre-bash       refuse a top-level `cd`. The Bash tool's shell is
//                  persistent, so a `cd` leaks its directory into every later
//                  command; a relative path then resolves somewhere else and a
//                  gate can report a green result from the wrong directory.
//                  Use a subshell `( cd DIR && ... )`, `git -C DIR`, or paths
//                  from the repository root instead.
//
// Exit code 2 from a PreToolUse hook blocks the tool call and shows stderr to
// the model; anything else lets it through.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.argv[2];

if (mode === "session-start") {
  let hooksPath = "";
  try {
    hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // unset: git exits 1
  }
  if (hooksPath !== ".githooks") {
    console.log(
      "WARNING: the repo git hooks are not installed (core.hooksPath is not .githooks). Run `npm run hooks:install` at the repository root.",
    );
  }
} else if (mode === "pre-bash") {
  let command = "";
  try {
    command = JSON.parse(readFileSync(0, "utf8")).tool_input?.command ?? "";
  } catch {
    // no or malformed input: nothing to check
  }
  // A `cd` that starts the command or follows a chain operator or newline is a
  // top-level statement; `( cd DIR && ... )` is not matched.
  if (/(^|\n|&&|\|\||;)\s*cd(\s|$)/.test(command)) {
    console.error(
      "Blocked: a top-level `cd` leaks the persistent shell cwd into every later command. Use a subshell `( cd DIR && ... )`, `git -C DIR`, or paths from the repository root.",
    );
    process.exit(2);
  }
}
