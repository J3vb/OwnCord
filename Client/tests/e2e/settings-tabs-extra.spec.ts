/**
 * Mocked E2E: the four settings tabs the audit found untested (gap #9) —
 * Text & Images, Accessibility, Advanced, and Notifications.
 *
 * These assert on rendered UI and on the app's outgoing IPC, not on the
 * injected mock's own state:
 *   - Text & Images toggles gate what a later-rendered message draws
 *     (YouTube embed, inline image, generic link card, frozen GIF). The prefs are cached
 *     at module load and invalidated by the `owncord:pref-change` event
 *     `savePref` dispatches, so a message emitted AFTER the toggle proves the
 *     whole toggle -> storage -> render path, not just the switch.
 *   - Accessibility toggles own classes on <html> (reduced-motion,
 *     high-contrast, large-font, OS-motion sync) and the Role Colors colour
 *     resolves on a newly rendered author.
 *   - Advanced drives Developer Mode into message rendering and the
 *     "Clear All Cache & Restart" two-step confirm into the outgoing
 *     `plugin:process|restart` IPC.
 *   - Notifications is the mute list: a mute set from the sidebar context
 *     menu must appear here and Unmute must clear it.
 *
 * Native-only bits (Launch on Login autostart, Open DevTools) are skipped: the
 * browser mock has no autostart plugin and DevTools is native chrome.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
  emitWsMessage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Local harness additions
// ---------------------------------------------------------------------------

/**
 * A full mocked session whose ready payload can override members, plus a
 * second init script that answers the native path/fs plugin calls the
 * Advanced tab's cache actions make. Without it `appLogDir()`/`readDir()`
 * resolve null from the mock's unhandled-command fallback and "Clear Log
 * Files" lands in its "Failed" branch instead of exercising the real flow.
 */
async function mockSession(
  page: Page,
  opts: { members?: unknown[]; seedMutes?: number[] } = {},
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      ],
      simulateWsFlow: true,
      ...(opts.members !== undefined ? { readyOverrides: { members: opts.members } } : {}),
    }),
  );

  // Runs after the Tauri mock script (addInitScript order is insertion order),
  // so it wraps the invoke the mock installed.
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = (window as any).__TAURI_INTERNALS__;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = (window as any).__invokeLog as Array<{ cmd: string; args?: unknown }>;
    const orig = internals.invoke;
    internals.invoke = async (cmd: string, args: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = args as any;
      // The stubs below answer before `orig` would record the call, so mirror
      // the mock's own `__invokeLog` here to keep the IPC evidence complete.
      const stubs =
        cmd === "plugin:path|resolve_directory" ||
        cmd === "plugin:path|join" ||
        cmd === "plugin:fs|read_dir" ||
        cmd === "plugin:fs|remove" ||
        cmd === "plugin:fs|exists" ||
        cmd === "plugin:fs|mkdir" ||
        cmd === "plugin:fs|write_text_file";
      if (stubs) log.push({ cmd, args });
      if (cmd === "plugin:path|resolve_directory") return "/mock/appdata";
      if (cmd === "plugin:path|join") return ((a?.paths as string[]) ?? []).join("/");
      // A small set of on-disk log files so the Advanced tab's cache actions
      // have something to delete (the log dir holds at most MAX_LOG_FILES).
      if (cmd === "plugin:fs|read_dir") {
        return [
          { name: "2026-01-01.jsonl", isDirectory: false },
          { name: "2026-01-02.jsonl", isDirectory: false },
        ];
      }
      if (cmd === "plugin:fs|remove") return;
      if (cmd === "plugin:fs|exists") return true;
      if (cmd === "plugin:fs|mkdir") return;
      if (cmd === "plugin:fs|write_text_file") return;
      // The broker hands a .gif URL back as a 1x1 GIF so the GIF-freeze path
      // runs; every other external image still refuses as in the base mock.
      if (cmd === "external_image" && String(a?.url ?? "").endsWith(".gif")) {
        const gif = atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
        return Uint8Array.from(gif, (c) => c.charCodeAt(0)).buffer;
      }
      return orig(cmd, args);
    };
  });

  if (opts.seedMutes !== undefined && opts.seedMutes.length > 0) {
    // Legacy unscoped key on purpose: channel-mutes migrates it to the
    // host-scoped key on first read, and this test does not know the host
    // before login. Seed at document start so the migration sees it.
    await page.addInitScript((ids: number[]) => {
      localStorage.setItem("owncord:settings:mutedChannels", JSON.stringify(ids));
    }, opts.seedMutes);
  }
}

/** A settings toggle whose row carries `label`. */
function toggleFor(page: Page, label: string) {
  return page.locator(".setting-row", { hasText: label }).locator(".toggle");
}

/** The `<html>` classes, as a plain array. */
async function htmlClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.documentElement.classList]);
}

/** Read the mute list from whichever scoped key exists. */
async function readStoredMuteList(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const prefix = "owncord:settings:mutedChannels";
    const key = Object.keys(localStorage).find((k) => k === prefix || k.startsWith(`${prefix}:`));
    return key === undefined ? [] : (JSON.parse(localStorage.getItem(key) ?? "[]") as number[]);
  });
}

/** Emit a chat message from another user into the active channel. */
async function emitChat(
  page: Page,
  id: number,
  content: string,
  author = { id: 2, username: "otheruser" as const },
): Promise<void> {
  await emitWsMessage(page, {
    type: "chat_message",
    payload: {
      id,
      channel_id: 1,
      user: { id: author.id, username: author.username, avatar: "" },
      content,
      timestamp: new Date(2026, 2, 15, 10, (id % 50) + 1).toISOString(),
      edited_at: null,
      attachments: [],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  });
}

/** Close the settings overlay and wait for it to leave the open state. */
async function closeSettings(page: Page): Promise<void> {
  await page.locator(".settings-close-btn").click();
  await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);
}

// ---------------------------------------------------------------------------
// Text & Images
// ---------------------------------------------------------------------------

test.describe("Settings — Text & Images Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("Show Embeds off suppresses a YouTube embed, on restores it", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");

    const toggle = toggleFor(page, "Show Embeds");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => localStorage.getItem("owncord:settings:showEmbeds"))).toBe(
      "false",
    );

    await closeSettings(page);
    await emitChat(page, 9101, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    // The message itself rendered — so the missing embed is the gate, not a
    // message that never showed up.
    await expect(page.locator("[data-testid='message-9101'] .msg-text")).toContainText("youtube");
    await expect(page.locator("[data-testid='message-9101'] .msg-embed-youtube")).toHaveCount(0);

    // Flip it back on and prove the embed renders again.
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await toggleFor(page, "Show Embeds").click();
    await closeSettings(page);
    await emitChat(page, 9102, "https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await expect(page.locator("[data-testid='message-9102'] .msg-embed-youtube")).toBeVisible();
  });

  test("Inline Attachment Preview off suppresses a direct image URL", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");

    const toggle = toggleFor(page, "Inline Attachment Preview");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await closeSettings(page);
    await emitChat(page, 9201, "https://example.com/photo.png");
    await expect(page.locator("[data-testid='message-9201'] .msg-text")).toContainText("photo.png");
    await expect(page.locator("[data-testid='message-9201'] .msg-image")).toHaveCount(0);

    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await toggleFor(page, "Inline Attachment Preview").click();
    await closeSettings(page);
    await emitChat(page, 9202, "https://example.com/other.png");
    await expect(page.locator("[data-testid='message-9202'] .msg-image")).toBeVisible();
  });

  test("Link Preview off suppresses a generic link card", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");

    const toggle = toggleFor(page, "Link Preview");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await closeSettings(page);
    await emitChat(page, 9301, "https://example.com/some-article-page");
    await expect(page.locator("[data-testid='message-9301'] .msg-text")).toContainText(
      "some-article-page",
    );
    await expect(page.locator("[data-testid='message-9301'] .msg-embed-link")).toHaveCount(0);

    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await toggleFor(page, "Link Preview").click();
    await closeSettings(page);
    await emitChat(page, 9302, "https://example.com/another-article");
    const card = page.locator("[data-testid='message-9302'] .msg-embed-link");
    await expect(card).toBeVisible();
    await expect(card.locator(".msg-embed-host")).toHaveText("example.com");
  });

  test("Animate GIFs off renders a new GIF frozen, on renders it playing", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");

    const toggle = toggleFor(page, "Animate GIFs");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await closeSettings(page);
    await emitChat(page, 9351, "https://example.com/frozen.gif");
    const frozen = page.locator("[data-testid='message-9351'] .msg-image");
    await expect(frozen).toHaveClass(/gif-paused/);
    await expect(frozen.locator(".gif-play-btn")).not.toHaveClass(/playing/);

    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await toggleFor(page, "Animate GIFs").click();
    await closeSettings(page);
    await emitChat(page, 9352, "https://example.com/playing.gif");
    const playing = page.locator("[data-testid='message-9352'] .msg-image");
    await expect(playing.locator(".gif-play-btn")).toHaveClass(/playing/);
    await expect(playing).not.toHaveClass(/gif-paused/);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

test.describe("Settings — Accessibility Tab", () => {
  test.beforeEach(async ({ page }) => {
    // otheruser is seeded as admin so Role Colors has a server colour
    // (#ff0000, MOCK_ROLES) to switch away from.
    await mockSession(page, {
      members: [
        { id: 1, username: "testuser", avatar: "", status: "online", role: "admin" },
        { id: 2, username: "otheruser", avatar: "", status: "online", role: "admin" },
      ],
    });
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("High Contrast toggles the html high-contrast class", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");

    const toggle = toggleFor(page, "High Contrast");
    await toggle.click();
    expect(await htmlClasses(page)).toContain("high-contrast");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    expect(await htmlClasses(page)).not.toContain("high-contrast");
  });

  test("Large Font toggles the html large-font class", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");

    const toggle = toggleFor(page, "Large Font");
    await toggle.click();
    expect(await htmlClasses(page)).toContain("large-font");

    await toggle.click();
    expect(await htmlClasses(page)).not.toContain("large-font");
  });

  test("Reduce Motion toggles the html reduced-motion class", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");

    const toggle = toggleFor(page, "Reduce Motion");
    await toggle.click();
    expect(await htmlClasses(page)).toContain("reduced-motion");
    expect(await page.evaluate(() => localStorage.getItem("owncord:settings:reducedMotion"))).toBe(
      "true",
    );

    await toggle.click();
    expect(await htmlClasses(page)).not.toContain("reduced-motion");
  });

  test("Sync with OS hands the reduced-motion class to the OS media query", async ({ page }) => {
    // The Playwright context runs with reducedMotion: "reduce", so the OS
    // query matches; with sync on the class must follow the OS, not the
    // manual pref (which is false here).
    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");

    const toggle = toggleFor(page, "Sync with OS");
    await toggle.click();
    expect(await htmlClasses(page)).toContain("reduced-motion");

    await toggle.click();
    expect(await htmlClasses(page)).not.toContain("reduced-motion");
  });

  test("Role Colors off recolours a newly rendered author to the member colour", async ({
    page,
  }) => {
    await emitChat(page, 9401, "colored when roles on");
    const onColor = await page
      .locator("[data-testid='message-9401'] .msg-author")
      .evaluate((el) => getComputedStyle(el).color);
    expect(onColor).toBe("rgb(255, 0, 0)");

    await openSettings(page);
    await switchSettingsTab(page, "Accessibility");
    await toggleFor(page, "Role Colors").click();
    await closeSettings(page);
    await emitChat(page, 9402, "member color when roles off");
    const offColor = await page
      .locator("[data-testid='message-9402'] .msg-author")
      .evaluate((el) => getComputedStyle(el).color);
    expect(offColor).not.toBe("rgb(255, 0, 0)");
    expect(offColor).toBe("rgb(148, 155, 164)");
  });
});

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

test.describe("Settings — Advanced Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("Developer Mode reveals the per-message Copy ID action", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Advanced");

    const toggle = toggleFor(page, "Developer Mode");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("owncord:settings:developerMode"))).toBe(
      "true",
    );

    await closeSettings(page);
    await emitChat(page, 9501, "dev mode on");
    await expect(page.locator("[data-testid='msg-copy-id-9501']")).toBeAttached();

    await openSettings(page);
    await switchSettingsTab(page, "Advanced");
    await toggleFor(page, "Developer Mode").click();
    await closeSettings(page);
    await emitChat(page, 9502, "dev mode off");
    await expect(page.locator("[data-testid='msg-copy-id-9502']")).toHaveCount(0);
  });

  test("Clear Image Cache deletes the IndexedDB image cache", async ({ page }) => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("owncord-image-cache", 1);
          req.onupgradeneeded = () => undefined;
          req.onsuccess = () => {
            req.result.close();
            resolve();
          };
          req.onerror = () => reject(req.error);
        }),
    );

    await openSettings(page);
    await switchSettingsTab(page, "Advanced");

    const btn = page
      .locator(".setting-row", { hasText: "Clear Image Cache" })
      .locator("button.ac-btn");
    await btn.click();
    await expect(btn).toHaveText("Cleared!");

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const dbs = await indexedDB.databases();
          return dbs.some((d) => d.name === "owncord-image-cache");
        }),
      )
      .toBe(false);
  });

  test("Clear Log Files removes the persisted JSONL files", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "Advanced");

    const btn = page
      .locator(".setting-row", { hasText: "Clear Log Files" })
      .locator("button.ac-btn");
    await btn.click();
    await expect(btn).toHaveText("Cleared!");

    // The action's only observable effect is outgoing IPC: one fs remove per
    // JSONL file the read_dir returned.
    const removed = await page.evaluate(() =>
      (
        window as unknown as { __invokeLog: Array<{ cmd: string; args?: { path?: string } }> }
      ).__invokeLog
        .filter((e) => e.cmd === "plugin:fs|remove")
        .map((e) => e.args?.path ?? ""),
    );
    expect(removed.filter((p) => p.endsWith("2026-01-01.jsonl"))).toHaveLength(1);
    expect(removed.filter((p) => p.endsWith("2026-01-02.jsonl"))).toHaveLength(1);
  });

  test("Clear All Cache & Restart is a two-step confirm that relaunches", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("owncord:profiles", JSON.stringify([{ name: "X" }]));
      localStorage.setItem("owncord:settings:fontSize", "20");
    });

    await openSettings(page);
    await switchSettingsTab(page, "Advanced");

    const btn = page
      .locator(".setting-row", { hasText: "Clear All Cache & Restart" })
      .locator("button.ac-btn");
    await btn.click();
    await expect(btn).toHaveText("Are you sure? Click again");
    await expect(btn).toHaveClass(/ac-btn-danger/);

    await btn.click();
    await page.waitForFunction(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "plugin:process|restart",
      ),
    );

    // User-critical storage survives; ordinary prefs are cleared.
    const preserved = await page.evaluate(() => localStorage.getItem("owncord:profiles"));
    expect(preserved).not.toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("owncord:settings:fontSize"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Notifications — mute list / unmute
// ---------------------------------------------------------------------------

test.describe("Settings — Notifications Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("mute from the sidebar appears in the list and Unmute clears it", async ({ page }) => {
    const channelOne = page.locator("[data-testid='channel-1']");
    await channelOne.click({ button: "right" });
    await page.locator("[data-testid='ctx-mute-channel']").click();
    await expect(page.locator("[data-testid='channel-1']")).toHaveClass(/muted/);

    await openSettings(page);
    await switchSettingsTab(page, "Notifications");

    const row = page.locator("[data-testid='muted-channel-list'] .settings-muted-row");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".settings-muted-name")).toHaveText("#general");

    await page.locator("[data-testid='unmute-1']").click();
    await expect(page.locator("[data-testid='muted-empty']")).toHaveText("Nothing is muted.");
    expect(await readStoredMuteList(page)).not.toContain(1);

    // Cross-surface proof it stuck: the context menu offers Mute again.
    await closeSettings(page);
    await page.locator("[data-testid='channel-1']").click({ button: "right" });
    await expect(page.locator("[data-testid='ctx-mute-channel']")).toHaveText("Mute Channel");
  });

  test("a mute that outlives its channel is listed and can be cleared", async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await mockSession(page, { seedMutes: [999] });
    await page.reload();
    await navigateToMainPageReady(page);

    await openSettings(page);
    await switchSettingsTab(page, "Notifications");

    const row = page.locator("[data-testid='muted-channel-list'] .settings-muted-row");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".settings-muted-name")).toHaveText("Channel 999");

    await page.locator("[data-testid='unmute-999']").click();
    await expect(page.locator("[data-testid='muted-empty']")).toBeVisible();
    expect(await readStoredMuteList(page)).not.toContain(999);
  });
});
