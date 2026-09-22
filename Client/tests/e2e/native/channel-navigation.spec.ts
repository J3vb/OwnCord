/**
 * Native E2E: Channel navigation with real server data.
 *
 * Tests switching between channels, verifying header updates,
 * message containers re-mount, and voice channel detection.
 *
 * Requires: Server with at least 2 text channels.
 */

import { test, expect } from "../native-fixture-persistent";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Channel Navigation", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("text channels have # icon", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item .ch-icon", { hasText: "#" });
    const count = await textChannels.count();
    expect(count).toBeGreaterThan(0);
  });

  test("voice channels have speaker icon", async ({ nativePage }) => {
    // Voice channels may or may not exist depending on server config
    const voiceChannels = nativePage.locator(".channel-item .ch-icon", { hasText: "🔊" });
    const count = await voiceChannels.count();

    if (count > 0) {
      await expect(voiceChannels.first()).toBeVisible();
    }
    // If no voice channels, that's fine — server may not have any
  });

  test("channel sidebar shows server name in header", async ({ nativePage }) => {
    const serverName = nativePage.locator(".unified-sidebar-header .server-name");
    await expect(serverName).toBeVisible();

    const text = await serverName.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });
});

test.describe("Channel Switching", () => {
  // The seed creates one text channel ("general") and two voice channels, so
  // the count-based skip this suite used to carry left every switching test
  // permanently skipped. Create a second text channel once through the real
  // admin route; the WS channel_create fan-out adds it to the open app.
  let seededSecondTextChannel = false;

  test.beforeEach(async ({ nativePage, nativeServer }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);

    if (!seededSecondTextChannel) {
      await nativeServer.api(
        "/admin/api/channels",
        { name: "switching-two", type: "text" },
        nativeServer.owner!.token,
      );
      seededSecondTextChannel = true;
    }

    // At least two text channels, so nth(1) below is a real second channel.
    // Do not assert an exact count: the worker-scoped server is shared with
    // other spec files in this project, and they may have added their own.
    await expect
      .poll(() => nativePage.locator(".channel-item:not(.voice)").count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
  });

  test("clicking a text channel makes it active", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const secondChannel = textChannels.nth(1);
    await secondChannel.click();
    await expect(secondChannel).toHaveClass(/active/, { timeout: 5_000 });
  });

  test("switching text channels updates chat header", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const firstChannel = textChannels.first();
    const firstName = await firstChannel.locator(".ch-name").textContent();
    const header = nativePage.locator("[data-testid='chat-header-name']");
    const headerText = await header.textContent();
    expect(headerText?.trim()).toBe(firstName?.trim());

    const secondChannel = textChannels.nth(1);
    const secondName = await secondChannel.locator(".ch-name").textContent();
    await secondChannel.click();
    await expect(header).toHaveText(secondName?.trim() ?? "", { timeout: 5_000 });
  });

  test("switching text channels loads new messages", async ({ nativePage }) => {
    await expect(nativePage.locator(".messages-container")).toBeVisible({ timeout: 10_000 });

    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    await textChannels.nth(1).click();
    await expect(nativePage.locator(".messages-container")).toBeVisible({ timeout: 10_000 });
  });

  test("clicking back to first text channel restores its active state", async ({ nativePage }) => {
    const textChannels = nativePage.locator(".channel-item").filter({
      has: nativePage.locator(".ch-icon", { hasText: "#" }),
    });
    const firstChannel = textChannels.first();
    const secondChannel = textChannels.nth(1);

    await secondChannel.click();
    await expect(secondChannel).toHaveClass(/active/, { timeout: 5_000 });

    await firstChannel.click();
    await expect(firstChannel).toHaveClass(/active/, { timeout: 5_000 });
  });
});
