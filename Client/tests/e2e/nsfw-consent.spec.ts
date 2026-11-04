/**
 * B9-7: NSFW consent is an authoritative pre-load gate.
 *
 * The journey from the plan — enter a labelled channel, decline, fail the
 * acknowledgement, accept, revoke, and follow a second device — in the real
 * shell, recording every first-party content request and every native
 * external-content broker invocation (`window.__invokeLog`) so "nothing loads
 * before consent" is observed rather than inferred. The Q1 checks (names,
 * keyboard, focus, contrast in every theme and High Contrast, reduced motion,
 * reflow at the 940×500 minimum window with 20 px Large Font and 200 % scale)
 * run on the gate itself. Native NVDA/Orca recordings are owner-run and not
 * claimed here.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  emitWsMessage,
  MOCK_MESSAGES,
  navigateToMainPageReady,
  ROUTE_HEALTH,
  ROUTE_LOGIN,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  setAppearance,
  textContrast,
} from "./support/accessibility";
import {
  attachScreenshot,
  contrastMatrix,
  expectControlFits,
  expectNoPageScroll,
} from "./support/a11yHarness";

/** #general (id 1, the default active channel) is labelled; #random is not. */
const CHANNELS = [
  { id: 1, name: "general", type: "text", position: 0, category: null, nsfw: true },
  { id: 2, name: "random", type: "text", position: 1, category: null },
];

async function mockSession(page: Page, ackStatus = 204): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        {
          pattern: "/nsfw-acknowledgement",
          method: "PUT",
          status: ackStatus,
          body: ackStatus === 204 ? null : { error: "INTERNAL", message: "mocked failure" },
        },
        { pattern: "/nsfw-acknowledgement", method: "DELETE", status: 204, body: null },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/pins", status: 200, body: { messages: [], has_more: false } },
      ],
      simulateWsFlow: true,
      readyOverrides: { channels: CHANNELS },
    }),
  );
  await page.goto("/");
}

/** Every content request for #general and every broker call, in order. */
async function contentTraffic(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((window as any).__invokeLog as Array<{ cmd: string; args?: any }>).flatMap(({ cmd, args }) => {
      if (cmd === "external_preview" || cmd === "external_image") return [cmd];
      if (cmd !== "plugin:http|fetch") return [];
      const url: string = args?.clientConfig?.url ?? "";
      const method: string = args?.clientConfig?.method ?? "GET";
      return /\/channels\/1\/|channel_id=1\b/.test(url)
        ? [`${method} ${url.replace(/^.*\/api\/v1/, "")}`]
        : [];
    }),
  );
}

const gate = (page: Page) => page.locator("[data-testid='nsfw-gate']");

test.describe("NSFW consent gate", () => {
  test("nothing from the channel is requested until the server confirms consent", async ({
    page,
  }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);

    await expect(gate(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "#general is age-restricted" })).toBeFocused();
    await expect(page.locator("[data-testid='message-101']")).toHaveCount(0);
    await expect(page.locator("[data-testid='message-input']")).toHaveCount(0);
    // Alternate entry point: the pins button fetches nothing behind the gate.
    await page.locator("[data-testid='pin-btn']").click();
    expect(await contentTraffic(page)).toEqual([]);

    // Accept with the keyboard: decline comes first in the tab order.
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='nsfw-gate-back']")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-testid='nsfw-gate-continue']")).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-testid='message-101']")).toBeVisible();
    await expect(gate(page)).toHaveCount(0);
    await expect(page.locator("[data-testid='nsfw-consent-bar']")).toBeVisible();
    const traffic = await contentTraffic(page);
    expect(traffic[0]).toBe("PUT /channels/1/nsfw-acknowledgement");
    expect(traffic.slice(1).some((t) => t.startsWith("GET /channels/1/messages"))).toBe(true);
  });

  test("withdrawing consent, here or on another device, unmounts the content", async ({ page }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);
    await page.locator("[data-testid='nsfw-gate-continue']").click();
    await expect(page.locator("[data-testid='message-101']")).toBeVisible();

    await page.locator("[data-testid='nsfw-consent-revoke']").click();
    await expect(gate(page)).toBeVisible();
    await expect(page.locator("[data-testid='message-101']")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "#general is age-restricted" })).toBeFocused();
    expect((await contentTraffic(page)).at(-1)).toBe("DELETE /channels/1/nsfw-acknowledgement");

    // A second device acknowledges: this one follows without a request.
    const before = (await contentTraffic(page)).length;
    await emitWsMessage(page, { type: "nsfw_ack", payload: { channel_id: 1, acknowledged: true } });
    await expect(page.locator("[data-testid='message-101']")).toBeVisible();
    expect((await contentTraffic(page)).slice(before).some((t) => t.startsWith("PUT"))).toBe(false);

    // ...and revokes: the content goes with it.
    await emitWsMessage(page, {
      type: "nsfw_ack",
      payload: { channel_id: 1, acknowledged: false },
    });
    await expect(gate(page)).toBeVisible();
    await expect(page.locator("[data-testid='message-101']")).toHaveCount(0);
  });

  test("a failed acknowledgement keeps the channel hidden and says so", async ({ page }) => {
    await mockSession(page, 500);
    await navigateToMainPageReady(page);

    await page.locator("[data-testid='nsfw-gate-continue']").click();

    await expect(page.getByRole("alert")).toContainText("could not be saved");
    await expect(page.locator("[data-testid='nsfw-gate-continue']")).toBeFocused();
    await expect(gate(page)).toBeVisible();
    expect(await contentTraffic(page)).toEqual(["PUT /channels/1/nsfw-acknowledgement"]);
  });

  test("Escape declines and leaves the channel, with nothing fetched", async ({ page }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);
    await expect(gate(page)).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(gate(page)).toHaveCount(0);
    expect(await contentTraffic(page)).toEqual([]);
    // Another channel still opens normally.
    await page.locator("[data-testid='channel-2']").click();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("random");
  });
});

test.describe("NSFW consent gate — accessibility", () => {
  for (const c of contrastMatrix({
    title: "names, focus and contrast",
    attachName: (theme, hc) => `nsfw-gate-contrast-${theme}-hc-${hc}.json`,
    boot: async (page, prefs) => {
      await mockSession(page);
      await setAppearance(page, prefs);
      await navigateToMainPageReady(page);
      await expect(gate(page)).toBeVisible();
    },
    scenario: async (page, { measure, ring }) => {
      expect(await findUnnamedControls(gate(page))).toEqual([]);
      for (const [name, selector] of [
        ["heading", ".nsfw-gate-title"],
        ["body", ".nsfw-gate-body"],
        ["scope", ".nsfw-gate-note"],
        ["decline", "[data-testid='nsfw-gate-back']"],
        ["accept", "[data-testid='nsfw-gate-continue']"],
      ] as const) {
        await measure(name, gate(page).locator(selector));
      }
      for (const name of ["back", "continue"]) {
        await page.keyboard.press("Tab");
        await ring(name);
      }
      const small = await gate(page)
        .locator("button")
        .evaluateAll((els) =>
          (els as HTMLElement[])
            .filter((el) => el.offsetWidth < 24 || el.offsetHeight < 24)
            .map((el) => el.dataset["testid"]),
        );
      expect(small).toEqual([]);
    },
  })) {
    test(c.title, c.run);
  }

  test("the withdraw bar is named, reachable and readable", async ({ page }) => {
    await mockSession(page);
    await navigateToMainPageReady(page);
    await page.locator("[data-testid='nsfw-gate-continue']").click();
    const bar = page.locator("[data-testid='nsfw-consent-bar']");
    await expect(bar).toBeVisible();

    expect(await findUnnamedControls(bar)).toEqual([]);
    for (const selector of [".nsfw-consent-bar-text", ".nsfw-consent-bar-revoke"]) {
      expect((await textContrast(bar.locator(selector))).ratio).toBeGreaterThanOrEqual(Q1.text);
    }
    const revoke = bar.locator("[data-testid='nsfw-consent-revoke']");
    expect(await revoke.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(
      24,
    );
    // Reach it with the keyboard, so :focus-visible applies as it would for a user.
    await revoke.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(revoke).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(gate(page)).toBeVisible();
  });

  test("no motion under OS or in-app reduced motion, and none required without it", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await mockSession(page);
    await navigateToMainPageReady(page);
    await expect(gate(page)).toBeVisible();
    expect(await gate(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
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
        await expect(gate(page)).toBeVisible();

        for (const control of await gate(page).locator("button").all()) {
          await expectControlFits(control);
        }
        // The heading scrolls back into view: nothing is cut off above it.
        const title = gate(page).locator(".nsfw-gate-title");
        await title.scrollIntoViewIfNeeded();
        await expect(title).toBeInViewport();
        await expectNoPageScroll(page);
        await attachScreenshot(
          testInfo,
          `nsfw-gate-940x500-${label.replaceAll(/\W+/g, "-")}.png`,
          page,
        );
      });
    });
  }
});
