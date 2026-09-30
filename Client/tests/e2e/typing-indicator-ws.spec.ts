import { test, expect } from "./fixtures";
import { mockTauriFullSession, navigateToMainPage, emitWsMessage } from "./helpers";

test.describe("Typing Indicator — WebSocket", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("typing indicator appears when another user starts typing", async ({ page }) => {
    const typingSlot = page.locator("[data-testid='typing-slot']");
    await expect(typingSlot).toBeAttached();

    // Initially empty
    const typingBar = page.locator(".typing-bar");
    if ((await typingBar.count()) > 0) {
      await expect(typingBar).toBeEmpty();
    }

    // Emit typing event from another user (server sends "typing", not "typing_start")
    await emitWsMessage(page, {
      type: "typing",
      payload: {
        channel_id: 1,
        user_id: 2,
        username: "otheruser",
      },
    });

    // Typing indicator should show the username
    const typingText = page.locator(".typing-bar");
    await expect(typingText).toContainText("otheruser", { timeout: 5_000 });
  });

  test("typing indicator does not show for current user", async ({ page }) => {
    // Positive control first: another user's typing DOES render, so the
    // negative assertion below proves the self-filter, not an indicator that
    // never renders at all.
    const typingBar = page.locator(".typing-bar");
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 1, user_id: 2, username: "otheruser" },
    });
    await expect(typingBar).toContainText("otheruser", { timeout: 5_000 });

    // Now the current user (id: 1) types — the indicator must not name them,
    // and must not replace the other user's entry.
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 1, user_id: 1, username: "testuser" },
    });
    await expect(typingBar).not.toContainText("testuser", { timeout: 1_000 });
    await expect(typingBar).toContainText("otheruser");
  });

  test("typing indicator ignores events from other channels", async ({ page }) => {
    // Positive control: a typing event on channel 1 (the viewed channel)
    // renders.
    const typingBar = page.locator(".typing-bar");
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 1, user_id: 2, username: "otheruser" },
    });
    await expect(typingBar).toContainText("otheruser", { timeout: 5_000 });

    // A typing event on channel 2 must be ignored — neither replacing the
    // channel-1 entry nor adding the channel-2 user.
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 2, user_id: 3, username: "elsewhere" },
    });
    await expect(typingBar).not.toContainText("elsewhere", { timeout: 1_000 });
    await expect(typingBar).toContainText("otheruser");
  });

  test("typing indicator clears the moment the sender's message lands (DP-15)", async ({
    page,
  }) => {
    const typingBar = page.locator(".typing-bar");

    // Positive control: the sender's typing renders first.
    await emitWsMessage(page, {
      type: "typing",
      payload: { channel_id: 1, user_id: 2, username: "otheruser" },
    });
    await expect(typingBar).toContainText("otheruser", { timeout: 5_000 });

    // Their message frame arrives — the indicator must be gone straight away,
    // not linger for the 5 s timeout. Wait for the message row first: the same
    // handler clears typing before it appends the row, so the row is the proof
    // the frame was processed and this assertion tests the clear, not frame
    // delivery timing.
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 9001,
        channel_id: 1,
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "dp15-unique-message",
        timestamp: new Date().toISOString(),
        attachments: [],
        reply_to: null,
      },
    });
    await expect(page.locator(".msg-text", { hasText: "dp15-unique-message" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(typingBar).toBeEmpty();
  });
});
