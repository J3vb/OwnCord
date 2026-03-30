import { test, expect } from "@playwright/test";
import { mockTauriFullSession, mockTauriFullSessionWithMessages, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Channel Sidebar
// ---------------------------------------------------------------------------

test.describe("Channel Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("sidebar is visible after login", async ({ page }) => {
    const sidebar = page.locator("[data-testid='channel-sidebar']");
    await expect(sidebar).toBeVisible({ timeout: 5_000 });
  });

  test("sidebar header shows server name", async ({ page }) => {
    // The channel-sidebar-header is hidden in the unified sidebar layout.
    // The server name is shown in the unified sidebar header instead.
    const serverName = page.locator(".unified-sidebar-header .server-name");
    await expect(serverName).toBeVisible();
    await expect(serverName).toHaveText("Test Server");
  });

  test("channel list shows channels", async ({ page }) => {
    const channelList = page.locator(".channel-list");
    await expect(channelList).toBeVisible();

    const channels = page.locator(".channel-item");
    const count = await channels.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("channel items display channel name", async ({ page }) => {
    const firstChannel = page.locator("[data-testid='channel-1']");
    await expect(firstChannel).toBeVisible();

    const name = firstChannel.locator(".ch-name");
    await expect(name).toBeVisible();
  });

  test("channel items have hash icon", async ({ page }) => {
    const firstChannel = page.locator("[data-testid='channel-1']");
    const icon = firstChannel.locator(".ch-icon");
    await expect(icon).toBeVisible();
  });

  test("clicking a channel marks it as active", async ({ page }) => {
    // Mock has 2 channels (general, random)
    const secondChannel = page.locator("[data-testid='channel-2']");
    await expect(secondChannel).toBeVisible({ timeout: 3000 });
    await secondChannel.click();

    await expect(secondChannel).toHaveClass(/active/);
  });

  test("clicking a channel updates chat header", async ({ page }) => {
    const secondChannel = page.locator("[data-testid='channel-2']");
    await expect(secondChannel).toBeVisible({ timeout: 3000 });
    const channelName = await secondChannel.locator(".ch-name").textContent();

    await secondChannel.click();

    const headerName = page.locator("[data-testid='chat-header-name']");
    await expect(headerName).toHaveText(channelName ?? "");
  });

  test("switching channels re-mounts message container", async ({ page }) => {
    // Verify first channel is active and messages container exists
    const messagesContainer = page.locator(".messages-container");
    await expect(messagesContainer).toBeVisible({ timeout: 5000 });

    // Switch to second channel
    const secondChannel = page.locator("[data-testid='channel-2']");
    await expect(secondChannel).toBeVisible({ timeout: 3000 });
    await secondChannel.click();

    // Messages container should still be present (re-mounted for new channel)
    await expect(messagesContainer).toBeVisible({ timeout: 5000 });

    // Chat header should reflect the new channel
    const headerName = page.locator("[data-testid='chat-header-name']");
    const channelName = await secondChannel.locator(".ch-name").textContent();
    await expect(headerName).toHaveText(channelName ?? "");
  });

  test("first channel is active by default", async ({ page }) => {
    const firstChannel = page.locator("[data-testid='channel-1']");
    await expect(firstChannel).toHaveClass(/active/);
  });
});

test.describe("Channel Sidebar — Categories", () => {
  test("categories with multiple channel types show correctly", async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const categories = page.locator(".category");
    const count = await categories.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
