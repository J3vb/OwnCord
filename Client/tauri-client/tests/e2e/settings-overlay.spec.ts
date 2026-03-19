import { test, expect } from "@playwright/test";
import { mockTauriFullSession, navigateToMainPage, openSettings, switchSettingsTab } from "./helpers";

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
    const name = page.locator(".ac-name");
    await expect(name).toHaveText("testuser");
  });

  test("shows account avatar", async ({ page }) => {
    const avatar = page.locator(".ac-avatar");
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

  test("shows theme options", async ({ page }) => {
    const themeOptions = page.locator(".theme-opt");
    const count = await themeOptions.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("clicking theme option activates it", async ({ page }) => {
    const themeOptions = page.locator(".theme-opt");
    const second = themeOptions.nth(1);
    await second.click();

    await expect(second).toHaveClass(/active/);
  });

  test("shows font size slider", async ({ page }) => {
    const slider = page.locator(".settings-slider").first();
    await expect(slider).toBeVisible();
  });

  test("shows compact mode toggle", async ({ page }) => {
    const toggle = page.locator(".toggle").first();
    await expect(toggle).toBeVisible();
  });

  test("toggling compact mode changes toggle state", async ({ page }) => {
    const toggle = page.locator(".toggle").first();
    const initialOn = await toggle.evaluate((el) => el.classList.contains("on"));

    await toggle.click();
    const afterOn = await toggle.evaluate((el) => el.classList.contains("on"));
    expect(afterOn).not.toBe(initialOn);
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

  test("shows notification toggles", async ({ page }) => {
    const toggles = page.locator(".toggle");
    const count = await toggles.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("notification toggles are clickable", async ({ page }) => {
    const toggle = page.locator(".toggle").first();
    const initialOn = await toggle.evaluate((el) => el.classList.contains("on"));

    await toggle.click();
    const afterOn = await toggle.evaluate((el) => el.classList.contains("on"));
    expect(afterOn).not.toBe(initialOn);
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

  test("shows device selectors", async ({ page }) => {
    const selects = page.locator("select.form-input");
    const count = await selects.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("shows voice sensitivity slider", async ({ page }) => {
    const slider = page.locator(".settings-slider");
    await expect(slider.first()).toBeVisible();
  });

  test("shows audio processing toggles", async ({ page }) => {
    const toggles = page.locator(".toggle");
    const count = await toggles.count();
    expect(count).toBeGreaterThanOrEqual(2);
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

  test("shows keybind rows", async ({ page }) => {
    const keybindRows = page.locator(".keybind-row");
    const count = await keybindRows.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("keybind rows show keyboard shortcuts", async ({ page }) => {
    const kbd = page.locator(".kbd").first();
    await expect(kbd).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Tests: Settings — Logs tab
// ---------------------------------------------------------------------------

test.describe("Settings — Logs Tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await openSettings(page);
    await switchSettingsTab(page, "Logs");
  });

  test("shows log viewer", async ({ page }) => {
    const logViewer = page.locator(".log-viewer");
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
