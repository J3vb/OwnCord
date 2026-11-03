/**
 * Native E2E: Windows crash and exit info in the native log.
 *
 * Three things the support bundle relies on, checked against the real binary
 * and WebView2:
 * - the run file (`run-<pid>.state`) is written on Windows, with memory and
 *   the main thread's state, so a silent ending reads as "last seen at T";
 * - a run file an earlier process left is reported at the next start, and
 *   the Application event log's crash record for that pid is copied into the
 *   log (the test writes a real Application Error record first, so the
 *   query, the record's encoding and the parser are all exercised);
 * - a WebView2 renderer crash (CDP `Page.crash`, the `chrome://crash`
 *   equivalent) is logged through WebView2's ProcessFailed event.
 *
 * The unhandled-exception filter is pinned by Rust unit tests on its line
 * format: crashing the app on purpose here would also hand the runner a
 * Windows Error Reporting dialog.
 */

import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { startNativeApp, withNativeArtifacts, type NativeApp } from "../support/native-app";

const APP_LOG_DIR = join(process.env.LOCALAPPDATA ?? "", "com.owncord.e2e", "logs");
/** A pid no process holds: Windows pids are multiples of four. */
const GONE_PID = 4_000_001;

/** Write an Application Error record, as Windows Error Reporting would,
 *  for a crash of `GONE_PID` in `x.dll`. CI runners are administrators. */
async function writeCrashRecord(): Promise<void> {
  const exe = basename(process.env.OWNCORD_E2E_CLIENT_BINARY ?? "owncord-client.exe");
  const fields = [exe, "0.0.0.0", "0", "x.dll", "1.2.3.4", "0", "c0000005", "0x10"]
    .concat(`0x${GONE_PID.toString(16)}`)
    .map((value) => `'${value}'`)
    .join(",");
  const script =
    "$i = New-Object System.Diagnostics.EventInstance(1000, 100, " +
    "[System.Diagnostics.EventLogEntryType]::Error); " +
    `[System.Diagnostics.EventLog]::WriteEvent('Application Error', $i, @(${fields}))`;
  await promisify(execFile)("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
}

async function readLog(): Promise<string> {
  return readFile(join(APP_LOG_DIR, "owncord-client.log"), "utf8").catch(() => "");
}

async function logShows(pattern: RegExp, timeout = 30_000): Promise<string> {
  let text = "";
  await expect
    .poll(
      async () => {
        text = await readLog();
        return pattern.test(text);
      },
      { timeout, message: `native log never matched ${pattern}` },
    )
    .toBe(true);
  return text;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("the run file, a previous run's report and a renderer crash reach the native log", async ({}, info) => {
  test.setTimeout(180_000);
  let app: NativeApp | undefined;
  try {
    await writeCrashRecord();
    app = await startNativeApp(undefined, {
      seedLogFiles: {
        [`run-${GONE_PID}.state`]:
          "version=0.0.0\nlast_seen=2026-11-03 18:51:30 UTC\nmain_thread=not answering for 40 s\n",
      },
    });
    await withNativeArtifacts(
      app,
      async () => {
        await logShows(/\[startup\] session: Windows \d+\.\d+\.\d+, RAM=\d+ MB, WebView2 /);

        // The planted run is reported with its last record, then consumed.
        await logShows(
          new RegExp(
            `the previous run \\(pid ${GONE_PID}\\) ended without a normal exit.*main_thread=not answering for 40 s`,
          ),
        );
        const report = await logShows(
          new RegExp(
            `Windows recorded a crash of the previous run \\(pid ${GONE_PID}\\): exception 0xC0000005 \\(access violation\\) in module 'x\\.dll' version 1\\.2\\.3\\.4`,
          ),
        );
        expect(report).not.toContain("panicked");
        expect(await readdir(APP_LOG_DIR)).not.toContain(`run-${GONE_PID}.state`);

        // This run's own file, written by the first heartbeat.
        const pid = app!.process.pid;
        const runFile = join(APP_LOG_DIR, `run-${pid}.state`);
        let state = "";
        await expect
          .poll(async () => {
            state = await readFile(runFile, "utf8").catch(() => "");
            return state;
          })
          .toContain("main_thread=answering");
        expect(state).toMatch(/^memory=\d+ MB$/m);
        expect(state).toMatch(/^threads=\d+$/m);
        expect(state).toContain("state=running");

        const cdp = await app!.page.context().newCDPSession(app!.page);
        // The renderer dies before it can answer, so the command never resolves.
        void cdp.send("Page.crash").catch(() => undefined);
        await logShows(/\[exit\] webview renderer process failed: (crashed|unexpected)/);
      },
      info,
    );
  } finally {
    await app?.close();
  }
});
