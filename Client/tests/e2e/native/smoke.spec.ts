/**
 * Native E2E smoke tests — verify the real Tauri production app works.
 *
 * These tests launch the actual OwnCord exe and connect via CDP.
 * They verify things that CANNOT be caught by mocked browser tests:
 * - Real Tauri window loads and renders
 * - Real Tauri IPC commands work (__TAURI_INTERNALS__ is real, not mocked)
 * - Real HTTP plugin makes actual network requests
 * - Real credential store works
 * - Window title and metadata match production config
 */

import { test, expect } from "../native-fixture";
import { SERVER_URL } from "./helpers";

test.describe("Native App Smoke Tests", () => {
  test("app window loads with correct title", async ({ nativePage }) => {
    // The real Tauri app should set the window title from tauri.conf.json
    const title = await nativePage.title();
    expect(title).toBe("OwnCord");
  });

  test("app renders the connect page on first launch", async ({ nativePage }) => {
    // On first launch (no saved credentials), the app should show the connect page.
    // Wait for the connect form to render rather than relying on networkidle.
    const hostInput = nativePage.locator("#host");
    await expect(hostInput).toBeVisible({ timeout: 15_000 });

    const usernameInput = nativePage.locator("#username");
    await expect(usernameInput).toBeVisible();

    const passwordInput = nativePage.locator("#password");
    await expect(passwordInput).toBeVisible();
  });

  test("real __TAURI_INTERNALS__ is present (not mocked)", async ({ nativePage }) => {
    // In the real app, __TAURI_INTERNALS__ is injected by Tauri, not by our mock script.
    // Verify it exists and has the expected structure.
    const hasTauriInternals = await nativePage.evaluate(() => {
      return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
    });
    expect(hasTauriInternals).toBe(true);

    // Verify it has the real invoke function (not our mock)
    const hasInvoke = await nativePage.evaluate(() => {
      return typeof (window as any).__TAURI_INTERNALS__?.invoke === "function";
    });
    expect(hasInvoke).toBe(true);

    // Our mock sets metadata.currentWindow.label — the real one does too,
    // but it's injected differently. Verify the structure exists.
    const hasMetadata = await nativePage.evaluate(() => {
      const t = (window as any).__TAURI_INTERNALS__;
      return t?.metadata?.currentWindow?.label === "main";
    });
    expect(hasMetadata).toBe(true);
  });

  test("CSS and styles load correctly in production", async ({ nativePage }) => {
    // Wait for the app container to be present before checking styles
    await nativePage.waitForSelector("#app", { timeout: 15_000 });

    // Verify that stylesheets are loaded (production build bundles CSS)
    const styleSheetCount = await nativePage.evaluate(() => {
      return document.styleSheets.length;
    });
    expect(styleSheetCount).toBeGreaterThan(0);

    // Verify the app container exists and has dimensions
    const appContainer = await nativePage.evaluate(() => {
      const app = document.getElementById("app");
      if (!app) return null;
      const rect = app.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(appContainer).not.toBeNull();
    expect(appContainer!.width).toBeGreaterThan(0);
    expect(appContainer!.height).toBeGreaterThan(0);
  });

  test("window dimensions match tauri.conf.json defaults", async ({ nativePage }) => {
    // tauri.conf.json pins a 1280x720 inner (client-area) size. The webview's
    // innerWidth/innerHeight is exactly that client area in CSS pixels, so this
    // compares the rendered app to its configured size instead of a ">800x400"
    // floor any window would pass. A 5% band tolerates Windows DPI rounding
    // while still failing on a window configured to some other size.
    const configured = { width: 1280, height: 720 };
    const inner = await nativePage.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    expect(Math.abs(inner.width - configured.width) / configured.width).toBeLessThan(0.05);
    expect(Math.abs(inner.height - configured.height) / configured.height).toBeLessThan(0.05);
  });
});

test.describe("Native App Server Connection", () => {
  test("health check via real Tauri HTTP plugin", async ({ nativePage }) => {
    // This test requires chatserver.exe to be running.
    // Skip if OWNCORD_SKIP_SERVER_TESTS is set.
    test.skip(!!process.env.OWNCORD_SKIP_SERVER_TESTS, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");

    // Wait for the connect form to be ready before interacting
    const hostInput = nativePage.locator("#host");
    await expect(hostInput).toBeVisible({ timeout: 15_000 });

    // The connect page health-checks its saved profiles through the real Rust
    // HTTP proxy. Reach that path deterministically: add the running server as
    // a profile via the real modal, then assert the row's health dot leaves
    // "unknown" and its latency badge shows a measured round-trip. That proves
    // the real Tauri HTTP plugin made a request — filling the host input and
    // re-reading it (the old assertion) proved only that the DOM kept a value.
    const host = SERVER_URL;
    await nativePage.locator(".btn-add-server").click();
    const modal = nativePage.locator(".modal-overlay.visible .modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator(".modal-body .form-input").nth(0).fill("Health Check");
    await modal.locator(".modal-body .form-input").nth(1).fill(host);
    await modal.locator(".modal-footer .btn-primary").click();

    const row = nativePage.locator(`.server-item[data-host='${host}']`);
    await expect(row).toBeVisible({ timeout: 5_000 });

    // The health probe is the first TLS contact, so the Rust proxy refuses it
    // until the self-signed certificate is explicitly trusted (the real user
    // ceremony). Trusting re-runs the health check.
    const dialog = nativePage.getByRole("dialog", { name: "New Server Certificate" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: "Trust This Certificate", exact: true }).click();
    await expect(dialog).toBeHidden();

    // The pin lands asynchronously in Rust; confirm it before asserting on a
    // probe that would otherwise still be refused.
    await expect
      .poll(() =>
        nativePage.evaluate(
          (h) => (window as any).__TAURI_INTERNALS__.invoke("get_cert_fingerprint", { host: h }),
          host,
        ),
      )
      .toMatch(/^[0-9A-Fa-f:]+$/);

    // A real round trip: the dot must become online/slow (not `unknown`), and
    // the latency badge must show a measurement.
    await expect(row.locator(".srv-status-dot.online, .srv-status-dot.slow")).toBeVisible({
      timeout: 15_000,
    });
    await expect(row.locator(".srv-latency")).toHaveText(/\d+ms/, { timeout: 15_000 });
  });
});

test.describe("Native App Credential Store", () => {
  test("credential commands are available", async ({ nativePage }) => {
    // Verify the real Tauri credential commands exist
    // (save_credential, load_credential, delete_credential)
    const canInvoke = await nativePage.evaluate(async () => {
      try {
        const result = await (window as any).__TAURI_INTERNALS__.invoke("load_credential", {
          host: "e2e-test-nonexistent",
        });
        // Should return null for nonexistent host, not throw
        return result === null || result === undefined;
      } catch (e: any) {
        // If the command doesn't exist, it throws
        return false;
      }
    });
    expect(canInvoke).toBe(true);
  });
});
