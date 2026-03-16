import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Chat Header
// ---------------------------------------------------------------------------

test.describe("Chat Header", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("chat header is visible", async ({ page }) => {
    const header = page.locator(".chat-header");
    await expect(header).toBeVisible();
  });

  test("chat header shows hash icon", async ({ page }) => {
    const hash = page.locator(".chat-header .ch-hash");
    await expect(hash).toBeVisible();
  });

  test("chat header shows channel name", async ({ page }) => {
    const name = page.locator(".chat-header .ch-name");
    await expect(name).toBeVisible();
    await expect(name).not.toBeEmpty();
  });

  test("chat header shows topic", async ({ page }) => {
    const topic = page.locator(".chat-header .ch-topic");
    await expect(topic).toBeAttached();
  });

  test("chat header has tools area", async ({ page }) => {
    const tools = page.locator(".ch-tools");
    await expect(tools).toBeVisible();
  });

  test("chat header has search input", async ({ page }) => {
    const search = page.locator(".ch-tools .search-input");
    await expect(search).toBeAttached();
  });
});
