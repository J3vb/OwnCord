/**
 * B9-8: external content is concealed until the viewer consents on this
 * server (Q3), in the real shell against the mocked broker. Every broker
 * invocation is recorded (`window.__invokeLog`), so "nothing is fetched before
 * consent" is observed. The Q1 checks run on the concealed item and the
 * consent dialog. The native broker traffic proof is
 * tests/e2e/native/b9-content-consent.spec.ts; NVDA/Orca recordings are
 * owner-run and not claimed here.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  setAppearance,
  textContrast,
} from "./support/b9-accessibility";

const LINK = "https://news.example/story";
const IMAGE = "https://cdn.example/cat.png";
const VIDEO = "https://www.youtube.com/watch?v=abc123";

async function mockSession(page: Page, content = `See ${LINK} and ${IMAGE}`): Promise<void> {
  const [message] = MOCK_MESSAGES.messages;
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
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
/** Animations still moving inside `root` (a reduced-motion 0.01 ms one is not). */
const runningMotion = (root: Locator): Promise<number> =>
  root.evaluate(
    (el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration) > 1)
        .length,
  );

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Load external content on this server?" });

test.describe("B9-8 external-content consent", () => {
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

test.describe("B9-8 external-content consent — Q1 accessibility", () => {
  for (const theme of ["dark", "neon-glow", "midnight", "light"] as const) {
    for (const highContrast of [false, true]) {
      test(`${theme}${highContrast ? " + High Contrast" : ""}: names, focus and contrast`, async ({
        page,
      }, testInfo) => {
        await mockSession(page);
        await setAppearance(page, { theme, highContrast, accent: null });
        await navigateToMainPageReady(page);
        const item = page.locator(".msg-embed-concealed").first();
        await expect(item).toBeVisible();

        const measured: Record<string, number> = {};
        const failures: string[] = [];
        const check = async (name: string, ratio: number): Promise<void> => {
          measured[name] = Number(ratio.toFixed(2));
          if (ratio < Q1.text) failures.push(`${name} ${ratio.toFixed(2)} < ${Q1.text}`);
        };
        expect(await findUnnamedControls(item)).toEqual([]);
        await check("item", (await textContrast(item.locator("button"))).ratio);
        await item.locator("button").focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await focusIndicator(page);
        measured["focus item"] = Number(ring.ratio.toFixed(2));
        for (const p of ring.problems) failures.push(`focus item: ${p}`);
        expect(
          await item.locator("button").evaluate((el) => (el as HTMLElement).offsetHeight),
        ).toBeGreaterThanOrEqual(24);

        await page.keyboard.press("Enter");
        await expect(dialog(page)).toBeVisible();
        expect(await findUnnamedControls(dialog(page))).toEqual([]);
        await check("dialog body", (await textContrast(dialog(page).locator("p"))).ratio);
        for (const name of ["Cancel", "Ask each time", "Load automatically on this server"]) {
          const button = dialog(page).getByRole("button", { name });
          await check(name, (await textContrast(button)).ratio);
        }
        await page.keyboard.press("Escape");

        await testInfo.attach(`external-consent-contrast-${theme}-hc-${highContrast}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
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
          await control.scrollIntoViewIfNeeded();
          await expect(control).toBeInViewport();
          expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(
          0,
        );
        await testInfo.attach(`external-consent-940x500-${label.replaceAll(/\W+/g, "-")}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    });
  }
});
