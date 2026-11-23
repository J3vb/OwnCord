/**
 * Command Deck's Direct folder: it sits at the bottom of the server tree with
 * the rail showing, opening a DM keeps the channel list, and a click on a
 * channel that is not a DM ends DM mode, so the member column comes back and
 * the joined call opens.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoiceChannelByName } from "./helpers";
import { CREW, MIRA, startDirectScene } from "./support/deckDirectScene";

const head = (page: Page) => page.locator(".server-tree-direct-head");
const dm = (page: Page, id: number) =>
  page.locator(`[data-testid=dm-entry][data-channel-id="${id}"]`);
const memberList = (page: Page) => page.getByTestId("member-list");

test.describe("Command Deck Direct folder", () => {
  test("the folder header is visible at 1280 px with the rail, and the preview section is gone", async ({
    page,
  }) => {
    await startDirectScene(page, { viewport: { width: 1280, height: 800 } });
    await expect(page.getByTestId("server-rail-home")).toBeVisible();
    await expect(head(page)).toBeVisible();
    await expect(head(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".sidebar-dm-section")).toHaveCount(0);
    await expect(page.getByTestId("dm-people-entry")).toBeVisible();
    await expect(page.getByTestId("dm-requests-entry")).toHaveAccessibleName(
      "Message requests, 1 waiting",
    );
    await expect(page.locator("[data-testid=dm-entry]")).toHaveCount(10);
  });

  test("opening a DM keeps the channel list, and a channel click brings the member column back", async ({
    page,
  }) => {
    await startDirectScene(page);
    await expect(memberList(page)).toBeVisible();
    await dm(page, MIRA).click();
    await expect(dm(page, MIRA)).toHaveAttribute("aria-current", "page");
    // No channel is active, and the tree still shows them.
    await expect(page.getByTestId("channel-3")).toBeVisible();
    await expect(
      page.locator(".channel-item[aria-current=page]:not([data-testid=dm-entry])"),
    ).toHaveCount(0);
    await expect(memberList(page)).toBeHidden();

    await page.getByTestId("channel-3").click();
    await expect(memberList(page)).toBeVisible();
    await expect(page.getByTestId("channel-3")).toHaveAttribute("aria-current", "page");
    await expect(dm(page, MIRA)).not.toHaveAttribute("aria-current", "page");
  });

  test("a group DM keeps DM mode, and collapsing keeps the open chat, People and requests", async ({
    page,
  }) => {
    await startDirectScene(page);
    await dm(page, CREW).click();
    await expect(dm(page, CREW)).toHaveAttribute("aria-current", "page");
    await head(page).click();
    await expect(head(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-testid=dm-entry]")).toHaveCount(1);
    await expect(dm(page, CREW)).toBeVisible();
    await expect(page.getByTestId("dm-people-entry")).toBeVisible();
    await expect(page.getByTestId("dm-requests-entry")).toBeVisible();
    await head(page).click();
    await expect(page.locator("[data-testid=dm-entry]")).toHaveCount(10);
  });

  test("the joined voice channel opens its call while a DM is open", async ({ page }) => {
    await startDirectScene(page);
    await dm(page, MIRA).click();
    await expect(memberList(page)).toBeHidden();
    // A first click joins without leaving the DM.
    await joinVoiceChannelByName(page, "Lounge");
    await expect(dm(page, MIRA)).toHaveAttribute("aria-current", "page");
    await page.evaluate(() =>
      (
        window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
      ).__owncord.setVoiceStatus("connected"),
    );
    // A click on the joined channel opens the call, which is a non-DM channel.
    await page.locator(".channel-item.voice", { hasText: "Lounge" }).click();
    await expect(page.getByTestId("video-grid")).toBeVisible();
    await expect(dm(page, MIRA)).not.toHaveAttribute("aria-current", "page");
  });
});
