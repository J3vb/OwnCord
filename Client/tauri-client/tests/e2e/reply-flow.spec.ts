/**
 * E2E tests for the reply-to message flow.
 * Covers: click reply → see reply bar → send reply → verify.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithMessagesAndEcho,
  navigateToMainPage,
} from "./helpers";

test.describe("Reply Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Reply shows reply bar", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();
    await page.locator("[data-testid='msg-reply-101']").click();

    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toBeVisible({ timeout: 3000 });
  });

  test("reply bar shows the referenced author name", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();
    await page.locator("[data-testid='msg-reply-101']").click();

    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toContainText("testuser");
  });

  test("sending a reply clears the reply bar", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();
    await page.locator("[data-testid='msg-reply-101']").click();

    // Verify reply bar is shown
    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toBeVisible();

    // Type and send reply
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("This is my reply");
    await textarea.press("Enter");

    // Reply bar should be hidden after sending
    await expect(replyBar).not.toBeVisible({ timeout: 5000 });
  });

  test("reply message appears with reply reference", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();
    await page.locator("[data-testid='msg-reply-101']").click();

    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Replying to you!");
    await textarea.press("Enter");

    // The new reply message should appear with a reply reference
    const newReply = page.locator(".message .msg-text", {
      hasText: "Replying to you!",
    });
    await expect(newReply).toBeVisible({ timeout: 5000 });

    // The reply message should also contain a reply reference element
    const replyMessage = page.locator(".message", {
      has: page.locator(".msg-text", { hasText: "Replying to you!" }),
    });
    const replyRef = replyMessage.locator(".msg-reply-ref");
    await expect(replyRef).toBeVisible({ timeout: 3000 });
  });

  test("cancel button on reply bar dismisses it", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();
    await page.locator("[data-testid='msg-reply-101']").click();

    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toBeVisible();

    // Click the close button on the reply bar
    const cancelBtn = replyBar.locator(".reply-close");
    await cancelBtn.click();
    await expect(replyBar).not.toBeVisible();
  });
});
