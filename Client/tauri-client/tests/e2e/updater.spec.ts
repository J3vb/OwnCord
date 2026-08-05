import { test, expect, type Page } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPageReady } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: updater journey (DC-04, spec: docs/architecture/ux/settings-and-admin.md §5)
//
// UpdateNotifier mounts on MainPage and checks the server 3 s after mount:
// available → banner "Update vX available" [Update Now] [Later]; installing →
// "Downloading update… N% / N.N MB" driven by the Rust `update-progress`
// event; success → relaunch() (there is no restart *prompt* — the spec's
// "applied" state is an automatic relaunch, observed here as the
// plugin:process|restart invoke); failure → "Update failed." + Dismiss.
//
// The update IPC commands are not part of the base mock, so each test layers
// an invoke wrapper over it (init-script order is preserved and the base
// script assigns __TAURI_INTERNALS__ synchronously).
// ---------------------------------------------------------------------------

async function mockUpdaterSession(
  page: Page,
  opts: { available: boolean; version?: string; failInstall?: boolean },
): Promise<void> {
  await mockTauriFullSession(page);
  await page.addInitScript((cfg) => {
    const t = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const orig = t.invoke.bind(t);
    const w = window as unknown as {
      __resolveInstall: (() => void) | null;
      __rejectInstall: ((e: Error) => void) | null;
    };
    w.__resolveInstall = null;
    w.__rejectInstall = null;
    t.invoke = async (cmd: string, args?: unknown) => {
      if (cmd === "check_client_update") {
        // Recorded by the base mock's __invokeLog via the orig call below? No —
        // wrapped commands short-circuit, so log them here for parity.
        return cfg.available
          ? { available: true, version: cfg.version, body: "release notes" }
          : { available: false, version: null, body: null };
      }
      if (cmd === "download_and_install_update") {
        // Held open until the test resolves/rejects it, so progress events
        // can be asserted deterministically mid-download.
        return new Promise<void>((res, rej) => {
          w.__resolveInstall = res;
          w.__rejectInstall = rej;
        });
      }
      return orig(cmd, args);
    };
  }, opts);
}

/** Wait for the update-progress listener, then emit a RAW object payload —
 *  the Tauri event system delivers deserialized objects, and emitWsEvent's
 *  stringify would break `event.payload.received`. */
async function emitProgress(page: Page, received: number, total: number | null): Promise<void> {
  await page.waitForFunction(
    () =>
      ((window as unknown as { __tauriEventListeners: Record<string, unknown[]> })
        .__tauriEventListeners["update-progress"]?.length ?? 0) > 0,
  );
  await page.evaluate(
    (p) => (window as unknown as { __tauriEmitEvent: (e: string, d: unknown) => void }).__tauriEmitEvent("update-progress", p),
    { received, total },
  );
}

const banner = (page: Page): ReturnType<Page["locator"]> => page.locator(".update-banner");
const bannerText = (page: Page): ReturnType<Page["locator"]> =>
  page.locator(".update-banner .update-banner-text");

test.describe("Updater journey", () => {
  test("no banner when the server reports no update", async ({ page }) => {
    await mockUpdaterSession(page, { available: false });
    await page.goto("/");
    await navigateToMainPageReady(page);

    // The check fires 3 s after mount; give it time to (not) show.
    await page.waitForTimeout(4_000);
    await expect(banner(page)).toHaveCount(0);
  });

  test("available → banner with version; Later dismisses it for the session", async ({ page }) => {
    await mockUpdaterSession(page, { available: true, version: "9.9.9" });
    await page.goto("/");
    await navigateToMainPageReady(page);

    await expect(bannerText(page)).toHaveText("Update v9.9.9 available", { timeout: 10_000 });

    await page.locator(".update-banner-later").click();
    await expect(banner(page)).toHaveCount(0);
  });

  test("full journey: banner → download progress (% and MB fallback) → auto-relaunch", async ({
    page,
  }) => {
    await mockUpdaterSession(page, { available: true, version: "9.9.9" });
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(bannerText(page)).toHaveText("Update v9.9.9 available", { timeout: 10_000 });

    await page.locator(".update-banner-install").click();
    await expect(bannerText(page)).toHaveText("Downloading update…");

    // Progress with a known total renders a percentage…
    await emitProgress(page, 25, 100);
    await expect(bannerText(page)).toHaveText("Downloading update… 25%");
    // …and an unknown total falls back to bytes so the banner never looks hung.
    await emitProgress(page, 2 * 1024 * 1024, null);
    await expect(bannerText(page)).toHaveText("Downloading update… 2.0 MB");

    // Install completes → the app relaunches itself (spec: "applied — App
    // relaunches automatically"; there is no separate restart prompt).
    await page.evaluate(() => (window as unknown as { __resolveInstall: () => void }).__resolveInstall());
    await page.waitForFunction(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    );
  });

  test("a failed install shows the error state and Dismiss clears it", async ({ page }) => {
    await mockUpdaterSession(page, { available: true, version: "9.9.9" });
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(bannerText(page)).toHaveText("Update v9.9.9 available", { timeout: 10_000 });

    await page.locator(".update-banner-install").click();
    await expect(bannerText(page)).toHaveText("Downloading update…");

    await page.evaluate(() =>
      (window as unknown as { __rejectInstall: (e: Error) => void }).__rejectInstall(
        new Error("signature verification failed"),
      ),
    );

    await expect(bannerText(page)).toHaveText("Update failed. Please try again later.");
    // No relaunch on failure.
    const restarted = await page.evaluate(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    );
    expect(restarted).toBe(false);

    await page.locator(".update-banner-later").click();
    await expect(banner(page)).toHaveCount(0);
  });
});
