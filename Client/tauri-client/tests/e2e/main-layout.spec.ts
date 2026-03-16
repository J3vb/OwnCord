import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Main Page Layout
// ---------------------------------------------------------------------------

test.describe("Main Page Layout", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("app layout has all major sections", async ({ page }) => {
    // Server strip
    await expect(page.locator(".server-strip")).toBeVisible();

    // Channel sidebar
    await expect(page.locator(".channel-sidebar")).toBeVisible();

    // Chat area
    await expect(page.locator(".chat-area")).toBeVisible();

    // Chat header
    await expect(page.locator(".chat-header")).toBeVisible();

    // Messages container
    await expect(page.locator(".messages-container")).toBeVisible();

    // User bar
    await expect(page.locator(".user-bar")).toBeVisible();
  });

  test("input slot is attached to DOM", async ({ page }) => {
    const inputSlot = page.locator(".input-slot");
    await expect(inputSlot).toBeAttached();
  });

  test("typing slot is attached to DOM", async ({ page }) => {
    const typingSlot = page.locator(".typing-slot");
    await expect(typingSlot).toBeAttached();
  });

  test("messages slot is visible", async ({ page }) => {
    const messagesSlot = page.locator(".messages-slot");
    await expect(messagesSlot).toBeVisible();
  });

  test("member list is visible", async ({ page }) => {
    const memberList = page.locator(".member-list");
    await expect(memberList).toBeVisible();
  });
});
