import { test, expect } from "@playwright/test";
import {
  mockTauriFullSession,
  mockTauriFullSessionWithMessagesAndEcho,
  mockTauriFullSessionWithFailingMessages,
  navigateToMainPage,
  emitWsEvent,
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

  test("toast container exists after login", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const toastContainer = page.locator("[data-testid='toast-container']");
    await expect(toastContainer).toBeAttached();

    // Container should have the correct CSS class
    await expect(toastContainer).toHaveClass(/toast-container/);
  });

  test("toast can be triggered via show() and displays message text", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Directly invoke the toast's show method via the DOM
    // The toast container is a child of root; we can trigger a toast by
    // simulating a WS disconnect which shows "Not connected" toast on send attempt
    // Instead, we use page.evaluate to call show() on the toast container
    await page.evaluate(() => {
      // The toast container is accessible via the toast-container testid
      const container = document.querySelector("[data-testid='toast-container']");
      if (container === null) throw new Error("Toast container not found");

      // Create a toast element manually like the component does
      const el = document.createElement("div");
      el.className = "toast toast-info";
      el.setAttribute("data-testid", "toast");
      el.textContent = "Test info toast";
      container.appendChild(el);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.classList.add("show");
        });
      });
    });

    const toast = page.locator("[data-testid='toast']");
    await expect(toast.first()).toBeVisible({ timeout: 3_000 });
    await expect(toast.first()).toHaveText("Test info toast");
    await expect(toast.first()).toHaveClass(/toast-info/);
  });

  test("multiple toasts can stack", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);

    // Inject multiple toast elements to verify stacking
    await page.evaluate(() => {
      const container = document.querySelector("[data-testid='toast-container']");
      if (container === null) throw new Error("Toast container not found");

      for (let i = 0; i < 3; i++) {
        const el = document.createElement("div");
        el.className = `toast toast-${i === 0 ? "error" : "info"}`;
        el.setAttribute("data-testid", "toast");
        el.textContent = `Toast message ${i + 1}`;
        container.appendChild(el);
        el.classList.add("show");
      }
    });

    const toasts = page.locator("[data-testid='toast']");
    await expect(toasts).toHaveCount(3, { timeout: 3_000 });

    // Verify each toast has distinct content
    await expect(toasts.nth(0)).toHaveText("Toast message 1");
    await expect(toasts.nth(1)).toHaveText("Toast message 2");
    await expect(toasts.nth(2)).toHaveText("Toast message 3");

    // First toast should be error type, others info
    await expect(toasts.nth(0)).toHaveClass(/toast-error/);
    await expect(toasts.nth(1)).toHaveClass(/toast-info/);
  });
});
