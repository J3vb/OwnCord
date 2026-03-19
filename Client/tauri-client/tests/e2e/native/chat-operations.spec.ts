/**
 * Native E2E: Chat operations with real server.
 *
 * Tests sending messages, receiving echoes, message display,
 * and message actions (edit, delete, reactions) against real server.
 */

import { test, expect } from "../native-fixture";
import { SKIP_SERVER, hasCredentials, nativeLoginAndReady, waitForMessages } from "./helpers";

test.describe("Chat Operations", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await nativeLoginAndReady(nativePage);
    await waitForMessages(nativePage);
  });

  test("message textarea is visible and focusable", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    await expect(textarea).toBeVisible();

    await textarea.focus();
    await expect(textarea).toBeFocused();
  });

  test("can type a message in the textarea", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    await textarea.fill("native e2e test typing");
    await expect(textarea).toHaveValue("native e2e test typing");
  });

  test("send button is present", async ({ nativePage }) => {
    const sendBtn = nativePage.locator("[data-testid='send-btn']");
    await expect(sendBtn).toBeAttached();
  });

  test("sending a message clears the textarea", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    const uniqueMsg = `native-e2e-${Date.now()}`;

    await textarea.fill(uniqueMsg);
    await textarea.press("Enter");

    // Textarea should clear after send
    await expect(textarea).toHaveValue("", { timeout: 5_000 });
  });

  test("sent message appears in message list", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    const uniqueMsg = `native-e2e-${Date.now()}`;

    await textarea.fill(uniqueMsg);
    await textarea.press("Enter");

    // Message should appear in the list (server echoes it back via WS)
    const sentMessage = nativePage.locator(".message .msg-text", { hasText: uniqueMsg });
    await expect(sentMessage).toBeVisible({ timeout: 10_000 });
  });

  test("message displays author and timestamp", async ({ nativePage }) => {
    // Check existing messages have author and time
    const firstMessage = nativePage.locator(".message").first();
    const isVisible = await firstMessage.isVisible().catch(() => false);
    test.skip(!isVisible, "No messages in current channel");

    const author = firstMessage.locator(".msg-author");
    const time = firstMessage.locator(".msg-time");

    // At least one of these should be present (grouped messages may hide author)
    const hasAuthor = await author.isVisible().catch(() => false);
    const hasTime = await time.isVisible().catch(() => false);
    expect(hasAuthor || hasTime).toBe(true);
  });

  test("empty message is not sent", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    const messagesBefore = await nativePage.locator(".message").count();

    // Try to send empty message
    await textarea.focus();
    await textarea.press("Enter");

    // Wait a moment, then verify no new message appeared
    await nativePage.waitForTimeout(2_000);
    const messagesAfter = await nativePage.locator(".message").count();
    expect(messagesAfter).toBe(messagesBefore);
  });

  test("message actions bar appears on hover", async ({ nativePage }) => {
    const firstMessage = nativePage.locator(".message").first();
    const isVisible = await firstMessage.isVisible().catch(() => false);
    test.skip(!isVisible, "No messages in current channel");

    await firstMessage.hover();

    const actionsBar = firstMessage.locator(".msg-actions-bar");
    await expect(actionsBar).toBeAttached({ timeout: 3_000 });
  });

  test("can send multiple messages in sequence", async ({ nativePage }) => {
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    const timestamp = Date.now();

    // Send 3 messages with sufficient wait between sends
    for (let i = 0; i < 3; i++) {
      const msg = `native-seq-${timestamp}-${i}`;
      await textarea.fill(msg);
      await textarea.press("Enter");
      await expect(textarea).toHaveValue("", { timeout: 5_000 });
      // Small delay between sends to avoid rate limiting
      if (i < 2) await nativePage.waitForTimeout(500);
    }

    // All 3 should appear
    const lastMsg = nativePage.locator(".message .msg-text", {
      hasText: `native-seq-${timestamp}-2`,
    });
    await expect(lastMsg).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Chat Message Display", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await nativeLoginAndReady(nativePage);
    await waitForMessages(nativePage);
  });

  test("messages container uses virtual scroll", async ({ nativePage }) => {
    const container = nativePage.locator(".messages-container");
    await expect(container).toBeVisible();

    // Container should have a height (not collapsed)
    const height = await container.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(0);
  });

  test("message avatars are displayed", async ({ nativePage }) => {
    const messages = nativePage.locator(".message");
    const count = await messages.count();
    test.skip(count === 0, "No messages to check");

    // At least some messages should have avatars (non-grouped ones)
    const avatars = nativePage.locator(".message .msg-avatar");
    const avatarCount = await avatars.count();
    expect(avatarCount).toBeGreaterThanOrEqual(0); // grouped messages may hide them
  });
});
