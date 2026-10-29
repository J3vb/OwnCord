/**
 * WP 1D-8: a moderator drags a voice participant onto another voice channel
 * in the sidebar to move them (voice_mod_move), with the shared a11y checks
 * run against the sidebar mid-drag.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  navigateToMainPageReady,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_ROLES,
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_VOICE_STATE,
  voiceWsHandlers,
} from "./helpers";
import { Q1, findUnnamedControls, textContrast } from "./support/accessibility";

interface CaptureWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
  __sentMessages: string[];
}

function captureScript(): void {
  const w = window as unknown as CaptureWindow;
  const orig = w.__TAURI_INTERNALS__.invoke;
  w.__sentMessages = [];
  w.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === "ws_send") {
      const message = (args as { message?: unknown } | undefined)?.message;
      if (typeof message === "string") w.__sentMessages.push(message);
    }
    return orig(cmd, args);
  };
}

async function sentMoves(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as CaptureWindow).__sentMessages.filter((m) => m.includes("voice_mod_move")),
  );
}

/** "Voice Chat" (10) and "Music" (11) both carry `verdict`; user 2 is in 10. */
async function mockVoiceSession(page: Page, verdict: boolean): Promise<void> {
  const channels = MOCK_CHANNELS_WITH_CATEGORIES.map((ch) =>
    ch.type === "voice" ? { ...ch, can_moderate_voice: verdict } : ch,
  );
  await page.addInitScript(
    buildTauriMockScript({
      wrappers: [captureScript],
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
      ],
      simulateWsFlow: true,
      wsHandlers: voiceWsHandlers(),
      readyOverrides: {
        channels,
        members: MOCK_MEMBERS_MULTI_ROLE,
        voice_states: MOCK_VOICE_STATE,
        roles: [...MOCK_ROLES],
      },
    }),
  );
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const ROW = ".voice-user-item[data-voice-uid='2']";
const MUSIC = "[data-voice-drop-channel-id='11']";

test.describe("Voice drag to move — moderator", () => {
  test.beforeEach(async ({ page }) => {
    await mockVoiceSession(page, true);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(page.locator(ROW)).toBeVisible({ timeout: 5_000 });
  });

  test("dragging a participant onto Music sends voice_mod_move once", async ({ page }) => {
    const from = await centre(page, ROW);
    const to = await centre(page, MUSIC);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 10, { steps: 2 });
    await page.mouse.move(to.x, to.y, { steps: 5 });

    const target = page.locator(MUSIC);
    await expect(target).toHaveClass(/voice-drop-target/);
    await expect(page.locator(".voice-user-drag-ghost")).toHaveAttribute("aria-hidden", "true");

    // Mid-drag the sidebar keeps a name on every control, and the highlighted
    // channel's name stays readable on the highlight.
    expect(await findUnnamedControls(page.getByTestId("channel-sidebar"))).toEqual([]);
    const name = target.locator(".ch-name").first();
    const { ratio } = await textContrast(name);
    expect(ratio).toBeGreaterThanOrEqual(Q1.text);

    await page.mouse.up();
    await expect(page.locator(".voice-user-drag-ghost")).toHaveCount(0);
    await expect.poll(() => sentMoves(page)).toHaveLength(1);
    const parsed = JSON.parse((await sentMoves(page))[0] ?? "{}") as {
      type: string;
      payload: { user_id: number; to_channel_id: number };
    };
    expect(parsed.type).toBe("voice_mod_move");
    expect(parsed.payload).toMatchObject({ user_id: 2, to_channel_id: 11 });
    await expect(page.locator(".user-profile-popup")).toHaveCount(0);
  });

  test("Escape cancels the drag and sends nothing", async ({ page }) => {
    const from = await centre(page, ROW);
    const to = await centre(page, MUSIC);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".voice-user-drag-ghost")).toHaveCount(0);
    await page.mouse.up();
    expect(await sentMoves(page)).toEqual([]);
  });
});

test.describe("Voice drag to move — without permission", () => {
  test.beforeEach(async ({ page }) => {
    await mockVoiceSession(page, false);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await expect(page.locator(ROW)).toBeVisible({ timeout: 5_000 });
  });

  test("participants are not draggable", async ({ page }) => {
    await expect(page.locator(ROW)).not.toHaveClass(/voice-user-draggable/);
    const from = await centre(page, ROW);
    const to = await centre(page, MUSIC);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await expect(page.locator(".voice-user-drag-ghost")).toHaveCount(0);
    await page.mouse.up();
    expect(await sentMoves(page)).toEqual([]);
  });
});
