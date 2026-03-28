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
    // Unified sidebar (replaces old server strip)
    await expect(page.locator("[data-testid='unified-sidebar']")).toBeVisible();

    // Channel sidebar
    await expect(page.locator("[data-testid='channel-sidebar']")).toBeVisible();

    // Chat area
    await expect(page.locator("[data-testid='chat-area']")).toBeVisible();

    // Chat header with channel name "general"
    const chatHeader = page.locator("[data-testid='chat-header']");
    await expect(chatHeader).toBeVisible();
    const headerName = page.locator("[data-testid='chat-header-name']");
    await expect(headerName).toHaveText("general");

    // Messages container
    await expect(page.locator(".messages-container")).toBeVisible();

    // User bar
    await expect(page.locator("[data-testid='user-bar']")).toBeVisible();
  });

  test("input slot is attached to DOM", async ({ page }) => {
    const inputSlot = page.locator("[data-testid='input-slot']");
    await expect(inputSlot).toBeAttached();
  });

  test("typing slot is attached to DOM", async ({ page }) => {
    const typingSlot = page.locator("[data-testid='typing-slot']");
    await expect(typingSlot).toBeAttached();
  });

  test("messages slot contains virtual scroll structure", async ({ page }) => {
    const messagesSlot = page.locator("[data-testid='messages-slot']");
    await expect(messagesSlot).toBeVisible();

    // Messages slot should contain the messages-container for virtual scrolling
    const container = messagesSlot.locator(".messages-container");
    await expect(container).toBeVisible();
  });

  test("member list is visible with role groups", async ({ page }) => {
    const memberList = page.locator("[data-testid='member-list']");
    await expect(memberList).toBeVisible();

    // Should have at least one role group
    const roleGroups = memberList.locator(".member-role-group");
    expect(await roleGroups.count()).toBeGreaterThanOrEqual(1);
  });
});
