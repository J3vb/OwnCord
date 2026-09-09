// Keep installer descendants away from Actions' output pipes. A process
// retaining an inherited pipe must not prevent the diagnostic upload step.
import { spawn, execFile } from "node:child_process";
import { open, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "win32" || !process.env.CI)
  throw new Error("Native updater tests run in Windows CI only");

await mkdir("test-results", { recursive: true });
const logPath = resolve("test-results/native-updater-process.log");
const log = await open(logPath, "w");
const child = spawn(
  process.execPath,
  [
    resolve("node_modules/@playwright/test/cli.js"),
    "test",
    "--config",
    "playwright.config.native.ts",
    "--project",
    "native-updater",
    "--output",
    "test-results/native-updater",
  ],
  { stdio: ["ignore", log.fd, log.fd] },
);
let timedOut = false;
let printedBytes = 0;
let outputPump = Promise.resolve();
// Forward output while the runner is alive. Waiting until the child exits
// hides the last installer stage when Windows itself loses communication.
// Only this parent writes to Actions; installer descendants still inherit
// the file handle above, never the runner's output pipes.
const flushOutput = () => {
  outputPump = outputPump
    .catch(() => {})
    .then(async () => {
      const bytes = await readFile(logPath);
      if (bytes.length > printedBytes) {
        process.stdout.write(bytes.subarray(printedBytes));
        printedBytes = bytes.length;
      }
    });
  return outputPump;
};
const outputTimer = setInterval(() => {
  void flushOutput().catch((error) => console.error(`Cannot read updater output: ${error}`));
}, 1_000);
const timer = setTimeout(async () => {
  timedOut = true;
  console.error("Native updater exceeded nine minutes; terminating its owned process tree.");
  try {
    await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      timeout: 15_000,
    });
  } catch (error) {
    console.error(String(error));
  } finally {
    // The report/progress files are already on disk. Do not let a hung child
    // or inherited installer handles hold Actions' artifact step hostage.
    process.exit(1);
  }
}, 9 * 60_000);

try {
  // Wait for the process itself, not `close` (which also waits for pipes).
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  process.exitCode = timedOut ? 1 : code;
} finally {
  clearTimeout(timer);
  clearInterval(outputTimer);
  await log.close();
  await flushOutput();
}
