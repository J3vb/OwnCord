import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { ROUTE_MESSAGES_EMPTY } from "./helpers";
import { type AppearancePrefs, findUnnamedControls } from "./support/accessibility";
import {
  attachScreenshot,
  bootSignedIn,
  contrastMatrix,
  expectNoMotion,
  expectReachable,
  horizontalOverflow,
  openModerationReport,
  undersizedTargets,
} from "./support/a11yHarness";

// ---------------------------------------------------------------------------
// B9-11: the Moderation Center's queue and a report's evidence against the
// owner's Q1 checks — keyboard, names, targets, contrast in every theme and
// High Contrast, motion, and reflow at 940x500 with 20 px Large Font.
//
// The server is mocked with one open and one assigned report so every state
// the view draws is on screen for measuring. Authorization, consent and role
// loss run against the real server in
// tests/e2e/fullstack/moderation-queue.spec.ts. Synthetic content only.
// ---------------------------------------------------------------------------

const OPEN = "a".repeat(32);
const ASSIGNED = "b".repeat(32);

const QUEUE = [
  {
    id: OPEN,
    reporter_name: "synthetic-reporter",
    subject_name: "otheruser",
    target_type: "message",
    target_ref: "201",
    channel_id: 1,
    reason: "harassment",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
  },
  {
    id: ASSIGNED,
    reporter_name: "synthetic-reporter",
    subject_name: "otheruser",
    target_type: "user",
    target_ref: "2",
    reason: "spam",
    state: "assigned",
    assignee_id: 1,
    outcome: "",
    created_at: "2026-09-04T10:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
  },
];

const DETAIL = {
  id: OPEN,
  reporter_id: 3,
  subject_id: 2,
  target_type: "message",
  target_ref: "201",
  channel_id: 1,
  reason: "harassment",
  detail: "Synthetic reporter detail that is long enough to wrap across the narrow window.",
  state: "open",
  assignee_id: 0,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
  evidence: [
    {
      seq: -1,
      author_id: 2,
      content: "Synthetic context before",
      attachments: "[]",
      captured_at: "2026-09-05T10:00:00Z",
    },
    {
      seq: 0,
      author_id: 2,
      content: "Synthetic reported message https://example.invalid/unbroken-long-link-text",
      attachments: JSON.stringify([
        { id: "att-1", filename: "synthetic-notes.txt", mime: "text/plain", size: 2048 },
      ]),
      captured_at: "2026-09-05T10:00:00Z",
    },
  ],
  notes: [],
  events: [],
  actions: [],
};

async function boot(page: Page, prefs?: AppearancePrefs): Promise<void> {
  await bootSignedIn(
    page,
    [
      ROUTE_MESSAGES_EMPTY,
      { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: QUEUE },
      { pattern: `/api/v1/moderation/queue/${OPEN}`, method: "GET", status: 200, body: DETAIL },
    ],
    prefs,
  );
}

/** Open the Moderation Center and the open report, from the keyboard. */
const openReport = (page: Page): Promise<Locator> =>
  openModerationReport(page, "2 reports open or in review");

test.describe("Moderation Center accessibility", () => {
  test("keyboard: Tab order, Enter, Escape back to the row, then back to the channel", async ({
    page,
  }) => {
    await boot(page);
    const center = await openReport(page);
    expect(await findUnnamedControls(center)).toEqual([]);
    const rows = center.getByTestId("mod-queue-row");
    await expect(rows.first()).toHaveAttribute("aria-current", "true");
    await expect(rows.first()).toHaveAccessibleName(
      /^Message reported for Harassment\. About otheruser, reported by synthetic-reporter\. Waiting for review\. Sent /,
    );

    // Tab order: filter, then the rows, in reading order.
    await center.getByTestId("mod-filter").focus();
    await page.keyboard.press("Tab");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(rows.nth(0)).toBeFocused();

    // Escape closes the report onto its row, then the view onto the channel.
    await center.getByTestId("mod-report").getByRole("heading", { level: 3 }).focus();
    await page.keyboard.press("Escape");
    await expect(center.getByTestId("mod-report")).toHaveCount(0);
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(center).toBeHidden();
    await expect(page.locator("[data-testid='chat-header-name']")).toHaveText("general");
    await expect(page.getByTestId("moderation-btn")).toBeFocused();
  });

  test("pointer targets are at least 24x24 CSS px (2.5.8)", async ({ page }) => {
    await boot(page);
    const center = await openReport(page);
    const small = await undersizedTargets(center.locator("button, select"), { skipHidden: true });
    expect(small).toEqual([]);
  });

  test("nothing in the view moves (no required animation)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const center = await openReport(page);
    await expectNoMotion([
      center.getByTestId("mod-queue-row").first(),
      center.getByTestId("mod-report"),
      center.locator(".mod-evidence-item").first(),
    ]);
  });

  for (const c of contrastMatrix({
    title: "text and focus contrast",
    attachName: (theme, hc) => `b9-11-contrast-${theme}${hc ? "-hc" : ""}.json`,
    boot: boot,
    scenario: async (page, { measure, ring }) => {
      const center = await openReport(page);
      const report = center.getByTestId("mod-report");
      await measure("intro", center.locator(".mod-center-intro"));
      await measure("filter label", center.locator(".mod-center-toolbar label"));
      await measure("count", center.getByTestId("mod-status"));
      await measure("row: report (selected)", center.locator(".mod-queue-what").first());
      await measure("row: who (selected)", center.locator(".mod-queue-who").first());
      await measure("row: report", center.locator(".mod-queue-what").nth(1));
      await measure("row: state", center.locator(".mod-queue-state").nth(1));
      await measure("row: date", center.locator(".mod-queue-when").nth(1));
      await measure("report title", report.locator("h3"));
      await measure("fact label", report.locator("dt").first());
      await measure("fact value", report.locator("dd").first());
      await measure("section heading", report.locator("h4").first());
      await measure("reporter detail", report.locator(".mod-report-note"));
      await measure("captured note", report.locator(".mod-evidence-status").first());
      await measure("evidence author", report.locator(".mod-evidence-author").first());
      await measure("evidence text", report.locator(".mod-evidence-text").first());
      await measure("reported marker", report.locator(".mod-evidence-marker"));
      await measure("reported text", report.locator(".mod-evidence-reported .mod-evidence-text"));
      await measure("attachment", report.locator(".mod-evidence-files li"));

      await center.getByTestId("mod-filter").focus();
      await page.keyboard.press("Tab");
      await ring("selected row");
      await page.keyboard.press("Tab");
      await ring("row");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await ring("filter");
    },
  })) {
    test(c.title, c.run);
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every control and line is reachable and nothing scrolls sideways", async ({
      page,
    }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      const center = await openReport(page);
      const view = page.getByTestId("feature-view");
      expect(await horizontalOverflow(view)).toBeLessThanOrEqual(0);
      expect(await horizontalOverflow(center.getByTestId("mod-queue"))).toBeLessThanOrEqual(0);
      await expectReachable(
        center.locator(
          "select, button, .mod-report dd, .mod-evidence-text, .mod-evidence-files li",
        ),
        { skipHidden: true },
      );
      await attachScreenshot(testInfo, "b9-11-moderation-940x500-20px.png", page);
    });
  });
});
