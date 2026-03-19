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

// ---------------------------------------------------------------------------
// Login helpers
// ---------------------------------------------------------------------------

/**
 * Perform a real login against the server.
 * Requires OWNCORD_TEST_USER and OWNCORD_TEST_PASS env vars.
 */
export async function nativeLogin(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");

  // Fill the connect form
  const hostInput = page.locator("#host");
  await hostInput.clear();
  await hostInput.fill(SERVER_URL);

  await page.locator("#username").fill(TEST_USER);
  await page.locator("#password").fill(TEST_PASS);
  await page.locator("button.btn-primary[type='submit']").click();

  // Wait for the main app layout to appear (real server + WS handshake).
  // 60s timeout — each test launches a fresh Tauri exe, and rapid
  // sequential logins may be rate-limited by the server.
  const appLayout = page.locator("[data-testid='app-layout']");
  await expect(appLayout).toBeVisible({ timeout: 60_000 });
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
