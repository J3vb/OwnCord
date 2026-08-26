import { execFileSync } from "node:child_process";

/**
 * Force-kill the dev server Playwright leaves running, so the runner can exit.
 *
 * Playwright's own `webServer` teardown does not stop the Vite dev server on
 * Windows. After the last test the runner still holds a live ChildProcess
 * handle plus its stdio pipes (`process.getActiveResourcesInfo()` reports
 * `ProcessWrap` + several `PipeWrap`), the event loop never drains, and
 * `playwright test` hangs forever with the whole suite already passed —
 * printing no summary, which is why the failure looked like "tests never
 * finish" rather than "process never exits".
 *
 * Every in-Playwright workaround was tried and failed the same way: spawning
 * through `npm run dev`, spawning Vite's entry point directly,
 * `reuseExistingServer: false`, and `gracefulShutdown`. Spawning through `npx`
 * appears to fix it only because npx exits as soon as Vite is up; Playwright
 * reads that as the server dying, tears the group down mid-run, and every
 * later test fails with ERR_CONNECTION_REFUSED.
 *
 * Killing the listener here closes the runner's handle so the process exits
 * normally. It also reaps servers orphaned by an earlier interrupted run,
 * which `reuseExistingServer` would otherwise silently adopt.
 *
 * Failing to kill must not fail an otherwise green suite, but it must not be
 * silent either: an earlier revision used `netstat`, which is not on PATH in
 * every shell here, and the swallowed ENOENT made this look fixed when the
 * hang was still present.
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:1420";

export default function globalTeardown(): void {
  const port = Number(new URL(BASE_URL).port);
  if (!Number.isInteger(port) || port <= 0) return;
  try {
    if (process.platform === "win32") {
      killListenerWindows(port);
    } else {
      killListenerPosix(port);
    }
  } catch (error) {
    console.warn(
      `[global-teardown] could not stop the dev server on port ${port}; ` +
        `the runner may hang. ${String(error)}`,
    );
  }
}

/**
 * Children first, then the listener itself: Vite spawns esbuild, which
 * inherits the stdio pipes the runner is waiting on.
 */
function killListenerWindows(port: number): void {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ids = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |` +
        ` Select-Object -ExpandProperty OwningProcess -Unique);` +
        ` foreach ($id in $ids) {` +
        ` Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue |` +
        ` ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };` +
        ` Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: "ignore" },
  );
}

function killListenerPosix(port: number): void {
  const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  for (const pid of new Set(out.split(/\s+/).filter(Boolean).map(Number))) {
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}
