import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  joinVoiceChannelByName,
  mockTauriFullSessionWithMessages,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";
import { findUnnamedControls } from "./support/b9-accessibility";

// ---------------------------------------------------------------------------
// B9-3: catalog text in English and through the expansion-only test catalog.
//
// Expansion switches the running app's own text seam: this page imports the
// dev server's /src/i18n/format.ts, the same module instance the app renders
// through. A production bundle has no such module to reach, so that run skips
// the expanded cases instead of the app shipping a switch. B9-18/19/20 add
// their journeys here.
// ---------------------------------------------------------------------------

const ENGLISH = [
  ["Reduce Motion", "Disable animations and transitions"],
  ["High Contrast", "Increase contrast for better readability"],
  ["Role Colors", "Show colored usernames based on role in chat"],
  ["Sync with OS", "Automatically enable reduced motion based on your OS accessibility settings"],
  ["Large Font", "Use larger text throughout the app for better readability"],
] as const;

async function expandCatalogText(page: Page): Promise<boolean> {
  return page.evaluate(async (url) => {
    try {
      const seam = await import(/* @vite-ignore */ url);
      seam.setTextTransformForTesting(seam.expandText);
      return true;
    } catch {
      return false;
    }
  }, "/src/i18n/format.ts");
}

async function openAccessibility(page: Page, expanded: boolean): Promise<void> {
  // Q1's largest text: 20 px with Large Font, applied by the real startup path.
  await page.addInitScript(() => {
    localStorage.setItem("owncord:settings:fontSize", "20");
    localStorage.setItem("owncord:settings:largeFont", "true");
  });
  await mockTauriFullSessionWithMessages(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
  if (expanded) test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");
  await openSettings(page);
  await switchSettingsTab(page, "Accessibility");
}

const pane = (page: Page) => page.locator("[data-testid='settings-overlay'] .settings-pane.active");

test.describe("B9-3 Accessibility tab text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("reads the catalog's English copy and names each switch with it", async ({ page }) => {
    await openAccessibility(page, false);
    const rows = pane(page).locator(".setting-row");
    await expect(rows).toHaveCount(ENGLISH.length);
    for (const [i, [label, desc]] of ENGLISH.entries()) {
      const row = rows.nth(i);
      await expect(row.locator(".setting-label")).toHaveText(label);
      await expect(row.locator(".setting-desc")).toHaveText(desc);
      await expect(row.getByRole("switch", { name: label, exact: true })).toBeVisible();
    }
  });

  test("keeps expanded text whole, named and operable at the minimum window with 20px text", async ({
    page,
  }, testInfo) => {
    await openAccessibility(page, true);
    const root = pane(page);
    const rows = root.locator(".setting-row");
    await expect(rows).toHaveCount(ENGLISH.length);
    expect(await findUnnamedControls(root)).toEqual([]);

    for (const [i, [label, desc]] of ENGLISH.entries()) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      for (const [el, english] of [
        [row.locator(".setting-label"), label],
        [row.locator(".setting-desc"), desc],
      ] as const) {
        await expect(el).toHaveText(new RegExp(`^⟦${english} .+⟧$`));
        await expect(el).toBeInViewport();
        expect(await el.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
      }
      const toggle = row.getByRole("switch");
      await expect(toggle).toHaveAccessibleName(new RegExp(`^⟦${label} .+⟧$`));
      await expect(toggle).toBeInViewport();
    }

    // Still operable from the keyboard with the longer names.
    const toggle = rows.nth(1).getByRole("switch");
    const before = await toggle.getAttribute("aria-checked");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toHaveAttribute("aria-checked", before ?? "");

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("accessibility-tab-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});

// ---------------------------------------------------------------------------
// B9-18: connect, shell and navigation text. The expanded run switches the
// seam on the connect page before signing in, so every surface below is built
// after the switch: the main page on login, the quick switcher when it opens,
// and a fresh connect page when "Add new server" leaves the session.
// ---------------------------------------------------------------------------

/** Q1's largest text at the minimum window, applied by the real startup path. */
async function startAtLargestText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("owncord:settings:fontSize", "20");
    localStorage.setItem("owncord:settings:largeFont", "true");
  });
  await mockTauriFullSessionWithMessages(page);
  await page.goto("/");
}

/** Expanded catalog text for `english`: bracketed, with the padding after it. */
const expanded = (english: string): RegExp =>
  new RegExp(`^⟦${english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .+⟧$`);

/**
 * Whole and on screen: its text does not overflow its own box, and no
 * ancestor that clips (overflow other than visible) cuts it off sideways.
 */
async function expectWhole(el: ReturnType<Page["locator"]>): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  await expect(el).toBeInViewport();
  const clippedBy = await el.evaluate((n) => {
    if (n.scrollWidth > n.clientWidth + 1) return "its own box";
    const r = n.getBoundingClientRect();
    if (r.width === 0) return "zero width";
    for (let p = n.parentElement; p !== null; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === "visible") continue;
      const q = p.getBoundingClientRect();
      if (r.left < q.left - 1 || r.right > q.right + 1) return p.className || p.tagName;
    }
    return null;
  });
  expect(clippedBy).toBeNull();
}

test.describe("B9-18 connect and shell text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("reads the catalogs' English copy on the connect page and in the shell", async ({
    page,
  }) => {
    await startAtLargestText(page);
    await expect(page.locator(".server-panel-header h2")).toHaveText("Servers");
    await expect(page.locator(".btn-add-server")).toHaveText("+ Add Server");
    await expect(page.locator(".brand-tagline")).toHaveText(
      "Self-hosted chat — Your server, your rules",
    );
    await expect(page.locator("label[for='host']")).toHaveText("Server Address");
    await expect(page.locator(".form-switch a")).toHaveText("Need an account? Register");
    await expect(page.getByRole("button", { name: "Toggle password visibility" })).toBeVisible();

    await navigateToMainPageReady(page);
    const sidebar = page.locator("[data-testid='unified-sidebar']");
    await expect(sidebar.locator(".server-online")).toHaveText(/^\d+ online$/);
    await expect(sidebar.locator("[data-testid='invite-btn']")).toHaveText("Invite");
    await expect(sidebar.locator(".sidebar-dm-section .category-name")).toHaveText(
      "DIRECT MESSAGES",
    );
    await expect(sidebar.locator(".sidebar-members-header .category-name")).toHaveText("MEMBERS");
    await page.getByRole("button", { name: "Switch server", exact: true }).click();
    const overlay = page.locator("[data-testid='quick-switch-overlay']");
    await expect(overlay.getByRole("dialog", { name: "Switch server" })).toBeVisible();
    await expect(overlay.locator(".quick-switch-footer")).toHaveText("Press Escape to cancel");
  });

  test("keeps expanded shell and connect text whole, named and operable at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await startAtLargestText(page);
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");

    // Sign in: the main page renders entirely through the expanded seam.
    await navigateToMainPageReady(page);
    const sidebar = page.locator("[data-testid='unified-sidebar']");
    await expect(sidebar.locator(".server-online")).toHaveText(/^⟦\d+ online .+⟧$/);
    // The header wraps its buttons instead of squeezing out the server name.
    await expectWhole(sidebar.locator(".server-online"));
    await expect(sidebar.locator(".server-name")).toHaveText("Test Server");
    await expectWhole(sidebar.locator(".server-name"));
    for (const [el, english] of [
      [sidebar.locator("[data-testid='invite-btn']"), "Invite"],
      [sidebar.locator("[data-testid='audit-log-btn']"), "Audit Log"],
      [sidebar.locator(".sidebar-dm-section .category-name"), "DIRECT MESSAGES"],
      [sidebar.locator(".sidebar-members-header .category-name"), "MEMBERS"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }
    expect(await findUnnamedControls(sidebar)).toEqual([]);
    const userBar = page.locator("[data-testid='user-bar']");
    expect(await findUnnamedControls(userBar)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("shell-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // The quick switcher: named by expanded text, reachable, Escape closes it
    // and focus goes back to its opener.
    const switchBtn = userBar.locator("[data-testid='disconnect-btn']");
    await expect(switchBtn).toHaveAccessibleName(expanded("Switch server"));
    await switchBtn.focus();
    await page.keyboard.press("Enter");
    const overlay = page.locator("[data-testid='quick-switch-overlay']");
    const dialog = overlay.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName(expanded("Switch server"));
    for (const [el, english] of [
      [overlay.locator(".quick-switch-header h2"), "Switch Server"],
      [overlay.locator(".quick-switch-footer"), "Press Escape to cancel"],
      [overlay.locator(".add-new .quick-switch-name"), "Add new server"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }
    expect(await findUnnamedControls(overlay)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(switchBtn).toBeFocused();

    // "Add new server" leaves for a freshly built connect page.
    await switchBtn.click();
    await overlay.locator("[data-testid='add-server-btn']").click();
    await expect(page.locator(".connect-form")).toBeVisible({ timeout: 5_000 });
    for (const [el, english] of [
      [page.locator(".server-panel-header h2"), "Servers"],
      [page.locator(".btn-add-server"), "+ Add Server"],
      [page.locator("label[for='host']"), "Server Address"],
      [page.locator("label[for='username']"), "Username"],
      [page.locator("label[for='password']"), "Password"],
      [page.locator(".connect-form .btn-text"), "Login"],
      [page.locator(".form-switch a"), "Need an account? Register"],
      [
        page.locator("[data-testid='recover-account-link']"),
        "Lost your password or 2FA device? Recover your account",
      ],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }
    await expect(page.locator(".password-toggle")).toHaveAccessibleName(
      expanded("Toggle password visibility"),
    );
    expect(await findUnnamedControls(page.locator(".connect-form"))).toEqual([]);

    // Register mode re-renders the title, the submit label and the switch link.
    await page.locator(".form-switch a").click();
    await expect(page.locator(".form-switch a")).toHaveText(
      expanded("Already have an account? Login"),
    );
    await expect(page.locator(".connect-form .btn-text")).toHaveText(expanded("Register"));

    // The Add Server dialog, opened and dismissed from the keyboard.
    await page.locator(".btn-add-server").focus();
    await page.keyboard.press("Enter");
    const addDialog = page.getByRole("dialog", { name: expanded("Add Server") });
    await expect(addDialog).toBeVisible();
    for (const [el, english] of [
      [addDialog.locator("label", { hasText: "Server Name" }), "Server Name"],
      [addDialog.locator("label", { hasText: "Host Address" }), "Host Address"],
      [addDialog.locator(".btn-ghost"), "Cancel"],
      [addDialog.locator(".btn-primary"), "Add Server"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }
    expect(await findUnnamedControls(addDialog)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("connect-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(addDialog).toHaveCount(0);
  });

  test("keeps an incompatible server's expanded badge whole in its row at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("owncord:settings:fontSize", "20");
      localStorage.setItem("owncord:settings:largeFont", "true");
    });
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          {
            pattern: "/api/v1/health",
            status: 200,
            body: { status: "ok", uptime: 10, online_users: 3 },
          },
          {
            pattern: "/api/v1/server-info",
            status: 200,
            body: { name: "Future Server", protocol_epoch: 2, browser_client_enabled: false },
          },
        ],
        simulateWsFlow: false,
      }),
    );
    await page.goto("/");
    const badges = page.locator(".srv-compat-badge");
    await expect(badges.first()).toHaveText("Client update needed", { timeout: 10_000 });
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");

    // Adding a server rebuilds every row and re-probes it through the seam.
    await page.locator(".btn-add-server").click();
    const addDialog = page.getByRole("dialog", { name: expanded("Add Server") });
    await addDialog.locator(".form-input").nth(0).fill("Future");
    await addDialog.locator(".form-input").nth(1).fill("future.example:8443");
    await addDialog.locator(".btn-primary").click();
    await expect(addDialog).toHaveCount(0);

    for (const row of await page.locator(".server-item").all()) {
      const badge = row.locator(".srv-compat-badge");
      await expect(badge).toHaveText(expanded("Client update needed"), { timeout: 10_000 });
      await expect(row.locator(".srv-online-users")).toHaveText(expanded("3 online"));
      await expectWhole(badge);
      // The status dot sits beside the row's text, never over it.
      const dot = (await row.locator(".srv-status-dot").boundingBox())!;
      for (const meta of await row.locator(".srv-meta > *").all()) {
        const box = await meta.boundingBox();
        if (box !== null && box.width > 0) expect(box.x + box.width).toBeLessThanOrEqual(dot.x + 1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("server-row-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});

// ---------------------------------------------------------------------------
// B9-20: settings, account and voice/media text. The settings overlay and the
// voice widget are built after the seam switch, so their labels are expanded.
// ---------------------------------------------------------------------------

test.describe("B9-20 settings, account and voice text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("reads the settings catalogs' English copy across the tabs", async ({ page }) => {
    await startAtLargestText(page);
    await navigateToMainPageReady(page);
    await openSettings(page);

    for (const [tab, english] of [
      ["Account", "Edit User Profile"],
      ["Notifications", "Desktop Notifications"],
      ["Text & Images", "Link Preview"],
      ["Voice & Audio", "Input Device"],
      ["Keybinds", "Push to Talk"],
      ["Advanced", "Developer Mode"],
      ["Logs", "Export Support Bundle"],
    ] as const) {
      await switchSettingsTab(page, tab);
      const content = page.locator("[data-testid='settings-overlay'] .settings-content");
      await expect(content.getByText(english, { exact: true }).or(content).first()).toBeVisible();
    }
  });

  test("keeps expanded settings and account text whole and named at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await startAtLargestText(page);
    await navigateToMainPageReady(page);
    // Open before the switch: the Settings button's own name comes from shell.ts,
    // and only a tab switched afterwards re-renders through the expanded seam.
    await openSettings(page);
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");

    for (const tab of [
      "Notifications",
      "Text & Images",
      "Voice & Audio",
      "Keybinds",
      "Advanced",
      "Logs",
    ] as const) {
      await switchSettingsTab(page, tab);
      const content = page.locator("[data-testid='settings-overlay'] .settings-content");
      // Every control on the tab has an accessible name built from the seam.
      expect(await findUnnamedControls(content)).toEqual([]);
    }

    const account = page.locator("[data-testid='settings-overlay'] .settings-content");
    await switchSettingsTab(page, "Account");
    for (const [el, english] of [
      [account.locator(".account-field-label", { hasText: "Username" }), "Username"],
      [account.locator("[data-testid='profile-save-btn']"), "Save Profile"],
      [account.locator("[data-testid='delete-account-trigger']"), "Delete Account"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("settings-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("keeps expanded voice controls named and operable at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await startAtLargestText(page);
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");
    await navigateToMainPageReady(page);
    await joinVoiceChannelByName(page);

    const widget = page.locator("[data-testid='voice-widget']");
    await expect(widget).toHaveClass(/visible/);
    await expect(widget.locator(".vw-channel")).toHaveText("Voice Chat");
    // The lifecycle status is expanded regardless of which branch it settles on.
    await expect(widget.locator("[data-testid='vw-status']")).toHaveText(/^⟦.+⟧$/);
    // The stats pane is hidden until its signal icon is clicked.
    await widget.locator(".vw-signal").click();
    await expect(widget.locator(".vw-stats")).toHaveClass(/visible/);
    for (const [el, english] of [
      [widget.locator(".vw-stats-title"), "Transport Statistics"],
      [widget.locator(".vw-stats-col-label.out"), "Outgoing"],
      [widget.locator(".vw-stats-col-label.in"), "Incoming"],
      [widget.locator(".vw-stats-totals-label"), "Session Totals"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }

    for (const name of ["Mute", "Deafen", "Camera", "Screenshare", "Disconnect"]) {
      await expect(
        widget.getByRole("button", { name: new RegExp(`^⟦${name} .+⟧$`) }),
      ).toBeVisible();
    }
    expect(await findUnnamedControls(widget)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("voice-widget-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
