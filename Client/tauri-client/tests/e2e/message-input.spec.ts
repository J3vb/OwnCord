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
    const inputWrap = page.locator(".message-input-wrap");
    await expect(inputWrap).toBeAttached();
  });

  test("textarea is present and focusable", async ({ page }) => {
    const textarea = page.locator(".msg-textarea");
    await expect(textarea).toBeAttached();

    await textarea.focus();
    await expect(textarea).toBeFocused();
  });

  test("textarea has placeholder with channel name", async ({ page }) => {
    const textarea = page.locator(".msg-textarea");
    const placeholder = await textarea.getAttribute("placeholder");
    expect(placeholder).toMatch(/Message #/);
  });

  test("send button exists", async ({ page }) => {
    const sendBtn = page.locator(".send-btn");
    await expect(sendBtn).toBeAttached();
  });

  test("emoji button exists", async ({ page }) => {
    const emojiBtn = page.locator(".emoji-btn");
    await expect(emojiBtn).toBeAttached();
  });

  test("attach button exists", async ({ page }) => {
    const attachBtn = page.locator(".attach-btn");
    await expect(attachBtn).toBeAttached();
  });

  test("can type in the textarea", async ({ page }) => {
    const textarea = page.locator(".msg-textarea");
    await textarea.fill("Hello, this is a test message");
    await expect(textarea).toHaveValue("Hello, this is a test message");
  });

  test("reply bar is hidden by default", async ({ page }) => {
    const replyBar = page.locator(".reply-bar").first();
    // Reply bar should exist but not have visible class
    await expect(replyBar).toBeAttached();
    await expect(replyBar).not.toHaveClass(/visible/);
  });
});
