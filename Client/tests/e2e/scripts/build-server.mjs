import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const destination = resolve("tests/e2e/.bin");
mkdirSync(destination, { recursive: true });
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
process.exit(result.status ?? 1);
