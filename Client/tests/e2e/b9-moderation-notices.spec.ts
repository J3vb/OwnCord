/**
 * B9-15: moderation notices in the real shell (owner decision Q4), against
 * the mocked transport. The real server's side of the same journey (live
 * frames, reconnect, the recorded acknowledgement, recipient privacy) is in
 * fullstack/b9-moderation-notices.spec.ts.
 *
 * Accessibility evidence for the journey (Q1): accessible names, keyboard
 * operation, focus indicator and its stable location through the async
 * removal, contrast in every theme, High Contrast and a custom accent,
 * reduced motion, and reflow at the 940x500 minimum window with 20px Large
 * Font. The native NVDA/Orca review is owner-run.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  emitWsMessage,
  MOCK_CHANNELS,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  submitLogin,
  waitForWsReady,
} from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  setAppearance,
  textContrast,
  type AppearancePrefs,
} from "./support/b9-accessibility";

const NOTICES = [
  { id: 12, kind: "warning", reason: "Second: keep it civil", created_at: "2026-09-21T09:00:00Z" },
  { id: 11, kind: "warning", reason: "First: no spam links", created_at: "2026-09-20T09:00:00Z" },
];

const HISTORY = [
  {
    id: 12,
    kind: "warning",
    reason: "Second: keep it civil",
    created_at: "2026-09-21T09:00:00Z",
    expires_at: null,
    lifted_at: null,
    acknowledged_at: null,
    appealable: true,
    appeal: null,
  },
  {
    id: 9,
    kind: "removal",
    reason: "Off-topic post",
    created_at: "2026-09-19T09:00:00Z",
    expires_at: null,
    lifted_at: null,
    acknowledged_at: null,
    appealable: true,
    appeal: { id: "APL-1", state: "open" },
  },
];

const VOICE = { id: 3, name: "Lounge", type: "voice", position: 2, category: null };

/** `history: null` answers GET /users/me/moderation with a 503, so only live frames drive state. */
async function start(
  page: Page,
  opts: { ackStatus?: number; history?: unknown[] | null } = {},
): Promise<void> {
  const ackStatus = opts.ackStatus ?? 204;
  const history = opts.history === undefined ? HISTORY : opts.history;
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        {
          pattern: "/api/v1/users/me/moderation",
          method: "GET",
          status: history === null ? 503 : 200,
          body: history ?? { error: "UNAVAILABLE", message: "down" },
        },
        {
          pattern: "/api/v1/users/me/notices/",
          method: "POST",
          status: ackStatus,
          body: ackStatus === 204 ? null : { error: "INTERNAL", message: "boom" },
        },
      ],
      simulateWsFlow: true,
      readyOverrides: { notices: NOTICES, channels: [...MOCK_CHANNELS, VOICE] },
    }),
  );
  await page.goto("/");
  await signIn(page);
}

async function signIn(page: Page): Promise<void> {
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
}

/** The acknowledgement POSTs the client sent, from the mock's IPC log. */
async function ackPosts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __invokeLog: { cmd: string; args: any }[] }).__invokeLog ?? [])
      .filter((c) => c.cmd === "plugin:http|fetch")
      .map((c) => `${c.args?.clientConfig?.method ?? "GET"} ${c.args?.clientConfig?.url ?? ""}`)
      .filter((line) => line.includes("/notices/")),
  );
}

const banner = (page: Page) => page.getByRole("region", { name: "Moderation notices" });
const notice = (page: Page, id: number) => page.locator(`[data-testid='moderation-notice-${id}']`);

test.describe("B9-15 moderation notices", () => {
  test("ready warnings show oldest first, persist across navigation and leave only through Acknowledge", async ({
    page,
  }) => {
    // A static mock cannot record the acknowledgement, so its history carries
    // no warnings (the real server's does; see the fullstack spec).
    await start(page, { history: HISTORY.filter((r) => r.kind !== "warning") });
    const region = banner(page);
    await expect(region).toBeVisible();
    await expect(region.locator(".moderation-notice")).toHaveCount(2);
    await expect(region.locator(".moderation-notice").first()).toContainText(
      "First: no spam links",
    );
    await expect(notice(page, 11)).toContainText("Issued Sep 20, 2026");
    // Never a modal, nothing else dismisses it (Q4).
    await expect(page.locator("[role='dialog'][aria-modal='true']:visible")).toHaveCount(0);
    await expect(region.getByRole("button")).toHaveText([
      "Acknowledge",
      "View in Safety settings",
      "Acknowledge",
      "View in Safety settings",
    ]);
    expect(await findUnnamedControls(region)).toEqual([]);

    // It survives navigation: another channel, Escape, settings open and closed.
    await page.locator(".channel-item").filter({ hasText: "random" }).click();
    await page.keyboard.press("Escape");
    await expect(notice(page, 11)).toBeVisible();

    // Keyboard: Tab reaches Acknowledge with a visible Q1 ring; Enter records it.
    const firstAck = notice(page, 11).getByRole("button", { name: "Acknowledge" });
    await firstAck.focus();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(notice(page, 11)).toHaveCount(0);
    expect(await ackPosts(page)).toEqual([
      expect.stringMatching(/^POST .*\/users\/me\/notices\/11\/ack$/),
    ]);
    // Focus lands on the next notice's Acknowledge, not <body>.
    await expect(notice(page, 12).getByRole("button", { name: "Acknowledge" })).toBeFocused();
    await expect(region.locator("[role='status'].sr-only")).toHaveText("Warning acknowledged.");

    await page.keyboard.press("Space");
    await expect(region).toBeHidden();
    // The last one gone: focus falls back to the composer.
    await expect(page.locator("[data-testid='message-input'] textarea")).toBeFocused();
  });

  test("a failed acknowledgement keeps the notice with an error and focus in place", async ({
    page,
  }) => {
    await start(page, { ackStatus: 500 });
    const ack = notice(page, 11).getByRole("button", { name: "Acknowledge" });
    await ack.click();
    await expect(notice(page, 11).getByRole("status")).toHaveText(
      "Your acknowledgement wasn't recorded. Try again.",
    );
    await expect(notice(page, 11)).toBeVisible();
    await expect(ack).toBeFocused();
    const error = await textContrast(notice(page, 11).getByRole("status"));
    expect(error.ratio).toBeGreaterThanOrEqual(Q1.text);
  });

  test("live warning, timeout and lift: announced once, restrictions inline with the server expiry", async ({
    page,
  }) => {
    // The mock's history cannot follow the live frames, so it stays down here:
    // the real server's read agrees with its frames (fullstack spec).
    await start(page, { history: null });
    const toasts = page.locator(".toast");
    const warning = {
      type: "mod_action",
      payload: { id: 30, kind: "warning", reason: "Live one", expires_at: null },
    };
    await emitWsMessage(page, warning);
    await expect(notice(page, 30)).toContainText("Reason: Live one");
    await expect(
      toasts.filter({ hasText: "You received a warning from the moderators: Live one" }),
    ).toHaveCount(1);
    // A repeated frame neither duplicates the notice nor re-announces.
    await emitWsMessage(page, warning);
    await expect(page.locator("[data-testid='moderation-notice-30']")).toHaveCount(1);
    await expect(toasts.filter({ hasText: "Live one" })).toHaveCount(1);

    const until = new Date(Date.now() + 3_600_000).toISOString();
    await emitWsMessage(page, {
      type: "mod_action",
      payload: { id: 31, kind: "timeout", reason: "Cool off", expires_at: until },
    });
    const textarea = page.locator("[data-testid='message-input'] textarea");
    await expect(textarea).toBeDisabled();
    await expect(textarea).toHaveAttribute("placeholder", /^You can't send messages until /);
    const voice = page.locator("[data-channel-id='3']");
    await expect(voice).toHaveAttribute("aria-disabled", "true");
    await expect(voice).toHaveAttribute("title", /^You can't join voice until /);
    // Timeouts are not banners (Q4).
    await expect(page.locator("[data-testid='moderation-notice-31']")).toHaveCount(0);

    await emitWsMessage(page, {
      type: "mod_action",
      payload: { id: 0, kind: "timeout", reason: "", expires_at: null },
    });
    await expect(textarea).toBeEnabled();
    await expect(voice).not.toHaveAttribute("aria-disabled", "true");
    await expect(toasts.filter({ hasText: "Your timeout has ended." })).toHaveCount(1);
  });

  test("the banner links to the Safety tab, which shows only member-safe history", async ({
    page,
  }) => {
    await start(page);
    await notice(page, 11).getByRole("button", { name: "View in Safety settings" }).click();
    const overlay = page.locator("[data-testid='settings-overlay']");
    await expect(overlay).toHaveClass(/open/);
    await expect(page.getByRole("tab", { name: "Safety" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const pane = page.locator(".safety-tab");
    await expect(pane).toContainText("You have no active restrictions.");
    await expect(pane.locator(".safety-history-row")).toHaveCount(2);
    await expect(page.locator("[data-testid='safety-history-9']")).toContainText("Message removed");
    await expect(page.locator("[data-testid='safety-history-9']")).toContainText("Appeal: open");
    expect(await findUnnamedControls(pane)).toEqual([]);
    // Escape closes settings and the notices are still there.
    await page.keyboard.press("Escape");
    await expect(overlay).not.toHaveClass(/open/);
    await expect(notice(page, 11)).toBeVisible();
  });

  test("contrast holds in every theme, High Contrast and a custom accent", async ({ page }) => {
    await start(page);
    const matrix: AppearancePrefs[] = [
      { theme: "dark" },
      { theme: "midnight" },
      { theme: "neon-glow" },
      { theme: "light" },
      { theme: "dark", highContrast: true },
      { theme: "light", accent: "#fee75c" }, // below 3:1 on light: falls back (Q8)
    ];
    const rows: string[] = [];
    for (const prefs of matrix) {
      await setAppearance(page, prefs);
      await signIn(page);
      const first = notice(page, 11);
      await expect(first).toBeVisible();
      const parts = {
        title: first.locator(".moderation-notice-title strong"),
        date: first.locator(".moderation-notice-date"),
        reason: first.locator(".moderation-notice-reason"),
        ack: first.getByRole("button", { name: "Acknowledge" }),
        link: first.getByRole("button", { name: "View in Safety settings" }),
      };
      for (const [name, locator] of Object.entries(parts)) {
        const { ratio } = await textContrast(locator);
        rows.push(`${JSON.stringify(prefs)} ${name} ${ratio.toFixed(2)}`);
        expect(ratio, `${name} in ${JSON.stringify(prefs)}`).toBeGreaterThanOrEqual(Q1.text);
      }
      // Reach both by keyboard, so :focus-visible draws the ring.
      await parts.ack.focus();
      await page.keyboard.press("Tab");
      await expect(parts.link).toBeFocused();
      expect((await focusIndicator(page)).problems, `link ${JSON.stringify(prefs)}`).toEqual([]);
      await page.keyboard.press("Shift+Tab");
      await expect(parts.ack).toBeFocused();
      expect((await focusIndicator(page)).problems, `ack ${JSON.stringify(prefs)}`).toEqual([]);
    }
    await test
      .info()
      .attach("b9-15-contrast.txt", { body: rows.join("\n"), contentType: "text/plain" });
  });

  test("reflows at 940x500 with 20px Large Font and needs no motion", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 500 });
    await start(page);
    await setAppearance(page, { fontSize: 20, largeFont: true, reducedMotion: true });
    await signIn(page);
    const region = banner(page);
    await expect(region).toBeVisible();
    expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    // Both notices' controls stay reachable (the banner scrolls, the app does not clip them).
    for (const id of [11, 12]) {
      const ack = notice(page, id).getByRole("button", { name: "Acknowledge" });
      await ack.focus();
      await expect(ack).toBeInViewport();
    }
    // The composer below is still on screen.
    await expect(page.locator("[data-testid='message-input'] textarea")).toBeInViewport();
    const motion = await notice(page, 11).evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.animationName}|${cs.transitionDuration}`;
    });
    expect(motion).toMatch(/^none\|0s/);
    await page.screenshot({ path: test.info().outputPath("b9-15-reflow-940x500.png") });
  });
});
