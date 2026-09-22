/**
 * Native E2E: Overlay features (Quick Switcher, Emoji Picker, Pins).
 *
 * Tests overlay open/close behavior, keyboard shortcuts, and content
 * rendering against the real production app.
 *
 * The persistent fixture reuses one app process for the whole project, so
 * `mode: "serial"` tests share a DOM. Each test therefore opens its overlay
 * from a known-closed state through the real toggle (a second Ctrl+K closes
 * the switcher, a second emoji-button click closes the picker), instead of
 * assuming the previous test left it closed.
 */

import { test, expect } from "../native-fixture-persistent";
import type { Page } from "@playwright/test";
import { SKIP_SERVER, hasCredentials, ensureLoggedIn } from "./helpers";

test.describe.configure({ mode: "serial" });

async function openQuickSwitcher(page: Page): Promise<void> {
  const overlay = page.locator(".quick-switcher-overlay");
  if (await overlay.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  }
  await page.keyboard.press("Control+k");
  await expect(overlay).toBeVisible({ timeout: 3_000 });
}

async function closeEmojiPicker(page: Page): Promise<void> {
  const picker = page.locator(".emoji-picker.open");
  if (await picker.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(picker).not.toBeVisible({ timeout: 3_000 });
  }
}

async function openEmojiPicker(page: Page): Promise<void> {
  await closeEmojiPicker(page);
  await page.locator(".emoji-btn").click();
  await expect(page.locator(".emoji-picker.open")).toBeVisible({ timeout: 3_000 });
}

test.describe("Quick Switcher", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("opens with Ctrl+K keyboard shortcut", async ({ nativePage }) => {
    await openQuickSwitcher(nativePage);
    await expect(nativePage.locator(".quick-switcher-overlay")).toBeVisible({ timeout: 3_000 });
  });

  test("search input is auto-focused on open", async ({ nativePage }) => {
    await openQuickSwitcher(nativePage);

    const searchInput = nativePage.locator(".quick-switcher__input");
    await expect(searchInput).toBeFocused();
  });

  test("shows channel results from real server", async ({ nativePage }) => {
    await openQuickSwitcher(nativePage);

    const items = nativePage.locator(".quick-switcher__item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test("typing filters results", async ({ nativePage }) => {
    await openQuickSwitcher(nativePage);

    const items = nativePage.locator(".quick-switcher__item");
    const initialCount = await items.count();
    test.skip(initialCount < 2, "Need at least 2 items to test filtering");

    // Type a filter query
    await nativePage.locator(".quick-switcher__input").fill("zzz_nonexistent");

    // Results should decrease or be empty
    await expect(async () => {
      const filteredCount = await items.count();
      expect(filteredCount).toBeLessThan(initialCount);
    }).toPass({ timeout: 3_000 });
  });

  test("Escape closes the switcher", async ({ nativePage }) => {
    await openQuickSwitcher(nativePage);

    await nativePage.keyboard.press("Escape");
    await expect(nativePage.locator(".quick-switcher-overlay")).not.toBeVisible({ timeout: 3_000 });
  });

  test("selecting a result switches channel", async ({ nativePage, nativeServer }) => {
    // The seeded server has a single text channel, so create a second one
    // through the real admin route; the WS channel_create fan-out adds it to
    // the open app's sidebar.
    const targetName = `switcher-${Date.now()}`;
    await nativeServer.api(
      "/admin/api/channels",
      { name: targetName, type: "text" },
      nativeServer.owner!.token,
    );
    const targetRow = nativePage.locator(".channel-item:not(.voice)", { hasText: targetName });
    await expect(targetRow).toBeVisible({ timeout: 10_000 });

    await openQuickSwitcher(nativePage);

    const items = nativePage.locator(".quick-switcher__item");
    const targetItem = items.filter({ hasText: targetName });
    await expect(targetItem).toBeVisible({ timeout: 5_000 });

    // Ensure a different channel is active first, so the switch is observable.
    const currentName = (
      await nativePage.locator("[data-testid='chat-header-name']").textContent()
    )?.trim();
    if (currentName === targetName) {
      await nativePage.keyboard.press("Escape");
      await nativePage.locator(".channel-item:not(.voice)").first().click();
      await openQuickSwitcher(nativePage);
    }

    const targetId = await targetItem.getAttribute("data-channelid");
    await targetItem.click();

    await expect(nativePage.locator(".quick-switcher-overlay")).not.toBeVisible({ timeout: 3_000 });
    await expect(nativePage.locator("[data-testid='chat-header-name']")).toHaveText(targetName, {
      timeout: 5_000,
    });
    await expect(nativePage.locator(`.channel-item[data-channel-id="${targetId}"]`)).toHaveClass(
      /active/,
    );

    // Restore the default channel for later tests in this shared process.
    await nativePage.locator(".channel-item:not(.voice)", { hasText: "general" }).first().click();
  });
});

test.describe("Emoji Picker", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("emoji button opens picker", async ({ nativePage }) => {
    await expect(nativePage.locator(".emoji-btn")).toBeVisible();
    await openEmojiPicker(nativePage);
  });

  test("emoji picker has search and grid", async ({ nativePage }) => {
    await expect(nativePage.locator(".emoji-btn")).toBeVisible();
    await openEmojiPicker(nativePage);

    await expect(nativePage.locator(".ep-search")).toBeVisible();
    const emojis = nativePage.locator(".ep-emoji");
    expect(await emojis.count()).toBeGreaterThan(0);
  });

  test("clicking emoji inserts it into the textarea", async ({ nativePage }) => {
    await expect(nativePage.locator(".emoji-btn")).toBeVisible();

    const textarea = nativePage.locator("[data-testid='msg-textarea']");
    await textarea.fill("");
    await openEmojiPicker(nativePage);

    // Click first emoji — the picker closes on select.
    await nativePage.locator(".ep-emoji").first().click();
    await expect(nativePage.locator(".emoji-picker.open")).not.toBeVisible({ timeout: 3_000 });

    // The textarea now holds the inserted emoji (non-empty).
    const value = await textarea.inputValue();
    expect(value.length).toBeGreaterThan(0);

    // Clean up the composer for any later test in this shared process.
    await textarea.fill("");
  });
});

test.describe("Pinned Messages", () => {
  test.beforeEach(async ({ nativePage }) => {
    test.skip(SKIP_SERVER, "Skipped: OWNCORD_SKIP_SERVER_TESTS is set");
    test.skip(!hasCredentials(), "Skipped: OWNCORD_TEST_USER/OWNCORD_TEST_PASS not set");
    await ensureLoggedIn(nativePage);
  });

  test("pin button opens the pinned messages panel", async ({ nativePage }) => {
    const pinBtn = nativePage.locator("[data-testid='pin-btn']");
    await expect(pinBtn).toBeVisible();

    await pinBtn.click();

    // A failed GET /pins surfaces an error toast, NOT the panel — so an error
    // toast must not be accepted as success. The seeded server answers with
    // 200 and an empty list, so the real outcome is the panel's empty state.
    const panel = nativePage.locator(".pinned-panel");
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await expect(panel.getByRole("heading", { name: /pinned messages/i })).toBeVisible();
    await expect(panel.locator(".pinned-panel__count")).toHaveText(/^\d+$/);
    await expect(nativePage.locator("[data-testid='toast']", { hasText: /pinned/i })).toHaveCount(
      0,
    );
  });

  test("pinned panel can be closed", async ({ nativePage }) => {
    const pinBtn = nativePage.locator("[data-testid='pin-btn']");
    await expect(pinBtn).toBeVisible();

    await pinBtn.click();

    const panel = nativePage.locator(".pinned-panel");
    await expect(panel).toBeVisible({ timeout: 5_000 });

    await panel.locator(".pinned-panel__close").click();
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });
});
