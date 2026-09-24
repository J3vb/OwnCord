/**
 * B9-9: once the viewer has consented, approved rich content must show honest,
 * typed states — loading, loaded, refused, unavailable, and a bounded retry —
 * with keyboard-operable controls, no motion that a reduced-motion setting does
 * not drop, and a layout that holds at the minimum desktop window.
 *
 * The mocked suite observes rendered UI and outgoing broker IPC
 * (`window.__invokeLog`); the real broker is never reached. Every
 * `ExternalContentFailure` variant is exercised by throwing it from the native
 * mock, which the broker wrapper classifies exactly as the real IPC would.
 * NVDA/Orca recordings are owner-run and not claimed here.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  grantExternalConsent,
  MOCK_LOGIN_RESPONSE,
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
const LINK_MESSAGE = 301;

/** A real 1×1 PNG, so a retried image has valid bytes for the <img> to load. */
const PNG_BYTES = [
  ...Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
];

const RICH_MESSAGE = {
  id: LINK_MESSAGE,
  channel_id: 1,
  user: { id: 2, username: "otheruser", avatar: "" },
  content: `Look ${LINK} ${IMAGE}`,
  timestamp: "2026-03-15T10:00:00Z",
  edited_at: null,
  attachments: [],
  reactions: [],
  reply_to: null,
  pinned: false,
  deleted: false,
};

interface ExternalOption {
  readonly preview?: Record<string, Record<string, unknown> | string>;
  readonly image?: Record<string, number[] | string>;
}

async function mockSession(
  page: Page,
  externalContent: ExternalOption = {},
  gifTrending?: { readonly status: number; readonly body: unknown },
): Promise<void> {
  const httpRoutes: Array<{ pattern: string; status: number; body: unknown }> = [
    { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
    { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
    { pattern: "/messages", status: 200, body: { messages: [RICH_MESSAGE], has_more: false } },
    { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
  ];
  if (gifTrending !== undefined) {
    httpRoutes.push({ pattern: "/api/v1/gif/trending", ...gifTrending });
  }
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  await page.addInitScript(
    buildTauriMockScript({ httpRoutes, simulateWsFlow: true, externalContent }),
  );
  await page.goto("/");
}

const card = (page: Page): Locator => page.locator(`[data-testid='message-${LINK_MESSAGE}']`);

const linkCard = (page: Page): Locator => card(page).locator(".msg-embed-link");
const imageWrap = (page: Page): Locator => card(page).locator(".msg-image");

/** Animations still moving inside `root` (a reduced-motion 0.01 ms one is not). */
const runningMotion = (root: Locator): Promise<number> =>
  root.evaluate(
    (el) =>
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration) > 1)
        .length,
  );

test.beforeEach(({ page }) => grantExternalConsent(page));

test.describe("B9-9 rich-content states", () => {
  test("a successful preview loads, and a refused one shows a typed failed state", async ({
    page,
  }) => {
    // The preview is served; the image has no mock entry, so the broker
    // refuses it as a transient "unavailable" (the retryable class).
    await mockSession(page, {
      preview: {
        [LINK]: { title: "A story", description: "Story text", siteName: null, image: null },
      },
    });
    await navigateToMainPageReady(page);

    // Loaded preview: typed "loaded", retry hidden.
    const link = linkCard(page);
    await expect(link).toHaveAttribute("data-embed-state", "loaded");
    await expect(link.locator(".msg-embed-link-title")).toHaveText("A story");
    await expect(link.locator(".msg-embed-retry")).toBeHidden();

    // Refused image: typed "failed", the failure line names the state, and the
    // information does not depend on colour alone.
    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "failed");
    const status = imageWrap(page).locator(".msg-media-fallback-text");
    await expect(status).toHaveText("Image unavailable");
    await expect(imageWrap(page).locator(".msg-media-retry")).toBeVisible();
  });

  for (const failure of [
    "blocked-destination",
    "too-many-redirects",
    "oversized",
    "wrong-type",
    "expired-handle",
    "unavailable",
  ] as const) {
    test(`a ${failure} preview refusal never reads as a loaded card`, async ({ page }) => {
      await mockSession(page, { preview: { [LINK]: failure } });
      await navigateToMainPageReady(page);

      const link = linkCard(page);
      await expect(link).toHaveAttribute("data-embed-state", "failed");
      await expect(link).toHaveAttribute("data-embed-failure", failure);
      await expect(link.locator(".msg-embed-status")).toBeVisible();
      await expect(link).not.toHaveAttribute("data-embed-state", "loaded");

      // Only a transient "unavailable" answer is retryable (no automatic retry
      // of a policy refusal), and a retry re-asks the broker.
      const retry = link.locator(".msg-embed-retry");
      if (failure === "unavailable") {
        await expect(retry).toBeVisible();
        await retry.click();
        await expect(link).toHaveAttribute("data-embed-state", "failed");
      } else {
        await expect(retry).toBeHidden();
      }
    });
  }

  test("a policy refusal of the inline image offers no retry and is not a Tab stop", async ({
    page,
  }) => {
    await mockSession(page, { image: { [`url:${IMAGE}`]: "blocked-destination" } });
    await navigateToMainPageReady(page);

    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "failed");
    // A policy refusal is not retryable (matches the preview path and the plan).
    await expect(imageWrap(page).locator(".msg-media-retry")).toBeHidden();
    const img = imageWrap(page).locator("img");
    // The refused image stays hidden, so it is neither shown nor reachable as
    // the "Open image" control that would open an empty lightbox.
    await expect(img).toBeHidden();
    expect(await img.evaluate((el) => (el as HTMLImageElement).tabIndex)).toBe(0);
    const focusable = await img.evaluate((el) => {
      el.focus();
      return document.activeElement === el;
    });
    // A hidden element cannot take focus, so it never becomes the Tab stop.
    expect(focusable).toBe(false);
    await expect(imageWrap(page).locator(".msg-media-fallback-text")).toHaveText(
      "Image unavailable",
    );
  });

  test("a transient image failure is retried on demand through the broker", async ({ page }) => {
    // First ask is refused; the second is served. The mock's image map is keyed
    // by URL, so toggling it between renders simulates the broker recovering.
    await mockSession(page, {});
    await navigateToMainPageReady(page);
    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "failed");

    const before = await brokerImageCalls(page);
    await page.evaluate(
      ({ image, bytes }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__mockExternalImage[`url:${image}`] = bytes;
      },
      { image: IMAGE, bytes: PNG_BYTES },
    );

    await imageWrap(page).locator(".msg-media-retry").click();
    await expect.poll(() => brokerImageCalls(page)).toBeGreaterThan(before);
  });

  test("a consent reset re-conceals the failed image and no stale retry can fetch", async ({
    page,
  }) => {
    await mockSession(page, {});
    await navigateToMainPageReady(page);
    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "failed");
    await expect(imageWrap(page).locator(".msg-media-retry")).toBeVisible();
    const before = await brokerImageCalls(page);

    // B9-8 preserved: the Text & Images reset revokes the grant and re-conceals
    // the item, so the retry control is gone and no further broker call occurs.
    await openSettings(page);
    await switchSettingsTab(page, "Text & Images");
    await page.getByRole("button", { name: "Reset external content consent" }).click();
    await page.keyboard.press("Escape");
    await expect(card(page).locator(".msg-embed-concealed")).toHaveCount(2);
    await expect(imageWrap(page)).toHaveCount(0);

    await page.waitForTimeout(300);
    expect(await brokerImageCalls(page)).toBe(before);
  });

  test("an inline image is keyboard operable and the lightbox contains then restores focus", async ({
    page,
  }) => {
    await mockSession(page, { image: { [`url:${IMAGE}`]: PNG_BYTES } });
    await navigateToMainPageReady(page);

    const img = imageWrap(page).locator("img");
    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "loaded");
    await expect(img).toHaveAttribute("role", "button");
    await expect(img).toHaveAttribute("aria-label", "Open image from cdn.example");

    await img.focus();
    await expect(img).toBeFocused();
    await page.keyboard.press("Enter");
    const lightbox = page.locator(".image-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator(".image-lightbox-close")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    await expect(img).toBeFocused();
  });

  test("the retry control is keyboard operable with an accessible name", async ({ page }) => {
    await mockSession(page, {});
    await navigateToMainPageReady(page);

    const retry = imageWrap(page).locator(".msg-media-retry");
    await expect(retry).toHaveAttribute("aria-label", "Retry image");
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press("Enter");
    // Activating it re-asks, so the failed state is re-entered at least once.
    await expect(imageWrap(page)).toHaveAttribute("data-media-state", "failed");
  });

  test("the rich-content controls are named and pass contrast at Q1 thresholds", async ({
    page,
  }, testInfo) => {
    await mockSession(page, {});
    await setAppearance(page, { theme: "dark", highContrast: false, accent: null });
    await navigateToMainPageReady(page);

    const measured: Record<string, number> = {};
    const failures: string[] = [];
    const check = async (name: string, ratio: number): Promise<void> => {
      measured[name] = Number(ratio.toFixed(2));
      if (ratio < Q1.text) failures.push(`${name} ${ratio.toFixed(2)} < ${Q1.text}`);
    };

    expect(await findUnnamedControls(imageWrap(page))).toEqual([]);
    await check(
      "failure line",
      (await textContrast(imageWrap(page).locator(".msg-media-fallback-text"))).ratio,
    );
    await check("retry", (await textContrast(imageWrap(page).locator(".msg-media-retry"))).ratio);

    // Keyboard focus (Tab) obtains :focus-visible, which a bare .focus() may not.
    await imageWrap(page).locator(".msg-media-retry").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ring = await focusIndicator(page);
    measured["focus retry"] = Number(ring.ratio.toFixed(2));
    for (const p of ring.problems) failures.push(`focus retry: ${p}`);

    await testInfo.attach("rich-content-contrast.json", {
      body: JSON.stringify(measured, null, 2),
      contentType: "application/json",
    });
    expect(failures).toEqual([]);
  });

  test("a transient GIF failure is a typed retry, not the empty state", async ({ page }) => {
    // The server's GIF proxy answers 502; the picker must not read as
    // "No GIFs found" and must offer a bounded retry.
    await mockSession(page, {}, { status: 502, body: { error: "BAD_GATEWAY" } });
    await navigateToMainPageReady(page);
    await page.locator(".gif-btn").click();
    const picker = page.locator(".gif-picker");
    await expect(picker).toBeVisible();

    await expect(picker.locator(".gp-empty")).toHaveCount(0);
    await expect(picker.locator(".msg-media-fallback-text")).toHaveText("Couldn't load GIFs");
    const retry = picker.locator(".msg-media-retry");
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute("aria-label", "Retry");

    // Activating the retry re-queries (the proxy answers 502 again) and
    // keyboard focus moves to the search field rather than falling to <body>
    // when the retry is replaced. The loading line may flash past, so assert
    // the durable outcome (the re-asked failure) and the focus, not the flash.
    await retry.focus();
    await retry.click();
    await expect(picker.locator(".gp-search")).toBeFocused();
    await expect(picker.locator(".msg-media-fallback-text")).toHaveText("Couldn't load GIFs");
    await expect(picker.locator(".msg-media-retry")).toBeVisible();
  });

  test("no required motion under reduced motion; GIF controls stay present", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mockSession(page, {});
    await setAppearance(page, { reducedMotion: true, syncOsMotion: false });
    await navigateToMainPageReady(page);

    expect(await runningMotion(linkCard(page))).toBe(0);
    expect(await runningMotion(imageWrap(page))).toBe(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await navigateToMainPageReady(page);
    expect(await runningMotion(imageWrap(page))).toBe(0);
  });

  for (const [label, scale] of [
    ["20px Large Font", 1],
    ["20px Large Font at 200% scale", 2],
  ] as const) {
    test.describe(label, () => {
      test.use({ viewport: { width: 940, height: 500 }, deviceScaleFactor: scale });

      test(`reflows at the 940x500 minimum window (${label})`, async ({ page }, testInfo) => {
        await mockSession(page, {});
        await setAppearance(page, { fontSize: 20, largeFont: true });
        await navigateToMainPageReady(page);

        const retry = imageWrap(page).locator(".msg-media-retry");
        await retry.scrollIntoViewIfNeeded();
        await expect(retry).toBeInViewport();
        expect(await retry.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(
          await retry.evaluate((el) => (el as HTMLElement).offsetHeight),
        ).toBeGreaterThanOrEqual(24);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(
          0,
        );
        await testInfo.attach(`rich-content-940x500-${label.replaceAll(/\W+/g, "-")}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });
    });
  }
});

/** Count the broker's external_image invocations (the URL is never logged). */
async function brokerImageCalls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).__invokeLog as Array<{ cmd: string }>).filter(
        (e) => e.cmd === "external_image",
      ).length,
  );
}
