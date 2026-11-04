import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  mockTauriFullSessionWithVoice,
  navigateToMainPage,
  emitWsMessage,
  joinVoiceChannelByName,
  expectUserBarToggle,
  startFullSession,
} from "./helpers";

async function joinVoice(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  await navigateToMainPage(page);
  await joinVoiceChannelByName(page);
}

test.describe("Voice Widget", () => {
  test("is hidden by default when user has no voice state", async ({ page }) => {
    await startFullSession(page);

    const widget = page.locator("[data-testid='voice-widget']");
    // The widget now loads on the first voice join, so it is absent (or hidden) here (O-6b).
    await expect(widget).toHaveCount(0);
    await expect(widget).not.toBeVisible();
  });

  test("appears with full UI after joining voice", async ({ page }) => {
    await joinVoice(page);

    const widget = page.locator("[data-testid='voice-widget'].visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    // Verify all widget parts render (users list is in sidebar, not widget)
    await expect(widget.locator(".vw-connected")).toBeVisible();
    await expect(widget.locator(".vw-channel")).toBeVisible();
    await expect(widget.locator(".vw-controls")).toBeVisible();
    await expect(page.locator("button[aria-label='Disconnect']")).toBeVisible();
  });

  test("mute button toggles active state on click", async ({ page }) => {
    await joinVoice(page);
    await expect(page.locator(".vw-controls")).toBeVisible({ timeout: 5_000 });

    await expectUserBarToggle(page, "Mute");
  });

  test("deafen button toggles active state on click", async ({ page }) => {
    await joinVoice(page);
    await expect(page.locator(".vw-controls")).toBeVisible({ timeout: 5_000 });

    await expectUserBarToggle(page, "Deafen");
  });

  test("the connection panel reads as a two-line header over Upload/Download tiles, nothing wrapping", async ({
    page,
  }) => {
    await joinVoice(page);
    const widget = page.locator("[data-testid='voice-widget'].visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    await widget.locator("[data-testid='vw-signal']").click();
    await expect(widget.locator(".vw-stats")).toHaveClass(/visible/);

    // Two tiles, Upload then Download, each a big rate over its packet count,
    // and one footer line for the RTT/session totals.
    const tiles = widget.locator(".vw-stats-tile");
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0).locator(".vw-stats-tile-label")).toContainText("Upload");
    await expect(tiles.nth(1).locator(".vw-stats-tile-label")).toContainText("Download");
    await expect(widget.locator(".vw-stats-footer")).toHaveCount(1);

    // Each header line and every value stays on one line: the old header
    // stacked "Voice / Connected / Secured / 00:15 / General" over several.
    for (const line of [".vw-header-main", ".vw-header-sub"]) {
      const lineHeight = await widget
        .locator(line)
        .evaluate((el) => el.getBoundingClientRect().height);
      expect(lineHeight, `${line} height`).toBeLessThan(28);
    }
    const overflow = await widget
      .locator(
        ".vw-stat-value, .vw-stat-packets, .vw-stats-footer, .vw-header-main, .vw-header-sub",
      )
      .evaluateAll((els) =>
        els.map((el) => ({
          text: el.textContent,
          wraps: el.scrollWidth > el.clientWidth + 1,
        })),
      );
    expect(overflow.filter((o) => o.wraps)).toEqual([]);
  });

  test("second user joining voice appears in sidebar users list", async ({ page }) => {
    await joinVoice(page);
    const widget = page.locator("[data-testid='voice-widget'].visible");
    await expect(widget).toBeVisible({ timeout: 5_000 });

    const usersBefore = await page.locator(".voice-user-item").count();

    // Another user joins the voice channel (id 4 — NOT already in
    // MOCK_VOICE_STATE, so this is a genuine join, not an in-place update).
    // The username must match id 4's record in MOCK_MEMBERS_MULTI_ROLE
    // ("member2"): the roster resolves identity through membersStore so a
    // nickname shows the same everywhere, and a real server never sends a
    // voice_state whose username disagrees with the member of that id.
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 4,
        username: "member2",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    });

    // New user should appear in the sidebar voice-users-list (not the widget)
    const newUser = page.locator(".voice-user-item .vu-name", { hasText: "member2" });
    await expect(newUser).toBeVisible({ timeout: 5_000 });
    const usersAfter = await page.locator(".voice-user-item").count();
    expect(usersAfter).toBeGreaterThan(usersBefore);
  });
});
