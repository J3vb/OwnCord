/**
 * E2E tests for the message send round-trip flow.
 * Covers: type message → send → see it appear in message list.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithEcho,
  navigateToMainPage,
} from "./helpers";

test.describe("Message Send Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("typing and pressing Enter sends a message", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Hello from E2E test!");
    await textarea.press("Enter");

    // Message should appear in the list via WS echo
    const newMsg = page.locator(".message .msg-text", {
      hasText: "Hello from E2E test!",
    });
    await expect(newMsg).toBeVisible({ timeout: 5000 });
  });

  test("send button click sends the message", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Sent via button click");

    const sendBtn = page.locator("[data-testid='send-btn']");
    await sendBtn.click();

    const newMsg = page.locator(".message .msg-text", {
      hasText: "Sent via button click",
    });
    await expect(newMsg).toBeVisible({ timeout: 5000 });
  });

  test("textarea clears after sending", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Clear after send");
    await textarea.press("Enter");

    // Wait for the echo message to appear (confirms send happened)
    await expect(
      page.locator(".message .msg-text", { hasText: "Clear after send" }),
    ).toBeVisible({ timeout: 5000 });

    // Textarea should be empty
    await expect(textarea).toHaveValue("");
  });

  test("empty message is not sent", async ({ page }) => {
    const textarea = page.locator("[data-testid='msg-textarea']");
    // Focus and press Enter without typing
    await textarea.focus();
    await textarea.press("Enter");

    // Count messages — should still be 1 (the pre-loaded mock message)
    const messages = page.locator(".message");
    await expect(messages).toHaveCount(1);
  });

  test("long message sends successfully", async ({ page }) => {
    const longContent = "A".repeat(500);
    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill(longContent);
    await textarea.press("Enter");

    const newMsg = page.locator(".message .msg-text", {
      hasText: longContent,
    });
    await expect(newMsg).toBeVisible({ timeout: 5000 });
  });
});
