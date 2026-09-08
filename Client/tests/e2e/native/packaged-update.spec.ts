import { createHash } from "node:crypto";
import { test, expect, chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startNativeApp } from "../support/native-app";
import { startTestServer } from "../support/server";
import { startNativeUpdateServer } from "../support/native-update-server";
import { configureNativeServer, nativeLogin } from "./helpers";
const exec = promisify(execFile);

test("signed NSIS update rejects broken downloads then installs and relaunches the new version", async ({}, info) => {
  test.setTimeout(240_000);
  const packages = resolve("tests/e2e/.bin/native-updates");
  const installation = await mkdtemp(join(tmpdir(), "owncord-installed-e2e-"));
  const exe = join(installation, "owncord-client.exe");
  const server = await startTestServer({ tls: true });
  const gateway = await startNativeUpdateServer(server, packages);
  const errors: string[] = [];
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  let replacement: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await exec(join(packages, "old/installer.exe"), ["/S", `/D=${installation}`], {
      timeout: 60_000,
    });
    app = await startNativeApp(exe);
    const page = app.page;
    page.on("pageerror", (error) => errors.push(error.message));
    configureNativeServer(gateway.origin);
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
    await app.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    for (const fault of ["corrupt", "interrupted"] as const) {
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
    await app.context.tracing.stop({ path: trace });
    await info.attach("before-install", { path: trace, contentType: "application/zip" });
    gateway.fault("none");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => page.isClosed(), { timeout: 90_000 }).toBe(true);
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
    if (app) await info.attach("native-process", { body: app.log(), contentType: "text/plain" });
    await replacement?.close();
    // The installer owns the replacement process. Select ONLY the executable
    // in this test's unique installation directory, then terminate its tree.
    await exec(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$path=$env.OWNCORD_E2E_INSTALLED_EXE; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $path } | ForEach-Object { taskkill /pid $_.ProcessId /t /f | Out-Null }",
      ],
      { env: { ...process.env, OWNCORD_E2E_INSTALLED_EXE: exe } },
    );
    await app?.close();
    await gateway.close();
    await server.close();
    await rm(installation, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    expect(errors, "Unhandled desktop updater errors").toEqual([]);
  }
});
