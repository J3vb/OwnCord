/**
 * Mocked E2E: DM System — sidebar mode switching, messaging, and unread counts.
 *
 * Tests the full DM flow with a mocked Tauri environment:
 * opening/closing DMs, sidebar mode transitions, message display,
 * and background unread increments.
 */

import { test, expect } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_AUTH_OK,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_CHANNELS,
  MOCK_ROLES,
  MOCK_PINNED_MESSAGES,
  submitLogin,
  navigateToMainPage,
  waitForWsReady,
  emitWsMessage,
} from "./helpers";

// ---------------------------------------------------------------------------
// DM mock data
// ---------------------------------------------------------------------------

const MOCK_DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
  {
    channel_id: 101,
    recipient: { id: 3, username: "thirduser", avatar: "", status: "idle" },
    last_message_id: 501,
    last_message: "See you later",
    last_message_at: "2026-03-15T11:00:00Z",
    unread_count: 2,
  },
];

const MOCK_READY_WITH_DMS = {
  type: "ready",
  payload: {
    channels: MOCK_CHANNELS,
    members: [
      { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
      { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
      { id: 3, username: "thirduser", avatar: "", status: "idle", role: "member" },
    ],
    voice_states: [],
    roles: MOCK_ROLES,
    dm_channels: MOCK_DM_CHANNELS,
  },
};

// ---------------------------------------------------------------------------
// Custom mock session with DM support
// ---------------------------------------------------------------------------

async function mockTauriSessionWithDms(page: import("@playwright/test").Page): Promise<void> {
  const script = buildTauriMockScript({
    httpRoutes: [
      { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
      { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
      { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
      { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      { pattern: "POST /api/v1/dms", status: 200, body: MOCK_DM_CHANNELS[0] },
      { pattern: "GET /api/v1/dms", status: 200, body: MOCK_DM_CHANNELS },
      { pattern: "DELETE /api/v1/dms/", status: 200, body: { success: true } },
    ],
    simulateWsFlow: true,
    echoChatSend: true,
    readyOverrides: {
      dm_channels: MOCK_DM_CHANNELS,
      members: [
        { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
        { id: 2, username: "otheruser", avatar: "", status: "online", role: "member" },
        { id: 3, username: "thirduser", avatar: "", status: "idle", role: "member" },
      ],
    },
  });
  await page.addInitScript(script);
}

async function navigateToMainPageWithDms(page: import("@playwright/test").Page): Promise<void> {
  await submitLogin(page);
  const appLayout = page.locator("[data-testid='app-layout']");
  await expect(appLayout).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
  // Wait for the DM section to render in the unified sidebar
  // In channels mode: DM section = .sidebar-dm-section, DM entries = [data-testid="dm-entry"]
  await expect(page.locator(".sidebar-dm-section, [data-testid='dm-entry']").first()).toBeVisible({
    timeout: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Tests: DM Sidebar Mode
// ---------------------------------------------------------------------------

test.describe("DM System — Sidebar Mode", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriSessionWithDms(page);
    await page.goto("/");
    await navigateToMainPageWithDms(page);
  });

  test("DM section shows in sidebar with DM items", async ({ page }) => {
    // The unified sidebar should show DM section
    const dmSection = page.locator(".sidebar-dm-section");
    await expect(dmSection.first()).toBeVisible({ timeout: 5_000 });

    // DM items should be visible in the sidebar
    const dmItems = page.locator("[data-testid='dm-entry']");
    await expect(async () => {
      const count = await dmItems.count();
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
  });

  test("clicking DM item switches sidebar to DM mode", async ({ page }) => {
    // DM items must be visible in the unified sidebar
    const dmItem = page.locator("[data-testid='dm-entry']").first();
    await expect(dmItem).toBeVisible({ timeout: 5_000 });

    await dmItem.click();

    // DM back header should appear (proves DM mode is active)
    const backHeader = page.locator("[data-testid='dm-back-header']");
    await expect(backHeader).toBeVisible({ timeout: 5_000 });
  });

  test("DM sidebar shows 'Back to Server' header", async ({ page }) => {
    const dmItem = page.locator("[data-testid='dm-entry']").first();
    await expect(dmItem).toBeVisible({ timeout: 5_000 });

    await dmItem.click();

    const backHeader = page.locator("[data-testid='dm-back-header']");
    await expect(backHeader).toBeVisible({ timeout: 5_000 });

    // Verify the text contains "Back to"
    const backTitle = page.locator(".dm-back-title");
    await expect(backTitle).toContainText("Back to");
  });

  test("'Back to Server' returns to channel sidebar", async ({ page }) => {
    const dmItem = page.locator("[data-testid='dm-entry']").first();
    await expect(dmItem).toBeVisible({ timeout: 5_000 });

    await dmItem.click();

    const backHeader = page.locator("[data-testid='dm-back-header']");
    await expect(backHeader).toBeVisible({ timeout: 5_000 });

    // Click "Back to Server"
    await backHeader.click();

    // Channel sidebar should be visible again (channel items appear)
    const channelItem = page.locator(".channel-item").first();
    await expect(channelItem).toBeVisible({ timeout: 5_000 });

    // Back header should be gone
    await expect(backHeader).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: DM WS Events
// ---------------------------------------------------------------------------

test.describe("DM System — WS Events", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriSessionWithDms(page);
    await page.goto("/");
    await navigateToMainPageWithDms(page);
  });

  test("dm_channel_open adds DM to sidebar", async ({ page }) => {
    // Count existing DM items before the event
    const dmItemsBefore = await page.locator("[data-testid='dm-entry']").count();

    // Emit a dm_channel_open event for a new user
    await emitWsMessage(page, {
      type: "dm_channel_open",
      payload: {
        channel_id: 200,
        recipient: { id: 10, username: "newdmuser", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "2026-03-15T14:00:00Z",
        unread_count: 0,
      },
    });

    // The DM item count should increase after the event
    await expect(async () => {
      const dmItemsAfter = await page.locator("[data-testid='dm-entry']").count();
      expect(dmItemsAfter).toBeGreaterThan(dmItemsBefore);
    }).toPass({ timeout: 5_000 });
  });

  test("dm_channel_close removes DM from sidebar", async ({ page }) => {
    // Count existing DM items before the event
    const dmItemsBefore = await page.locator("[data-testid='dm-entry']").count();

    // Emit a dm_channel_close event
    await emitWsMessage(page, {
      type: "dm_channel_close",
      payload: {
        channel_id: 100,
      },
    });

    // Verify the DM was removed by checking the DOM count decreased
    await expect(async () => {
      const dmItemsAfter = await page.locator("[data-testid='dm-entry']").count();
      expect(dmItemsAfter).toBeLessThan(dmItemsBefore);
    }).toPass({ timeout: 5_000 });
  });

  test("incoming chat_message in DM updates unread count", async ({ page }) => {
    // Send a message to a DM channel that is not active
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 999,
        channel_id: 101, // thirduser's DM channel
        user: { id: 3, username: "thirduser", avatar: "" },
        content: "New background message",
        timestamp: new Date().toISOString(),
        edited_at: null,
        attachments: [],
        reactions: [],
        reply_to: null,
        pinned: false,
        deleted: false,
      },
    });

    // The unread count should increment. In channels mode, DM entries use .dm-unread-badge
    await expect(page.locator(".dm-unread-badge").first()).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests: DM Message Display
// ---------------------------------------------------------------------------

test.describe("DM System — Message Display", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriSessionWithDms(page);
    await page.goto("/");
    await navigateToMainPageWithDms(page);
  });

  test("sending message in DM echoes back in chat", async ({ page }) => {
    const dmItem = page.locator("[data-testid='dm-entry']").first();
    await expect(dmItem).toBeVisible({ timeout: 5_000 });

    await dmItem.click();

    // Wait for the message input to appear after switching to DM
    const input = page.locator("[data-testid='msg-textarea']");
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill("Hello from DM!");
    await input.press("Enter");

    // Wait for the echo (mock echoChatSend is enabled)
    const echoMsg = page.locator(".msg-text", { hasText: "Hello from DM!" });
    await expect(echoMsg).toBeVisible({ timeout: 5_000 });
  });

  test("receiving WS chat_message in active DM shows in chat", async ({ page }) => {
    const dmItem = page.locator("[data-testid='dm-entry']").first();
    await expect(dmItem).toBeVisible({ timeout: 5_000 });

    await dmItem.click();

    // Wait for messages container to be ready
    const messagesContainer = page.locator(".messages-container");
    await expect(messagesContainer).toBeVisible({ timeout: 5_000 });

    // Emit a chat_message for this DM channel
    await emitWsMessage(page, {
      type: "chat_message",
      payload: {
        id: 1001,
        channel_id: 100, // otheruser's DM channel
        user: { id: 2, username: "otheruser", avatar: "" },
        content: "Hello from the other side!",
        timestamp: new Date().toISOString(),
        edited_at: null,
        attachments: [],
        reactions: [],
        reply_to: null,
        pinned: false,
        deleted: false,
      },
    });

    // Check the message appears in the messages container
    const messageText = page.locator(".msg-text", { hasText: "Hello from the other side!" });
    await expect(messageText).toBeVisible({ timeout: 5_000 });
  });
});
