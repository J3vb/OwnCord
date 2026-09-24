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
// B9-13: a report's warning, timeout and lift-timeout actions against the
// owner's Q1 checks — keyboard, names, errors, targets, contrast in every
// theme and High Contrast, motion, and reflow at 940x500 with 20 px Large Font.
//
// The server is mocked with one report held by the signed-in moderator
// (testuser, id 1) about otheruser (id 2), with a timeout still running, so
// every action is on screen. The mock answers a timeout with its voice half
// applied, the outcome a real server gives only with a live voice session;
// skipped voice, refusals and role loss run against the real server in
// tests/e2e/fullstack/b9-moderation-actions.spec.ts. Synthetic content only.
// ---------------------------------------------------------------------------

const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;
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

async function boot(page: Page, prefs?: AppearancePrefs): Promise<void> {
  const q = "/api/v1/moderation/queue";
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: { messages: [], has_more: false } },
        { pattern: q, method: "GET", status: 200, body: QUEUE },
        { pattern: `${q}/${MINE}`, method: "GET", status: 200, body: DETAIL },
        { pattern: `${q}/${MINE}/act`, method: "POST", status: 200, body: { voice: "applied" } },
        {
          pattern: "/api/v1/moderation/users/2/untimeout",
          method: "POST",
          status: 204,
          body: null,
        },
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

/** Open the Moderation Center and the report, from the keyboard; the actions section. */
async function openActions(page: Page): Promise<{ center: Locator; acts: Locator }> {
  await page.getByTestId("moderation-btn").focus();
  await page.keyboard.press("Enter");
  const center = page.getByRole("region", { name: "Moderation" });
  await expect(center.getByTestId("mod-status")).toHaveText("1 report open or in review");
  await center.getByTestId("mod-queue-row").focus();
  await page.keyboard.press("Enter");
  await expect(center.getByTestId("mod-report").getByRole("heading", { level: 3 })).toBeFocused();
  return { center, acts: center.getByTestId("mod-act") };
}

test.describe("B9-13 moderation actions accessibility (Q1)", () => {
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
    const small: string[] = [];
    for (const target of await acts.locator("button, input, select").all()) {
      const box = await target.boundingBox();
      if (box === null || box.width < 24 || box.height < 24) {
        small.push(`${await target.getAttribute("data-focus")}: ${box?.width}x${box?.height}`);
      }
    }
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

        await testInfo.attach(`b9-13-contrast-${theme}${highContrast ? "-hc" : ""}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
  }

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every action is reachable and nothing scrolls sideways", async ({ page }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      const { acts } = await openActions(page);
      const view = page.getByTestId("feature-view");
      expect(await view.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
      for (const el of await acts.locator("button, input, select, label, p").all()) {
        if (!(await el.isVisible())) continue;
        await el.scrollIntoViewIfNeeded();
        await expect(el).toBeInViewport();
      }
      await testInfo.attach("b9-13-moderation-actions-940x500-20px.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
});
