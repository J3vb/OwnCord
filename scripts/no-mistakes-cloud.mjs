#!/usr/bin/env node
// Opt-in author-side adapter. It does not install or invoke Firstmate.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE = {
  version: "v1.84.0",
  source: "4822244e763fd4c3d7f48be6433f92df10bb5b33",
  url: "https://github.com/kunchenguid/no-mistakes/releases/download/v1.84.0/no-mistakes-v1.84.0-linux-amd64.tar.gz",
  sha256: "b0fb8a9df412c5fa1fb92a3584ffa1d4d5b4d6e0d1738efa2f8b88320f8bf1c2",
};

// JSON is valid YAML and is parsed by no-mistakes' strict configuration reader.
// All keys are from the pinned release's global configuration interface.
export function configuration() {
  return {
    agent: ["codex", "claude"],
    session_reuse: true,
    auto_fix: { rebase: 3, review: 3, test: 3, document: 3, lint: 3, ci: 3 },
    ci: {
      revalidate_repairs: true,
      rerun_transient: 1,
    },
    agent_timeout: "30m",
    review_agent_timeout: "30m",
    test_agent_timeout: "30m",
  };
}

export function invocation(argv) {
  if (argv.length === 1 && argv[0] === "--setup") return { mode: "setup" };
  if (argv.length === 1 && argv[0] === "--status") return { mode: "run", args: ["axi", "status"] };
  if (argv.length === 2 && argv[0] === "--intent-file" && argv[1].trim()) {
    return {
      mode: "run",
      args: [
        "axi",
        "run",
        "--base-branch",
        "dev",
        "--intent-file",
        resolve(argv[1]),
        "--no-publish-intent",
        "--yes",
        "--wait",
        "60s",
      ],
    };
  }
  if (argv.length === 1 && argv[0] === "--reattach")
    return { mode: "run", args: ["axi", "run", "--yes", "--wait", "60s"] };
  throw new Error(
    "Use --setup, --status, --intent-file <file>, or --reattach; no skip/approval override is exposed",
  );
}

export function verifyArchive(data) {
  if (createHash("sha256").update(data).digest("hex") !== RELEASE.sha256)
    throw new Error("no-mistakes archive digest mismatch");
}

export async function run(argv, dependencies = {}) {
  const command = invocation(argv);
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const remote = dependencies.remote ?? process.env.CLAUDE_CODE_REMOTE;
  if (platform !== "linux" || arch !== "x64" || remote !== "true")
    throw new Error("This adapter is opt-in for x64 Linux Claude cloud sessions only");
  const root = dependencies.root ?? resolve(fileURLToPath(new URL("..", import.meta.url)));
  const home =
    dependencies.home ??
    join(tmpdir(), `oc-nm-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`);
  const binary = join(home, "bin", "no-mistakes");
  const config = join(home, "config.yaml");
  const execute =
    dependencies.execute ??
    ((cmd, args, options) => {
      const result = spawnSync(cmd, args, { ...options, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${cmd === binary ? "no-mistakes" : "setup command"} did not complete successfully`,
        );
    });
  const env = { ...process.env, NM_HOME: home, NO_MISTAKES_TELEMETRY: "off" };
  if (command.mode === "setup") {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const stat = lstatSync(home);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("Cloud state directory is not owned by this session");
    const serialized = JSON.stringify(configuration(), null, 2) + "\n";
    if (existsSync(config) && readFileSync(config, "utf8") !== serialized)
      throw new Error("Existing cloud profile differs; refusing to overwrite it");
    const response = await (dependencies.fetcher ?? fetch)(RELEASE.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error("Cannot download pinned no-mistakes release");
    const data = Buffer.from(await response.arrayBuffer());
    (dependencies.verify ?? verifyArchive)(data);
    mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
    const archive = join(home, "release.tar.gz");
    writeFileSync(archive, data, { mode: 0o600 });
    // Extract only the one expected executable from the verified archive.
    (dependencies.extract ?? execFileSync)(
      "tar",
      ["-xzf", archive, "-C", join(home, "bin"), "no-mistakes"],
      { stdio: "pipe" },
    );
    writeFileSync(config, serialized, { mode: 0o600 });
    const probe =
      dependencies.probe ??
      ((cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0);
    if (!probe("codex") && !probe("claude"))
      throw new Error("No runnable Codex or Claude CLI in this cloud session");
    execute("gh", ["auth", "status", "--active", "--hostname", "github.com"], { cwd: root, env });
    // doctor is diagnostic (some releases exit zero with failed checks).
    // Explicit executable/auth checks above own those setup prerequisites.
    execute(binary, ["doctor"], { cwd: root, env });
    execute(binary, ["init"], { cwd: root, env });
    return { home, mode: "setup" };
  }
  if (!existsSync(config) || !existsSync(binary))
    throw new Error("Run --setup in this cloud session first");
  execute(binary, command.args, { cwd: root, env });
  return { home, mode: "run" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await run(process.argv.slice(2));
