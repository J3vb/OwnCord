/**
 * B9-23: account, privacy, recovery and settings polish.
 *
 * The account journey — recover, read retention, review/revoke sessions,
 * review the irreversible-action disclosures and cancel/confirm a deletion —
 * must be keyboard-operable, announced, contrast-checked and reflow-safe
 * (BPR-090, BPR-091). These tests run against the real app and assert the
 * observable behaviour:
 *
 * - a validation error is linked to its field (aria-invalid +
 *   aria-describedby) and focus lands on the control to fix;
 * - the recovery overlay's error is associated with every field it can be about;
 * - a destructive action keeps the error text on the qualified status token and
 *   announces it with a live role;
 * - the deletion disclosure and its password field are labelled;
 * - the account pane reflows at the 940x500 minimum window with 20px text.
 *
 * Automated evidence supplements the owner's native AT recordings (NVDA/Orca),
 * which stay pending owner-run with the other B9 lanes.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_AUTH_OK,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import { findUnnamedControls, focusIndicator, textContrast, Q1 } from "./support/b9-accessibility";

const ROUTE_HEALTH = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", version: "1.0.0" },
};
const ROUTE_LOGIN = { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE };
const ROUTE_MESSAGES = { pattern: "/messages", status: 200, body: MOCK_MESSAGES };
const ROUTE_PINS = { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES };

function meRoute(totpEnabled = false) {
  return {
    pattern: "/api/v1/auth/me",
    status: 200,
    body: { ...MOCK_AUTH_OK.payload.user, totp_enabled: totpEnabled },
  };
}

type HttpRoute = { pattern: string; status: number; body: unknown; method?: string };

async function bootAccount(page: Page, extraRoutes: HttpRoute[] = []): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ROUTE_HEALTH,
        ROUTE_LOGIN,
        ROUTE_MESSAGES,
        ROUTE_PINS,
        meRoute(),
        ...extraRoutes,
      ],
      simulateWsFlow: true,
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
  await openSettings(page);
  await switchSettingsTab(page, "Account");
}

const accountPane = (page: Page) =>
  page.locator("[data-testid='settings-overlay'] .settings-pane.active");

// ---------------------------------------------------------------------------
// Connect form: field-linked validation (BPR-091)
// ---------------------------------------------------------------------------

test.describe("B9-23 connect form validation is field-linked", () => {
  test("the host error marks the host input invalid and focuses it", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ROUTE_HEALTH,
          ROUTE_LOGIN,
          {
            pattern: "/api/v1/server-info",
            status: 200,
            body: { name: "Test", protocol_epoch: 1 },
          },
        ],
        simulateWsFlow: false,
      }),
    );
    await page.goto("/");

    const host = page.locator("#host");
    await host.fill("");
    await page.locator("button.btn-primary[type='submit']").click();

    const banner = page.locator(".error-banner.visible");
    await expect(banner).toHaveText(/Server address is required/);
    await expect(host).toHaveAttribute("aria-invalid", "true");
    await expect(host).toHaveAttribute("aria-describedby", "connect-error-banner");
    await expect(host).toBeFocused();
  });

  test("the short-password error marks the password input invalid", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ROUTE_HEALTH,
          { pattern: "/api/v1/auth/login", status: 401, body: { message: "no" } },
        ],
        simulateWsFlow: false,
      }),
    );
    await page.goto("/");

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("user");
    await page.locator("#password").fill("short");
    await page.locator("button.btn-primary[type='submit']").click();

    const password = page.locator("#password");
    await expect(page.locator(".error-banner.visible")).toHaveText(/at least 8 characters/);
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// Account: feedback, disclosure, reflow
// ---------------------------------------------------------------------------

test.describe("B9-23 account settings feedback and disclosure", () => {
  test("a failed password change is announced on the qualified error class", async ({ page }) => {
    await bootAccount(page, [
      {
        pattern: "/api/v1/users/me/password",
        method: "PUT",
        status: 400,
        body: { error: "BAD_REQUEST", message: "Incorrect old password" },
      },
    ]);

    const pane = accountPane(page);
    await pane.locator("#pw-old").fill("wrongold");
    await pane.locator("#pw-new").fill("newpassword123");
    await pane.locator("#pw-confirm").fill("newpassword123");
    await pane.getByRole("button", { name: "Change Password" }).click();

    const status = pane.locator("[data-testid='pw-change-status']");
    await expect(status).toHaveText("Incorrect old password");
    await expect(status).toHaveAttribute("role", "alert");
    await expect(status).toHaveClass(/form-error/);

    // Q1: the error text reads at 4.5:1 against its surface.
    const { ratio } = await textContrast(status);
    expect(ratio).toBeGreaterThanOrEqual(Q1.text);
  });

  test("the deletion disclosure is labelled, and its error is announced", async ({ page }) => {
    await bootAccount(page);
    const pane = accountPane(page);

    await pane.locator("[data-testid='delete-account-trigger']").click();
    const confirmArea = pane.locator("[data-testid='delete-account-confirm-area']");
    await expect(confirmArea).toBeVisible();
    for (const part of ["permanent", "Enter your password to confirm."]) {
      await expect(confirmArea).toContainText(part);
    }

    // The password field has a real label, not just a placeholder.
    const password = pane.locator("[data-testid='delete-account-password']");
    await expect(password).toBeFocused();
    await expect(password).toHaveAccessibleName(/Enter your password/);
    await expect(password).toHaveAttribute("aria-describedby", "delete-account-error");

    await pane.locator("[data-testid='delete-account-confirm']").click();
    const error = pane.locator("[data-testid='delete-account-error']");
    await expect(error).toHaveText("Password is required.");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toHaveClass(/form-error/);
  });

  test("the recovery overlay's error is associated with every field", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          ROUTE_HEALTH,
          ROUTE_LOGIN,
          {
            pattern: "/api/v1/server-info",
            status: 200,
            body: { name: "Test", protocol_epoch: 1 },
          },
        ],
        simulateWsFlow: false,
      }),
    );
    await page.goto("/");

    await page.locator("[data-testid='recover-account-link']").click();
    const overlay = page.locator("[data-testid='recover-overlay']");
    await expect(overlay).toBeVisible();

    // Submit with an empty secret: the error is tied to the fields.
    await overlay.locator("[data-testid='recover-submit']").click();
    const error = overlay.locator("[data-testid='recover-error']");
    await expect(error).not.toHaveText("");
    await expect(error).toHaveAttribute("role", "alert");
    for (const id of ["#recover-username", "#recover-secret", "#recover-password"]) {
      await expect(overlay.locator(id)).toHaveAttribute("aria-describedby", "recover-error");
    }
  });
});

// ---------------------------------------------------------------------------
// Reflow and naming at the minimum window with the largest text
// ---------------------------------------------------------------------------

test.describe("B9-23 account reflow", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("the account pane keeps every control whole, named and on screen at 20px text", async ({
    page,
  }, testInfo) => {
    // Q1's largest text, applied by the real startup path — set before the
    // login so the mocked session survives (setAppearance reloads).
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:fontSize", "20");
      localStorage.setItem("owncord:settings:largeFont", "true");
    });
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [ROUTE_HEALTH, ROUTE_LOGIN, ROUTE_MESSAGES, ROUTE_PINS, meRoute()],
        simulateWsFlow: true,
      }),
    );
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Account");

    const pane = accountPane(page);
    expect(await findUnnamedControls(pane)).toEqual([]);

    // Every control is reachable and none is clipped by an ancestor.
    for (const el of await pane.locator("button, input").all()) {
      if (!(await el.isVisible())) continue;
      await el.scrollIntoViewIfNeeded();
      await expect(el).toBeInViewport();
      expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    // The focused element's ring meets Q1. Reach it by keyboard so Chromium's
    // :focus-visible modality matches (a programmatic focus after a mouse
    // click does not).
    await pane.locator("[data-testid='delete-account-trigger']").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(pane.locator("[data-testid='delete-account-trigger']")).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);

    await testInfo.attach("account-settings-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
