/**
 * Native E2E: DM System — real server DM flow.
 *
 * Tests starting a DM from the member list, the DM sidebar's Back-to-Server
 * header, real DM message send/receive, and returning to channels.
 *
 * The seeded fixture server has two users (alice, bob) but no DM channels, so
 * the "DM row already exists" half of this surface is reached by creating the
 * DM through the profile popup first — the same path a user takes. Tests share
 * one app process (serial + persistent fixture), so each starts by returning
 * the sidebar to channel mode.
 */

import { test, expect } from "../native-fixture-persistent";
import type { Page } from "@playwright/test";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn } from "./helpers";

test.describe.configure({ mode: "serial" });

/** Return a sidebar left in DM mode back to channels so the member list mounts. */
async function ensureChannelMode(page: Page): Promise<void> {
  const backHeader = page.locator("[data-testid='dm-back-header']");
  if (await backHeader.isVisible().catch(() => false)) {
    await backHeader.click();
  }
  await expect(page.locator(".member-item").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Start a DM with another member via the member-list profile popup, and wait
 * for the DM sidebar to show its Back-to-Server header. Returns the row's
 * channel id (from `.dm-item[data-channel-id]`).
 */
async function startDmWithOtherMember(page: Page): Promise<string> {
  await ensureChannelMode(page);

  const memberItems = page.locator(".member-item");
  const memberCount = await memberItems.count();
  test.skip(memberCount < 2, "Need at least 2 members visible to test DMs");

  // Pick a roster row that is not the signed-in user (alice, the fixture).
  const otherMember = memberItems.filter({ hasNotText: /alice/i }).first();
  await otherMember.click();

  // Member left-click opens the anchored profile popup, which is NOT a DM.
  const popup = page.locator("[data-testid='user-profile-popup']");
  await expect(popup).toBeVisible({ timeout: 5_000 });

  // "Message" is the real DM action; it calls handleCreateDm and switches the
  // sidebar into DM mode.
  await popup.getByTestId("upp-message-btn").click();
  await expect(popup).not.toBeVisible({ timeout: 5_000 });

  const backHeader = page.locator("[data-testid='dm-back-header']");
  await expect(backHeader).toBeVisible({ timeout: 10_000 });

  const firstDm = page.locator(".dm-item").first();
  await expect(firstDm).toBeVisible({ timeout: 10_000 });
  const channelId = await firstDm.getAttribute("data-channel-id");
  expect(channelId).toBeTruthy();
  return channelId!;
}

test.describe("DM System (Native)", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("the member list offers a Message action that opens the profile popup", async ({
    nativePage,
  }) => {
    await ensureChannelMode(nativePage);

    const memberItems = nativePage.locator(".member-item");
    test.skip((await memberItems.count()) < 2, "Need at least 2 members to test DMs");

    await memberItems.filter({ hasNotText: /alice/i }).first().click();

    // The popup is a real profile card, not the DM itself: its Message button
    // is asserted on the popup element, so a broken popup that rendered a DM
    // instead would fail here.
    const popup = nativePage.locator("[data-testid='user-profile-popup']");
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup.getByTestId("upp-message-btn")).toBeVisible();
    await expect(popup.locator(".upp-username")).not.toHaveText("");
  });

  test("clicking Message switches the sidebar into DM mode", async ({ nativePage }) => {
    await startDmWithOtherMember(nativePage);

    // The DM sidebar replaced the channel sidebar; the back header is the
    // proof, and the DM row itself carries the server-assigned channel id.
    await expect(nativePage.locator(".dm-sidebar-header")).toBeVisible();
    await expect(nativePage.locator(".dm-item.active")).toBeVisible();
  });

  test("Back to Server header names the server and returns to channels", async ({ nativePage }) => {
    const channelId = await startDmWithOtherMember(nativePage);

    const backHeader = nativePage.locator("[data-testid='dm-back-header']");
    await expect(backHeader.locator(".dm-back-title")).toContainText("Back to");

    await backHeader.click();
    await expect(nativePage.locator(".channel-item").first()).toBeVisible({ timeout: 5_000 });
    await expect(backHeader).not.toBeVisible();

    // The DM preview section in channel mode still lists the conversation we
    // just left; clicking it re-enters the same DM.
    await nativePage.locator(`.channel-item[data-testid='dm-entry']`).first().click();
    await expect(backHeader).toBeVisible({ timeout: 5_000 });
    await expect(nativePage.locator(`.dm-item[data-channel-id='${channelId}']`)).toHaveClass(
      /active/,
    );
  });

  test("DM messages container loads and a sent DM reaches the real server", async ({
    nativePage,
    nativeServer,
  }) => {
    const channelId = await startDmWithOtherMember(nativePage);

    const messagesContainer = nativePage.locator(".messages-container");
    await expect(messagesContainer).toBeVisible({ timeout: 10_000 });

    const text = `native-dm-${Date.now()}`;
    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    await textarea.fill(text);
    await textarea.press("Enter");

    // Rendered locally...
    await expect(nativePage.locator(".msg-text", { hasText: text })).toBeVisible({
      timeout: 10_000,
    });

    // ...and durable on the server: read history back through the REST API
    // rather than trusting the optimistic bubble.
    await expect
      .poll(async () => {
        const history = await nativeServer.api(
          `/api/v1/channels/${channelId}/messages`,
          undefined,
          nativeServer.owner!.token,
        );
        return history.messages.filter((m: { content: string }) => m.content === text).length;
      })
      .toBe(1);
  });
});
