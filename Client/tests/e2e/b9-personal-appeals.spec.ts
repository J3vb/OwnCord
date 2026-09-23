/**
 * B9-16: filing, withdrawing and tracking an own appeal in the real shell,
 * against the mocked transport. The real server's side (duplicate and rate
 * refusals, live status, reconnect, a lapsed ban) is in
 * fullstack/b9-personal-appeals.spec.ts.
 *
 * Accessibility evidence for the journey (Q1): accessible names, keyboard
 * operation, focus indicator and its location through the async send and
 * withdrawal, announced errors and results, contrast in every theme, High
 * Contrast and a custom accent, reduced motion, and reflow at the 940x500
 * minimum window with 20px Large Font. The native NVDA/Orca review is
 * owner-run.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
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

const HISTORY = [
  {
    id: 21,
    kind: "timeout",
    reason: "Flooding the channel",
    created_at: "2026-09-21T09:00:00Z",
    expires_at: "2026-09-21T10:00:00Z",
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
    appealable: false,
    appeal: { id: "APL-1", state: "open" },
  },
];

const APPEALS = [
  {
    id: "APL-1",
    action_kind: "removal",
    action_reason: "Off-topic post",
    action_created_at: "2026-09-19T09:00:00Z",
    state: "open",
    decision_note: null,
    created_at: "2026-09-19T12:00:00Z",
    decided_at: null,
  },
  {
    id: "APL-0",
    action_kind: "warning",
    action_reason: "Rude reply",
    action_created_at: "2026-09-10T09:00:00Z",
    state: "upheld",
    decision_note: "The warning stands.",
    created_at: "2026-09-10T12:00:00Z",
    decided_at: "2026-09-11T08:00:00Z",
  },
];

async function start(page: Page, opts: { fileStatus?: number } = {}): Promise<void> {
  const fileStatus = opts.fileStatus ?? 201;
  const refusal: Record<number, unknown> = {
    409: { error: "ALREADY_APPEALED", message: "already appealed" },
    429: { error: "RATE_LIMITED", message: "too many" },
  };
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        { pattern: "/api/v1/users/me/moderation", method: "GET", status: 200, body: HISTORY },
        { pattern: "/api/v1/appeals/mine", method: "GET", status: 200, body: APPEALS },
        {
          pattern: "/api/v1/appeals/",
          method: "POST",
          status: fileStatus,
          body: fileStatus === 201 ? { id: "APL-2" } : refusal[fileStatus],
        },
        { pattern: "/api/v1/appeals/APL-1/withdraw", method: "POST", status: 204, body: null },
      ],
      simulateWsFlow: true,
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

async function openSafety(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Safety" }).click();
  const pane = page.locator(".safety-tab");
  await expect(pane.locator("[data-testid='safety-appeal-APL-1']")).toBeVisible();
  return pane;
}

/** The appeal POSTs the client sent, from the mock's IPC log. */
async function appealPosts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __invokeLog: { cmd: string; args: any }[] }).__invokeLog ?? [])
      .filter((c) => c.cmd === "plugin:http|fetch")
      .map((c) => `${c.args?.clientConfig?.method ?? "GET"} ${c.args?.clientConfig?.url ?? ""}`)
      .filter((line) => line.startsWith("POST") && line.includes("/appeals/")),
  );
}

const appealButton = (page: Page) =>
  page.getByRole("button", { name: "Appeal Timeout, Sep 21, 2026", exact: false });
const panel = (page: Page) => page.getByRole("group", { name: /^Appeal: Timeout/ });

test.describe("B9-16 personal appeals", () => {
  test("files an appeal by keyboard; the result is announced and focus lands on Appeals", async ({
    page,
  }) => {
    await start(page);
    const pane = await openSafety(page);
    // The routing disclosure and the paths with no appeal here.
    await expect(pane).toContainText("Your appeal goes only to this server's moderators.");
    await expect(pane).toContainText("Kicks can't be appealed.");
    // Eligibility is the server's: the already-appealed removal offers none.
    await expect(pane.locator(".safety-appeal-open")).toHaveCount(1);
    expect(await findUnnamedControls(pane)).toEqual([]);

    // Arrive by keyboard, so :focus-visible draws the ring.
    await appealButton(page).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(appealButton(page)).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText("Reason: Flooding the channel");
    const body = page.getByRole("textbox", { name: /Why should the moderators reconsider/ });
    await expect(body).toBeFocused();
    await page.keyboard.type("I was quoting the rules.");
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send appeal" });
    await expect(send).toBeFocused();
    expect(await findUnnamedControls(panel(page))).toEqual([]);
    await page.keyboard.press("Enter");

    await expect(panel(page)).toBeHidden();
    await expect(pane.locator(".safety-appeals > [role='status'].sr-only")).toHaveText(
      "Appeal sent. Its status appears under Appeals.",
    );
    await expect(page.getByRole("heading", { name: "Appeals" })).toBeFocused();
    expect(await appealPosts(page)).toEqual([
      expect.stringMatching(/^POST .*\/api\/v1\/appeals\/$/),
    ]);
  });

  test("a refused appeal keeps the draft, alerts, and leaves focus on Send; Cancel returns to Appeal", async ({
    page,
  }) => {
    await start(page, { fileStatus: 429 });
    await openSafety(page);
    await appealButton(page).click();
    const body = page.locator("#safety-appeal-body");
    await body.fill("Please look again.");
    const send = page.getByRole("button", { name: "Send appeal" });
    await send.focus();
    await page.keyboard.press("Enter");
    const alert = panel(page).getByRole("alert");
    await expect(alert).toHaveText("You've filed 3 appeals in the last 24 hours. Try again later.");
    await expect(send).toBeFocused();
    await expect(body).toHaveValue("Please look again.");
    expect((await textContrast(alert)).ratio).toBeGreaterThanOrEqual(Q1.text);
    // No automatic resubmission.
    await page.waitForTimeout(500);
    expect(await appealPosts(page)).toHaveLength(1);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(panel(page)).toBeHidden();
    await expect(appealButton(page)).toBeFocused();
  });

  test("tracks each appeal's status and withdraws after a confirmation", async ({ page }) => {
    await start(page);
    const pane = await openSafety(page);
    const open = pane.locator("[data-testid='safety-appeal-APL-1']");
    const decided = pane.locator("[data-testid='safety-appeal-APL-0']");
    await expect(open).toContainText("Status: open");
    await expect(decided).toContainText("Status: upheld");
    await expect(decided).toContainText("Moderator's note: The warning stands.");
    // Only an open or assigned appeal can be withdrawn.
    await expect(decided.getByRole("button")).toHaveCount(0);

    const withdraw = open.getByRole("button", { name: /^Withdraw appeal \(Message removed/ });
    await withdraw.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("group", { name: /^Withdraw your appeal/ });
    await expect(confirm).toContainText("You can't appeal this action again after withdrawing.");
    const confirmButton = confirm.getByRole("button", { name: "Withdraw appeal" });
    await expect(confirmButton).toBeFocused();
    expect(await appealPosts(page)).toEqual([]);
    await page.keyboard.press("Tab");
    await expect(confirm.getByRole("button", { name: "Keep appeal" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(confirm).toBeHidden();
    await expect(pane.locator(".safety-appeals > [role='status'].sr-only")).toHaveText(
      "Appeal withdrawn.",
    );
    await expect(page.getByRole("heading", { name: "Appeals" })).toBeFocused();
    expect(await appealPosts(page)).toEqual([
      expect.stringMatching(/^POST .*\/api\/v1\/appeals\/APL-1\/withdraw$/),
    ]);
  });

  test("contrast and focus hold in every theme, High Contrast and a custom accent", async ({
    page,
  }) => {
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
      const pane = await openSafety(page);
      await appealButton(page).click();
      const parts = {
        appealsRow: pane.locator("[data-testid='safety-appeal-APL-0'] .setting-desc").first(),
        withdraw: pane.getByRole("button", { name: /^Withdraw appeal \(/ }),
        title: panel(page).locator(".safety-appeal-title"),
        reason: panel(page).locator(".setting-desc").first(),
        label: panel(page).locator("label"),
        hint: page.locator("#safety-appeal-body-hint"),
        send: page.getByRole("button", { name: "Send appeal" }),
        cancel: page.getByRole("button", { name: "Cancel" }),
      };
      for (const [name, locator] of Object.entries(parts)) {
        const { ratio } = await textContrast(locator);
        rows.push(`${JSON.stringify(prefs)} ${name} ${ratio.toFixed(2)}`);
        expect(ratio, `${name} in ${JSON.stringify(prefs)}`).toBeGreaterThanOrEqual(Q1.text);
      }
      // Reach each by keyboard, so :focus-visible draws the ring.
      await page.locator("#safety-appeal-body").focus();
      for (const name of ["body", "send", "cancel"]) {
        expect((await focusIndicator(page)).problems, `${name} ${JSON.stringify(prefs)}`).toEqual(
          [],
        );
        await page.keyboard.press("Tab");
      }
      await page.keyboard.press("Escape"); // closes settings for the next theme
    }
    await test
      .info()
      .attach("b9-16-contrast.txt", { body: rows.join("\n"), contentType: "text/plain" });
  });

  test("reflows at 940x500 with 20px Large Font and needs no motion", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 500 });
    await start(page);
    await setAppearance(page, { fontSize: 20, largeFont: true, reducedMotion: true });
    await signIn(page);
    const pane = await openSafety(page);
    await appealButton(page).click();
    expect(await pane.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    for (const control of [
      page.locator("#safety-appeal-body"),
      page.getByRole("button", { name: "Send appeal" }),
      page.getByRole("button", { name: "Cancel" }),
      pane.getByRole("button", { name: /^Withdraw appeal \(/ }),
    ]) {
      await control.focus();
      await expect(control).toBeInViewport();
    }
    const motion = await panel(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.animationName}|${cs.transitionDuration}`;
    });
    expect(motion).toMatch(/^none\|0s/);
    await page.screenshot({ path: test.info().outputPath("b9-16-reflow-940x500.png") });
  });
});
