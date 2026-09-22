import { test, expect } from "./fixtures";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithMessagesAndEcho,
  mockTauriFullSessionWithFailingMessages,
  navigateToMainPage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Toast Notifications
// ---------------------------------------------------------------------------

test.describe("Toast Notifications", () => {
  // Message-load failure no longer toasts: the app renders an inline
  // section error + Retry in the message region instead (UX spec §2 — a
  // toast would vanish and leave the region silently empty). See
  // MessageController.loadMessages.
  test("message load failure (500) shows inline error with Retry", async ({ page }) => {
    await mockTauriFullSessionWithFailingMessages(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const loadError = page.locator(".messages-load-error");
    await expect(loadError).toBeVisible({ timeout: 10_000 });
    await expect(loadError).toContainText(/couldn't load messages/i);

    const retryBtn = page.locator("[data-testid='messages-retry']");
    await expect(retryBtn).toBeVisible();
  });

  test("toast auto-dismisses after timeout", async ({ page }) => {
    // Trigger a real toast through the delete-confirmation flow: the first
    // click on a message's Delete action shows the info toast
    // "Click delete again to confirm".
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    await page.locator("[data-testid='msg-delete-101']").click();

    const toast = page.locator("[data-testid='toast']");
    await expect(toast.first()).toBeVisible({ timeout: 5_000 });

    // Default duration is 5000ms; toast gets .show removed then transitions out.
    // Wait for toast to disappear (5s timeout + 400ms fallback removal)
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
  });

  test("toast container is a polite live region for screen readers", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const toastContainer = page.locator("[data-testid='toast-container']");
    // The container carries the DC-13 announcement contract: a status live
    // region that reads each appended toast without interrupting speech.
    await expect(toastContainer).toHaveAttribute("role", "status");
    await expect(toastContainer).toHaveAttribute("aria-live", "polite");
    await expect(toastContainer).toHaveAttribute("aria-atomic", "false");
  });

  test("distinct app toasts stack in the one container", async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    // Two real app paths with distinct copy: pinning shows a success toast…
    await page.locator("[data-testid='msg-pin-101']").click();
    await expect(page.locator("[data-testid='toast']", { hasText: "Message pinned" })).toBeVisible({
      timeout: 5_000,
    });

    // …and the first delete click asks for confirmation, without replacing
    // the pin toast — both live in the same container at once.
    await page.locator("[data-testid='msg-delete-101']").click();
    const deleteToast = page.locator("[data-testid='toast']", {
      hasText: "Click delete again to confirm",
    });
    await expect(deleteToast).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='toast']")).toHaveCount(2);

    const containerChildren = page.locator(
      "[data-testid='toast-container'] > [data-testid='toast']",
    );
    await expect(containerChildren).toHaveCount(2);
  });
});
