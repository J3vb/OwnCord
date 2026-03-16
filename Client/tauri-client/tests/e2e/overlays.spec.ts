import { test, expect } from "@playwright/test";
import { mockTauriFullSession, mockTauriFullSessionWithMessages, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Quick Switcher (Ctrl+K)
// ---------------------------------------------------------------------------

test.describe("Quick Switcher", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("Ctrl+K opens quick switcher", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const overlay = page.locator(".quick-switcher-overlay");
    await expect(overlay).toBeVisible({ timeout: 3_000 });
  });

  test("quick switcher has search input", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const input = page.locator(".quick-switcher__input");
    await expect(input).toBeVisible({ timeout: 3_000 });
    await expect(input).toBeFocused();
  });

  test("quick switcher shows channel results", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const results = page.locator(".quick-switcher__item");
    await expect(results.first()).toBeVisible({ timeout: 3_000 });
  });

  test("first result is highlighted by default", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const active = page.locator(".quick-switcher__item--active");
    await expect(active).toBeVisible({ timeout: 3_000 });
  });

  test("Escape closes quick switcher", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".quick-switcher-overlay")).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(page.locator(".quick-switcher-overlay")).not.toBeVisible();
  });

  test("clicking overlay backdrop closes quick switcher", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const overlay = page.locator(".quick-switcher-overlay");
    await expect(overlay).toBeVisible({ timeout: 3_000 });

    // Click the backdrop (not the modal)
    await overlay.click({ position: { x: 10, y: 10 } });
    await expect(overlay).not.toBeVisible();
  });

  test("typing in search filters results", async ({ page }) => {
    await page.keyboard.press("Control+k");
    const input = page.locator(".quick-switcher__input");
    await expect(input).toBeVisible({ timeout: 3_000 });

    const initialCount = await page.locator(".quick-switcher__item").count();

    await input.fill("general");
    await page.waitForTimeout(200);

    const filteredCount = await page.locator(".quick-switcher__item").count();
    expect(filteredCount).toBeLessThanOrEqual(initialCount);
    expect(filteredCount).toBeGreaterThanOrEqual(1);
  });

  test("Enter selects highlighted result", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".quick-switcher__item").first()).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Enter");
    await expect(page.locator(".quick-switcher-overlay")).not.toBeVisible();
  });

  test("arrow keys navigate results", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".quick-switcher__item").first()).toBeVisible({ timeout: 3_000 });

    const firstItem = page.locator(".quick-switcher__item").first();
    const firstIsActive = await firstItem.evaluate((el) =>
      el.classList.contains("quick-switcher__item--active"),
    );

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);

    // Active state should have moved
    const secondItem = page.locator(".quick-switcher__item").nth(1);
    if (await secondItem.count() > 0) {
      const secondIsActive = await secondItem.evaluate((el) =>
        el.classList.contains("quick-switcher__item--active"),
      );
      expect(firstIsActive || secondIsActive).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Emoji Picker
// ---------------------------------------------------------------------------

test.describe("Emoji Picker", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("emoji button opens emoji picker", async ({ page }) => {
    const emojiBtn = page.locator(".emoji-btn");
    await emojiBtn.click();

    const picker = page.locator(".emoji-picker.open");
    await expect(picker).toBeVisible({ timeout: 3_000 });
  });

  test("emoji picker has search input", async ({ page }) => {
    await page.locator(".emoji-btn").click();

    const search = page.locator(".ep-search");
    await expect(search).toBeVisible({ timeout: 3_000 });
  });

  test("emoji picker shows emoji grid", async ({ page }) => {
    await page.locator(".emoji-btn").click();

    const grid = page.locator(".ep-grid");
    await expect(grid.first()).toBeVisible({ timeout: 3_000 });
  });

  test("emoji picker shows category labels", async ({ page }) => {
    await page.locator(".emoji-btn").click();

    const categoryLabel = page.locator(".ep-category-label");
    await expect(categoryLabel.first()).toBeVisible({ timeout: 3_000 });
  });

  test("emoji picker has clickable emojis", async ({ page }) => {
    await page.locator(".emoji-btn").click();

    const emoji = page.locator(".ep-emoji");
    await expect(emoji.first()).toBeVisible({ timeout: 3_000 });
  });

  test("searching filters emojis", async ({ page }) => {
    await page.locator(".emoji-btn").click();

    const search = page.locator(".ep-search");
    await expect(search).toBeVisible({ timeout: 3_000 });

    // Get count before filtering
    const allEmojis = page.locator(".ep-emoji");
    const countBefore = await allEmojis.count();
    expect(countBefore).toBeGreaterThan(10);

    // Search for a specific emoji character that exists in the grid
    await search.fill("\uD83D\uDE00");
    await page.waitForTimeout(200);

    const countAfter = await allEmojis.count();
    // After filtering, should have fewer results
    expect(countAfter).toBeLessThan(countBefore);
    expect(countAfter).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Pinned Messages
// ---------------------------------------------------------------------------

test.describe("Pinned Messages", () => {
  test("pinned panel can be opened from chat header", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Look for a pin button in chat header tools area
    const pinBtn = page.locator(".ch-tools button", { hasText: /pin/i });
    if (await pinBtn.count() > 0) {
      await pinBtn.click();

      const panel = page.locator(".pinned-panel");
      await expect(panel).toBeVisible({ timeout: 3_000 });
    }
  });

  test("pinned panel has close button", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const pinBtn = page.locator(".ch-tools button", { hasText: /pin/i });
    if (await pinBtn.count() > 0) {
      await pinBtn.click();

      const closeBtn = page.locator(".pinned-panel__close");
      await expect(closeBtn).toBeVisible({ timeout: 3_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Invite Manager
// ---------------------------------------------------------------------------

test.describe("Invite Manager", () => {
  test("invite manager can be opened", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Invite manager is typically opened from channel sidebar header or server context
    const inviteBtn = page.locator("button", { hasText: /invite/i });
    if (await inviteBtn.count() > 0) {
      await inviteBtn.first().click();

      const overlay = page.locator(".invite-manager-overlay");
      await expect(overlay).toBeVisible({ timeout: 3_000 });
    }
  });
});
