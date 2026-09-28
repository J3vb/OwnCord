import { test, expect } from "./fixtures";
import {
  mockTauriFullSession,
  navigateToMainPage,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import { Q1, findUnnamedControls, focusIndicator, textContrast } from "./support/b9-accessibility";
import { ZOOM_VIEWPORT, expectScreenReflows } from "./support/b9-zoom";

// ---------------------------------------------------------------------------
// Tests: Settings Overlay — structure
// ---------------------------------------------------------------------------

test.describe("Settings Overlay", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("settings overlay opens from user bar", async ({ page }) => {
    await openSettings(page);

    const overlay = page.locator("[data-testid='settings-overlay']");
    await expect(overlay).toHaveClass(/open/);
  });

  test("settings overlay has sidebar with tabs", async ({ page }) => {
    await openSettings(page);

    const sidebar = page.locator(".settings-sidebar");
    await expect(sidebar).toBeVisible();

    const tabs = sidebar.locator("button.settings-nav-item");
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test("settings overlay starts on Account tab", async ({ page }) => {
    await openSettings(page);

    const activeTab = page.locator(".settings-sidebar button.settings-nav-item.active");
    await expect(activeTab).toHaveText("Account");
  });

  test("close button closes settings", async ({ page }) => {
    await openSettings(page);

    const closeBtn = page.locator(".settings-close-btn");
    await closeBtn.click();

    const overlay = page.locator("[data-testid='settings-overlay']");
    await expect(overlay).not.toHaveClass(/open/);
  });

  test("Escape key closes settings", async ({ page }) => {
    await openSettings(page);

    await page.keyboard.press("Escape");

    const overlay = page.locator("[data-testid='settings-overlay']");
    await expect(overlay).not.toHaveClass(/open/);
  });

  test("has Log Out button with danger class", async ({ page }) => {
    await openSettings(page);

    const logoutBtn = page.locator(".settings-nav-item.danger");
    await expect(logoutBtn).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Account tab
// ---------------------------------------------------------------------------

test.describe("Settings — Account Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
  });

  test("shows username in account card", async ({ page }) => {
    const name = page.locator(".account-header-name");
    await expect(name).toHaveText("testuser");
  });

  test("shows account avatar", async ({ page }) => {
    const avatar = page.locator(".account-avatar-large");
    await expect(avatar).toBeVisible();
  });

  test("has password change fields", async ({ page }) => {
    const passwordInputs = page.locator(".settings-content input[type='password']");
    const count = await passwordInputs.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("has Change Password button", async ({ page }) => {
    const changePwBtn = page.locator(".ac-btn", { hasText: "Change Password" });
    await expect(changePwBtn).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Appearance tab
// ---------------------------------------------------------------------------

test.describe("Settings — Appearance Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);

    await switchSettingsTab(page, "Appearance");
  });

  test("clicking theme option activates it and applies the body class", async ({ page }) => {
    const themeOptions = page.locator(".theme-opt");
    const second = themeOptions.nth(1);
    await second.click();

    await expect(second).toHaveClass(/active/);
    // The activation is only real if it reaches the rendered document.
    await expect(second).toHaveAttribute("aria-checked", "true");
    const themeName = await second.evaluate((el) => {
      for (const name of ["dark", "neon-glow", "midnight", "light"]) {
        if (el.classList.contains(name)) return name;
      }
      return "";
    });
    expect(themeName).not.toBe("");
    await expect(page.locator("body")).toHaveClass(new RegExp(`theme-${themeName}`));
  });

  test("shows font size slider", async ({ page }) => {
    const slider = page.locator(".settings-slider").first();
    await expect(slider).toBeVisible();
  });

  test("toggling compact mode changes toggle state and the document", async ({ page }) => {
    const toggle = page.locator(".setting-row", { hasText: "Compact Mode" }).locator(".toggle");
    const initialOn = await toggle.evaluate((el) => el.classList.contains("on"));
    const initialClass = await page.evaluate(() =>
      document.documentElement.classList.contains("compact-mode"),
    );

    await toggle.click();

    const afterOn = await toggle.evaluate((el) => el.classList.contains("on"));
    expect(afterOn).not.toBe(initialOn);
    // The toggle is only real if it drives the document class it names.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("compact-mode")))
      .toBe(!initialClass);
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Notifications tab
// ---------------------------------------------------------------------------

test.describe("Settings — Notifications Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await switchSettingsTab(page, "Notifications");
  });

  test("notification toggles persist their state", async ({ page }) => {
    // Named rows, not a bare count: the tab must render the documented toggles.
    await expect(page.locator(".setting-row", { hasText: "Desktop Notifications" })).toBeVisible();
    await expect(page.locator(".setting-row", { hasText: "Suppress @everyone" })).toBeVisible();

    const row = page.locator(".setting-row", { hasText: "Desktop Notifications" });
    const toggle = row.locator(".toggle");
    const initialOn = await toggle.evaluate((el) => el.classList.contains("on"));

    await toggle.click();

    // `/(?!on)/` would match any string (an empty match always satisfies the
    // lookahead), so the rendered state was never actually checked. Assert the
    // class the toggle must hold after the click.
    if (initialOn) {
      await expect(toggle).not.toHaveClass(/\bon\b/);
    } else {
      await expect(toggle).toHaveClass(/\bon\b/);
    }
    // A toggle that does not persist is not a settings control.
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("owncord:settings:desktopNotifications")),
      )
      .toBe(JSON.stringify(!initialOn));
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Voice & Audio tab
// ---------------------------------------------------------------------------

test.describe("Settings — Voice & Audio Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await switchSettingsTab(page, "Voice & Audio");
  });

  test("shows device selectors for input and output", async ({ page }) => {
    // Named sections, not a bare select count: the tab must offer both the
    // input and output device pickers.
    const pane = page.locator(".settings-pane", { hasText: "Input Device" });
    await expect(pane).toBeVisible();
    await expect(page.locator("h3", { hasText: "Output Device" })).toBeVisible();

    const selects = page.locator("select.form-input");
    await expect(selects.first()).toBeVisible();
    // Each selector has at least a Default option to choose.
    await expect(selects.first().locator("option", { hasText: "Default" })).toHaveCount(1);
  });

  test("shows voice sensitivity slider", async ({ page }) => {
    const slider = page.locator(".settings-slider");
    await expect(slider.first()).toBeVisible();
  });

  test("shows audio processing toggles", async ({ page }) => {
    const toggles = page.locator(".toggle");
    await expect(toggles.first()).toBeVisible();
    expect(await toggles.count()).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Keybinds tab
// ---------------------------------------------------------------------------

test.describe("Settings — Keybinds Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await switchSettingsTab(page, "Keybinds");
  });

  test("keybind rows show named actions and their shortcuts", async ({ page }) => {
    // Push to Talk is a real rebindable row with a kbd chip.
    const pttRow = page.locator(".keybind-row", { hasText: "Push to Talk" });
    await expect(pttRow).toBeVisible();
    await expect(pttRow.locator(".kbd")).toBeVisible();

    // The shortcut rendered is the app's actual binding text, not a placeholder.
    const kbd = pttRow.locator(".kbd");
    await expect(kbd).not.toBeEmpty();
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Diagnostics & logs tab
// ---------------------------------------------------------------------------

test.describe("Settings — Diagnostics & logs Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await switchSettingsTab(page, "Logs");
  });

  test("names every control, rings the disclosure summaries and keeps status text readable", async ({
    page,
  }) => {
    const pane = page.locator("[data-testid='settings-overlay'] .settings-pane.active");
    await pane
      .getByRole("checkbox", { name: "Include a brief microphone permission check" })
      .uncheck();
    await page.getByTestId("diagnostics-start").click();
    await expect(page.getByTestId("diagnostics-status")).toContainText("Test complete", {
      timeout: 15_000,
    });
    expect(await findUnnamedControls(pane)).toEqual([]);

    const failures: string[] = [];
    for (const selector of [
      ".summary-line .disclose-count",
      ".diag-step-btn[aria-pressed='true'] .diag-step-label",
      ".diag-step-btn[aria-pressed='false'] .diag-step-label",
      ".diag-step-detail",
      "summary .disclose-count",
    ]) {
      const { ratio } = await textContrast(pane.locator(selector).first());
      if (ratio < Q1.text) failures.push(`${selector} ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);

    // Keyboard focus on a disclosure summary draws the shared focus ring.
    const summary = pane.locator("summary", { hasText: "Client logs" });
    await summary.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(summary).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.locator(".log-viewer")).toBeVisible();
  });

  test("steps through the connection stages by keyboard and reflows at 200 % zoom", async ({
    page,
  }, testInfo) => {
    const pane = page.locator("[data-testid='settings-overlay'] .settings-pane.active");
    await pane
      .getByRole("checkbox", { name: "Include a brief microphone permission check" })
      .uncheck();
    await page.getByTestId("diagnostics-start").click();
    await expect(page.getByTestId("diagnostics-status")).toContainText("Test complete", {
      timeout: 15_000,
    });
    const stages = pane.locator("ol.diag-stepper > li");
    await expect(stages).toHaveCount(6);

    const server = pane.getByRole("button", { name: /^Server — Server connection, / });
    await server.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(server).toBeFocused();
    expect((await focusIndicator(page)).problems).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(server).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("diagnostics-detail")).toContainText("Server connection");

    await page.setViewportSize(ZOOM_VIEWPORT);
    await expectScreenReflows(
      page,
      {
        name: "diagnostics-stepper-640x400.png",
        root: page.locator("[data-testid='settings-overlay'] .settings-content"),
        actions: [stages.last().locator("button")],
      },
      testInfo,
    );
  });

  test("shows log viewer once the client logs disclosure is opened", async ({ page }) => {
    const logViewer = page.locator(".log-viewer");
    await expect(logViewer).toBeHidden();
    await page.locator("summary", { hasText: "Client logs" }).click();
    await expect(logViewer).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — tab switching
// ---------------------------------------------------------------------------

test.describe("Settings — Tab Switching", () => {
  test("switching tabs updates active class and content", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);

    const tabs = page.locator(".settings-sidebar button.settings-nav-item");

    // Click each tab and verify it becomes active
    const tabCount = await tabs.count();
    for (let i = 0; i < Math.min(tabCount, 6); i++) {
      const tab = tabs.nth(i);
      const tabName = await tab.textContent();

      // Skip Log Out button
      if (tabName === "Log Out") continue;

      await tab.click();
      await expect(tab).toHaveClass(/active/);
    }
  });
});
