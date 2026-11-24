/**
 * Command Deck's Direct folder: it sits at the bottom of the server tree with
 * the rail showing, opening a DM keeps the channel list, and a click on a
 * channel that is not a DM ends DM mode, so the member column comes back and
 * the joined call opens.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoiceChannelByName } from "./helpers";
import { CREW, MIRA, TESS, startDirectScene } from "./support/deckDirectScene";

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

  test("a group DM keeps DM mode, and collapsing keeps the open chat, unread DMs, People and requests", async ({
    page,
  }) => {
    await startDirectScene(page);
    await dm(page, CREW).click();
    await expect(dm(page, CREW)).toHaveAttribute("aria-current", "page");
    await head(page).click();
    await expect(head(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-testid=dm-entry]")).toHaveCount(2);
    await expect(dm(page, TESS)).toBeVisible();
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

  test("the Direct button counts unread DMs plus the request, and a click focuses the folder header", async ({
    page,
  }) => {
    await startDirectScene(page, { viewport: { width: 1280, height: 800 } });
    const button = page.getByTestId("deck-direct");
    await expect(button).toBeVisible();
    // The scene's unread DMs (3 in the group, 2 from Tess) plus its one request.
    await expect(button.locator(".deck-direct-badge")).toHaveText("6");
    await expect(button).toHaveAccessibleName(
      "Direct messages, 5 unread, 1 message request waiting",
    );
    await button.click();
    await expect(head(page)).toBeFocused();
  });

  test("collapsed with no DM open, the Direct button focuses the header and the unread DMs are listed under Message requests", async ({
    page,
  }) => {
    await startDirectScene(page, { viewport: { width: 1280, height: 800 } });
    await head(page).click();
    await expect(head(page)).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("deck-direct").click();
    await expect(head(page)).toBeFocused();
    await expect(page.locator("[data-testid=dm-entry]")).toHaveCount(2);
    await expect(dm(page, CREW)).toBeVisible();
    await expect(dm(page, TESS)).toBeVisible();
    const requests = await page.getByTestId("dm-requests-entry").boundingBox();
    const crew = await dm(page, CREW).boundingBox();
    const tess = await dm(page, TESS).boundingBox();
    expect(requests).not.toBeNull();
    expect(crew!.y).toBeGreaterThan(requests!.y);
    expect(tess!.y).toBeGreaterThan(crew!.y);
  });

  test("at 780 px the Direct button opens the drawer, focuses the header, and Escape returns", async ({
    page,
  }) => {
    await startDirectScene(page, { viewport: { width: 780, height: 600 } });
    const sidebar = page.locator("#unified-sidebar");
    // The drawer's controller loads a moment after the page: wait until it has
    // made the closed sidebar inert.
    await expect(sidebar).toHaveAttribute("inert", "");
    const button = page.getByTestId("deck-direct");
    await button.click();
    await expect(sidebar).toHaveClass(/drawer-open/);
    await expect(head(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar).not.toHaveClass(/drawer-open/);
    await expect(button).toBeFocused();
  });
});
