import { devices } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  emitWsMessage,
  mockTauriFullSessionWithMessagesAndEcho,
  mockTauriFullSessionWithFailingMessages,
  navigateToMainPage,
  startFullSession,
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
    // Trigger a real toast through the pin flow: pinning a message shows the
    // success toast "Message pinned", which auto-dismisses.
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();
    // Pin shows only while Shift is held (WP 3A-7).
    await page.keyboard.down("Shift");
    await page.locator("[data-testid='msg-pin-101']").click();
    await page.keyboard.up("Shift");

    const toast = page.locator("[data-testid='toast']");
    await expect(toast.first()).toBeVisible({ timeout: 5_000 });

    // Default duration is 5000ms; toast gets .show removed then transitions out.
    // Wait for toast to disappear (5s timeout + 400ms fallback removal)
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
  });

  test("toast container is a polite live region for screen readers", async ({ page }) => {
    await startFullSession(page);

    const toastContainer = page.locator("[data-testid='toast-container']");
    // The container carries the DC-13 announcement contract: a status live
    // region that reads each appended toast without interrupting speech.
    await expect(toastContainer).toHaveAttribute("role", "status");
    await expect(toastContainer).toHaveAttribute("aria-live", "polite");
    await expect(toastContainer).toHaveAttribute("aria-atomic", "false");
  });

  test("an error toast persists until dismissed", async ({ page }) => {
    // Errors persist (UX-5): drive a real error toast from a server WS
    // `error` frame and check it outlives the old 5s auto-dismiss.
    await startFullSession(page);

    // A generic error frame with no pending send reaches the dispatcher's
    // catch-all, which toasts it as an error.
    await emitWsMessage(page, {
      type: "error",
      payload: { code: "RATE_LIMITED", message: "too many requests" },
    });

    const errorToast = page.locator("[data-testid='toast']", { hasText: "Too many requests" });
    await expect(errorToast).toBeVisible({ timeout: 5_000 });

    // It waits to be dismissed, so it must sit clear of the composer.
    const toastBox = await errorToast.boundingBox();
    const composerBox = await page.locator("[data-testid='message-input']").boundingBox();
    expect(toastBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(toastBox!.y + toastBox!.height).toBeLessThan(composerBox!.y);

    // Well past the old 5s auto-dismiss, the error is still there…
    await page.waitForTimeout(6000);
    await expect(errorToast).toBeVisible();

    // …and its close button removes it.
    await errorToast.locator(".toast-close").click();
    await expect(errorToast).toHaveCount(0, { timeout: 5_000 });
  });

  test("distinct app toasts stack in the one container", async ({ page }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await navigateToMainPage(page);

    const ownMessage = page.locator("[data-testid='message-101']");
    await ownMessage.hover();

    // Two real app paths with distinct copy: pinning shows a success toast…
    await page.keyboard.down("Shift");
    await page.locator("[data-testid='msg-pin-101']").click();
    await page.keyboard.up("Shift");
    await expect(page.locator("[data-testid='toast']", { hasText: "Message pinned" })).toBeVisible({
      timeout: 5_000,
    });

    // …and unpinning shows its own, without replacing the pin toast — both
    // live in the same container at once.
    await ownMessage.hover();
    // Pin shows only while Shift is held (WP 3A-7).
    await page.keyboard.down("Shift");
    await page.locator("[data-testid='msg-pin-101']").click();
    await page.keyboard.up("Shift");
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Message unpinned" }),
    ).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("[data-testid='toast']")).toHaveCount(2);

    const containerChildren = page.locator(
      "[data-testid='toast-container'] > [data-testid='toast']",
    );
    await expect(containerChildren).toHaveCount(2);
  });
});

async function showStickyToast(page: import("@playwright/test").Page): Promise<void> {
  await startFullSession(page);
  await emitWsMessage(page, {
    type: "error",
    payload: { code: "RATE_LIMITED", message: "too many requests" },
  });
  await expect(page.locator("[data-testid='toast']", { hasText: "Too many requests" })).toBeVisible(
    {
      timeout: 5_000,
    },
  );
}

async function setOverlay(page: import("@playwright/test").Page, cls: string, on: boolean) {
  await page.evaluate(
    ({ cls, on }) => {
      document.querySelectorAll("[data-test-overlay]").forEach((el) => el.remove());
      if (!on) return;
      const el = document.createElement("div");
      el.className = cls;
      el.setAttribute("data-test-overlay", "");
      document.body.appendChild(el);
    },
    { cls, on },
  );
}

test.describe("Toast position with an overlay open (desktop)", () => {
  test("drops to the window edge under a dialog and returns when it closes", async ({ page }) => {
    await showStickyToast(page);
    const container = page.locator("[data-testid='toast-container']");
    const before = (await container.boundingBox())!;
    await setOverlay(page, "modal-overlay", true);
    await expect
      .poll(async () => ((await container.boundingBox())?.y ?? 0) + before.height)
      .toBeGreaterThan(before.y + before.height + 1);
    const viewportHeight = page.viewportSize()!.height;
    const under = (await container.boundingBox())!;
    expect(viewportHeight - (under.y + under.height)).toBeLessThanOrEqual(24);
    await setOverlay(page, "modal-overlay", false);
    await expect
      .poll(async () => Math.round((await container.boundingBox())!.y))
      .toBe(Math.round(before.y));
  });
});

test.describe("Toast position with a sheet open (Pixel 7)", () => {
  const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
  test.use(pixel7);

  test("moves to the top while a bottom sheet is open", async ({ page }) => {
    await showStickyToast(page);
    const container = page.locator("[data-testid='toast-container']");
    await setOverlay(page, "bottom-sheet-overlay", true);
    await expect.poll(async () => (await container.boundingBox())?.y ?? 9999).toBeLessThan(80);
    await setOverlay(page, "bottom-sheet-overlay", false);
    await expect.poll(async () => (await container.boundingBox())?.y ?? 0).toBeGreaterThan(200);
  });
});
