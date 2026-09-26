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
// B9-12: a report's review controls, internal notes and history against the
// owner's Q1 checks — keyboard, names, targets, contrast in every theme and
// High Contrast, motion, and reflow at 940x500 with 20 px Large Font.
//
// The server is mocked with one unassigned report and one assigned to the
// signed-in moderator (testuser, id 1), with a note, events and a moderator
// action, so every part of the review is on screen for measuring. Conflicts,
// refusals and role loss run against the real server in
// tests/e2e/fullstack/b9-moderation-workflow.spec.ts. Synthetic content only.
// ---------------------------------------------------------------------------

const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;
const OPEN = "c".repeat(32);
const MINE = "d".repeat(32);

const row = (id: string, state: string, assignee: number, reason: string) => ({
  id,
  reporter_name: "synthetic-reporter",
  subject_name: "otheruser",
  target_type: "user",
  target_ref: "2",
  reason,
  state,
  assignee_id: assignee,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
});

const QUEUE = [row(MINE, "assigned", 1, "harassment"), row(OPEN, "open", 0, "spam")];

const detail = (id: string, state: string, assignee: number, reason: string) => ({
  id,
  reporter_id: 3,
  subject_id: 2,
  target_type: "user",
  target_ref: "2",
  reason,
  detail: "",
  state,
  assignee_id: assignee,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
  evidence: [],
  notes:
    assignee === 1
      ? [
          {
            id: 1,
            author_id: 1,
            body: "Synthetic internal note that is long enough to wrap across the narrow window without breaking anything.",
            created_at: "2026-09-05T10:40:00Z",
          },
        ]
      : [],
  events: [
    { actor_id: 0, action: "created", detail: reason, created_at: "2026-09-05T10:00:00Z" },
    ...(assignee === 1
      ? [
          { actor_id: 1, action: "assigned", detail: "", created_at: "2026-09-05T10:30:00Z" },
          { actor_id: 1, action: "noted", detail: "", created_at: "2026-09-05T10:40:00Z" },
        ]
      : []),
  ],
  actions:
    assignee === 1
      ? [
          {
            id: 9,
            kind: "warning",
            actor_id: 1,
            reason: "Synthetic warning reason shown to the member.",
            created_at: "2026-09-05T10:50:00Z",
            lifted_at: "2026-09-06T10:00:00Z",
          },
        ]
      : [],
});

async function boot(page: Page, prefs?: AppearancePrefs): Promise<void> {
  const q = "/api/v1/moderation/queue";
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: q, method: "GET", status: 200, body: QUEUE },
        {
          pattern: `${q}/${MINE}`,
          method: "GET",
          status: 200,
          body: detail(MINE, "assigned", 1, "harassment"),
        },
        {
          pattern: `${q}/${OPEN}`,
          method: "GET",
          status: 200,
          body: detail(OPEN, "open", 0, "spam"),
        },
        { pattern: `${q}/${MINE}/notes`, method: "POST", status: 204, body: null },
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

/** Open the Moderation Center and the report at `index`, from the keyboard. */
async function openReport(page: Page, index = 0): Promise<Locator> {
  await page.getByTestId("moderation-btn").focus();
  await page.keyboard.press("Enter");
  const center = page.getByRole("region", { name: "Moderation" });
  await expect(center.getByTestId("mod-status")).toHaveText("2 reports open or in review");
  await center.getByTestId("mod-queue-row").nth(index).focus();
  await page.keyboard.press("Enter");
  await expect(center.getByTestId("mod-report").getByRole("heading", { level: 3 })).toBeFocused();
  return center;
}

test.describe("B9-12 moderation review accessibility (Q1)", () => {
  test("keyboard: note, outcome and close are reachable and operable in order", async ({
    page,
  }) => {
    await boot(page);
    const center = await openReport(page);
    const work = center.getByTestId("mod-work");
    expect(await findUnnamedControls(center)).toEqual([]);
    await expect(work).toHaveAccessibleName("Review");

    const note = work.getByRole("textbox", { name: "Internal note" });
    await expect(note).toHaveAccessibleDescription(/Only moderators can read notes/);
    await note.focus();
    await page.keyboard.type("Synthetic keyboard note");
    await page.keyboard.press("Tab");
    const add = work.getByRole("button", { name: "Add note" });
    await expect(add).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(center.getByTestId("mod-write-status")).toHaveText("Note added.");
    // The re-read rebuilt the review; focus stays on the same control.
    await expect(add).toBeFocused();

    // One Tab reaches the outcome group; arrows move within it.
    await page.keyboard.press("Tab");
    const outcomes = work.getByRole("radio");
    await expect(outcomes).toHaveCount(3);
    await expect(outcomes.first()).toBeFocused();
    await expect(work.getByRole("group", { name: "Outcome" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(work.getByRole("radio", { name: "No action needed" })).toBeChecked();
    await page.keyboard.press("Tab");
    const close = work.getByRole("button", { name: "Close report" });
    await expect(close).toBeFocused();
    await expect(close).toHaveAccessibleDescription(/can't be reopened/);

    // No hover-only action; notes and history hold nothing to operate.
    await expect(center.locator(".mod-history button, .mod-notes button")).toHaveCount(0);
    await expect(center.getByTestId("mod-history").locator("li")).toHaveCount(4);
  });

  test("an outcome is required before closing, and the error is announced", async ({ page }) => {
    await boot(page);
    const center = await openReport(page);
    const work = center.getByTestId("mod-work");
    await work.getByRole("button", { name: "Close report" }).focus();
    await page.keyboard.press("Enter");
    await expect(work.getByRole("group", { name: "Outcome" })).toHaveAccessibleDescription(
      "Choose an outcome first.",
    );
    await expect(work.getByRole("radio").first()).toBeFocused();
  });

  test("pointer targets are at least 24x24 CSS px (2.5.8)", async ({ page }) => {
    await boot(page);
    const small: string[] = [];
    const check = async (root: Locator) => {
      for (const target of await root
        .locator(
          "[data-testid=mod-work] button, [data-testid=mod-work] textarea, .mod-work-outcome",
        )
        .all()) {
        if (!(await target.isVisible())) continue;
        const box = await target.boundingBox();
        if (box === null || box.width < 24 || box.height < 24) {
          small.push(`${await target.textContent()}: ${box?.width}x${box?.height}`);
        }
      }
    };
    const center = await openReport(page);
    await check(center);
    await center.getByTestId("mod-queue-row").nth(1).click();
    await expect(center.getByRole("button", { name: "Take this report" })).toBeVisible();
    await check(center);
    expect(small).toEqual([]);
  });

  test("nothing in the review moves (no required animation)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const center = await openReport(page);
    for (const el of [
      center.getByTestId("mod-work"),
      center.locator(".mod-history-item").first(),
      center.locator(".mod-note").first(),
      center.locator(".mod-work-outcome").first(),
    ]) {
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

        const center = await openReport(page);
        const report = center.getByTestId("mod-report");
        const work = center.getByTestId("mod-work");
        await measure("notes heading", report.locator("h4", { hasText: "Internal notes" }));
        await measure("note byline", report.locator(".mod-note .mod-history-when"));
        await measure("note text", report.locator(".mod-note-body"));
        await measure(
          "history hint",
          report.locator(".mod-evidence-status", { hasText: "can't be edited" }),
        );
        await measure("history entry", report.locator(".mod-history-what").first());
        await measure("history date", report.locator(".mod-history .mod-history-when").first());
        await measure("action reason", report.locator(".mod-history-reason"));
        await measure("review heading", work.locator("h4"));
        await measure("review state", work.locator(".mod-evidence-status").first());
        await measure("note label", work.locator("label").first());
        await measure("note hint", work.locator(".mod-work-form .mod-evidence-status").first());
        await measure("outcome legend", work.locator("legend"));
        await measure("outcome label", work.locator(".mod-work-outcome span").first());
        await measure("close hint", work.locator(".mod-work-form .mod-evidence-status").nth(1));
        await measure("add note button", work.getByRole("button", { name: "Add note" }));
        await measure("close button", work.getByRole("button", { name: "Close report" }));

        await work.getByRole("textbox").focus();
        await ring("note field");
        await page.keyboard.press("Tab");
        await ring("add note");
        await page.keyboard.press("Tab");
        await ring("outcome");
        await page.keyboard.press("Tab");
        await ring("close");

        await testInfo.attach(`b9-12-contrast-${theme}${highContrast ? "-hc" : ""}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every control and line is reachable and nothing scrolls sideways", async ({
      page,
    }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      const center = await openReport(page);
      const view = page.getByTestId("feature-view");
      expect(await view.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
      for (const el of await center
        .locator(
          "[data-testid=mod-work] button, [data-testid=mod-work] textarea, .mod-work-outcome, .mod-note-body, .mod-history-item",
        )
        .all()) {
        if (!(await el.isVisible())) continue;
        await el.scrollIntoViewIfNeeded();
        await expect(el).toBeInViewport();
      }
      await testInfo.attach("b9-12-moderation-review-940x500-20px.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
});
