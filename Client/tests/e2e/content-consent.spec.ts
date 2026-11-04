/**
 * B9-8: external content is concealed until the viewer consents on this
 * server (Q3), in the real shell against the mocked broker. Every broker
 * invocation is recorded (`window.__invokeLog`), so "nothing is fetched before
 * consent" is observed. The Q1 checks run on the concealed item and the
 * consent dialog. The native broker traffic proof is
 * tests/e2e/native/content-consent.spec.ts; NVDA/Orca recordings are
 * owner-run and not claimed here.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_MESSAGES,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
} from "./helpers";
import { findUnnamedControls, setAppearance } from "./support/accessibility";
import {
  attachScreenshot,
  contrastMatrix,
  expectControlFits,
  expectNoPageScroll,
  runningMotion,
} from "./support/a11yHarness";

const LINK = "https://news.example/story";
const IMAGE = "https://cdn.example/cat.png";
const VIDEO = "https://www.youtube.com/watch?v=abc123";

async function mockSession(page: Page, content = `See ${LINK} and ${IMAGE}`): Promise<void> {
  const [message] = MOCK_MESSAGES.messages;
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        {
          pattern: "/messages",
          status: 200,
          body: { messages: [{ ...message, content }], has_more: false },
        },
        { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      externalContent: {
        preview: {
          [LINK]: { title: "A story", description: "Story text", siteName: null, image: null },
        },
      },
    }),
  );
  await page.goto("/");
}

/** Every URL handed to the broker, in order (the empty partition rotation excluded). */
async function brokerUrls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((window as any).__invokeLog as Array<{ cmd: string; args?: any }>).flatMap(({ cmd, args }) =>
      (cmd === "external_preview" || cmd === "external_image") && args?.url
        ? [String(args.url)]
        : [],
    ),
  );
}

const loadButton = (page: Page, host: string) =>
  page.getByRole("button", { name: `Load external content from ${host}` });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Load external content on this server?" });

test.describe("external-content consent", () => {
  test("nothing reaches the broker before consent; 'Ask each time' admits one item", async ({
    page,
  }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);
    const link = loadButton(page, "news.example");
    await expect(link).toBeVisible();
    await expect(loadButton(page, "cdn.example")).toBeVisible();

    // Focus and hover grant nothing.
    await link.focus();
    await loadButton(page, "cdn.example").hover();
    expect(await brokerUrls(page)).toEqual([]);

    // Escape chooses nothing and returns focus to the item.
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("can see your IP address");
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(link).toBeFocused();
    expect(await brokerUrls(page)).toEqual([]);

    await page.keyboard.press("Enter");
    // The dialog loads lazily; Tab before it takes focus would be lost.
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("button", { name: "Ask each time" })).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("link", { name: "A story" })).toBeFocused();
    await expect(loadButton(page, "cdn.example")).toBeVisible();
    expect(await brokerUrls(page)).toEqual([LINK]);
  });

  test("'Load automatically' persists across a restart; the reset revokes it", async ({ page }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);
    await loadButton(page, "cdn.example").click();
    await dialog(page).getByRole("button", { name: "Load automatically on this server" }).click();
    await expect(page.getByRole("link", { name: "A story" })).toBeVisible();
    await expect(page.locator(".msg-embed-concealed")).toHaveCount(0);
    expect((await brokerUrls(page)).sort()).toEqual([IMAGE, LINK]);

    await page.reload();
    await navigateToMainPageReady(page);
    await expect(page.getByRole("link", { name: "A story" })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await page.getByRole("button", { name: "Reset external content consent" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Consent reset" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(loadButton(page, "news.example")).toBeVisible();
    await expect(loadButton(page, "cdn.example")).toBeVisible();

    await page.reload();
    await navigateToMainPageReady(page);
    await expect(loadButton(page, "news.example")).toBeVisible();
    expect(await brokerUrls(page)).toEqual([]);
  });

  test("YouTube playback is a separate, named, keyboard-operable step", async ({ page }) => {
    await mockSession(page, VIDEO);
    await navigateToMainPageReady(page);
    await loadButton(page, "www.youtube.com").click();
    await dialog(page).getByRole("button", { name: "Ask each time" }).click();

    const play = page.getByRole("button", { name: "Play on YouTube" });
    await expect(play).toBeVisible();
    await expect(play).toHaveAccessibleDescription("Playing connects you to YouTube directly.");
    await expect(page.locator("iframe")).toHaveCount(0);
    await play.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("iframe[title='YouTube video player']")).toBeFocused();
  });
});

test.describe("external-content consent — accessibility", () => {
  for (const c of contrastMatrix({
    title: "names, focus and contrast",
    attachName: (theme, hc) => `external-consent-contrast-${theme}-hc-${hc}.json`,
    boot: async (page, prefs) => {
      await mockSession(page);
      await setAppearance(page, prefs);
      await navigateToMainPageReady(page);
    },
    scenario: async (page, { measure, ring }) => {
      const item = page.locator(".msg-embed-concealed").first();
      await expect(item).toBeVisible();

      expect(await findUnnamedControls(item)).toEqual([]);
      await measure("item", item.locator("button"));
      await item.locator("button").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await ring("item");
      expect(
        await item.locator("button").evaluate((el) => (el as HTMLElement).offsetHeight),
      ).toBeGreaterThanOrEqual(24);

      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible();
      expect(await findUnnamedControls(dialog(page))).toEqual([]);
      await measure("dialog body", dialog(page).locator("p"));
      for (const name of ["Cancel", "Ask each time", "Load automatically on this server"]) {
        await measure(name, dialog(page).getByRole("button", { name }));
      }
      await page.keyboard.press("Escape");
    },
  })) {
    test(c.title, c.run);
  }

  test("no motion under the in-app reduced-motion setting", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mockSession(page);
    await setAppearance(page, { reducedMotion: true, syncOsMotion: false });
    await navigateToMainPageReady(page);
    const item = page.locator(".msg-embed-concealed").first();
    await item.locator("button").click();
    await expect(dialog(page)).toBeVisible();
    for (const root of [item, dialog(page)]) expect(await runningMotion(root)).toBe(0);
  });

  test("no motion under OS reduced motion; without it, none is required", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockSession(page);
    await navigateToMainPageReady(page);
    const item = page.locator(".msg-embed-concealed").first();
    await item.locator("button").click();
    await expect(dialog(page)).toBeVisible();
    for (const root of [item, dialog(page)]) expect(await runningMotion(root)).toBe(0);

    // The shared modal's decorative fade is the only motion otherwise; the
    // choice is operable at once, without waiting for it.
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await item.locator("button").click();
    await dialog(page).getByRole("button", { name: "Ask each time" }).click();
    await expect(page.getByRole("link", { name: "A story" })).toBeVisible();
  });

  for (const [label, scale] of [
    ["20px Large Font", 1],
    ["20px Large Font at 200% scale", 2],
  ] as const) {
    test.describe(label, () => {
      test.use({ viewport: { width: 940, height: 500 }, deviceScaleFactor: scale });

      test(`reflows at the 940x500 minimum window (${label})`, async ({ page }, testInfo) => {
        await mockSession(page);
        await setAppearance(page, { fontSize: 20, largeFont: true });
        await navigateToMainPageReady(page);
        const item = page.locator(".msg-embed-concealed button").first();
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeInViewport();
        await item.click();
        for (const control of await dialog(page).getByRole("button").all()) {
          await expectControlFits(control);
        }
        await expectNoPageScroll(page);
        await attachScreenshot(
          testInfo,
          `external-consent-940x500-${label.replaceAll(/\W+/g, "-")}.png`,
          page,
        );
      });
    });
  }
});
