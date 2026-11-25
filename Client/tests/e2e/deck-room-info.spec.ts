/**
 * Command Deck's room Info block under Buddies: the voice room you are in,
 * shown only while you are in a server voice room, with five rows, or one
 * summary line in a short window.
 *
 * The scene's voice handlers send no voice_token, so a join stays at
 * `joining`; `enterCall` marks it connected through the `__owncord` seam every
 * build exposes. The steps that write a store directly (a voice config, a
 * sample, a key notice, a degraded call) go through the dev server's module
 * graph and skip on the production preview.
 *
 * Screenshots for the hand check: room-info-1333x934.png (the column in a
 * call), room-info-1333x934-20px.png (the same at 20 px text) and
 * room-info-1333x600.png (the compact form).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { joinVoiceChannelByName } from "./helpers";
import { contrastMeter, findUnnamedControls } from "./support/accessibility";
import { attachShot, expectReflowNoWorse, seedFontSize } from "./support/deckHandCheck";
import { DECK_VIEWPORT, startDeckScene, type SceneOptions } from "./support/deckTreeScene";
import { auditReflow, ZOOM_VIEWPORT, type ReflowAudit } from "./support/zoom-reflow";

const LOUNGE = 6;

/**
 * The reflow audit of the column overlay at 640x400 in a call with the stats
 * pane open, on dev at 23ac90ac: the same scene and steps, before Info
 * existed. dev was clean: every value is 0 or empty. Entries are compared by
 * count, since the audit labels them by class and text.
 */
const DEV_BASELINE: ReflowAudit = {
  pageOverflow: 0,
  clipped: [],
  covered: [],
  twoDimensional: [],
};

const info = (page: Page): Locator => page.getByTestId("room-info");
const rowValue = (page: Page, name: string): Locator =>
  info(page).locator(`[data-testid="room-info-${name}"] > dd`);
const summary = (page: Page): Locator => page.getByTestId("room-info-summary");

/** The drawn text of an element: its text without the sr-only parts or hidden ones. */
function drawnText(el: Locator): Promise<string> {
  return el.evaluate((root) => {
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof HTMLElement)) return "";
      if (node.hidden || node.classList.contains("sr-only")) return "";
      return [...node.childNodes].map(walk).join("");
    };
    return walk(root);
  });
}

const spokenText = (el: Locator): Promise<string[]> =>
  el.locator(".sr-only").evaluateAll((els) => els.map((e) => e.textContent ?? ""));

async function expectDrawn(el: Locator, text: string): Promise<void> {
  await expect.poll(() => drawnText(el)).toBe(text);
}

/** Joins Lounge, then marks the call connected, as the room's status writer would. */
async function enterCall(page: Page): Promise<void> {
  await joinVoiceChannelByName(page, "Lounge");
  await page.evaluate(() =>
    (
      window as unknown as { __owncord: { setVoiceStatus(s: string): void } }
    ).__owncord.setVoiceStatus("connected"),
  );
  await expect(info(page)).toBeVisible();
}

async function leaveCall(page: Page): Promise<void> {
  await page.locator("[data-testid='voice-widget'] button[aria-label='Disconnect']").click();
  await expect(page.locator("[data-testid='voice-widget']")).not.toHaveClass(/visible/);
}

/** Calls an export of a dev-graph module with `args`. False on the preview build. */
async function devCall(page: Page, url: string, name: string, args: unknown[]): Promise<boolean> {
  return page.evaluate(
    async ([u, n, a]) => {
      try {
        const mod = (await import(/* @vite-ignore */ u)) as Record<
          string,
          (...rest: unknown[]) => void
        >;
        mod[n]!(...a);
        return true;
      } catch {
        return false;
      }
    },
    [url, name, args] as const,
  );
}

const VOICE_STORE = "/src/stores/voice.store.ts";
const LIVE_STATS = "/src/lib/voice/liveStats.ts";

const sample = (rtt: number) => ({
  rtt,
  quality: "excellent",
  outRate: 0,
  inRate: 0,
  outPackets: 0,
  inPackets: 0,
  totalUp: 0,
  totalDown: 0,
  loss: 0,
  jitter: 0,
  available: true,
});

const mediumConfig = {
  channel_id: LOUNGE,
  quality: "medium",
  bitrate: 64000,
  threshold_mode: "auto",
  mixing_threshold: 0,
  top_speakers: 0,
  max_users: 8,
};

async function boot(page: Page, options: SceneOptions & { fontSize?: number } = {}) {
  if (options.fontSize !== undefined) await seedFontSize(page, options.fontSize);
  await startDeckScene(page, { theme: "gunmetal", ...options });
}

test.describe("Command Deck room Info", () => {
  test("shows the room you are in, and hides out of a call", async ({ page }) => {
    await boot(page);
    await expect(page.locator("#member-column")).toBeVisible();
    await expect(info(page)).toBeHidden();

    await enterCall(page);
    await expect(info(page).locator(".room-info-title")).toHaveText("Info · Lounge");
    await expectDrawn(rowValue(page, "users"), "3 / 8");
    await expectDrawn(rowValue(page, "audio"), "Not known");
    await expectDrawn(rowValue(page, "security"), "Secured");
    await expectDrawn(rowValue(page, "streams"), "Rin · screen");
    await expectDrawn(rowValue(page, "quality"), "Not measured");
    // Info follows Buddies' scroller, inside the column.
    expect(
      await info(page).evaluate(
        (el) => el.previousElementSibling?.classList.contains("member-column-body") === true,
      ),
    ).toBe(true);
    await expect(summary(page)).toBeHidden();

    await leaveCall(page);
    await expect(info(page)).toBeHidden();
  });

  test("follows the room's voice config, a connected sample, a key notice and a degraded call", async ({
    page,
  }) => {
    await boot(page);
    await enterCall(page);
    test.skip(
      !(await devCall(page, VOICE_STORE, "setVoiceConfig", [mediumConfig])),
      "needs the dev server's module graph",
    );
    await expectDrawn(rowValue(page, "audio"), "Medium · 64 kbps");

    expect(await devCall(page, LIVE_STATS, "writeLiveStats", [sample(18), true])).toBe(true);
    await expectDrawn(rowValue(page, "quality"), "Good · 18 ms");

    // A fresh call, in a short window: a mismatch replaces Secured (edge case 2).
    await leaveCall(page);
    await enterCall(page);
    await page.setViewportSize({ width: 1333, height: 600 });
    expect(
      await devCall(page, VOICE_STORE, "setPeerVerification", [
        { userId: 2, status: "mismatch", safetyNumber: null, sessionFingerprint: null },
      ]),
    ).toBe(true);
    await expect(summary(page)).toBeVisible();
    await expect(info(page).locator(".room-info-rows")).toBeHidden();
    await expectDrawn(summary(page), "3/8 · Blocked");
    const spoken = (await spokenText(summary(page))).join(" ");
    expect(spoken).toContain("key does not match");
    expect(spoken).not.toContain("Secured");

    // A fresh call, last: a degraded call outranks every key notice (edge case 1).
    await page.setViewportSize(DECK_VIEWPORT);
    await leaveCall(page);
    await enterCall(page);
    await expectDrawn(rowValue(page, "security"), "Secured");
    expect(await devCall(page, VOICE_STORE, "setEncryptionDegraded", [true])).toBe(true);
    await expectDrawn(rowValue(page, "security"), "Unsecured");
    await expect(info(page).locator(".room-info-light")).toHaveAttribute("data-level", "bad");

    await leaveCall(page);
    await expect(info(page)).toBeHidden();
  });

  test("at 1333x600 the compact summary reads 3/8 · Secured", async ({ page }) => {
    await boot(page, { viewport: { width: 1333, height: 600 } });
    await enterCall(page);
    await expect(summary(page)).toBeVisible();
    await expect(info(page).locator(".room-info-rows")).toBeHidden();
    // The prefix is out of sight, and the region is still named "Info · Lounge".
    expect(
      await info(page)
        .locator(".room-info-prefix")
        .evaluate((el) => getComputedStyle(el).clip),
    ).toBe("rect(0px, 0px, 0px, 0px)");
    await expect(page.getByRole("region", { name: "Info · Lounge" })).toBeVisible();
    await expectDrawn(summary(page), "3/8 · Secured");
    const box = (await info(page).boundingBox())!;
    expect(Math.abs(box.height - 63)).toBeLessThanOrEqual(0.5);
  });

  for (const highContrast of [false, true]) {
    test(`contrast and names in Gunmetal${highContrast ? " with High Contrast" : ""}`, async ({
      page,
    }, testInfo) => {
      await boot(page, { highContrast });
      await enterCall(page);
      const meter = contrastMeter(page);
      await meter.measure("title", info(page).locator(".room-info-title"));
      for (const name of ["users", "audio", "security", "quality", "streams"]) {
        const row = info(page).locator(`[data-testid="room-info-${name}"]`);
        await meter.measure(`label ${name}`, row.locator(".room-info-label"));
        const parts = row.locator("dd > .room-info-word:not([hidden]), dd > .room-info-detail");
        for (const part of await parts.all()) {
          if ((await part.textContent()) === "") continue;
          await meter.measure(`value ${name}`, part);
        }
      }
      await testInfo.attach(`room-info-contrast-gunmetal${highContrast ? "-hc" : ""}.json`, {
        body: JSON.stringify(meter.measured, null, 2),
        contentType: "application/json",
      });
      expect(meter.failures).toEqual([]);
      // The repository's structural accessibility check: nothing in Info is an
      // unnamed control, and nothing in it takes focus.
      expect(await findUnnamedControls(info(page))).toEqual([]);
      expect(await info(page).locator("button, a, input, [tabindex]").count()).toBe(0);
      expect(await info(page).getAttribute("aria-live")).toBeNull();
      await expect(page.getByRole("region", { name: "Info · Lounge" })).toBeVisible();
    });
  }

  test("Buddies still reaches its last row with Info showing", async ({ page }) => {
    const members = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      username: i === 0 ? "testuser" : `user${String(i + 1).padStart(2, "0")}`,
      avatar: "",
      status: "online",
      role: i === 0 ? "admin" : "member",
    }));
    await boot(page, { members });
    await enterCall(page);
    const body = page.locator("#member-column .member-column-body");
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const last = page.locator("#member-column").getByTestId("member-60");
    await expect(last).toBeVisible();
    const rowBottom = await last.evaluate((el) => el.getBoundingClientRect().bottom);
    const infoTop = await info(page).evaluate((el) => el.getBoundingClientRect().top);
    expect(rowBottom).toBeLessThanOrEqual(infoTop + 0.5);
  });

  test("the overlay at 640x400 in a call, with the stats pane open, reflows no worse than dev", async ({
    page,
  }) => {
    await boot(page);
    await enterCall(page);
    await page.setViewportSize(ZOOM_VIEWPORT);
    const signal = page.locator("[data-testid='voice-widget'] [data-testid='vw-signal']");
    await signal.click();
    await expect(signal).toHaveAttribute("aria-expanded", "true");
    const column = page.locator("#member-column");
    if (!(await column.isVisible())) await page.getByTestId("member-list-toggle").click();
    await expect(column).toBeVisible();
    await expect(summary(page)).toBeVisible();
    expectReflowNoWorse(test.info(), await auditReflow(column), DEV_BASELINE);
  });

  test("screenshots for the hand check", async ({ page }, testInfo) => {
    await boot(page);
    await enterCall(page);
    await devCall(page, VOICE_STORE, "setVoiceConfig", [mediumConfig]);
    await devCall(page, LIVE_STATS, "writeLiveStats", [sample(18), true]);
    await attachShot(page, testInfo, "room-info-1333x934.png");
    await page.setViewportSize({ width: 1333, height: 600 });
    await expect(summary(page)).toBeVisible();
    await attachShot(page, testInfo, "room-info-1333x600.png");
  });

  test("screenshot at 20 px text", async ({ page }, testInfo) => {
    await boot(page, { fontSize: 20 });
    await enterCall(page);
    const box = (await info(page).boundingBox())!;
    expect(Math.abs(box.height - 178.5)).toBeLessThanOrEqual(0.5);
    await attachShot(page, testInfo, "room-info-1333x934-20px.png");
  });
});
