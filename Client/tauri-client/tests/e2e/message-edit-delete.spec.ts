/**
 * E2E tests for message edit and delete flows.
 * Covers: edit → save, edit → cancel, delete.
 */
import { test, expect } from "@playwright/test";
import {
  mockTauriFullSessionWithMessagesAndEcho,
  navigateToMainPage,
} from "./helpers";

test.describe("Message Edit Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Edit puts message content in textarea", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    await page.locator("[data-testid='msg-edit-101']").click();

    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toHaveValue("Hello world!");
  });

  test("edit mode shows save and cancel controls", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    await page.locator("[data-testid='msg-edit-101']").click();

    // Edit bar reuses .reply-bar class and becomes .visible
    const editBar = page.locator(".reply-bar.visible");
    await expect(editBar).toBeVisible({ timeout: 3000 });

    // Cancel button uses .reply-close class
    const cancelBtn = editBar.locator(".reply-close");
    await expect(cancelBtn).toBeVisible();
  });

  test("saving edit updates the message content", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    await page.locator("[data-testid='msg-edit-101']").click();

    const textarea = page.locator("[data-testid='msg-textarea']");
    await textarea.fill("Edited message content");
    await textarea.press("Enter");

    // The edited message should show "(edited)" indicator
    // (may take a moment for WS echo to process)
    const editedMessage = page.locator(".message", {
      has: page.locator(".msg-text", { hasText: "Edited message content" }),
    });
    await expect(editedMessage.locator(".msg-edited")).toBeVisible({ timeout: 5000 });
  });

  test("cancelling edit clears the edit bar", async ({ page }) => {
    // Click Edit on own message
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    await page.locator("[data-testid='msg-edit-101']").click();

    // Verify edit bar (.reply-bar.visible) appears
    const editBar = page.locator(".reply-bar.visible");
    await expect(editBar).toBeVisible({ timeout: 3000 });

    // Click cancel (.reply-close on the visible edit bar)
    const cancelBtn = editBar.locator(".reply-close");
    await cancelBtn.click();

    // Verify edit bar is no longer visible
    await expect(editBar).not.toBeVisible({ timeout: 3000 });

    // Verify textarea is empty
    const textarea = page.locator("[data-testid='msg-textarea']");
    await expect(textarea).toHaveValue("");
  });
});

test.describe("Message Delete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("clicking Delete marks the message as deleted", async ({ page }) => {
    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    const deleteBtn = page.locator("[data-testid='msg-delete-101']");

    // Delete uses a double-click confirmation pattern:
    // first click = "pending" (shows toast "Click delete again to confirm"),
    // second click = "confirmed" (sends chat_delete WS message).
    await deleteBtn.click();
    await deleteBtn.click();

    // Soft-delete: message stays in DOM but shows "[message deleted]"
    await expect(
      ownMessage.locator(".msg-text", { hasText: "[message deleted]" }),
    ).toBeVisible({ timeout: 5000 });
  });
});
