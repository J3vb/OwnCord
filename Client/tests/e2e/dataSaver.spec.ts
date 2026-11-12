import { devices } from "@playwright/test";
import { test, expect } from "./fixtures";
import { emitWsMessage, openSettings, startFullSession, switchSettingsTab } from "./helpers";
import { findUnnamedControls, focusIndicator, Q1, textContrast } from "./support/accessibility";

test.use({ ...devices["Pixel 7"], defaultBrowserType: "chromium" });

test("Android data saver settings and per-image placeholders", async ({ page }, testInfo) => {
  await startFullSession(page, { ready: true });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await openSettings(page);
  await switchSettingsTab(page, "Text & Images");
  const select = page.getByRole("combobox", { name: "Data saver" });
  await expect(select).toHaveValue("off");
  await select.selectOption("always");
  await expect(select).toHaveValue("always");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("owncord:settings:dataSaver")))
    .toBe(JSON.stringify("always"));
  expect(await findUnnamedControls(page.locator(".settings-pane.active"))).toEqual([]);
  await testInfo.attach("Pixel 7 data saver setting", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.locator(".settings-close-btn").click();
  const closeNavigation = page.getByRole("button", { name: "Close navigation", exact: true });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await emitWsMessage(page, {
    type: "chat_message",
    payload: {
      id: 9901,
      channel_id: 1,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Photos and a GIF — tap only what you want to load.",
      timestamp: new Date().toISOString(),
      edited_at: null,
      reply_to: null,
      reactions: [],
      attachments: [
        {
          id: "saver-photo",
          url: "/api/v1/files/saver-photo",
          filename: "holiday-photo.png",
          mime: "image/png",
          size: 524288,
        },
        {
          id: "saver-gif",
          url: "/api/v1/files/saver-gif",
          filename: "celebration.gif",
          mime: "image/gif",
          size: 2097152,
        },
      ],
    },
  });
  const row = page.getByTestId("message-9901");
  const placeholders = row.getByRole("button", { name: /Tap to load/ });
  await expect(placeholders).toHaveCount(2);
  await expect(row.locator("img")).toHaveCount(0);
  expect(await findUnnamedControls(row)).toEqual([]);
  await page.keyboard.press("Tab");
  await placeholders.first().focus();
  expect((await focusIndicator(page)).problems).toEqual([]);
  expect(
    (await textContrast(placeholders.first().locator(".data-saver-action"))).ratio,
  ).toBeGreaterThanOrEqual(Q1.text);
  await testInfo.attach("Pixel 7 chat placeholders", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await placeholders.first().click();
  await expect(row.locator('[data-data-saver="loaded"]')).toHaveCount(1);
  await expect(row.locator('[data-data-saver="waiting"]')).toHaveCount(1);
});
