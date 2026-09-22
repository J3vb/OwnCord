import { test, expect } from "./fixtures";
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
    const slot = page.locator("[data-testid='typing-slot']");
    await expect(slot).toBeAttached();
  });

  test("typing bar is empty by default", async ({ page }) => {
    const typingBar = page.locator(".typing-bar");
    // The bar exists (rendered into the typing slot) and starts empty — not a
    // guarded `if (count > 0)` that passes when the component is missing.
    await expect(typingBar).toBeAttached();
    await expect(typingBar).toBeEmpty();

    // Positive control: a typing event fills it, proving "empty" meant empty
    // rather than "the component never renders".
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 1, user_id: 2, username: "otheruser" },
    });
    await expect(typingBar).toContainText("otheruser", { timeout: 5_000 });
  });

  test("typing indicator appears when someone types", async ({ page }) => {
    // Emit a typing event
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 2,
        username: "otheruser",
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
        username: "otheruser",
      },
    });

    const dots = page.locator(".typing-dots");
    await expect(dots).toBeAttached({ timeout: 3_000 });
  });
});
