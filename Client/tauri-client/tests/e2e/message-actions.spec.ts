/**
 * E2E tests for message action buttons (hover actions bar).
 * Tests: reply, edit, delete buttons on message hover.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithMessagesAndEcho,
  navigateToMainPage,
} from "./helpers";

test.describe("Message Actions Bar", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("hovering a message shows actions bar", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();

    const actionsBar = firstMessage.locator(".msg-actions-bar");
    await expect(actionsBar).toBeAttached();
  });

  test("own message has Reply button", async ({ page }) => {
    // Message id 101 is from testuser (id: 1) = own message
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const replyBtn = page.locator("[data-testid='msg-reply-101']");
    await expect(replyBtn).toBeAttached();
  });

  test("own message has Edit button", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const editBtn = page.locator("[data-testid='msg-edit-101']");
    await expect(editBtn).toBeAttached();
  });

  test("own message has Delete button", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const deleteBtn = page.locator("[data-testid='msg-delete-101']");
    await expect(deleteBtn).toBeAttached();
  });

  test("other user message does NOT have Edit button", async ({ page }) => {
    // Message id 102 is from otheruser (id: 2)
    const otherMessage = page.locator("[data-testid='message-102']");
    await otherMessage.hover();

    const editBtn = page.locator("[data-testid='msg-edit-102']");
    await expect(editBtn).toHaveCount(0);
  });

  test("clicking Reply opens reply bar in input", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const replyBtn = page.locator("[data-testid='msg-reply-101']");
    await replyBtn.click();

    // Reply bar should appear in the message input area
    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toBeVisible({ timeout: 3000 });
  });

  test("clicking Edit populates textarea with message content", async ({
    page,
  }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const editBtn = page.locator("[data-testid='msg-edit-101']");
    await editBtn.click();

    // Textarea should contain the original message content
    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toHaveValue("Hello world!");
  });

  test("React button exists on messages", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();

    const reactBtn = page.locator("[data-testid='msg-react-101']");
    await expect(reactBtn).toBeAttached();
  });
});

test.describe("Message Reactions", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("reaction chips are visible on messages with reactions", async ({
    page,
  }) => {
    const reactions = page.locator(".msg-reactions");
    await expect(reactions.first()).toBeVisible();
  });

  test("reaction chip shows emoji and count", async ({ page }) => {
    const chip = page.locator(".reaction-chip").first();
    await expect(chip).toBeVisible();

    const count = chip.locator(".rc-count");
    await expect(count).toHaveText("2");
  });

  test("user own reaction has me class", async ({ page }) => {
    const meChip = page.locator(".reaction-chip.me");
    await expect(meChip.first()).toBeVisible();
  });

  test("add reaction button exists", async ({ page }) => {
    const addBtn = page.locator(".reaction-chip.add-reaction");
    await expect(addBtn.first()).toBeVisible();
  });
});
