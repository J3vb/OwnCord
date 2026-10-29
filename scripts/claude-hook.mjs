// Claude Code hooks for this repository, wired in .claude/settings.json.
//
//   session-start  warn when the repo git hooks are not installed, so a clone
//                  or a new machine cannot silently run without them. In a
//                  Claude Code cloud session it installs them instead, plus
//                  Node 26 and the root and Client node_modules.
//   pre-bash       refuse a top-level `cd`. The Bash tool's shell is
//                  persistent, so a `cd` leaks its directory into every later
//                  command; a relative path then resolves somewhere else and a
//                  gate can report a green result from the wrong directory.
//                  Use a subshell `( cd DIR && ... )`, `git -C DIR`, or paths
//                  from the repository root instead. Also refuses a command
//                  that names a `.env` file (secrets).
//
// Exit code 2 from a PreToolUse hook blocks the tool call and shows stderr to
// the model; anything else lets it through.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const mode = process.argv[2];
// Claude Code cloud containers start with an older Node, no node_modules and
// no git hooks, so the pre-commit gates never ran there and the same CI
// failures (prettier, mutation shards, Node-26-only tests) kept coming back.
const cloud = process.env.CLAUDE_CODE_REMOTE === "true";
const NODE_MAJOR = 26;
const NVM = "/opt/nvm/nvm.sh";

// Node 26 via the container's nvm, put on PATH for every later Bash call
// through CLAUDE_ENV_FILE, then node_modules where missing. Every failure is a
// warning: the session must start even with no network.
function cloudToolchain() {
  let bin = "";
  if (Number(process.versions.node.split(".")[0]) === NODE_MAJOR) {
    // the major both package.json engines pin: only node_modules may be missing
  } else if (existsSync(NVM)) {
    try {
      bin = execFileSync(
        "bash",
        [
          "-c",
          `. ${NVM} >/dev/null && nvm install ${NODE_MAJOR} >/dev/null 2>&1 && dirname "$(nvm which ${NODE_MAJOR})"`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
      ).trim();
    } catch {
      console.log(`WARNING: could not install Node ${NODE_MAJOR} with nvm; client checks need it.`);
      return;
    }
    const line = `export PATH="${bin}:$PATH"`;
    // Subagent shells get no CLAUDE_ENV_FILE and ran the container's Node 22,
    // so the same line goes to ~/.bashrc, once.
    try {
      const rc = `${homedir()}/.bashrc`;
      if (!(existsSync(rc) && readFileSync(rc, "utf8").split("\n").includes(line))) {
        appendFileSync(rc, `${line}\n`);
      }
    } catch {
      console.log(
        `WARNING: could not add Node ${NODE_MAJOR} to ~/.bashrc; subagent shells may use an older Node.`,
      );
    }
    if (process.env.CLAUDE_ENV_FILE) {
      appendFileSync(process.env.CLAUDE_ENV_FILE, `${line}\n`);
      console.log(`Cloud session: Node ${NODE_MAJOR} is on PATH (${bin}).`);
    } else {
      console.log(
        `Cloud session: Node ${NODE_MAJOR} installed; run \`${line}\` before npm commands.`,
      );
    }
  } else {
    console.log(
      `WARNING: Node ${process.versions.node} is not ${NODE_MAJOR} and nvm is not at ${NVM}.`,
    );
    return;
  }
  const env = bin ? { ...process.env, PATH: `${bin}:${process.env.PATH}` } : process.env;
  for (const dir of [".", "Client"]) {
    if (existsSync(`${dir}/node_modules`) || !existsSync(`${dir}/package-lock.json`)) continue;
    try {
      execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
        cwd: dir,
        env,
        stdio: "ignore",
        timeout: 90_000,
      });
      console.log(`Cloud session: installed ${dir}/node_modules.`);
    } catch {
      console.log(
        `WARNING: npm ci failed in ${dir}; the pre-commit checks that need it will be skipped.`,
      );
    }
  }
}

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
  if (hooksPath !== ".githooks" && cloud) {
    try {
      execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
      hooksPath = ".githooks";
      console.log("Cloud session: installed the repo git hooks (core.hooksPath = .githooks).");
    } catch {
      // fall through to the warning
    }
  }
  if (hooksPath !== ".githooks") {
    console.log(
      "WARNING: the repo git hooks are not installed (core.hooksPath is not .githooks). Run `npm run hooks:install` at the repository root.",
    );
  }
  if (cloud) {
    // The findings-ledger merge driver (.gitattributes): parallel lanes merge
    // dev into their branches, and the ledger conflicted on every merge.
    try {
      execFileSync(
        "git",
        ["config", "merge.findings-ledger.driver", "node scripts/merge-ledger.mjs %O %A %B %P"],
        { stdio: "ignore" },
      );
    } catch {
      console.log("WARNING: could not register the findings-ledger merge driver.");
    }
    cloudToolchain();
  }
} else if (mode === "pre-bash") {
  let command = "";
  try {
    command = JSON.parse(readFileSync(0, "utf8")).tool_input?.command ?? "";
  } catch {
    // no or malformed input: nothing to check
  }
  // A `cd` that starts the command or follows a chain operator, newline, brace
  // or compound keyword is a top-level statement; `( cd DIR && ... )` is not
  // matched.
  if (/(^|\n|&&|\|\||[;&|{)]|\b(?:then|do|else)\b)\s*cd(\s|$)/.test(command)) {
    console.error(
      "Blocked: a top-level `cd` leaks the persistent shell cwd into every later command. Use a subshell `( cd DIR && ... )`, `git -C DIR`, or paths from the repository root.",
    );
    process.exit(2);
  }
  // A path token that is exactly `.env` or ends in `/.env` (not `.env.example`
  // or `.envoy`). The Read deny rule in .claude/settings.json does not cover
  // Bash. This is an accidental-exposure guard, not a sandbox: a determined
  // command can still read the file.
  if (/(^|[\s'"=/(<>])\.env(?=$|[\s'");|&<>])/.test(command)) {
    console.error(
      "Blocked: this command names a `.env` file, which holds secrets. Do not read it; ask the human for the value you need.",
    );
    process.exit(2);
  }
}
