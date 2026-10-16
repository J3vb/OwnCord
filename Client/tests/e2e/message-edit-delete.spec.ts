/**
 * E2E tests for message edit and delete flows.
 * Covers: inline edit → save, edit → cancel, delete.
 */
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithMessagesAndEcho, navigateToMainPage } from "./helpers";

test.describe("Message Edit Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  /** Open the inline editor on the signed-in user's message 101. */
  async function startEdit(page: import("@playwright/test").Page): Promise<void> {
    await page.locator("[data-testid='message-101']").hover();
    await page.locator("[data-testid='msg-edit-101']").click();
  }

  test("clicking Edit puts message content in an editor inside the row", async ({ page }) => {
    await startEdit(page);

    const editor = page.locator("[data-testid='message-101'] [data-testid='msg-edit-input-101']");
    await expect(editor).toHaveValue("Hello world!");
    await expect(editor).toBeFocused();
    // The composer is not involved: it keeps its own (empty) draft.
    await expect(page.locator("[data-testid='msg-textarea']")).toHaveValue("");
    await expect(page.locator(".reply-bar.visible")).toHaveCount(0);
  });

  test("the editor shows its save and cancel links", async ({ page }) => {
    await startEdit(page);

    const hint = page.locator("[data-testid='message-101'] .msg-inline-edit-hint");
    await expect(hint).toBeVisible({ timeout: 3000 });
    await expect(hint.locator("[data-testid='msg-edit-cancel-101']")).toBeVisible();
    await expect(hint.locator("[data-testid='msg-edit-save-101']")).toBeVisible();
  });

  test("saving edit updates the message content", async ({ page }) => {
    await startEdit(page);

    const editor = page.locator("[data-testid='msg-edit-input-101']");
    await editor.fill("Edited message content");
    await editor.press("Enter");

    // The edited message should show "(edited)" indicator
    // (may take a moment for WS echo to process)
    const editedMessage = page.locator(".message", {
      has: page.locator(".msg-text", { hasText: "Edited message content" }),
    });
    await expect(editedMessage.locator(".msg-edited")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("[data-testid='msg-edit-input-101']")).toHaveCount(0);
  });

  test("Shift+Enter adds a line and Enter saves both", async ({ page }) => {
    await startEdit(page);

    const editor = page.locator("[data-testid='msg-edit-input-101']");
    await editor.fill("first line");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("second line");
    await expect(editor).toHaveValue("first line\nsecond line");
    await editor.press("Enter");

    await expect(
      page.locator("[data-testid='message-101'] .msg-text", { hasText: "second line" }),
    ).toBeVisible({ timeout: 5000 });
  });

  test("Escape cancels the edit and leaves the message as it was", async ({ page }) => {
    await startEdit(page);

    const editor = page.locator("[data-testid='msg-edit-input-101']");
    await editor.fill("never mind");
    await editor.press("Escape");

    await expect(editor).toHaveCount(0);
    await expect(page.locator("[data-testid='message-101'] .msg-text")).toHaveText("Hello world!");
    // Focus went back to the composer.
    await expect(page.locator("[data-testid='msg-textarea']")).toBeFocused();
  });

  test("the cancel link closes the editor", async ({ page }) => {
    await startEdit(page);

    await page.locator("[data-testid='msg-edit-cancel-101']").click();

    await expect(page.locator("[data-testid='msg-edit-input-101']")).toHaveCount(0);
    await expect(page.locator("[data-testid='message-101'] .msg-text")).toHaveText("Hello world!");
  });
});

test.describe("Message Delete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Delete removes the message from the list", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    // The hover bar's Delete is Shift-only and skips the confirmation (WP
    // 3A-7), so the confirmed path goes through the "..." menu's Delete
    // Message (P4-12); confirming sends the chat_delete WS message.
    await page.locator("[data-testid='msg-more-101']").click();
    await page.locator("[data-testid='msg-menu-delete']").click();
    await page.locator("[data-testid='msg-delete-confirm']").click();

    // The deleted message leaves the list (the store keeps a tombstone).
    await expect(ownMessage).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByText("[message deleted]")).toHaveCount(0);
  });
});
