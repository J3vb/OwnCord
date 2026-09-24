/**
 * B9-24: polish the voice and media controls and their accessibility
 * (BPR-090, BPR-091).
 *
 * The journey: join a call, inspect the transport stats by keyboard, receive a
 * moderator mute, leave, and open the video grid — with names on every
 * control, a keyboard-operable (never pointer-only) stats toggle, a single
 * announced moderator state, the Q1 focus/contrast thresholds and a bounded
 * reflow at the 940x500 minimum window with 20px text.
 *
 * The mocked suite runs without LiveKit, so the video grid is exercised
 * through its component contract (the tile overlay focus reveal), not a live
 * track; native media behaviour is qualified by the desktop suite
 * (tests/e2e/native/voice-controls.spec.ts). Automated evidence supplements
 * the owner's NVDA/Orca recordings, which stay pending owner-run (B9-26).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  emitWsMessage,
  joinVoiceChannelByName,
  mockTauriFullSessionWithVoice,
  navigateToMainPageReady,
} from "./helpers";
import { findUnnamedControls, focusIndicator, textContrast } from "./support/b9-accessibility";

const widget = (page: Page) => page.locator("[data-testid='voice-widget']");

async function bootJoined(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
  await joinVoiceChannelByName(page);
  // The mock's voice_join handler echoes our own voice_state ~50ms after the
  // join. Wait for it to land before any test emits a replacement, or the
  // echo overwrites the state under test.
  await expect(page.locator(".voice-user-item[data-voice-uid='1']")).toBeVisible({
    timeout: 5_000,
  });
}

test.describe("B9-24 voice widget interaction and feedback", () => {
  test("the transport-stats toggle is a keyboard-operable button, not pointer-only", async ({
    page,
  }) => {
    await bootJoined(page);
    const signal = widget(page).locator("[data-testid='vw-signal']");
    await expect(signal).toHaveAttribute("aria-expanded", "false");

    // A keyboard press first sets :focus-visible modality, so the ring check
    // measures the same indicator a keyboard user sees.
    await page.keyboard.press("Tab");
    await signal.focus();
    const ring = await focusIndicator(page);
    expect(ring.problems).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(widget(page).locator(".vw-stats")).toHaveClass(/visible/);
    await expect(signal).toHaveAttribute("aria-expanded", "true");

    // Space works too, as a real button.
    await page.keyboard.press("Space");
    await expect(widget(page).locator(".vw-stats")).not.toHaveClass(/visible/);
    await expect(signal).toHaveAttribute("aria-expanded", "false");
  });

  test("names every voice control (no unnamed focusable)", async ({ page }) => {
    await bootJoined(page);
    expect(await findUnnamedControls(widget(page))).toEqual([]);
  });

  test("announces a moderator-imposed mute once and clears it when lifted", async ({ page }) => {
    await bootJoined(page);
    const status = widget(page).locator("[data-testid='vw-mod-status']");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveText("");

    // The server mutes us: the local user's voice_state carries server_muted.
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: true,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
        server_muted: true,
      },
    });
    await expect(status).toHaveText("You were muted by a moderator");
    const mute = widget(page).getByRole("button", { name: "Mute", exact: true });
    await expect(mute).toBeDisabled();

    // The restriction is lifted: the announcement clears.
    await emitWsMessage(page, {
      type: "voice_state",
      payload: {
        user_id: 1,
        username: "testuser",
        channel_id: 10,
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
        server_muted: false,
      },
    });
    await expect(status).toHaveText("");
  });

  test("header status text meets the Q1 4.5:1 text threshold", async ({ page }) => {
    await bootJoined(page);
    for (const sel of [".vw-connected", ".vw-timer"]) {
      const { ratio } = await textContrast(widget(page).locator(sel));
      expect(ratio, `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.describe("at the 940x500 minimum window with 20px text", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("keeps the widget controls reachable without horizontal overflow", async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("owncord:settings:fontSize", "20");
        localStorage.setItem("owncord:settings:largeFont", "true");
      });
      await bootJoined(page);
      for (const name of ["Mute", "Deafen", "Camera", "Screenshare", "Disconnect"]) {
        const btn = widget(page).getByRole("button", { name, exact: true });
        await btn.scrollIntoViewIfNeeded();
        await expect(btn).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    });
  });
});

test.describe("B9-24 video tile overlay keyboard parity", () => {
  // The real grid component is mounted into a visible host via the dev server's
  // module graph: the mocked suite cannot create a live MediaStream track, but
  // the overlay markup and CSS are what this lane changed, so driving the
  // component's own addStream (with a stub stream) is the honest check.
  async function mountGrid(page: Page): Promise<void> {
    await bootJoined(page);
    await page.evaluate(async (moduleUrl) => {
      const mod = await import(/* @vite-ignore */ moduleUrl);
      const host = document.createElement("div");
      host.id = "b9-grid-host";
      host.style.cssText = "position:fixed;inset:0 auto auto 0;width:640px;height:360px;z-index:1";
      document.body.appendChild(host);
      const grid = mod.createVideoGrid();
      grid.mount(host);
      // A real MediaStream (canvas capture) so the browser accepts srcObject.
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const stream = canvas.captureStream(1);
      grid.addStream(42, "peer", stream, {
        isSelf: false,
        audioUserId: 42,
        isScreenshare: false,
      });
    }, "/src/components/VideoGrid.ts");
    await expect(page.locator("#b9-grid-host .video-cell")).toBeVisible();
  }

  test("a tile's audio controls reveal on focus, not only on hover", async ({ page }) => {
    await mountGrid(page);
    const overlay = page.locator("#b9-grid-host .video-tile-overlay");
    await expect(overlay).toHaveCSS("opacity", "0");

    await page.locator("#b9-grid-host .tile-mute-btn").focus();
    await expect(overlay).toHaveCSS("opacity", "1");

    // Moving focus off the tile hides it again (not sticky).
    await page.locator(".channel-item.voice").first().focus();
    await expect(overlay).toHaveCSS("opacity", "0");
  });

  test("a tile's mute control is at least a 24x24 pointer target", async ({ page }) => {
    await mountGrid(page);
    const box = await page.locator("#b9-grid-host .tile-mute-btn").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });
});
