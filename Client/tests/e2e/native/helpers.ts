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

export let SERVER_URL = process.env.OWNCORD_SERVER_URL ?? "localhost:8443";
export let TEST_USER = process.env.OWNCORD_TEST_USER ?? "";
export let TEST_PASS = process.env.OWNCORD_TEST_PASS ?? "";
export const SKIP_SERVER = !!process.env.OWNCORD_SKIP_SERVER_TESTS;

export function configureNativeServer(origin: string): void {
  SERVER_URL = origin.replace("https://", "");
  TEST_USER = "alice";
  TEST_PASS = "OwnCord-E2E-pass-123!";
}

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
 * The fixture owns the fresh server and certificate store; retries happen at
 * the Playwright attempt boundary with a fresh worker.
 */
const confirmedHosts = new WeakMap<Page, Set<string>>();
export async function nativeLogin(page: Page): Promise<void> {
  await expect(page.locator("#host")).toBeEditable();
  await page.locator("#host").fill(SERVER_URL);
  const confirmed = confirmedHosts.get(page) ?? new Set<string>();
  if (!confirmed.has(SERVER_URL)) {
    // Every fixture starts with its own empty certificate store. Exercise the
    // real first-use ceremony before sending credentials to the owned server.
    const dialog = page.getByRole("dialog", { name: "New Server Certificate" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(SERVER_URL);
    await dialog.getByRole("button", { name: "Trust This Certificate", exact: true }).click();
    await expect(dialog).toBeHidden();
    confirmed.add(SERVER_URL);
    confirmedHosts.set(page, confirmed);
  }
  await page.locator("#username").fill(TEST_USER);
  await page.locator("#password").fill(TEST_PASS);
  await page.locator("button.btn-primary[type='submit']").click();
  await expect(page.getByTestId("app-layout")).toBeVisible({ timeout: 30_000 });
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
