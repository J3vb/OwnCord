import { createHash } from "node:crypto";
import { test, expect, chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startNativeApp } from "../support/native-app";
import { startTestServer } from "../support/server";
import { startNativeUpdateServer } from "../support/native-update-server";
import { configureNativeServer, nativeLogin } from "./helpers";
const exec = promisify(execFile);

test("signed NSIS update rejects broken downloads then installs and relaunches the new version", async ({}, info) => {
  test.setTimeout(240_000);
  const progress = async (stage: string) => {
    const line = `${new Date().toISOString()} ${stage}`;
    console.log(`[native-updater] ${line}`);
    await appendFile(info.outputPath("installer-progress.log"), `${line}\n`);
  };
  await progress("starting server");
  const packages = resolve("tests/e2e/.bin/native-updates");
  const installation = await mkdtemp(join(tmpdir(), "owncord-installed-e2e-"));
  const exe = join(installation, "owncord-client.exe");
  const server = await startTestServer({ tls: true });
  const gateway = await startNativeUpdateServer(server, packages);
  const errors: string[] = [];
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  let traceActive = false;
  let replacement: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await progress("installing old NSIS package");
    await exec(join(packages, "old/installer.exe"), ["/S", `/D=${installation}`], {
      timeout: 60_000,
    });
    await progress("starting installed app");
    app = await startNativeApp(exe);
    const page = app.page;
    await app.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceActive = true;
    page.on("pageerror", (error) => errors.push(error.message));
    configureNativeServer(gateway.origin);
    await progress("logging in");
    await page.locator("#auto-connect").check();
    await nativeLogin(page);
    const version = () =>
      page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("plugin:app|version"));
    expect(await version()).toBe("1.2.0-alpha.4");
    const original = createHash("sha256")
      .update(await readFile(exe))
      .digest("hex");
    const text = `desktop-update-${crypto.randomUUID()}`;
    await page.locator("[data-testid='message-input'] textarea").fill(text);
    await page.locator("[data-testid='message-input'] textarea").press("Enter");
    await expect(page.locator(".msg-text", { hasText: text })).toHaveCount(1);
    for (const fault of ["corrupt", "interrupted"] as const) {
      await progress(`testing ${fault} download`);
      const previous = gateway.downloads();
      gateway.fault(fault);
      await page
        .getByRole("button", { name: fault === "corrupt" ? "Update Now" : "Retry", exact: true })
        .click();
      await expect(page.locator(".update-banner")).toContainText("Update failed", {
        timeout: 45_000,
      });
      expect(gateway.downloads()).toBe(previous + 1);
      expect(
        createHash("sha256")
          .update(await readFile(exe))
          .digest("hex"),
      ).toEqual(original);
      expect(await version()).toBe("1.2.0-alpha.4");
      await expect(page.getByTestId("app-layout")).toBeVisible();
    }
    // The installer closes the original WebView. Save that trace first, then
    // attach to the successor at the inherited CDP port and record its state.
    const trace = info.outputPath("before-install.zip");
    await progress("saving trace before valid update");
    await app.context.tracing.stop({ path: trace });
    traceActive = false;
    await info.attach("before-install", { path: trace, contentType: "application/zip" });
    gateway.fault("none");
    await progress("installing valid update");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => page.isClosed(), { timeout: 90_000 }).toBe(true);
    await progress("waiting for successor version");
    await expect
      .poll(
        async () => {
          try {
            replacement = await chromium.connectOverCDP(app!.cdpURL, { timeout: 1000 });
            const next = replacement.contexts()[0]?.pages()[0];
            if (!next) {
              await replacement.close();
              replacement = undefined;
              return "starting";
            }
            const current = await next.evaluate(() =>
              (window as any).__TAURI_INTERNALS__.invoke("plugin:app|version"),
            );
            if (current !== "1.2.0-alpha.5") {
              await replacement.close();
              replacement = undefined;
            }
            return current;
          } catch {
            await replacement?.close().catch(() => {});
            replacement = undefined;
            return "starting";
          }
        },
        { timeout: 90_000 },
      )
      .toBe("1.2.0-alpha.5");
    const next = replacement!.contexts()[0]!.pages()[0]!;
    next.context().setDefaultTimeout(30_000);
    await progress("checking persisted session and messages");
    next.on("pageerror", (error) => errors.push(error.message));
    await expect(next.getByTestId("app-layout")).toBeVisible({ timeout: 30_000 });
    await expect(next.locator(".msg-text", { hasText: text })).toHaveCount(1);
    expect(
      createHash("sha256")
        .update(await readFile(exe))
        .digest("hex"),
    ).not.toEqual(original);
    await info.attach("updated-desktop", {
      body: await next.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await progress("capturing failure diagnostics");
    // A crashed WebView can make trace capture fail. Preserve the owned
    // process logs before asking that same WebView for more diagnostics.
    if (app) await info.attach("native-process", { body: app.log(), contentType: "text/plain" });
    await info.attach("native-server", { body: server.log(), contentType: "text/plain" });
    if (app && traceActive) {
      const trace = info.outputPath("failed-install.zip");
      try {
        await app.context.tracing.stop({ path: trace });
        await info.attach("failed-install", { path: trace, contentType: "application/zip" });
        if (!app.page.isClosed())
          await info.attach("failed-install-screenshot", {
            body: await app.page.screenshot(),
            contentType: "image/png",
          });
      } catch (error) {
        await info.attach("trace-capture-error", {
          body: String(error),
          contentType: "text/plain",
        });
      }
    }
    await progress("disconnecting successor CDP");
    await replacement?.close();
    // The installer owns the replacement process. Select ONLY the executable
    // in this test's unique installation directory, then terminate its tree.
    await progress("terminating installed successor");
    await exec(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$path=$env.OWNCORD_E2E_INSTALLED_EXE; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $path } | ForEach-Object { taskkill /pid $_.ProcessId /t /f | Out-Null }",
      ],
      { env: { ...process.env, OWNCORD_E2E_INSTALLED_EXE: exe }, timeout: 30_000 },
    );
    await progress("closing original app and profile");
    await app?.close();
    await progress("closing gateway");
    await gateway.close();
    await progress("closing server");
    await server.close();
    await progress("removing installation directory");
    await rm(installation, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    expect(errors, "Unhandled desktop updater errors").toEqual([]);
    await progress("finished");
  }
});
