import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { ROUTE_MESSAGES_EMPTY } from "./helpers";
import { type AppearancePrefs, findUnnamedControls } from "./support/accessibility";
import {
  attachScreenshot,
  bootSignedIn,
  contrastMatrix,
  expectReachable,
  horizontalOverflow,
  openModerationReport,
  undersizedTargets,
} from "./support/a11yHarness";

// ---------------------------------------------------------------------------
// B9-13: a report's warning, timeout and lift-timeout actions against the
// owner's Q1 checks — keyboard, names, errors, targets, contrast in every
// theme and High Contrast, motion, and reflow at 940x500 with 20 px Large Font.
//
// The server is mocked with one report held by the signed-in moderator
// (testuser, id 1) about otheruser (id 2), with a timeout still running, so
// every action is on screen. The mock answers a timeout with its voice half
// applied, the outcome a real server gives only with a live voice session;
// skipped voice, refusals and role loss run against the real server in
// tests/e2e/fullstack/moderation-actions.spec.ts. Synthetic content only.
//
// B9-14 adds removal, kick (force logout) and ban, each confirmed first. The
// mocked moderator's role holds ADMINISTRATOR, so all three are offered; which
// role gets which, and the server's refusals, run against the real server.
// ---------------------------------------------------------------------------

const MINE = "e".repeat(32);

const QUEUE = [
  {
    id: MINE,
    reporter_name: "synthetic-reporter",
    subject_name: "otheruser",
    target_type: "user",
    target_ref: "2",
    reason: "harassment",
    state: "assigned",
    assignee_id: 1,
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
  },
];

const DETAIL = {
  id: MINE,
  reporter_id: 3,
  subject_id: 2,
  target_type: "user",
  target_ref: "2",
  reason: "harassment",
  detail: "",
  state: "assigned",
  assignee_id: 1,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
  evidence: [],
  notes: [],
  events: [
    { actor_id: 0, action: "created", detail: "harassment", created_at: "2026-09-05T10:00:00Z" },
    { actor_id: 1, action: "assigned", detail: "", created_at: "2026-09-05T10:30:00Z" },
  ],
  actions: [
    {
      id: 12,
      kind: "timeout",
      actor_id: 1,
      reason: "Synthetic timeout reason shown to the member.",
      created_at: "2026-09-05T10:50:00Z",
      expires_at: "2999-01-01T00:00:00Z",
    },
  ],
};

/** The report about a message (B9-14): the same report, so removal is offered too. */
const ABOUT_MESSAGE = {
  queue: QUEUE.map((r) => ({ ...r, target_type: "message", target_ref: "55" })),
  detail: { ...DETAIL, target_type: "message", target_ref: "55" },
};

async function boot(
  page: Page,
  prefs?: AppearancePrefs,
  report: { queue: unknown; detail: unknown } = { queue: QUEUE, detail: DETAIL },
): Promise<void> {
  const q = "/api/v1/moderation/queue";
  await bootSignedIn(
    page,
    [
      ROUTE_MESSAGES_EMPTY,
      { pattern: q, method: "GET", status: 200, body: report.queue },
      { pattern: `${q}/${MINE}`, method: "GET", status: 200, body: report.detail },
      { pattern: `${q}/${MINE}/act`, method: "POST", status: 200, body: { voice: "applied" } },
      {
        pattern: "/api/v1/moderation/users/2/untimeout",
        method: "POST",
        status: 204,
        body: null,
      },
    ],
    prefs,
  );
}

/** Open the Moderation Center and the report, from the keyboard; the actions section. */
async function openActions(page: Page): Promise<{ center: Locator; acts: Locator }> {
  const center = await openModerationReport(page, "1 report open or in review");
  return { center, acts: center.getByTestId("mod-act") };
}

test.describe("moderation actions accessibility", () => {
  test("keyboard: warn, time out and lift in order, each outcome announced after the answer", async ({
    page,
  }) => {
    await boot(page);
    const { center, acts } = await openActions(page);
    expect(await findUnnamedControls(center)).toEqual([]);
    await expect(acts).toHaveAccessibleName("Actions");
    const status = center.getByTestId("mod-write-status");

    const warn = acts.getByRole("textbox", { name: "Warning reason, shown to the member" });
    await expect(warn).toHaveAccessibleDescription("Optional, up to 500 characters.");
    await warn.focus();
    await page.keyboard.type("Synthetic warning");
    await page.keyboard.press("Tab");
    await expect(acts.getByRole("button", { name: "Issue warning" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(
      "Warning issued. The member sees it now, or the next time they sign in.",
    );

    // Tab order: reason, length, unit, Time out.
    await page.keyboard.press("Tab");
    await expect(
      acts.getByRole("textbox", { name: "Timeout reason, shown to the member" }),
    ).toBeFocused();
    await page.keyboard.type("Synthetic timeout");
    await page.keyboard.press("Tab");
    const length = acts.getByRole("spinbutton", { name: "Timeout length" });
    await expect(length).toBeFocused();
    await expect(length).toHaveAccessibleDescription(/From 1 minute to 28 days/);

    // A length out of bounds is refused before sending, and says why.
    await page.keyboard.type("29");
    const unit = acts.getByRole("combobox", { name: "Unit" });
    await unit.selectOption("days");
    await acts.getByRole("button", { name: "Time out" }).focus();
    await page.keyboard.press("Enter");
    await expect(length).toBeFocused();
    await expect(length).toHaveAttribute("aria-invalid", "true");
    await expect(length).toHaveAccessibleDescription(/Enter a whole number/);

    await length.fill("3");
    await unit.focus();
    await page.keyboard.press("Tab");
    await expect(acts.getByRole("button", { name: "Time out" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(
      "Timed out for 3 days: they can't send messages or react. They were also server-muted in their voice channel.",
    );

    // Lift is last, described by when the timeout ends.
    await page.keyboard.press("Tab");
    const lift = acts.getByRole("button", { name: "Lift timeout" });
    await expect(lift).toBeFocused();
    await expect(lift).toHaveAccessibleDescription(/^This report's timeout runs until /);
    await page.keyboard.press("Space");
    await expect(status).toHaveText("Timeout lifted: they can send messages and react again.");
  });

  test("pointer targets are at least 24x24 CSS px (2.5.8)", async ({ page }) => {
    await boot(page);
    const { acts } = await openActions(page);
    const small = await undersizedTargets(acts.locator("button, input, select"), {
      label: (target) => target.getAttribute("data-focus"),
    });
    expect(small).toEqual([]);
  });

  test("nothing in the actions moves (no required animation)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const { acts } = await openActions(page);
    for (const el of [acts, acts.locator("form").first(), acts.getByRole("button").first()]) {
      await expect(el).toHaveCSS("animation-name", "none");
    }
    await expect(acts).toHaveCSS("transition-duration", "0s");
  });

  for (const c of contrastMatrix({
    title: "text and focus contrast",
    attachName: (theme, hc) => `b9-13-contrast-${theme}${hc ? "-hc" : ""}.json`,
    boot: boot,
    scenario: async (page, { measure, ring }) => {
      const { center, acts } = await openActions(page);
      await measure("actions heading", acts.locator("h4"));
      await measure("actions hint", acts.locator(":scope > .mod-evidence-status"));
      await measure("reason label", acts.locator("label").first());
      await measure("reason hint", acts.locator("form .mod-evidence-status").first());
      await measure("length hint", acts.locator("form .mod-evidence-status").nth(2));
      await measure("warn button", acts.getByRole("button", { name: "Issue warning" }));
      await measure("timeout button", acts.getByRole("button", { name: "Time out" }));
      await measure("lift hint", acts.locator(".mod-work-form > .mod-evidence-status").last());
      await measure("lift button", acts.getByRole("button", { name: "Lift timeout" }));
      await measure(
        "history end",
        center.locator(".mod-history-item .mod-history-when", { hasText: "Until" }),
      );

      // The length error, shown by refusing an empty length.
      await acts.getByRole("button", { name: "Time out" }).click();
      await measure("length error", acts.locator(".form-error"));

      await acts.getByRole("textbox").first().focus();
      await ring("warning reason");
      for (const name of ["warn", "timeout reason", "length", "unit", "time out", "lift"]) {
        await page.keyboard.press("Tab");
        await ring(name);
      }
    },
  })) {
    test(c.title, c.run);
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every action is reachable and nothing scrolls sideways", async ({ page }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      const { acts } = await openActions(page);
      const view = page.getByTestId("feature-view");
      expect(await horizontalOverflow(view)).toBeLessThanOrEqual(0);
      await expectReachable(acts.locator("button, input, select, label, p"), { skipHidden: true });
      await attachScreenshot(testInfo, "b9-13-moderation-actions-940x500-20px.png", page);
    });
  });
});

test.describe("removal, kick and ban accessibility", () => {
  const ACTIONS = ["Remove reported message", "Log out of every session", "Ban member"];

  test("keyboard: the three actions follow lift, each confirmed in a dialog that returns focus", async ({
    page,
  }) => {
    await boot(page, undefined, ABOUT_MESSAGE);
    const { center, acts } = await openActions(page);
    const status = center.getByTestId("mod-write-status");
    expect(await findUnnamedControls(center)).toEqual([]);

    // Tab order after Lift timeout: reason, then each action in severity order.
    await acts.getByRole("button", { name: "Lift timeout" }).focus();
    await page.keyboard.press("Tab");
    const reason = acts.getByRole("textbox", { name: "Reason for a removal, log-out or ban" });
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAccessibleDescription(
      "Optional, up to 500 characters. Recorded with this report; the member sees the reason for a removal or ban.",
    );
    await page.keyboard.type("Synthetic enforcement reason");
    for (const name of ACTIONS) {
      await page.keyboard.press("Tab");
      await expect(acts.getByRole("button", { name })).toBeFocused();
    }

    // Ban asks first: a named modal dialog, Cancel focused, Escape cancels
    // and focus goes back to Ban.
    const ban = acts.getByRole("button", { name: "Ban member" });
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Ban this member?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await findUnnamedControls(dialog)).toEqual([]);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(ban).toBeFocused();
    await expect(status).toHaveText("");

    // Tab stays inside the dialog; confirming from the keyboard sends it, and
    // the outcome is said only after the server's answer.
    await page.keyboard.press("Space");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Ban", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(status).toHaveText(
      "Member banned. They were disconnected and can't sign in again.",
    );
  });

  test("dialog targets are at least 24x24 CSS px and nothing in it moves", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page, undefined, ABOUT_MESSAGE);
    const { acts } = await openActions(page);
    await acts.getByRole("button", { name: "Remove reported message" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove the reported message?" });
    for (const b of await dialog.getByRole("button").all()) {
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    await expect(dialog.getByRole("button").first()).toHaveCSS("animation-name", "none");
  });

  for (const c of contrastMatrix({
    title: "action and dialog contrast",
    attachName: (theme, hc) => `b9-14-contrast-${theme}${hc ? "-hc" : ""}.json`,
    boot: (page, prefs) => boot(page, prefs, ABOUT_MESSAGE),
    scenario: async (page, { measure, ring }) => {
      const { acts } = await openActions(page);
      const reason = acts.getByRole("textbox", { name: "Reason for a removal, log-out or ban" });
      await measure("reason label", acts.locator("label", { hasText: "Reason for a removal" }));
      await measure("reason hint", acts.locator(".mod-evidence-status").last());
      await reason.focus();
      await ring("reason");
      for (const name of ACTIONS) {
        await measure(name, acts.getByRole("button", { name }));
        await page.keyboard.press("Tab");
        await ring(name);
      }

      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Ban this member?" });
      await measure("dialog title", dialog.getByRole("heading"));
      await measure("dialog body", dialog.locator(".modal-danger-text"));
      await measure("dialog cancel", dialog.getByRole("button", { name: "Cancel" }));
      await measure("dialog ban", dialog.getByRole("button", { name: "Ban", exact: true }));
      await ring("dialog cancel");
      await page.keyboard.press("Tab");
      await ring("dialog ban");
    },
  })) {
    test(c.title, c.run);
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("the actions and their dialog stay reachable with no sideways scroll", async ({
      page,
    }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true }, ABOUT_MESSAGE);
      const { acts } = await openActions(page);
      const view = page.getByTestId("feature-view");
      expect(await horizontalOverflow(view)).toBeLessThanOrEqual(0);
      for (const name of ACTIONS) {
        const b = acts.getByRole("button", { name });
        await b.scrollIntoViewIfNeeded();
        await expect(b).toBeInViewport();
      }
      await acts.getByRole("button", { name: "Log out of every session" }).click();
      const dialog = page.getByRole("dialog", { name: "Log this member out of every session?" });
      for (const el of await dialog.locator("h3, p, button").all()) {
        await expect(el).toBeInViewport();
      }
      await attachScreenshot(testInfo, "b9-14-confirm-940x500-20px.png", page);
    });
  });
});
