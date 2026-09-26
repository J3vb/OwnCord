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
// B9-10: the report form and My reports against the owner's Q1 checks —
// keyboard, names, focus, contrast in every theme and High Contrast, reduced
// motion from the OS and the app, and reflow at 940x500 with 20 px Large Font.
//
// The server here is mocked, so every send is refused as a duplicate: that
// keeps the dialog open in its error state for measuring. The real-server
// journey (success, duplicate, removed target, quota, role isolation) is
// tests/e2e/fullstack/b9-reports.spec.ts. Synthetic content only.
// ---------------------------------------------------------------------------

const THEMES = ["dark", "neon-glow", "midnight", "light"] as const;

const MESSAGES = {
  messages: [
    {
      id: 201,
      channel_id: 1,
      user: { id: 2, username: "otheruser", avatar: "" },
      content: "Synthetic message to report",
      timestamp: "2026-03-15T10:00:00Z",
      edited_at: null,
      attachments: [
        {
          id: "att-synthetic-1",
          filename: "synthetic-notes.txt",
          size: 12,
          mime: "text/plain",
          url: "/api/v1/files/att-synthetic-1",
        },
      ],
      reactions: [],
      reply_to: null,
      pinned: false,
      deleted: false,
    },
  ],
  has_more: false,
};

const MINE = [
  {
    id: "a".repeat(32),
    target_type: "message",
    reason: "harassment",
    state: "open",
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    closed_at: null,
  },
  {
    id: "b".repeat(32),
    target_type: "attachment",
    reason: "nsfw_unlabelled",
    state: "dismissed",
    outcome: "duplicate",
    created_at: "2026-09-04T10:00:00Z",
    closed_at: "2026-09-05T11:00:00Z",
  },
];

async function boot(page: Page, prefs?: AppearancePrefs): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MESSAGES },
        { pattern: "/api/v1/reports/mine", method: "GET", status: 200, body: MINE },
        {
          pattern: "/api/v1/reports",
          method: "POST",
          status: 409,
          body: { error: "DUPLICATE_REPORT", message: "duplicate" },
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
  await expect(page.getByTestId("message-201")).toBeVisible();
}

const reportDialog = (page: Page, name = "Report message") => page.getByRole("dialog", { name });

/** Open the message's report form from the keyboard; returns its opener. */
async function openFromKeyboard(page: Page): Promise<Locator> {
  const opener = page.getByTestId("msg-report-201");
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(reportDialog(page)).toBeVisible();
  return opener;
}

/** Submit with no reason, then with one, so both error states are on screen. */
async function showErrors(page: Page): Promise<void> {
  const dialog = reportDialog(page);
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(dialog.getByText("Choose a reason.")).toBeVisible();
  await dialog.getByRole("radio", { name: "Spam" }).check();
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(dialog.getByText("You already have an open report about this.")).toBeVisible();
}

async function openSafety(page: Page): Promise<Locator> {
  await page.locator("button[aria-label='Settings']").click();
  await page.getByRole("tab", { name: "Safety" }).click();
  const section = page.getByRole("region", { name: "My reports" });
  await expect(section.locator(".my-reports-item")).toHaveCount(2);
  return section;
}

test.describe("B9-10 report form and My reports (Q1)", () => {
  test("keyboard reaches and operates every action, and focus returns", async ({ page }) => {
    await boot(page);
    const opener = await openFromKeyboard(page);
    const dialog = reportDialog(page);
    expect(await findUnnamedControls(dialog)).toEqual([]);

    // Focus starts on the target choice; arrows move within it.
    const message = dialog.getByRole("radio", { name: "This message" });
    await expect(message).toBeFocused();
    await expect(message).toBeChecked();
    await page.keyboard.press("ArrowDown");
    await expect(
      dialog.getByRole("radio", { name: "The attachment synthetic-notes.txt" }),
    ).toBeChecked();

    // Enter submits; with no reason, focus goes to the reason at fault.
    await page.keyboard.press("Enter");
    const spam = dialog.getByRole("radio", { name: "Spam" });
    await expect(spam).toBeFocused();
    await expect(spam).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("alert").filter({ hasText: "Choose a reason." })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(spam).toBeChecked();

    // Tab order: details, Cancel, Send; the close button wraps round.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("textbox", { name: "Details (optional)" })).toBeFocused();
    await page.keyboard.type("Synthetic detail");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    const send = dialog.getByRole("button", { name: "Send report" });
    await expect(send).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      dialog.getByRole("alert").filter({ hasText: "already have an open report" }),
    ).toBeVisible();
    await expect(send).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

    // Escape closes and returns focus to the Report button.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    // A user: the member row opens the profile from the keyboard, and its
    // Report button opens the user form.
    const row = page.getByTestId("member-2");
    await row.focus();
    await page.keyboard.press("Enter");
    const report = page.getByTestId("upp-report-btn");
    await report.focus();
    await page.keyboard.press("Enter");
    await expect(reportDialog(page, "Report otheruser")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).press("Enter");
    await expect(reportDialog(page, "Report otheruser")).toHaveCount(0);
    await expect(row).toBeFocused();

    // My reports: a named region, reachable in the Settings tab order.
    const section = await openSafety(page);
    expect(await findUnnamedControls(section)).toEqual([]);
    await expect(section.locator(".my-reports-state")).toHaveText([
      "Waiting for review",
      "Closed: already reported",
    ]);
  });

  test("pointer targets are at least 24x24 CSS px (2.5.8)", async ({ page }) => {
    await boot(page);
    await openFromKeyboard(page);
    const dialog = reportDialog(page);
    const small: string[] = [];
    for (const target of await dialog.locator(".report-option, button").all()) {
      const box = await target.boundingBox();
      if (box === null || box.width < 24 || box.height < 24) {
        small.push(`${await target.textContent()}: ${box?.width}x${box?.height}`);
      }
    }
    expect(small).toEqual([]);
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

        await openFromKeyboard(page);
        await ring("target radio");
        const dialog = reportDialog(page);
        await dialog.getByRole("button", { name: "Send report" }).click();
        await measure("reason error", dialog.getByText("Choose a reason."));
        await showErrors(page);
        await measure("title", dialog.locator("h3"));
        await measure("privacy note", dialog.locator(".report-note").first());
        await measure("legend", dialog.locator("legend").first());
        await measure("option", dialog.locator(".report-option span").first());
        await measure("detail label", dialog.locator("label.form-label"));
        await measure("detail hint", dialog.locator(".form-group .report-note"));
        await measure("send refusal", dialog.getByText("You already have an open report"));
        await measure("cancel", dialog.getByRole("button", { name: "Cancel" }));
        await measure("send", dialog.getByRole("button", { name: "Send report" }));
        await dialog.getByRole("radio", { name: "Spam" }).focus();
        await page.keyboard.press("ArrowDown");
        await ring("reason radio");
        await page.keyboard.press("Tab");
        await ring("details");
        await page.keyboard.press("Tab");
        await ring("cancel");
        await page.keyboard.press("Tab");
        await ring("send");
        await page.keyboard.press("Escape");

        const section = await openSafety(page);
        await measure("my reports heading", section.locator("h2"));
        await measure("my reports description", section.locator(".setting-desc"));
        await measure("report", section.locator(".my-reports-what").first());
        await measure("status", section.locator(".my-reports-state").first());
        await measure("dates", section.locator(".my-reports-when").nth(1));

        await testInfo.attach(`b9-10-contrast-${theme}${highContrast ? "-hc" : ""}.json`, {
          body: JSON.stringify(measured, null, 2),
          contentType: "application/json",
        });
        expect(failures).toEqual([]);
      });
    }
  }

  test("reduced motion from the OS or the app stops the dialog's animation", async ({ page }) => {
    // Control: with neither asking, the dialog animates, so the checks below can fail.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await boot(page);
    const dialog = page.locator(".report-dialog");
    await openFromKeyboard(page);
    await expect(dialog).toHaveCSS("animation-duration", "0.3s");
    await page.keyboard.press("Escape");

    // The OS setting (Sync with OS is on by default).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFromKeyboard(page);
    await expect(dialog).toHaveCSS("animation-duration", "0s");
    await page.keyboard.press("Escape");

    // The in-app toggle alone.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await setAppearance(page, { reducedMotion: true, syncOsMotion: false });
    await submitLogin(page);
    await waitForWsReady(page);
    await openFromKeyboard(page);
    await expect(dialog).toHaveCSS("animation-duration", "0s");
  });

  test.describe("reflow at the 940x500 minimum window with 20 px Large Font", () => {
    test.use({ viewport: { width: 940, height: 500 } });

    test("every control is reachable and nothing scrolls sideways", async ({ page }, testInfo) => {
      await boot(page, { fontSize: 20, largeFont: true });
      await openFromKeyboard(page);
      await showErrors(page);
      const dialog = reportDialog(page);
      const overflow = (el: Locator) => el.evaluate((n) => n.scrollWidth - n.clientWidth);
      expect(await overflow(page.locator(".report-dialog"))).toBeLessThanOrEqual(0);
      for (const control of await dialog.locator("input, textarea, button").all()) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
      }
      await testInfo.attach("b9-10-dialog-940x500-20px.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.keyboard.press("Escape");

      const section = await openSafety(page);
      expect(await overflow(section)).toBeLessThanOrEqual(0);
      for (const item of await section.locator(".my-reports-item").all()) {
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeInViewport();
      }
      await testInfo.attach("b9-10-my-reports-940x500-20px.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  });
});
