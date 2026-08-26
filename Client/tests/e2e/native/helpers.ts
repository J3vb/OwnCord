/**
 * Shared helpers for native E2E tests.
 *
 * Unlike mocked helpers, these interact with the REAL Tauri app + server.
 * No __TAURI_INTERNALS__ mocking — everything is genuine.
 */

import { type Page, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

export const SERVER_URL = process.env.OWNCORD_SERVER_URL ?? "localhost:8443";
export const TEST_USER = process.env.OWNCORD_TEST_USER ?? "";
export const TEST_PASS = process.env.OWNCORD_TEST_PASS ?? "";
export const SKIP_SERVER = !!process.env.OWNCORD_SKIP_SERVER_TESTS;

/** Returns true if real server credentials are configured. */
export function hasCredentials(): boolean {
  return TEST_USER.length > 0 && TEST_PASS.length > 0;
}

/**
 * Log the native E2E environment state for diagnosing skipped tests.
 * Call once in a globalSetup or first test to understand what's available.
 */
export function logEnvironmentState(): void {
  const state = {
    serverUrl: SERVER_URL,
    hasCredentials: hasCredentials(),
    skipServer: SKIP_SERVER,
  };
  console.log("[native-e2e] Environment:", JSON.stringify(state));
  if (!hasCredentials()) {
    console.log(
      "[native-e2e] WARNING: Set OWNCORD_TEST_USER and OWNCORD_TEST_PASS to enable authenticated tests",
    );
  }
}

/**
 * Count visible elements matching a selector. Useful for deciding whether
 * a data-dependent test can run. Returns 0 if the selector isn't found.
 */
export async function countVisible(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

// ---------------------------------------------------------------------------
// Login helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the page is already on the main app layout (logged in).
 * Returns true if app-layout is visible, false if on connect page or elsewhere.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const appLayout = page.locator("[data-testid='app-layout']");
    return await appLayout.isVisible();
  } catch {
    return false;
  }
}

/**
 * Perform a real login against the server.
 * Requires OWNCORD_TEST_USER and OWNCORD_TEST_PASS env vars.
 *
 * Includes exponential backoff retry to handle server rate limiting
 * (5 logins/min, 10-failure lockout).
 */
export async function nativeLogin(page: Page, maxRetries = 3): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Wait for the connect form to be ready instead of relying on networkidle
      const hostInput = page.locator("#host");
      await expect(hostInput).toBeVisible({ timeout: 15_000 });
      await expect(hostInput).toBeEditable({ timeout: 5_000 });

      // Fill the connect form
      await hostInput.clear();
      await hostInput.fill(SERVER_URL);

      await page.locator("#username").fill(TEST_USER);
      await page.locator("#password").fill(TEST_PASS);
      await page.locator("button.btn-primary[type='submit']").click();

      // Wait for the main app layout to appear (real server + WS handshake).
      // Use 60s timeout to accommodate server rate limiting and slow connections.
      const appLayout = page.locator("[data-testid='app-layout']");
      await expect(appLayout).toBeVisible({ timeout: 60_000 });
      return; // success
    } catch (error: unknown) {
      lastError = error;

      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise((r) => setTimeout(r, delay));

        // Dismiss any error banner before retrying
        const errorBanner = page.locator(".error-banner");
        const hasBanner = await errorBanner.isVisible().catch(() => false);
        if (hasBanner) {
          // Wait for the error banner to disappear before retrying
          await errorBanner.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
        }
      }
    }
  }

  throw lastError;
}

/**
 * Login and wait for channels to populate (WS ready handshake complete).
 */
export async function nativeLoginAndReady(page: Page): Promise<void> {
  await nativeLogin(page);

  // Wait for at least one channel to appear (proof of WS ready)
  const channel = page.locator(".channel-item").first();
  await expect(channel).toBeVisible({ timeout: 15_000 });
}

/**
 * Ensure the page is logged in and ready. If already on the main app layout,
 * skip login entirely. Used by persistent fixture tests to avoid redundant
 * login attempts that trigger rate limiting.
 */
export async function ensureLoggedIn(page: Page): Promise<void> {
  if (await isLoggedIn(page)) {
    // Already logged in — verify channels are still loaded
    const channel = page.locator(".channel-item").first();
    const hasChannels = await channel.isVisible().catch(() => false);
    if (hasChannels) {
      return; // fully ready, nothing to do
    }
    // App layout visible but no channels — wait for WS reconnect
    await expect(channel).toBeVisible({ timeout: 15_000 });
    return;
  }

  // Not logged in — perform full login
  await nativeLoginAndReady(page);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Click a text channel by its visible name.
 */
export async function selectChannel(page: Page, name: string): Promise<void> {
  const channel = page.locator(".channel-item", { hasText: name });
  await channel.click();
  await expect(channel).toHaveClass(/active/, { timeout: 5_000 });
}

/**
 * Open the settings overlay via the gear button.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.locator("button[aria-label='Settings']").click();
  const overlay = page.locator("[data-testid='settings-overlay']");
  await expect(overlay).toHaveClass(/open/, { timeout: 5_000 });
}

/**
 * Wait for messages to load in the current channel.
 */
export async function waitForMessages(page: Page): Promise<void> {
  const container = page.locator(".messages-container");
  await expect(container).toBeVisible({ timeout: 10_000 });
}

/**
 * Count text channels visible in the sidebar.
 * Useful for data-dependent test gating.
 */
export async function countTextChannels(page: Page): Promise<number> {
  return page
    .locator(".channel-item")
    .filter({ has: page.locator(".ch-icon", { hasText: "#" }) })
    .count();
}

/**
 * Count voice channels visible in the sidebar.
 */
export async function countVoiceChannels(page: Page): Promise<number> {
  return page.locator(".channel-item .ch-icon", { hasText: "\u{1F50A}" }).count();
}
