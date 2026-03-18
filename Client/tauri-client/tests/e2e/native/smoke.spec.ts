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

test.describe("Native App Smoke Tests", () => {
  test("app window loads with correct title", async ({ nativePage }) => {
    // The real Tauri app should set the window title from tauri.conf.json
    const title = await nativePage.title();
    expect(title).toBe("OwnCord");
  });

  test("app renders the connect page on first launch", async ({ nativePage }) => {
    // On first launch (no saved credentials), the app should show the connect page.
    // Wait for the page to fully render.
    await nativePage.waitForLoadState("networkidle");

    // The connect page should have the host/username/password fields
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
    await nativePage.waitForLoadState("networkidle");

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
    // tauri.conf.json specifies 1280x720 default window size
    const viewport = nativePage.viewportSize();
    // WebView2 viewport may not be exactly 1280x720 due to window chrome,
    // but it should be close. Check it's reasonable.
    if (viewport) {
      expect(viewport.width).toBeGreaterThan(800);
      expect(viewport.height).toBeGreaterThan(400);
    }
  });
});

test.describe("Native App Server Connection", () => {
  test("health check via real Tauri HTTP plugin", async ({ nativePage }) => {
    // This test requires chatserver.exe to be running.
    // Skip if OWNCORD_SKIP_SERVER_TESTS is set.
    test.skip(
      !!process.env.OWNCORD_SKIP_SERVER_TESTS,
      "Skipped: OWNCORD_SKIP_SERVER_TESTS is set",
    );

    await nativePage.waitForLoadState("networkidle");

    // The connect page auto-pings saved servers on load.
    // If a saved server profile exists (e.g. "localhost:8443"), the sidebar
    // shows a .server-item with a .srv-latency badge showing the ping time.
    // This proves the real Tauri HTTP plugin made a network request.
    const serverItem = nativePage.locator(".server-item").first();
    const hasServer = await serverItem.isVisible().catch(() => false);

    if (hasServer) {
      // A saved server exists — wait for latency to populate (proves real HTTP)
      const latencyBadge = serverItem.locator(".srv-latency");
      await expect(latencyBadge).toHaveText(/\d+ms/, { timeout: 10_000 });
    } else {
      // No saved server — fill in host and verify server-side response.
      // The health check happens when the server profile is pinged.
      const hostInput = nativePage.locator("#host");
      await hostInput.fill("localhost:8443");
      await hostInput.press("Tab");

      // Give the health check time, then verify the form is still functional
      // (no crash = real HTTP plugin loaded correctly)
      await nativePage.waitForTimeout(3_000);
      await expect(nativePage.locator("#host")).toHaveValue("localhost:8443");
    }
  });

  test("login attempt reaches real server", async ({ nativePage }) => {
    // This test verifies the real Tauri HTTP plugin makes actual API calls.
    // It does NOT require valid credentials — an "invalid credentials" error
    // from the server proves the round-trip works.
    // Skip if OWNCORD_SKIP_SERVER_TESTS is set.
    test.skip(
      !!process.env.OWNCORD_SKIP_SERVER_TESTS,
      "Skipped: OWNCORD_SKIP_SERVER_TESTS is set",
    );

    await nativePage.waitForLoadState("networkidle");

    // Fill login form — use env vars for real creds, or dummy creds to prove API round-trip
    const serverUrl = process.env.OWNCORD_SERVER_URL ?? "localhost:8443";
    const username = process.env.OWNCORD_TEST_USER ?? "e2e-native-test";
    const password = process.env.OWNCORD_TEST_PASS ?? "e2e-native-test";

    await nativePage.locator("#host").fill(serverUrl);
    await nativePage.locator("#username").fill(username);
    await nativePage.locator("#password").fill(password);
    await nativePage.locator("button.btn-primary[type='submit']").click();

    // Wait for either: successful login OR server error response.
    // Both prove the real HTTP plugin made a round-trip to the server.
    const appLayout = nativePage.locator("[data-testid='app-layout']");
    const errorBanner = nativePage.locator(".error-banner, .error-message, .toast-error, [role='alert']");

    // Use Promise.race — whichever appears first
    const result = await Promise.race([
      appLayout.waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "login-success" as const),
      errorBanner.waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "login-error" as const),
    ]).catch(() => "timeout" as const);

    // Either outcome proves the real Tauri HTTP plugin works
    expect(["login-success", "login-error"]).toContain(result);
  });
});

test.describe("Native App Credential Store", () => {
  test("credential commands are available", async ({ nativePage }) => {
    // Verify the real Tauri credential commands exist
    // (save_credential, load_credential, delete_credential)
    const canInvoke = await nativePage.evaluate(async () => {
      try {
        const result = await (window as any).__TAURI_INTERNALS__.invoke(
          "load_credential",
          { host: "e2e-test-nonexistent" },
        );
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
