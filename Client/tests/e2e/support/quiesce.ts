import { expect, type Page } from "@playwright/test";

/** Settle the app into its sampled state: no overlay open, `#general` shown. */
export async function quiesce(page: Page): Promise<void> {
  // Close every overlay, return to the default channel and member-list state.
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(".settings-close-btn")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page
    .locator(".reaction-picker-wrap")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page
    .locator("[data-testid='user-profile-overlay']")
    .click({ timeout: 1000 })
    .catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  // Return to #general. Clicking the row is a no-op when it is already active,
  // and after a logout the app has already landed there.
  await page
    .locator("[data-testid='channel-sidebar'] .channel-list .channel-item", { hasText: "general" })
    .first()
    .click();
  // Wait for the app to be fully settled before measuring: a sample taken
  // mid-render reads a smaller DOM and a partially-registered listener set.
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await expect(page.locator("[data-testid='member-list']")).toBeVisible();
  await expect(page.locator(".chat-header .ch-name")).toHaveText("general");
  await expect(page.locator("[data-testid='message-input']")).toBeVisible();
  // Toasts default to a 5 s duration; wait for the DOM to drain.
  await expect
    .poll(async () => page.locator(".toast").count(), { timeout: 15_000, intervals: [200] })
    .toBe(0);
  // Let asynchronous teardown drain before the GCs and the counters: leaving a
  // voice room, closing a socket and disposing a session all finish on
  // microtasks/timers after their synchronous call returns. Sampling in that
  // window reads listeners and controllers that are already being released,
  // which is a measurement bug, not a leak.
  await page.waitForTimeout(1000);
}
