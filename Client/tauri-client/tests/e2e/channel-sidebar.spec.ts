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
    const sidebar = page.locator(".channel-sidebar");
    await expect(sidebar).toBeVisible();
  });

  test("sidebar header shows server name", async ({ page }) => {
    const header = page.locator(".channel-sidebar-header h2");
    await expect(header).toBeVisible();
    await expect(header).toHaveText("Test Server");
  });

  test("channel list shows channels", async ({ page }) => {
    const channelList = page.locator(".channel-list");
    await expect(channelList).toBeVisible();

    const channels = page.locator(".channel-item");
    const count = await channels.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("channel items display channel name", async ({ page }) => {
    const firstChannel = page.locator(".channel-item").first();
    await expect(firstChannel).toBeVisible();

    const name = firstChannel.locator(".ch-name");
    await expect(name).toBeVisible();
  });

  test("channel items have hash icon", async ({ page }) => {
    const firstChannel = page.locator(".channel-item").first();
    const icon = firstChannel.locator(".ch-icon");
    await expect(icon).toBeVisible();
  });

  test("clicking a channel marks it as active", async ({ page }) => {
    const channels = page.locator(".channel-item");
    const count = await channels.count();
    if (count < 2) return;

    const secondChannel = channels.nth(1);
    await secondChannel.click();

    await expect(secondChannel).toHaveClass(/active/);
  });

  test("clicking a channel updates chat header", async ({ page }) => {
    const channels = page.locator(".channel-item");
    const count = await channels.count();
    if (count < 2) return;

    const secondChannel = channels.nth(1);
    const channelName = await secondChannel.locator(".ch-name").textContent();

    await secondChannel.click();

    const headerName = page.locator(".chat-header .ch-name");
    await expect(headerName).toHaveText(channelName ?? "");
  });

  test("first channel is active by default", async ({ page }) => {
    const firstChannel = page.locator(".channel-item").first();
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
