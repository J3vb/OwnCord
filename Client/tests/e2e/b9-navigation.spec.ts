/**
 * B9-4: the shared navigation seams in the real shell.
 *
 * Message Requests (B9-5) and the Moderation Center (B9-11) add their own
 * entries later; the Safety tab ships with B9-15 and B9-10 (their journeys
 * are in b9-moderation-notices.spec.ts and b9-reports.spec.ts). What the running app must show is the
 * owner's Q2 rule: no empty or nonfunctional destination, and the familiar channel, DM and
 * settings routes unchanged with the content-view column in place. The
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

  test("shows no Requests or Moderation entry before their features ship (Q2)", async ({
    page,
  }) => {
    // Moderation would sit beside Audit Log; Audit Log is there, Moderation is not.
    await expect(page.locator("[data-testid='audit-log-btn']")).toBeVisible();
    await expect(page.locator("[data-testid='moderation-btn']")).toHaveCount(0);
    // No pending-request badge on the DM header.
    await expect(page.locator("[data-testid='dm-requests-badge']")).toHaveCount(0);
    await expectNoView(page);

    // DM mode has no Message Requests section at its top.
    await page.locator("[data-testid='dm-entry']").first().click();
    await expect(page.locator("[data-testid='dm-back-header']")).toBeVisible();
    await expect(page.locator("[data-testid='dm-requests-entry']")).toHaveCount(0);
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
    // The entry B9-11 turns on is the same button SidebarArea renders beside
    // Audit Log, with the header class it sets while the entry is shown. No
    // destination can be registered in the production bundle, so add both to
    // the real header and measure the real stylesheet.
    const sidebar = page.locator("[data-testid='unified-sidebar']");
    const header = sidebar.locator(".unified-sidebar-header");
    await page.locator("[data-testid='audit-log-btn']").evaluate((audit) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sidebar-audit-btn";
      btn.dataset.testid = "moderation-btn";
      btn.textContent = "Moderation";
      audit.after(btn);
      audit.parentElement!.classList.add("with-moderation");
    });
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

  test("channel → DM → back → settings → logout → sign in again keeps the shell whole", async ({
    page,
  }) => {
    const header = page.locator("[data-testid='chat-header-name']");

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
    const gear = page.locator("button[aria-label='Settings']");
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
