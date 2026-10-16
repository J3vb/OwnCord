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

  test("own message: quick emoji, React, Edit and More, with Reply, Pin and Delete on Shift", async ({
    page,
  }) => {
    // Message id 101 is from testuser (id: 1) = own message. Assert the whole
    // action set is present and usable, rather than separate toBeAttached
    // rows that are all true whenever the bar exists.
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    for (const id of [
      "msg-quick-react-101-0",
      "msg-quick-react-101-1",
      "msg-quick-react-101-2",
      "msg-react-101",
      "msg-edit-101",
      "msg-more-101",
    ]) {
      await expect(page.locator(`[data-testid='${id}']`)).toBeVisible();
    }
    const shiftOnly = ["msg-reply-101", "msg-pin-101", "msg-delete-101"];
    for (const id of shiftOnly) {
      await expect(page.locator(`[data-testid='${id}']`)).toBeHidden();
    }

    await page.keyboard.down("Shift");
    for (const id of shiftOnly) {
      await expect(page.locator(`[data-testid='${id}']`)).toBeVisible();
    }
    await page.keyboard.up("Shift");
    for (const id of shiftOnly) {
      await expect(page.locator(`[data-testid='${id}']`)).toBeHidden();
    }
  });

  test("a quick emoji reacts in one click", async ({ page }) => {
    await page.locator("[data-testid='message-102']").hover();
    await page.locator("[data-testid='msg-quick-react-102-0']").click();
    await expect(
      page.locator("[data-testid='message-102'] .reaction-chip:not(.add-reaction)").first(),
    ).toBeVisible({ timeout: 3000 });
  });

  test("the More button opens the message menu and Escape returns focus to it", async ({
    page,
  }) => {
    await page.locator("[data-testid='message-102']").hover();
    const more = page.locator("[data-testid='msg-more-102']");
    await more.click();
    const menu = page.locator(".message-context-menu");
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
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

    // Reply on your own message shows only while Shift is held (WP 3A-7).
    await page.keyboard.down("Shift");
    const replyBtn = page.locator("[data-testid='msg-reply-101']");
    await replyBtn.click();
    await page.keyboard.up("Shift");

    // Reply bar should appear in the message input area
    const replyBar = page.locator(".reply-bar.visible");
    await expect(replyBar).toBeVisible({ timeout: 3000 });
  });

  test("clicking Edit opens the inline editor with the message content", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    const editBtn = page.locator("[data-testid='msg-edit-101']");
    await editBtn.click();

    // The editor sits in the message's own row and holds the original content;
    // the composer is not involved (WP 3A-8).
    const editor = ownMessage.locator("[data-testid='msg-edit-input-101']");
    await expect(editor).toHaveValue("Hello world!");
    await expect(page.locator("[data-testid='msg-textarea']")).toHaveValue("");
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
