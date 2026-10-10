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
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { mockTauriFullSessionWithVoice, navigateToMainPageReady } from "./helpers";
import { findUnnamedControls, keyboardReachable } from "./support/b9-accessibility";

const TILE = 42;

const APP_CSP: string = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).app.security.csp;

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

    // Closing the window puts the stream back in its tile, still playing,
    // with keyboard focus back on the tile's Pop out control.
    await popup.close();
    await expect(tile(page).locator("video")).toHaveCount(1);
    await expect(tile(page).locator("[data-tile-control='pip']")).toBeFocused();
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

    // Tab reaches Bring back, not the tile controls under the cover.
    const popIn = tile(page).locator("[data-tile-control='pop-in']");
    expect(await keyboardReachable(page, popIn)).toBe(true);
    expect(
      await keyboardReachable(page, tile(page).locator("[data-tile-control='fullscreen']")),
    ).toBe(false);

    // By keyboard: focus stays on the tile, on its Pop out control.
    await popIn.focus();
    await page.keyboard.press("Enter");

    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(tile(page).locator("video")).toHaveCount(1);
    await expect(tile(page).locator("[data-tile-control='pip']")).toBeFocused();
  });

  test("the stream's volume and mute go along into the window, usable there", async ({ page }) => {
    await mountGrid(page);
    await tile(page).hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      tile(page).locator("[data-tile-control='pip']").click(),
    ]);
    await expect(popup.locator(".video-popout video")).toHaveCount(1);

    // Shown without a hover, on the left of the window's full-screen control.
    const slider = popup.locator(".video-popout .tile-volume-slider");
    const mute = popup.locator(".video-popout .tile-mute-btn");
    await expect(slider).toHaveAttribute("aria-label", "peer voice volume");
    await expect(popup.locator(".video-popout .video-tile-overlay")).toHaveCSS("opacity", "1");
    expect(await keyboardReachable(popup, slider)).toBe(true);
    await mute.click();
    await expect(mute).toHaveAttribute("aria-label", "Unmute");
    expect(await findUnnamedControls(popup.locator("body"))).toEqual([]);

    // Closing the window brings them back to the tile, still muted.
    await popup.close();
    await expect(tile(page).locator(".tile-mute-btn")).toHaveAttribute("aria-label", "Unmute");
  });

  test("the popup document runs under the app's CSP, styled and playing", async ({ page }) => {
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), "content-security-policy": APP_CSP },
      });
    });
    await mountGrid(page);
    await tile(page).hover();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      tile(page).locator("[data-tile-control='pip']").click(),
    ]);
    const video = popup.locator(".video-popout video");
    await expect(video).toHaveCount(1);

    const outcome = await popup.evaluate(
      () =>
        new Promise<{ violated: boolean; ran: boolean }>((resolve) => {
          const w = window as unknown as { __inlineRan?: boolean };
          let violated = false;
          document.addEventListener("securitypolicyviolation", () => {
            violated = true;
          });
          const script = document.createElement("script");
          script.textContent = "window.__inlineRan = true";
          document.head.appendChild(script);
          setTimeout(() => resolve({ violated, ran: w.__inlineRan === true }), 100);
        }),
    );
    expect(outcome).toEqual({ violated: true, ran: false });

    await expect(popup.locator(".video-popout")).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2))
      .toBe(true);
  });
});
