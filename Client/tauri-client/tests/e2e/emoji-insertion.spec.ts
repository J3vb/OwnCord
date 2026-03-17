/**
 * E2E tests for emoji picker insertion into the message textarea.
 * Covers: clicking emoji inserts it, picker closes after selection.
 */
import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

test.describe("Emoji Picker — Insert into textarea", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
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
