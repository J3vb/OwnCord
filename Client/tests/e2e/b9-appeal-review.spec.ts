import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE, submitLogin, waitForWsReady } from "./helpers";
import {
  Q1,
  findUnnamedControls,
  focusIndicator,
  setAppearance,
  textContrast,
  type AppearancePrefs,
} from "./support/b9-accessibility";

// ---------------------------------------------------------------------------
// B9-17: the Moderation Center's Appeals tab against the owner's Q1 checks —
// keyboard, names, errors, targets, contrast in every theme and High
// Contrast, motion, and reflow at 940x500 with 20 px Large Font.
//
// The server is mocked with two appeals from otheruser (id 2): one held by
// the signed-in moderator (testuser, id 1) with its decision form on screen,
// and one already overturned. Refusals, races, role loss and the appellant's
// own view run against the real server in
// tests/e2e/fullstack/b9-appeal-review.spec.ts. Synthetic content only.
// ---------------------------------------------------------------------------

const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;
const HELD = "a".repeat(32);
const DONE = "d".repeat(32);

const ACTION = {
  id: 12,
  kind: "timeout",
  actor_id: 2,
  reason: "Synthetic timeout reason shown to the member.",
  created_at: "2026-09-05T10:50:00Z",
  expires_at: "2999-01-01T00:00:00Z",
};

const row = (id: string, over: object) => ({
  id,
  action_id: 12,
  appellant_id: 2,
  body: "",
  state: "assigned",
  assignee_id: 1,
  decided_by: 0,
  decision_note: "",
  created_at: "2026-09-06T10:00:00Z",
  decided_at: null,
  ...over,
});

const QUEUE = [row(HELD, {}), row(DONE, { state: "overturned" })];

const HELD_DETAIL = {
  ...row(HELD, {}),
  body: "Synthetic statement from the appellant.",
  action: ACTION,
  report_id: "r".repeat(32),
};

const DONE_DETAIL = {
  ...row(DONE, {
    state: "overturned",
    decided_by: 1,
    decided_at: "2026-09-07T10:00:00Z",
    decision_note: "Synthetic note sent to the appellant.",
  }),
  body: "",
  action: { ...ACTION, kind: "removal", expires_at: undefined },
};

async function boot(page: Page, prefs?: AppearancePrefs): Promise<void> {
  const q = "/api/v1/moderation/appeals";
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: [] },
        { pattern: q, method: "GET", status: 200, body: QUEUE },
        { pattern: `${q}/${HELD}`, method: "GET", status: 200, body: HELD_DETAIL },
        { pattern: `${q}/${DONE}`, method: "GET", status: 200, body: DONE_DETAIL },
        { pattern: `${q}/${HELD}/decide`, method: "POST", status: 204, body: null },
      ],
      simulateWsFlow: true,
    }),
  );
  await page.goto("/");
  if (prefs !== undefined) await setAppearance(page, prefs);
  await submitLogin(page);
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
  await waitForWsReady(page);
}

/** Open the Moderation Center, the Appeals tab and one appeal, from the keyboard. */
async function openAppeal(
  page: Page,
  id = HELD,
): Promise<{ center: Locator; appeal: Locator; work: Locator }> {
  await page.getByTestId("moderation-btn").focus();
  await page.keyboard.press("Enter");
  const center = page.getByRole("region", { name: "Moderation" });
  await center.getByRole("tab", { name: "Reports" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(center.getByRole("tab", { name: "Appeals" })).toBeFocused();
  await expect(center.getByRole("tab", { name: "Appeals" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(center.getByTestId("mod-appeal-status")).toHaveText("2 appeals open or in review");
  await center.locator(`[data-appeal-id="${id}"]`).focus();
  await page.keyboard.press("Enter");
  const appeal = center.getByTestId("mod-appeal");
  await expect(appeal.getByRole("heading", { level: 3 })).toBeFocused();
  return { center, appeal, work: center.getByTestId("mod-appeal-work") };
}

test.describe("B9-17 appeal review accessibility (Q1)", () => {
  test("keyboard: tabs, the appeal, the decision; outcome announced after the answer", async ({
    page,
  }) => {
    await boot(page);
    const { center, appeal, work } = await openAppeal(page);
    expect(await findUnnamedControls(center)).toEqual([]);
    await expect(center.getByRole("tablist")).toHaveAccessibleName("Moderation queues");
    await expect(work).toHaveAccessibleName("Decision");
    const status = center.getByTestId("mod-appeal-write-status");

    // Tab order: linked report, the outcome group (one stop), the note, Record decision.
    await page.keyboard.press("Tab");
    await expect(appeal.getByRole("button", { name: "Open the report" })).toBeFocused();
    await page.keyboard.press("Tab");
    const uphold = work.getByRole("radio", { name: "Uphold (the action stands)" });
    await expect(uphold).toBeFocused();
    await page.keyboard.press("Tab");
    const note = work.getByRole("textbox", { name: "Note to the appellant" });
    await expect(note).toBeFocused();
    await expect(note).toHaveAccessibleDescription(/The appellant sees this note/);
    await page.keyboard.press("Tab");
    const decide = work.getByRole("button", { name: "Record decision" });
    await expect(decide).toBeFocused();
    await expect(decide).toHaveAccessibleDescription(/A decision is final/);

    // No outcome chosen: refused before sending, and says why.
    await page.keyboard.press("Enter");
    await expect(uphold).toBeFocused();
    await expect(work.getByRole("group", { name: "Decision" })).toHaveAccessibleDescription(
      /Overturning lifts the timeout.*Choose uphold or overturn first/,
    );
    await expect(status).toHaveText("");

    await page.keyboard.press("ArrowDown");
    await expect(work.getByRole("radio", { name: "Overturn (reverse the action)" })).toBeChecked();
    await page.keyboard.press("Tab");
    await page.keyboard.type("Synthetic decision note");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(status).toHaveText(
      "Decision recorded. The status below is what the server saved.",
    );

    // Escape closes the appeal back to its row.
    await appeal.getByRole("heading", { level: 3 }).focus();
    await page.keyboard.press("Escape");
    await expect(center.locator(`[data-appeal-id="${HELD}"]`)).toBeFocused();
  });

  test("a decided appeal shows the recorded outcome and no controls", async ({ page }) => {
    await boot(page);
    const { work } = await openAppeal(page, DONE);
    await expect(work.getByTestId("mod-appeal-result")).toHaveText("Overturned.");
    await expect(work).toContainText("the removed message wasn't restored");
    await expect(work).toContainText("Synthetic note sent to the appellant.");
    await expect(work.getByRole("button")).toHaveCount(0);
  });

  test("pointer targets are at least 24x24 CSS px (2.5.8)", async ({ page }) => {
    await boot(page);
    const { center } = await openAppeal(page);
    const small: string[] = [];
    for (const target of await center
      .locator("[role=tab], .mod-queue-row, button, textarea, select, .mod-work-outcome")
      .all()) {
      if (!(await target.isVisible())) continue;
      const box = await target.boundingBox();
      if (box === null || box.width < 24 || box.height < 24) {
        small.push(`${await target.textContent()}: ${box?.width}x${box?.height}`);
      }
    }
    expect(small).toEqual([]);
  });

  test("nothing in the appeal moves (no required animation)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const { center, work } = await openAppeal(page);
    for (const el of [center.getByRole("tab").first(), work, work.locator("form")]) {
      await expect(el).toHaveCSS("animation-name", "none");
      await expect(el).toHaveCSS("transition-duration", "0s");
    }
  });

  for (const theme of THEMES) {
    for (const highContrast of [false, true]) {
      test(`${theme}${highContrast ? " + High Contrast" : ""}: text and focus contrast`, async ({
        page,
      }, testInfo) => {
        await boot(page, { theme, highContrast, accent: null });
        const measured: Record<string, number> = {};
        const failures: string[] = [];
        const measure = async (name: string, locator: Locator, min = Q1.text): Promise<void> => {
          const { ratio } = await textContrast(locator);
          measured[name] = Number(ratio.toFixed(2));
          if (ratio < min) failures.push(`${name} ${ratio.toFixed(2)} < ${min}`);
        };
        const ring = async (name: string): Promise<void> => {
          const f = await focusIndicator(page);
          measured[`focus: ${name}`] = Number(f.ratio.toFixed(2));
          if (f.problems.length > 0) failures.push(`focus ${name}: ${f.problems.join(", ")}`);
        };

        const { center, appeal, work } = await openAppeal(page);
        // Rings first, from the keyboard: from the appeal's heading forward.
        for (const name of ["report link", "outcome", "note", "decide"]) {
          await page.keyboard.press("Tab");
          await ring(name);
        }
        await center.locator(`[data-appeal-id="${HELD}"]`).focus();
        await ring("row");
        await center.getByRole("tab", { name: "Appeals" }).focus();
        await ring("appeals tab");

        await measure("tab selected", center.getByRole("tab", { name: "Appeals" }));
        await measure("tab", center.getByRole("tab", { name: "Reports" }));
        await measure("intro", center.locator(".mod-panel:not([hidden]) .mod-center-intro"));
        await measure("row title", center.locator(".mod-queue-what").first());
        await measure("row state", center.locator(".mod-queue-state").first());
        await measure("fact label", appeal.locator(".mod-report-facts dt").first());
        await measure("statement", appeal.locator(".mod-report-note"));
        await measure("hint", work.locator(":scope > .mod-evidence-status").first());
        await measure("outcome label", work.locator(".mod-work-outcome span").first());
        await measure("note label", work.locator("label[for]").last());
        await measure("decide button", work.getByRole("button", { name: "Record decision" }));
        await work.getByRole("button", { name: "Record decision" }).click();
        await measure("outcome error", work.locator(".form-error"));

        await testInfo.attach(`b9-17-contrast-${theme}${highContrast ? "-hc" : ""}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every control is reachable and nothing scrolls sideways", async ({ page }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      const { center } = await openAppeal(page);
      const view = page.getByTestId("feature-view");
      expect(await view.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
      for (const el of await center
        .locator("[role=tab], button, textarea, select, label, p, dd")
        .all()) {
        if (!(await el.isVisible())) continue;
        await el.scrollIntoViewIfNeeded();
        await expect(el).toBeInViewport();
      }
      await testInfo.attach("b9-17-appeal-review-940x500-20px.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
});
