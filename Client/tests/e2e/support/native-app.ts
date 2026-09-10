import { chromium, expect, type ConsoleMessage, type TestInfo } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startProcess, stopProcess, waitForHttp } from "./process";

export async function startNativeApp(
  binary = process.env.OWNCORD_E2E_CLIENT_BINARY,
  options: { preserveProfile?: boolean } = {},
) {
  if (process.platform !== "win32") throw new Error("Native WebView2 tests require Windows");
  const exe = resolve(binary ?? "src-tauri/target/release/owncord-client.exe");
  const directory = await mkdtemp(join(tmpdir(), "owncord-native-e2e-"));
  // Native builds use com.owncord.e2e and a fixed CDP port configured via
  // Tauri, because elevated WebView2 ignores environment overrides. The
  // native lane is serial and owns this namespace; production data is separate.
  const port = 9222;
  const profiles = [...new Set([process.env.APPDATA, process.env.LOCALAPPDATA])]
    .filter((root): root is string => !!root)
    .map((root) => join(root, "com.owncord.e2e"));
  if (profiles.length === 0) throw new Error("Windows application data paths are missing");
  const clearProfiles = async () => {
    for (const profile of profiles)
      await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  };
  if (!options.preserveProfile) await clearProfiles();
  const running = startProcess(exe, [], directory);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/json/version`, running);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("WebView2 did not create a context");
    // This context is attached manually, so Playwright's `use` timeouts are
    // not applied by the built-in browser fixture.
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    return {
      cdpURL: `http://127.0.0.1:${port}`,
      page,
      context,
      process: running.child,
      directory,
      log: running.log,
      async close(closeOptions: { preserveProfile?: boolean } = {}) {
        try {
          await browser?.close();
        } finally {
          await stopProcess(running.child);
          if (!closeOptions.preserveProfile) await clearProfiles();
          await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
        }
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await stopProcess(running.child);
    await clearProfiles();
    await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    throw new Error(`${String(error)}\n${running.log()}`);
  }
}

export type NativeApp = Awaited<ReturnType<typeof startNativeApp>>;

/** Finish recording before the worker disconnects CDP or terminates WebView2. */
export async function withNativeArtifacts(
  app: NativeApp,
  use: () => Promise<void>,
  info: TestInfo,
) {
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  // The HTTP SDK patch observes detached cleanup failures instead of leaving
  // rejected promises unhandled. Preserve the same strict native failure gate.
  const onConsole = (message: ConsoleMessage) => {
    if (
      message.type() === "error" &&
      message.text().startsWith("Failed to release Tauri HTTP resource")
    )
      errors.push(message.text());
  };
  app.page.on("pageerror", onError);
  app.page.on("console", onConsole);
  await app.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  try {
    await use();
  } finally {
    app.page.off("pageerror", onError);
    app.page.off("console", onConsole);
    const failed = info.status !== info.expectedStatus || errors.length > 0;
    if (failed) {
      const trace = info.outputPath("native-trace.zip");
      await app.context.tracing.stop({ path: trace });
      await info.attach("native-trace", { path: trace, contentType: "application/zip" });
      // Attach by path: reporters drop inline text bodies, and the list
      // reporter truncates them, so a body attachment never reaches CI.
      const processLog = info.outputPath("native-process.log");
      await writeFile(processLog, app.log());
      await info.attach("native-process", { path: processLog, contentType: "text/plain" });
      if (!app.page.isClosed())
        await info.attach("native-screenshot", {
          body: await app.page.screenshot(),
          contentType: "image/png",
        });
    } else {
      await app.context.tracing.stop();
    }
    expect(errors, "WebView2 runtime or HTTP cleanup errors").toEqual([]);
  }
}
