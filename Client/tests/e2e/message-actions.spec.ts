/**
 * E2E tests for message action buttons (hover actions bar).
 * Tests: reply, edit, delete buttons on message hover.
 */
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithMessagesAndEcho, navigateToMainPage } from "./helpers";

test.describe("Message Actions Bar", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("hovering a message reveals its actions bar", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    const actionsBar = firstMessage.locator(".msg-actions-bar");

    // The bar is in the DOM but hidden by CSS (opacity:0 / pointer-events:none),
    // so `toBeAttached` alone proves nothing. Assert the hidden state, then the
    // hover reveal on the computed style.
    await expect(actionsBar).toHaveCSS("opacity", "0");
    await expect(actionsBar).toHaveCSS("pointer-events", "none");

    await firstMessage.hover();

    await expect(actionsBar).toHaveCSS("opacity", "1");
    await expect(actionsBar).toHaveCSS("pointer-events", "auto");
  });

  test("own message has Reply, Edit, Delete, and React actions", async ({ page }) => {
    // Message id 101 is from testuser (id: 1) = own message. Assert the whole
    // action set is present and usable, rather than four separate
    // toBeAttached rows that are all true whenever the bar exists.
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    await expect(page.locator("[data-testid='msg-reply-101']")).toBeVisible();
    await expect(page.locator("[data-testid='msg-edit-101']")).toBeVisible();
    await expect(page.locator("[data-testid='msg-delete-101']")).toBeVisible();
    await expect(page.locator("[data-testid='msg-react-101']")).toBeVisible();
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

  test("clicking Edit populates textarea with message content", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const editBtn = page.locator("[data-testid='msg-edit-101']");
    await editBtn.click();

    // Textarea should contain the original message content
    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toHaveValue("Hello world!");
  });

  test("clicking React opens the emoji picker", async ({ page }) => {
    const firstMessage = page.locator("[data-testid='message-101']");
    await firstMessage.hover();

    await page.locator("[data-testid='msg-react-101']").click();
    await expect(page.locator(".reaction-picker-wrap .emoji-picker")).toBeVisible();
  });
});

test.describe("Message Reactions", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("reaction chips are visible on messages with reactions", async ({ page }) => {
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
