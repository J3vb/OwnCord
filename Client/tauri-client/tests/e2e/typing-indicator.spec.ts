import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage, emitWsMessage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: Typing Indicator
// ---------------------------------------------------------------------------

test.describe("Typing Indicator", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("typing indicator slot exists", async ({ page }) => {
    const slot = page.locator(".typing-slot");
    await expect(slot).toBeAttached();
  });

  test("typing bar is empty by default", async ({ page }) => {
    const typingBar = page.locator(".typing-bar");
    if (await typingBar.count() > 0) {
      // When empty, typing bar should have no visible dots text
      const text = await typingBar.textContent();
      expect(text?.trim()).toBe("");
    }
  });

  test("typing indicator appears when someone types", async ({ page }) => {
    // Emit a typing event
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 2,
      },
    });

    const typingBar = page.locator(".typing-bar");
    // Should show typing text after event
    await expect(typingBar).not.toBeEmpty({ timeout: 3_000 });
  });

  test("typing dots animate", async ({ page }) => {
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 2,
      },
    });

    const dots = page.locator(".typing-dots");
    await expect(dots).toBeAttached({ timeout: 3_000 });
  });
});
