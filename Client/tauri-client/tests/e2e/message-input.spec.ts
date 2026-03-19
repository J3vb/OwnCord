import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Message Input
// ---------------------------------------------------------------------------

test.describe("Message Input", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("message input area is visible", async ({ page }) => {
    const inputWrap = page.locator("[data-testid='message-input']");
    await expect(inputWrap).toBeAttached();
  });

  test("textarea is present and focusable", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toBeAttached();

    await textarea.focus();
    await expect(textarea).toBeFocused();
  });

  test("textarea has placeholder containing channel name 'general'", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    const placeholder = await textarea.getAttribute("placeholder");
    expect(placeholder).toBe("Message #general");
  });

  test("send button exists with arrow icon", async ({ page }) => {
    const sendBtn = page.locator("[data-testid='send-btn']");
    await expect(sendBtn).toBeAttached();
    await expect(sendBtn).toHaveText("\u27A4");
  });

  test("emoji button exists", async ({ page }) => {
    const emojiBtn = page.locator(".emoji-btn");
    await expect(emojiBtn).toBeAttached();
  });

  test("attach button exists", async ({ page }) => {
    const attachBtn = page.locator(".attach-btn");
    await expect(attachBtn).toBeAttached();
  });

  test("typing in textarea updates its value", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Hello, this is a test message");
    await expect(textarea).toHaveValue("Hello, this is a test message");

    // Verify clearing also works
    await textarea.fill("");
    await expect(textarea).toHaveValue("");
  });

  test("reply bar is hidden by default", async ({ page }) => {
    const replyBar = page.locator(".reply-bar").first();
    // Reply bar should exist but not have visible class
    await expect(replyBar).toBeAttached();
    await expect(replyBar).not.toHaveClass(/visible/);
  });
});
