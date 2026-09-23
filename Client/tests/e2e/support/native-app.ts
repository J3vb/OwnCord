import {
  chromium,
  expect,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { once } from "node:events";
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
  // One budget for the whole app start. The first launch of a freshly built
  // exe on a cold Windows runner takes up to ~30s more than a warm one, and the
  // WebView2 browser process opens the CDP port well before the renderer
  // attaches its page target, so the page wait must share the same deadline.
  const startupDeadline = Date.now() + 60_000;
  const started = Date.now();
  const running = startProcess(exe, [], directory);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await waitForHttp(
      `http://127.0.0.1:${port}/json/version`,
      running,
      startupDeadline - Date.now(),
    );
    const cdpReady = Date.now() - started;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("WebView2 did not create a context");
    // This context is attached manually, so Playwright's `use` timeouts are
    // not applied by the built-in browser fixture.
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    const page = await waitForFirstPage(context, running, startupDeadline - Date.now());
    // WebView2 exposes a page as soon as it starts loading its own
    // "Loading <url>" interstitial, before the app document has navigated in.
    // Returning that page made any spec that asserts immediately (title,
    // __TAURI_INTERNALS__) race the navigation. index.html's <title> is static
    // markup, so the app document is present as soon as its title is "OwnCord" —
    // wait for that, across the navigation, before handing the page out. The
    // navigation can stall past the 15s expect default on a busy runner, so it
    // shares the startup deadline too.
    await expect(page).toHaveTitle("OwnCord", {
      timeout: Math.max(1, startupDeadline - Date.now()),
    });
    console.log(`native app ready: CDP after ${cdpReady}ms, page after ${Date.now() - started}ms`);
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

/** The WebView2 page target, or a prompt failure when the app dies first. */
async function waitForFirstPage(
  context: BrowserContext,
  running: ReturnType<typeof startProcess>,
  timeout: number,
): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) return existing;
  const aborter = new AbortController();
  try {
    return await Promise.race([
      context.waitForEvent("page", { timeout }),
      once(running.child, "exit", { signal: aborter.signal }).then(() => {
        throw new Error(`Process exited before WebView2 created a page\n${running.log()}`);
      }),
    ]);
  } finally {
    aborter.abort();
  }
}

/** Finish recording before the worker disconnects CDP or terminates WebView2. */
export async function withNativeArtifacts(
  app: NativeApp,
  use: () => Promise<void>,
  info: TestInfo,
) {
  const errors: string[] = [];
  const webview: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  // The HTTP SDK patch observes detached cleanup failures instead of leaving
  // rejected promises unhandled. Preserve the same strict native failure gate.
  const onConsole = (message: ConsoleMessage) => {
    webview.push(`[${message.type()}] ${message.text()}`);
    if (
      message.type() === "error" &&
      message.text().startsWith("Failed to release Tauri HTTP resource")
    )
      errors.push(message.text());
  };
  app.page.on("pageerror", onError);
  app.page.on("console", onConsole);
  await app.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  // `info.status` is still the expected status while the test body's own
  // rejection is propagating, so track the throw directly.
  let threw = false;
  try {
    await use();
  } catch (error) {
    threw = true;
    throw error;
  } finally {
    app.page.off("pageerror", onError);
    app.page.off("console", onConsole);
    const failed = threw || info.status !== info.expectedStatus || errors.length > 0;
    if (failed) {
      // Attach by path: reporters drop inline text bodies, and the list
      // reporter truncates them, so a body attachment never reaches CI.
      const attachText = async (name: string, content: string) => {
        const path = info.outputPath(`${name}.log`);
        await writeFile(path, content);
        await info.attach(name, { path, contentType: "text/plain" });
      };
      // Logs first: `tracing.stop` can fail after the app exited mid-test,
      // and a capture error must never replace the test's own failure.
      await attachText("native-process", app.log());
      await attachText("native-webview", webview.join("\n"));
      try {
        if (!app.page.isClosed())
          await info.attach("native-screenshot", {
            body: await app.page.screenshot(),
            contentType: "image/png",
          });
        const trace = info.outputPath("native-trace.zip");
        await app.context.tracing.stop({ path: trace });
        await info.attach("native-trace", { path: trace, contentType: "application/zip" });
      } catch (error) {
        await attachText("native-capture-error", String(error));
      }
    } else {
      await app.context.tracing.stop();
    }
    expect(errors, "WebView2 runtime or HTTP cleanup errors").toEqual([]);
  }
}
