import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  openSettings,
  BASE_SESSION_ROUTES,
} from "./helpers";
import { findUnnamedControls, focusIndicator, keyboardReachable } from "./support/accessibility";

// ---------------------------------------------------------------------------
// Tests: Settings > My uploads journey, by keyboard, with the shared
// accessibility checks run on the page and on the remove confirmation.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const file = (id: string, filename: string, size: number, mime: string) => ({
  id,
  filename,
  size,
  mime,
  url: `/api/v1/files/${id}`,
});
const UPLOADS = {
  items: [
    {
      attachment: file("a1", "quarterly-report.pdf", 12 * MB, "application/pdf"),
      uploaded_at: "2026-10-20 09:10:00",
      channel_id: 1,
      message_id: 31,
      state: "message",
      removable: true,
    },
    {
      attachment: file("a2", "me.png", 0.3 * MB, "image/png"),
      uploaded_at: "2026-09-02 12:00:00",
      channel_id: null,
      message_id: null,
      state: "avatar",
      removable: false,
    },
  ],
};

test.describe("My uploads", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ...BASE_SESSION_ROUTES,
          { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
          {
            pattern: "/api/v1/users/me/storage",
            status: 200,
            body: { used_bytes: 64 * MB, quota_bytes: 100 * MB },
          },
          { pattern: "/api/v1/users/me/uploads", method: "GET", status: 200, body: UPLOADS },
          { pattern: "/api/v1/users/me/uploads/a1", method: "DELETE", status: 204, body: null },
        ],
        simulateWsFlow: true,
      }),
    );
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await page
      .locator(".settings-sidebar button.settings-nav-item", { hasText: "My uploads" })
      .click();
    await expect(page.locator(".my-uploads__row")).toHaveCount(2);
  });

  test("controls are named and reachable by keyboard", async ({ page }) => {
    const pane = page.locator(".settings-content");
    expect(await findUnnamedControls(pane)).toEqual([]);
    await expect(page.locator(".my-uploads__remove")).toHaveCount(1);
    for (const target of [
      page.locator(".my-uploads__sort-btn").first(),
      page.locator(".my-uploads__search"),
      page.locator(".my-uploads__remove"),
    ]) {
      expect(await keyboardReachable(page, target)).toBe(true);
      expect((await focusIndicator(page)).problems).toEqual([]);
    }
  });

  test("Escape cancels the confirmation only; confirming removes the row", async ({ page }) => {
    const remove = page.locator(".my-uploads__remove");
    expect(await keyboardReachable(page, remove)).toBe(true);
    await page.keyboard.press("Enter");

    const dialog = page.locator("[data-testid='uploads-remove-confirm']");
    await expect(dialog).toBeVisible();
    expect(await findUnnamedControls(dialog)).toEqual([]);
    expect((await focusIndicator(page)).problems).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
    await expect(page.locator(".my-uploads__row")).toHaveCount(2);

    await remove.click();
    await expect(dialog).toBeVisible();
    const confirm = page.locator("[data-testid='uploads-remove-confirm-btn']");
    expect(await keyboardReachable(page, confirm)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".my-uploads__row")).toHaveCount(1);
    await expect(page.locator(".my-uploads__remove")).toHaveCount(0);
  });
});
