/**
 * E2E tests for emoji picker insertion into the message textarea.
 * Covers: clicking emoji inserts it, picker closes after selection.
 */
import { test, expect } from "./fixtures";
import { startFullSession } from "./helpers";
import { findUnnamedControls, keyboardReachable } from "./support/accessibility";

test.describe("Emoji Picker — Insert into textarea", () => {
  test.beforeEach(async ({ page }) => {
    await startFullSession(page);
  });

  test("clicking an emoji inserts it into the textarea", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    const initialValue = await textarea.inputValue();

    // Open emoji picker
    await page.locator(".emoji-btn").click();
    const picker = page.locator(".emoji-picker.open");
    await expect(picker).toBeVisible({ timeout: 3000 });

    // Click the first emoji
    const firstEmoji = picker.locator(".ep-emoji").first();
    const emojiText = await firstEmoji.textContent();
    await firstEmoji.click();

    // Textarea should now contain the emoji
    const newValue = await textarea.inputValue();
    expect(newValue.length).toBeGreaterThan(initialValue.length);
    if (emojiText) {
      expect(newValue).toContain(emojiText);
    }
  });

  test("keeps emoji scrolling stable and keyboard selection accessible", async ({ page }) => {
    await page.locator(".emoji-btn").click();
    const picker = page.locator(".emoji-picker.open");
    await expect(picker.locator(".ep-loading")).toHaveCount(0);
    const area = picker.locator(".ep-scroll");
    await expect(picker.locator(".ep-category-label")).toHaveCount(9);
    const height = await area.evaluate((el) => el.scrollHeight);
    const first = picker.locator(".ep-emoji").first();
    expect(await keyboardReachable(page, first)).toBe(true);
    await first.press("End");
    const last = picker.locator(".ep-emoji").last();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    expect(await area.evaluate((el) => el.scrollHeight)).toBe(height);
    expect(await findUnnamedControls(picker)).toEqual([]);
    await last.press("Home");
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    const emoji = await first.getAttribute("data-emoji");
    await first.press("Enter");
    await expect(page.locator("[data-testid='msg-textarea']")).toHaveValue(emoji!);
  });

  test("emoji picker closes after selecting an emoji", async ({ page }) => {
    await page.locator(".emoji-btn").click();
    const picker = page.locator(".emoji-picker.open");
    await expect(picker).toBeVisible({ timeout: 3000 });

    // Click an emoji
    await picker.locator(".ep-emoji").first().click();

    // Picker should close
    await expect(picker).not.toBeVisible({ timeout: 3000 });
  });

  test("multiple emojis can be selected by reopening picker", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");

    // First emoji
    await page.locator(".emoji-btn").click();
    await page.locator(".emoji-picker.open .ep-emoji").first().click();
    const afterFirst = await textarea.inputValue();
    expect(afterFirst.length).toBeGreaterThan(0);

    // Second emoji
    await page.locator(".emoji-btn").click();
    const picker = page.locator(".emoji-picker.open");
    await expect(picker).toBeVisible({ timeout: 3000 });
    await picker.locator(".ep-emoji").nth(1).click();

    const afterSecond = await textarea.inputValue();
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });
});
