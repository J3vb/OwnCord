import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// No package install scripts. The registry archive is pinned by version AND
// integrity, and only the native executable is extracted into runner scratch.
if (
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  !process.env.RUNNER_TEMP ||
  !process.env.GITHUB_PATH
)
  throw new Error("Review worker requires an x64 Linux Actions runner");
const url =
  "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.302.tgz";
const digest =
  "+d4RUq3E3K+3/J4MysB3z4QXA4rkDNt70VYpTLE6kJCnUe/Z6SB8VJsVJG/NV4bECrvkxkLHjXk+vrgBstfZkw==";
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error("Cannot download pinned Claude worker");
const data = Buffer.from(await response.arrayBuffer());
if (createHash("sha512").update(data).digest("base64") !== digest)
  throw new Error("Claude archive integrity mismatch");
const dir = join(process.env.RUNNER_TEMP, "owncord-claude");
mkdirSync(dir, { recursive: true });
const archive = join(dir, "claude.tgz");
writeFileSync(archive, data);
execFileSync("tar", ["-xzf", archive, "-C", dir, "--strip-components=1", "package/claude"], {
  stdio: "pipe",
});
chmodSync(join(dir, "claude"), 0o755);
appendFileSync(process.env.GITHUB_PATH, `${dir}\n`);
