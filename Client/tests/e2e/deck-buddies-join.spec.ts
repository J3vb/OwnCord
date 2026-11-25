/**
 * Join in the Buddies row menu under Command Deck: "Join {room}" on a member
 * in another server voice room sends the same voice_join a click on the room
 * does, from the mouse and from the keyboard. A full room offers it only to a
 * viewer who may bypass the limit, and your own room never.
 *
 * Screenshot for the hand check: buddies-join-menu.png (the menu open on Rin
 * with "Join Lounge").
 */
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoiceChannelByName, openContextMenuOn } from "./helpers";
import { findUnnamedControls, focusIndicator, Q1, textContrast } from "./support/accessibility";
import { startDeckScene, type SceneOptions } from "./support/deckTreeScene";
import { sentFrames } from "./support/invokeLog";

const column = (page: Page): Locator => page.locator("#member-column");
/** Rin (id 2) is in Lounge (id 6) with Marco; testuser (id 1) is in no room. */
const rin = (page: Page): Locator => column(page).getByTestId("member-2");
const joinRow = (menu: Locator): Locator => menu.getByTestId("member-menu-join");

async function bootJoin(page: Page, options: SceneOptions = {}): Promise<void> {
  await startDeckScene(page, { theme: "gunmetal", ...options });
  await expect(rin(page)).toBeVisible();
}

/** The voice_join frames the client has sent so far. */
async function voiceJoins(page: Page): Promise<Array<Record<string, unknown>>> {
  return (await sentFrames(page))
    .filter((frame) => frame.type === "voice_join")
    .map((frame) => (frame.payload ?? {}) as Record<string, unknown>);
}

async function expectOneJoinOfLounge(page: Page): Promise<void> {
  await expect.poll(async () => (await voiceJoins(page)).length).toBe(1);
  expect(await voiceJoins(page)).toEqual([
    expect.objectContaining({ channel_id: 6, user_initiated: true }),
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("Command Deck Buddies: Join in the row menu", () => {
  test('right-click, then "Join Lounge", sends one voice_join', async ({ page }, testInfo) => {
    await bootJoin(page);
    const menu = await openContextMenuOn(page, rin(page));
    await expect(joinRow(menu)).toHaveText("Join Lounge");
    await shot(page, testInfo, "buddies-join-menu.png");

    expect(await voiceJoins(page)).toEqual([]);
    await joinRow(menu).click();
    await expect(page.locator(".context-menu")).toHaveCount(0);
    await expectOneJoinOfLounge(page);
  });

  test("Shift+F10 on a row, then the Join row, does the same", async ({ page }) => {
    await bootJoin(page);
    await rin(page).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.locator(".context-menu").first();
    const focused = menu.locator("[role='menuitem']:focus");
    await expect(focused).toHaveText("Profile");
    // Profile, Mention, Message, Call, then Join.
    for (let step = 0; step < 6 && (await focused.textContent()) !== "Join Lounge"; step++) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(focused).toHaveText("Join Lounge");
    await page.keyboard.press("Enter");
    await expectOneJoinOfLounge(page);
  });

  test("the focused Join row is named, shows its focus ring and meets contrast", async ({
    page,
  }) => {
    await bootJoin(page);
    await rin(page).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.locator(".context-menu").first();
    const focused = menu.locator("[role='menuitem']:focus");
    for (let step = 0; step < 6 && (await focused.textContent()) !== "Join Lounge"; step++) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(focused).toHaveText("Join Lounge");
    expect(await findUnnamedControls(menu)).toEqual([]);
    expect((await focusIndicator(page)).problems).toEqual([]);
    expect((await textContrast(joinRow(menu))).ratio).toBeGreaterThanOrEqual(Q1.text);
  });

  test("a full Lounge offers no Join, unless the viewer may bypass its limit", async ({ page }) => {
    // Rin and Marco fill a limit of 2; can_moderate_voice is absent, as from an older server.
    await bootJoin(page, { loungeLimit: 2 });
    const menu = await openContextMenuOn(page, rin(page));
    await expect(menu.getByTestId("member-menu-profile")).toBeVisible();
    await expect(joinRow(menu)).toHaveCount(0);
  });

  test("a full Lounge offers Join to a viewer who may moderate voice there", async ({ page }) => {
    await bootJoin(page, { loungeLimit: 2, loungeCanModerate: true });
    const menu = await openContextMenuOn(page, rin(page));
    await expect(joinRow(menu)).toHaveText("Join Lounge");
  });

  test("a member in your own room shows the voice icon and no Join", async ({ page }) => {
    await bootJoin(page);
    await joinVoiceChannelByName(page, "Lounge");
    await expect(column(page).getByTestId("buddy-voice-2")).toBeVisible();
    const menu = await openContextMenuOn(page, rin(page));
    await expect(menu.getByTestId("member-menu-profile")).toBeVisible();
    await expect(joinRow(menu)).toHaveCount(0);
  });
});
