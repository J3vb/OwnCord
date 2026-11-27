/**
 * Call helpers the phone Command Deck specs share: joining Voice Chat from the
 * tree drawer, checking that exactly one Mute and one Leave reach a tap (the
 * status bar's), and faking a voice-store flag on the dev server.
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "../fixtures";
import {
  ROUTE_HEALTH,
  ROUTE_LOGIN,
  dmChannel,
  voiceJoinWithTokenHandlers,
  buildTauriMockScript,
} from "../helpers";
import { reachableCount, swipeOn } from "./phone";

export const MUTE =
  "[data-testid='user-bar'] [data-testid='ub-mute'], [data-testid='pcb-mute'], .video-grid__controls [data-call-control='mute'], [data-testid='dcp-mute']";
export const LEAVE =
  ".vw-controls .disconnect, [data-testid='pcb-leave'], .video-grid__controls [data-call-control='leave'], [data-testid='dcp-leave'], [data-testid='dcp-leave-call']";
export const BAR_MUTE = ".deck-status-bar [data-testid='ub-mute']";
export const BAR_LEAVE = ".deck-status-bar .vw-controls .disconnect";

export const statusBar = (page: Page): Locator => page.locator("[data-testid='deck-status-bar']");

export async function openTree(page: Page): Promise<void> {
  await page.locator("[data-testid='sidebar-toggle']").first().tap();
  await expect(page.locator("[data-testid='unified-sidebar']")).toHaveClass(/drawer-open/);
}

/** Joins Voice Chat from the tree drawer and stands in for the room connecting. */
export async function enterCall(page: Page): Promise<void> {
  await openTree(page);
  await page.locator(".channel-item.voice", { hasText: "Voice Chat" }).tap();
  await page.getByTestId("join-sheet-join").tap();
  await page.evaluate(() =>
    (
      window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
    ).__owncord.setVoiceStatus("connected"),
  );
  await expect(statusBar(page).locator(".voice-widget.visible")).toBeVisible();
  await expect(page.locator("[data-testid='unified-sidebar']")).not.toHaveClass(/drawer-open/);
}

/** Exactly one Mute and one Leave reach a tap, and they are the status bar's. */
export async function expectOneMuteAndLeave(page: Page, where: string): Promise<void> {
  await expect.poll(() => reachableCount(page, MUTE), `Mute, ${where}`).toBe(1);
  await expect.poll(() => reachableCount(page, LEAVE), `Leave, ${where}`).toBe(1);
  expect(await reachableCount(page, BAR_MUTE), `status bar Mute, ${where}`).toBe(1);
  expect(await reachableCount(page, BAR_LEAVE), `status bar Leave, ${where}`).toBe(1);
}

export async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

/** Calls one of the voice store's existing setters through the dev server's
 *  module graph, as reconnect-media-notice.spec.ts does. False when the graph
 *  is not served (the production preview), so the case skips. */
export async function setVoiceFlag(
  page: Page,
  setter: "setListenOnly" | "setEncryptionDegraded",
): Promise<boolean> {
  return page.evaluate(
    async ([url, name]) => {
      try {
        const mod = (await import(/* @vite-ignore */ url!)) as Record<
          string,
          (value: boolean) => void
        >;
        mod[name!]!(true);
        return true;
      } catch {
        return false;
      }
    },
    ["/src/stores/voice.store.ts", setter],
  );
}

export const PHONE_DM = 100;
export const PHONE_DM_CHANNELS = [dmChannel(PHONE_DM, { id: 2, username: "otheruser" })];

/** A session with one DM whose call can be started and connected; `ready` adds to the ready payload. */
export function dmCallScene(
  ready: Record<string, unknown> = {},
): Parameters<typeof buildTauriMockScript>[0] {
  return {
    httpRoutes: [
      ROUTE_HEALTH,
      ROUTE_LOGIN,
      { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
      { pattern: "GET /api/v1/dms", status: 200, body: { dm_channels: PHONE_DM_CHANNELS } },
      { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
    ],
    simulateWsFlow: true,
    wsHandlers: voiceJoinWithTokenHandlers(),
    readyOverrides: { ...ready, dm_channels: PHONE_DM_CHANNELS },
  };
}

/** Swipes left across the chat header from near the right edge, which opens Buddies. */
export async function swipeBuddiesOpen(page: Page): Promise<void> {
  const width = page.viewportSize()!.width;
  const header = await boxOf(page.locator(".chat-header"));
  await swipeOn(page, ".chat-header", -200, 0, {
    x: width - 30,
    y: header.y + header.height / 2,
  });
}
