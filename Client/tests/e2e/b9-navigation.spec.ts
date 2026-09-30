/**
 * B9-4: the shared navigation seams in the real shell.
 *
 * Message Requests (B9-5), the Safety tab (B9-15 and B9-10) and the
 * Moderation Center (B9-11) ship in this build; their journeys are
 * b9-message-requests.spec.ts, b9-moderation-notices.spec.ts, b9-reports.spec.ts
 * and fullstack/b9-moderation-queue.spec.ts. What this spec pins is the owner's
 * Q2 placement, and the familiar channel, DM and settings routes unchanged
 * with the content-view column in place. The
 * transitions through a destination (open, Close/Escape back to the channel,
 * replacement, permission loss, sign-out) run against inert views in
 * src/features/navigation/navigation.test.ts, because this spec also runs
 * against the production bundle, which has no test-only way to register one.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  submitLogin,
  waitForWsReady,
} from "./helpers";
import { findUnnamedControls, focusIndicator, keyboardReachable } from "./support/b9-accessibility";

const DM_CHANNELS = [
  {
    channel_id: 100,
    recipient: { id: 2, username: "otheruser", avatar: "", status: "online" },
    last_message_id: 500,
    last_message: "Hey there!",
    last_message_at: "2026-03-15T12:00:00Z",
    unread_count: 0,
  },
];

async function signIn(page: Page): Promise<void> {
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
  await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
}

/** The content-view column exists, is hidden, and claims no landmark. */
async function expectNoView(page: Page): Promise<void> {
  const view = page.locator("[data-testid='feature-view']");
  await expect(view).toBeAttached();
  await expect(view).toBeHidden();
  await expect(view).not.toHaveAttribute("role", /./);
  await expect(page.locator("[data-testid='chat-area']")).toBeVisible();
}

test.describe("B9-4 shared navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
          { pattern: "/api/v1/invites", status: 200, body: [] },
        ],
        simulateWsFlow: true,
        // The mock signs in as "admin", whose role holds ADMINISTRATOR and so
        // MODERATE_MEMBERS: the strongest case for a Moderation entry.
        readyOverrides: { dm_channels: DM_CHANNELS },
      }),
    );
    await page.goto("/");
    await signIn(page);
  });

  test("shows the Moderation entry beside Audit Log for a MODERATE_MEMBERS holder (Q2)", async ({
    page,
  }) => {
    const audit = page.locator("[data-testid='audit-log-btn']");
    await expect(audit).toBeVisible();
    const moderation = page.locator("[data-testid='moderation-btn']");
    await expect(moderation).toBeVisible();
    await expect(moderation).toHaveAccessibleName("Moderation");
    expect(
      await moderation.evaluate(
        (btn, a) => btn.previousElementSibling === a,
        await audit.elementHandle(),
      ),
    ).toBe(true);
    // No pending requests (the mock server has no inbox): no badge on the DM header.
    await expect(page.locator("[data-testid='dm-requests-badge']")).toBeHidden();
    await expectNoView(page);

    // DM mode: opening it opens no view by itself.
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
    await expectNoView(page);

    // Settings has the Safety tab (B9-10/15) after Account, in the arrow-key order.
    await page.locator("button[aria-label='Settings']").click();
    await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
    const tabs = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
    await expect(tabs.filter({ hasText: "Safety" })).toHaveCount(1);
    await page.getByRole("tab", { name: "Account" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Safety" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Appearance" })).toBeFocused();
  });

  test("the header fits a Moderation entry beside Audit Log (Q2)", async ({ page }) => {
    // The real entry (B9-11), measured against the real stylesheet.
    const sidebar = page.locator("[data-testid='unified-sidebar']");
    const header = sidebar.locator(".unified-sidebar-header");
    const moderation = page.locator("[data-testid='moderation-btn']");
    await expect(moderation).toBeVisible();

    const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBe(0);
    const bar = await sidebar.boundingBox();
    const box = await moderation.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(bar!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bar!.x + bar!.width);

    // Focusing it scrolls nothing sideways under the chat column.
    await moderation.focus();
    expect(await sidebar.evaluate((el) => el.scrollLeft)).toBe(0);
    expect(await header.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test("the header actions are one named row of icon buttons, in Tab order", async ({ page }) => {
    const header = page.locator("[data-testid='unified-sidebar'] .unified-sidebar-header");
    const actions = header.locator(".sidebar-header-actions > button");
    await expect(actions).toHaveCount(3);
    const names = ["Invite", "Audit Log", "Moderation"];
    for (const [i, name] of names.entries()) {
      await expect(actions.nth(i)).toHaveAccessibleName(name);
      await expect(actions.nth(i)).toHaveText("");
    }
    expect(await findUnnamedControls(header)).toEqual([]);

    // One row: every button shares a top edge.
    const tops = await actions.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().top),
    );
    expect(new Set(tops).size).toBe(1);

    // Tab walks them in order, each with the shared focus ring.
    const invite = actions.nth(0);
    expect(await keyboardReachable(page, invite)).toBe(true);
    for (const [i, name] of names.entries()) {
      if (i > 0) await page.keyboard.press("Tab");
      await expect(actions.nth(i)).toBeFocused();
      const ring = await focusIndicator(page);
      expect(ring.problems, `${name}: ${ring.problems.join("; ")}`).toEqual([]);
    }

    // Enter on Invite opens the invite manager.
    await invite.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Server Invites" })).toBeVisible();
  });

  test("Alt+ArrowDown / Alt+ArrowUp step the channel list (DP-35)", async ({ page }) => {
    const header = page.locator("[data-testid='chat-header-name']");
    await expect(header).toHaveText("general");

    // Switching channels focuses the composer, where a bare Alt+Arrow belongs
    // to the field — blur so the document-level shortcut can see the key.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press("Alt+ArrowDown");
    await expect(header).toHaveText("random");

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Alt+ArrowUp");
    await expect(header).toHaveText("general");
  });

  test("channel → DM → back → settings → logout → sign in again keeps the shell whole", async ({
    page,
  }) => {
    const header = page.locator("[data-testid='chat-header-name']");

    // The shell's controls are named and the settings opener is reachable by
    // Tab (A11Y-08; this spec historically skipped the shared helpers).
    expect(await findUnnamedControls(page.locator("[data-testid='unified-sidebar']"))).toEqual([]);
    const gear = page.locator("button[aria-label='Settings']");
    expect(await keyboardReachable(page, gear)).toBe(true);

    // channels → DM
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(header).toHaveText("otheruser");
    await expectNoView(page);

    // DM → back: the channelBeforeDm path content views also take (Q2).
    await page.locator("[data-testid='dm-back-header']").click();
    await expect(header).toHaveText("general");
    await expect(page.locator("[data-testid='channel-sidebar']")).toBeVisible();
    await expectNoView(page);

    // → settings, Escape closes it and focus returns to the opener.
    await gear.focus();
    await page.keyboard.press("Enter");
    const overlay = page.locator("[data-testid='settings-overlay']");
    await expect(overlay).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(overlay).not.toHaveClass(/open/);
    await expect(gear).toBeFocused();

    // → logout
    await gear.click();
    await page.locator(".settings-nav-item.danger", { hasText: "Log Out" }).click();
    await expect(page.locator("[data-testid='app-layout']")).toHaveCount(0, { timeout: 10_000 });

    // → the next session starts on a channel, with no view left over.
    await signIn(page);
    await expectNoView(page);
    await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);
  });
});
