import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// The web suite (tests/e2e/config/playwright.config.web.ts) needs the browser bundle inside the
// binary. Every other E2E job builds with the committed placeholder only, so
// the copy is opt-in: OWNCORD_E2E_EMBED_WEB=1 builds `dist-web/` (npm run
// build:web) and copies it into Server/webclient/dist/ for the go build.
// The `--web` argument does the same. OWNCORD_E2E_REUSE_DIST_WEB=1 reuses an existing dist-web/ instead of
// rebuilding it.
const embedWeb = process.env.OWNCORD_E2E_EMBED_WEB === "1" || process.argv.includes("--web");
const reuseDist = process.env.OWNCORD_E2E_REUSE_DIST_WEB === "1";
const distWeb = resolve("dist-web");
const embedDir = resolve("../Server/webclient/dist");

/** Empty the embed dir back to the tracked PLACEHOLDER.txt alone. */
function resetEmbedDir() {
  mkdirSync(embedDir, { recursive: true });
  for (const entry of readdirSync(embedDir)) {
    if (entry === "PLACEHOLDER.txt") continue;
    rmSync(join(embedDir, entry), { recursive: true, force: true });
  }
}

function buildWeb() {
  if (reuseDist && existsSync(join(distWeb, "index.html"))) return;
  const npm = spawnSync("npm", ["run", "build:web"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (npm.error) throw npm.error;
  if (npm.status !== 0) process.exit(npm.status ?? 1);
}

const destination = resolve("tests/e2e/.bin");
mkdirSync(destination, { recursive: true });
let status = 1;
try {
  // Every build starts from the placeholder alone, so a --web build that was
  // killed before its cleanup cannot leave a bundle in a plain build's binary.
  resetEmbedDir();
  if (embedWeb) {
    buildWeb();
    if (!existsSync(join(distWeb, "index.html"))) {
      throw new Error(`${distWeb} has no index.html after the web build`);
    }
    cpSync(distWeb, embedDir, { recursive: true });
  }
  const result = spawnSync(
    "go",
    [
      "build",
      "-o",
      resolve(destination, `chatserver${process.platform === "win32" ? ".exe" : ""}`),
      ".",
    ],
    { cwd: "../Server", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  // Leave the checkout as it was. Two --web builds in one checkout at once
  // would race on this directory; CI runs one per job.
  if (embedWeb) resetEmbedDir();
}
process.exit(status);
