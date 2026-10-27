#!/usr/bin/env node
// N-1 client compatibility check (ARCH-027).
//
// Runs the PREVIOUS release's client dispatcher against TODAY's server wire
// transcripts (protocol/fixtures/epoch-1/, which the server's own contract test
// forces to match what it sends). Two halves:
//
//   strict    every fixture that also exists in the old release is overwritten
//             with the current one, then the old release's own contract test
//             (Client/tests/contract/protocol-fixtures.test.ts) runs. A failure
//             means a frame the old client relied on changed shape.
//   tolerant  every fixture that is NEW since that release is replayed through
//             the old dispatcher (Client/tests/compat/n1-new-frames.compat.ts,
//             copied in); the only assertion is that nothing throws.
//
// Usage: node scripts/protocol-n1-compat.mjs [--tag vX.Y.Z] [--keep]
// Exit:  0 pass, 1 the change breaks the old client, 2 the check could not run.

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_REL = path.join("protocol", "fixtures", "epoch-1");
const STRICT_TEST = "tests/contract/protocol-fixtures.test.ts";
const COMPAT_SRC = path.join(REPO, "Client", "tests", "compat", "n1-new-frames.compat.ts");
const COMPAT_DEST = "tests/contract/n1-new-frames.test.ts";
// Anything that is not a plain release tag is not "the previous release".
const PRERELEASE_NOISE = /nightly|[-.]rc\.?\d*$|alpha|dev|snapshot/i;

class CompatError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function git(args, cwd = REPO) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseArgs(argv) {
  const opts = { tag: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") opts.keep = true;
    else if (a === "--tag") {
      opts.tag = argv[++i] ?? "";
      if (opts.tag === "") throw new CompatError("--tag needs a value", 2);
    } else if (a.startsWith("--tag=")) opts.tag = a.slice(6);
    else throw new CompatError(`unknown argument: ${a}`, 2);
  }
  // An empty tag (an unset workflow_dispatch input) means "use the default".
  if (opts.tag === "") opts.tag = null;
  return opts;
}

function tagExists(tag) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function ensureTag(tag) {
  if (tagExists(tag)) return;
  console.log(`tag ${tag} not present locally; fetching tags`);
  try {
    git(["fetch", "--tags", "--force", "origin"]);
  } catch (err) {
    throw new CompatError(`cannot fetch tags to find ${tag}: ${err.message}`, 2);
  }
  if (!tagExists(tag)) throw new CompatError(`tag ${tag} does not exist`, 2);
}

function defaultTag() {
  const list = () =>
    git(["-c", "versionsort.suffix=-", "tag", "--list", "v*", "--sort=-v:refname"])
      .split("\n")
      .filter(Boolean);
  const pick = () => {
    const atHead = new Set(git(["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean));
    return list().find((t) => !PRERELEASE_NOISE.test(t) && !atHead.has(t));
  };
  let tag = pick();
  if (tag === undefined) {
    try {
      git(["fetch", "--tags", "--force", "origin"]);
    } catch {
      /* fall through to the error below */
    }
    tag = pick();
  }
  if (tag === undefined) throw new CompatError("no release tag v* found to compare against", 2);
  return tag;
}

// Match the root runner: Windows npm/npx .cmd shims cannot be spawned directly.
// Launch their JavaScript entry points with Node, retaining argument boundaries.
function npmCliPath(command) {
  const entry = `${command}-cli.js`;
  const candidates = [];
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath) === "npm-cli.js") {
    candidates.push(path.join(path.dirname(npmExecPath), entry));
  }
  for (const dir of (process.env.PATH || "").split(";")) {
    if (dir)
      candidates.push(path.join(dir.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", entry));
  }
  candidates.push(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", entry));
  return candidates.find((candidate) => existsSync(candidate));
}

function spawnCommand(cmd, args, opts) {
  const where = `cwd: ${opts?.cwd ?? process.cwd()}`;
  const npmCommand = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const cli = npmCommand ? npmCliPath(cmd) : undefined;
  if (npmCommand && !cli) {
    throw new CompatError(
      `cannot locate ${cmd}'s JavaScript CLI (${where}); install npm on PATH`,
      2,
    );
  }
  const r = spawnSync(cli ? process.execPath : cmd, cli ? [cli, ...args] : args, {
    ...opts,
    shell: false,
  });
  if (r.error || r.status === null) {
    throw new CompatError(
      `${cmd} could not run (${where}): ${r.error?.code ?? r.signal ?? "no exit status"}`,
      2,
    );
  }
  return r;
}

export function run(cmd, args, opts) {
  const r = spawnCommand(cmd, args, { stdio: "inherit", ...opts });
  return r.status;
}

export function runCaptured(cmd, args, opts) {
  const r = spawnCommand(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  return { status: r.status, out };
}

function jsonFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
}

function countPassed(reportFile) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  return { passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0 };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tag = opts.tag ?? defaultTag();
  ensureTag(tag);
  console.log(
    `N-1 compatibility: previous release ${tag} vs ${git(["rev-parse", "--short", "HEAD"])}`,
  );

  const work = mkdtempSync(path.join(os.tmpdir(), "owncord-n1-"));
  const tree = path.join(work, "old");
  let added = false;
  try {
    git(["worktree", "add", "--detach", tree, tag]);
    added = true;
    return compat(tag, tree, work);
  } finally {
    if (opts.keep) {
      console.log(`kept: ${tree} (remove with: git worktree remove --force ${tree})`);
    } else {
      if (added) {
        try {
          git(["worktree", "remove", "--force", tree]);
        } catch {
          /* removed below */
        }
      }
      rmSync(work, { recursive: true, force: true });
      try {
        git(["worktree", "prune"]);
      } catch {
        /* best effort */
      }
    }
  }
}

function compat(tag, tree, work) {
  const nowDir = path.join(REPO, FIXTURES_REL);
  const oldDir = path.join(tree, FIXTURES_REL);
  const nowFiles = jsonFiles(nowDir);
  const oldFiles = new Set(jsonFiles(oldDir));
  const shared = nowFiles.filter((f) => oldFiles.has(f));
  const added = nowFiles.filter((f) => !oldFiles.has(f));
  const dropped = [...oldFiles].filter((f) => !nowFiles.includes(f));
  if (dropped.length > 0) {
    throw new CompatError(
      `fixtures that ${tag} has were removed since: ${dropped.join(", ")}. A journey the last release speaks is gone; that is a protocol break.`,
      1,
    );
  }

  for (const required of [
    STRICT_TEST,
    "Client/src/lib/dispatcher.ts",
    "Client/tests/helpers/mock-ws.ts",
  ]) {
    const p = path.join(
      tree,
      required.startsWith("Client/") ? required : path.join("Client", required),
    );
    if (!existsSync(p)) {
      throw new CompatError(
        `${tag} has no ${path.relative(tree, p)}; it predates the client contract test, so there is nothing to run. Pick a newer --tag.`,
        2,
      );
    }
  }

  // Strict half: today's bytes into the old tree, existing file names only.
  for (const f of shared) cpSync(path.join(nowDir, f), path.join(oldDir, f));
  console.log(`strict: ${shared.length} fixture files overwritten with the current wire`);

  const client = path.join(tree, "Client");
  const ci = run("npm", ["ci", "--engine-strict=false", "--no-audit", "--no-fund"], {
    cwd: client,
  });
  if (ci !== 0) throw new CompatError(`npm ci failed in the ${tag} client (exit ${ci})`, 2);

  const strictReport = path.join(work, "strict.json");
  const strict = runCaptured(
    "npx",
    [
      "vitest",
      "run",
      STRICT_TEST,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${strictReport}`,
    ],
    { cwd: client },
  );
  if (strict.status !== 0) {
    throw new CompatError(
      `The current server wire breaks the ${tag} client: its own contract test fails against today's fixtures (output above). ` +
        `A frame that release relied on changed shape. Make the change additive, or plan an epoch bump (docs/protocol.md, Compatibility).`,
      1,
    );
  }
  const strictCount = existsSync(strictReport) ? countPassed(strictReport).passed : "?";
  console.log(`strict: ${strictCount} journey assertions passed against ${tag}`);

  // Tolerant half: only the fixtures the old release has never seen.
  let replayed = 0;
  if (added.length === 0) {
    console.log("tolerant: no fixtures are new since this tag; nothing to replay");
  } else {
    const newDir = path.join(work, "new-fixtures");
    mkdirSync(newDir, { recursive: true });
    for (const f of added) cpSync(path.join(nowDir, f), path.join(newDir, f));
    cpSync(COMPAT_SRC, path.join(client, COMPAT_DEST));
    const tol = runCaptured("npx", ["vitest", "run", COMPAT_DEST], {
      cwd: client,
      env: { ...process.env, N1_NEW_FIXTURE_DIR: newDir },
    });
    if (tol.status !== 0) {
      if (
        /Failed to resolve import|Cannot find module|does not provide an export|is not a function/.test(
          tol.out,
        )
      ) {
        throw new CompatError(
          `The tolerant replay could not run against ${tag}: an API it uses is missing from that tree (see the error above). ` +
            `Fix Client/tests/compat/n1-new-frames.compat.ts to use only what ${tag} has; this is not a protocol break.`,
          2,
        );
      }
      throw new CompatError(
        `A frame new since ${tag} makes its dispatcher throw (output above). The old client crashes on it: make it ignorable, or plan an epoch bump.`,
        1,
      );
    }
    replayed = added.length;
  }
  console.log(
    `\nN-1 compat OK: tag ${tag}, ${strictCount} strict journey assertions passed, ${replayed} new fixtures replayed`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof CompatError) {
      console.error(`\nN-1 compat ${err.code === 1 ? "FAILED" : "could not run"}: ${err.message}`);
      process.exitCode = err.code;
    } else {
      console.error(err);
      process.exitCode = 2;
    }
  }
}
