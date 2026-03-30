/**
 * Native E2E: Main app layout after real login.
 *
 * Verifies all major UI sections render correctly when connected
 * to the real server with real data.
 */

import { test, expect } from "../native-fixture-persistent";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("App Layout (Logged In)", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("all major layout sections are visible", async ({ nativePage }) => {
    await expect(nativePage.locator("[data-testid='unified-sidebar']")).toBeVisible();
    await expect(nativePage.locator("[data-testid='channel-sidebar']")).toBeVisible();
    await expect(nativePage.locator("[data-testid='chat-area']")).toBeVisible();
    await expect(nativePage.locator("[data-testid='user-bar']")).toBeVisible();
  });

  test("chat header shows a channel name", async ({ nativePage }) => {
    const headerName = nativePage.locator("[data-testid='chat-header-name']");
    await expect(headerName).toBeVisible();
    const text = await headerName.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test("message input area is mounted", async ({ nativePage }) => {
    const inputSlot = nativePage.locator("[data-testid='input-slot']");
    await expect(inputSlot).toBeAttached();

    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
  });

  test("user bar shows current username", async ({ nativePage }) => {
    const userName = nativePage.locator("[data-testid='user-bar-name']");
    await expect(userName).toBeVisible();
    const text = await userName.textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test("user bar shows status and avatar", async ({ nativePage }) => {
    const avatar = nativePage.locator("[data-testid='user-bar'] .ub-avatar");
    await expect(avatar).toBeVisible();

    const status = nativePage.locator("[data-testid='user-bar'] .ub-status");
    await expect(status).toBeVisible();
  });

  test("user bar control buttons are present", async ({ nativePage }) => {
    const controls = nativePage.locator("[data-testid='user-bar'] .ub-controls");
    await expect(controls).toBeVisible();

    // Settings gear button should always be visible
    const settingsBtn = nativePage.locator("button[aria-label='Settings']");
    await expect(settingsBtn).toBeVisible();
  });

  test("channel sidebar has channels from real server", async ({ nativePage }) => {
    const channels = nativePage.locator(".channel-item");
    const count = await channels.count();
    expect(count).toBeGreaterThan(0);

    // Each channel should have a name
    const firstName = await channels.first().locator(".ch-name").textContent();
    expect(firstName?.trim().length).toBeGreaterThan(0);
  });

  test("channel sidebar shows channel icons", async ({ nativePage }) => {
    // Text channels should have # icon, voice channels 🔊
    const icons = nativePage.locator(".channel-item .ch-icon");
    const count = await icons.count();
    expect(count).toBeGreaterThan(0);

    const firstIcon = await icons.first().textContent();
    expect(firstIcon).toMatch(/[#🔊]/);
  });

  test("member list is visible with real members", async ({ nativePage }) => {
    const memberList = nativePage.locator("[data-testid='member-list']");
    await expect(memberList).toBeVisible({ timeout: 10_000 });

    // Should have at least 1 member (the logged-in user)
    const members = memberList.locator(".member-item");
    const count = await members.count();
    expect(count).toBeGreaterThan(0);
  });

  test("member list groups by role", async ({ nativePage }) => {
    const roleGroups = nativePage.locator(".member-role-group");
    const count = await roleGroups.count();
    expect(count).toBeGreaterThan(0);
  });

  test("first channel is active by default", async ({ nativePage }) => {
    const firstChannel = nativePage.locator(".channel-item").first();
    await expect(firstChannel).toHaveClass(/active/);
  });

  test("messages container loads for active channel", async ({ nativePage }) => {
    const msgContainer = nativePage.locator(".messages-container");
    await expect(msgContainer).toBeVisible({ timeout: 10_000 });
  });
});
