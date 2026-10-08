/**
 * Stream pop-out (Discord-style): a tile's stream in a window of its own that
 * can be maximised or go full screen. The window is window.open's popup; the
 * desktop backend builds it as a real window (src-tauri/src/popout.rs), and
 * Chromium here stands in for WebView2.
 *
 * The real grid is mounted through the dev server's module graph, as in
 * b9-voice-polish.spec.ts, with a canvas-capture stream (the mocked suite has
 * no LiveKit track). The production preview serves only the bundle, so there
 * the test skips.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithVoice, navigateToMainPageReady } from "./helpers";
import { findUnnamedControls } from "./support/b9-accessibility";

const TILE = 42;

async function mountGrid(page: Page): Promise<void> {
  await mockTauriFullSessionWithVoice(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
  const mounted = await page.evaluate(async (moduleUrl) => {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ moduleUrl);
    } catch {
      return false;
    }
    const host = document.createElement("div");
    host.id = "popout-grid-host";
    host.style.cssText = "position:fixed;inset:0 auto auto 0;width:640px;height:360px;z-index:1";
    document.body.appendChild(host);
    const grid = mod.createVideoGrid();
    grid.mount(host);
    // A moving picture, so playback after the move is observable.
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d")!;
    let n = 0;
    const draw = (): void => {
      ctx.fillStyle = `hsl(${n++ % 360} 80% 50%)`;
      ctx.fillRect(0, 0, 320, 180);
    };
    draw();
    (window as unknown as { popoutTimer: number }).popoutTimer = window.setInterval(draw, 50);
    grid.addStream(42, "peer", canvas.captureStream(20), {
      isSelf: false,
      audioUserId: 42,
      isScreenshare: false,
    });
    return true;
  }, "/src/components/VideoGrid.ts");
  test.skip(!mounted, "needs the dev server's modules");
}

const tile = (page: Page) => page.locator(`#popout-grid-host .video-cell[data-user-id='${TILE}']`);

test.describe("stream pop-out window", () => {
  test("moves the playing stream into its own window, full screen there, and back on close", async ({
    page,
  }) => {
    await mountGrid(page);
    await tile(page).hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      tile(page).locator("[data-tile-control='pip']").click(),
    ]);

    // The video left the tile for the window, and plays there.
    await expect(tile(page).locator("video")).toHaveCount(0);
    await expect(tile(page).locator(".video-popped")).toBeVisible();
    await expect(popup).toHaveTitle("peer — OwnCord");
    const video = popup.locator(".video-popout video");
    await expect(video).toHaveCount(1);
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2))
      .toBe(true);
    // The app's styles came along: the page is the video on black.
    await expect(popup.locator(".video-popout")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    expect(await findUnnamedControls(popup.locator("body"))).toEqual([]);
    expect(await findUnnamedControls(tile(page))).toEqual([]);

    // Full screen from the window's own control.
    await popup.locator(".video-popout").hover();
    await popup.locator("[data-popout-control='fullscreen']").click();
    await expect
      .poll(() => popup.evaluate(() => document.fullscreenElement?.className ?? null))
      .toBe("video-popout");
    await expect(popup.locator("[data-popout-control='fullscreen']")).toHaveAttribute(
      "aria-label",
      "Exit full screen",
    );
    await popup.keyboard.press("f");
    await expect.poll(() => popup.evaluate(() => document.fullscreenElement)).toBeNull();

    // Closing the window puts the stream back in its tile, still playing.
    await popup.close();
    await expect(tile(page).locator("video")).toHaveCount(1);
    await expect(tile(page).locator(".video-popped")).toHaveCount(0);
    await expect
      .poll(() =>
        tile(page)
          .locator("video")
          .evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2),
      )
      .toBe(true);
  });

  test("Bring back closes the window", async ({ page }) => {
    await mountGrid(page);
    await tile(page).hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      tile(page).locator("[data-tile-control='pip']").click(),
    ]);
    await expect(popup.locator(".video-popout video")).toHaveCount(1);

    await tile(page).locator("[data-tile-control='pop-in']").click();

    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(tile(page).locator("video")).toHaveCount(1);
  });
});
