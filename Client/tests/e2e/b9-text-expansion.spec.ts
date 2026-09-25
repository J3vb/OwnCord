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
    await expect(page.locator(".form-switch button")).toHaveText("Need an account? Register");
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
      [page.locator(".form-switch button"), "Need an account? Register"],
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
    await page.locator(".form-switch button").click();
    await expect(page.locator(".form-switch button")).toHaveText(
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
// B9-19: messaging, rich-content and media text. The main page and its pickers
// are built after the seam switch, so the message actions, the pinned panel and
// the search overlay resolve through the expanded catalog.
// ---------------------------------------------------------------------------

test.describe("B9-19 messaging text", () => {
  test.use({ viewport: { width: 940, height: 500 } });

  test("reads the messaging catalogs' English copy", async ({ page }) => {
    await startAtLargestText(page);
    await navigateToMainPageReady(page);

    const own = page.locator("[data-testid='message-101']");
    await own.hover();
    await expect(page.locator("[data-testid='msg-reply-101']")).toHaveAccessibleName("Reply");
    await expect(page.locator("[data-testid='msg-edit-101']")).toHaveAccessibleName("Edit");
    await expect(page.locator("[data-testid='msg-react-101']")).toHaveAccessibleName("React");

    await page.locator("[data-testid='pin-btn']").click();
    const panel = page.locator(".pinned-panel");
    await expect(panel).toHaveAccessibleName("Pinned messages");
    await expect(panel.locator(".pinned-panel__close")).toHaveAccessibleName(
      "Close pinned messages",
    );
    await page.locator(".pinned-panel__close").click();

    await expect(page.locator("[data-testid='search-input']")).toHaveAttribute(
      "placeholder",
      "Search...",
    );
    await page.locator("[data-testid='search-input']").focus();
    await expect(page.locator("[data-testid='search-overlay-input']")).toHaveAttribute(
      "placeholder",
      "Search messages...",
    );
  });

  test("keeps expanded message-action names operable at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await startAtLargestText(page);
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");
    // Sign in after the switch: the message rows, pinned panel and search
    // overlay are all built through the expanded seam.
    await navigateToMainPageReady(page);

    const own = page.locator("[data-testid='message-101']");
    await own.scrollIntoViewIfNeeded();
    await own.hover();
    for (const [testId, english] of [
      ["msg-react-101", "React"],
      ["msg-reply-101", "Reply"],
      ["msg-edit-101", "Edit"],
      ["msg-delete-101", "Delete"],
    ] as const) {
      const btn = page.locator(`[data-testid='${testId}']`);
      await expect(btn).toHaveAccessibleName(expanded(english));
      await expect(btn).toBeVisible();
    }

    // The pinned panel's complementary landmark and close control are named
    // from the seam, and its empty state stays whole.
    await page.locator("[data-testid='pin-btn']").click();
    const panel = page.locator(".pinned-panel");
    await expect(panel).toHaveAccessibleName(expanded("Pinned messages"));
    await expect(panel.locator(".pinned-panel__close")).toHaveAccessibleName(
      expanded("Close pinned messages"),
    );
    await expectWhole(panel.locator(".pinned-panel__close"));
    await panel.locator(".pinned-panel__close").click();

    // The search overlay resolves its placeholder and label through the seam.
    await page.locator("[data-testid='search-input']").focus();
    const searchInput = page.locator("[data-testid='search-overlay-input']");
    await expect(searchInput).toHaveAttribute(
      "placeholder",
      new RegExp("^⟦Search messages\\.\\.\\. .+⟧$"),
    );
    await expect(searchInput).toHaveAccessibleName(expanded("Search messages"));
    expect(await findUnnamedControls(page.locator("[data-testid='search-overlay']"))).toEqual([]);

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("messaging-expanded-940x500-20px.png", {
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
      await expect(content.getByText(english, { exact: true }).first()).toBeVisible();
    }
  });

  test("keeps expanded settings and account text whole, named and keyboard-operable at 940×500 with 20px text", async ({
    page,
  }, testInfo) => {
    await startAtLargestText(page);
    await navigateToMainPageReady(page);
    // Open before the switch: the Settings button's own name comes from shell.ts,
    // and only a tab switched afterwards re-renders through the expanded seam.
    await openSettings(page);
    test.skip(!(await expandCatalogText(page)), "needs the dev server's modules");

    // Walk every tab from the keyboard: ArrowDown moves focus to the next tab
    // and activates it, so each panel is rebuilt through the expanded seam.
    const sidebar = page.locator("[data-testid='settings-overlay'] .settings-sidebar");
    const account = page.locator("[data-testid='settings-overlay'] .settings-content");
    const activeTab = sidebar.locator("[role='tab'][aria-selected='true']");
    const tabCount = await sidebar.getByRole("tab").count();
    await activeTab.focus();
    const visited = new Set<string>();
    for (let i = 0; i < tabCount; i++) {
      await page.keyboard.press("ArrowDown");
      await expect(activeTab).toBeFocused();
      visited.add((await activeTab.getAttribute("id")) ?? "");
      // Every control on the tab has an accessible name built from the seam.
      expect(await findUnnamedControls(account)).toEqual([]);
    }
    expect(visited.size).toBe(tabCount);

    // Home reaches Account, the first tab.
    await page.keyboard.press("Home");
    await expect(sidebar.locator("#settings-tab-account")).toBeFocused();
    await expect(sidebar.locator("#settings-tab-account")).toHaveAttribute("aria-selected", "true");
    for (const [el, english] of [
      [account.locator(".account-field-label", { hasText: "Username" }), "Username"],
      [account.locator("[data-testid='profile-save-btn']"), "Save Profile"],
      [account.locator("[data-testid='delete-account-trigger']"), "Delete Account"],
    ] as const) {
      await expect(el).toHaveText(expanded(english));
      await expectWhole(el);
    }

    // The deletion form opens, refuses an empty password and closes, all from
    // the keyboard, with every control named.
    const trigger = account.locator("[data-testid='delete-account-trigger']");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const password = account.locator("[data-testid='delete-account-password']");
    await expect(password).toBeFocused();
    await expect(password).toHaveAccessibleName(expanded("Enter your password"));
    expect(await findUnnamedControls(account)).toEqual([]);
    await page.keyboard.press("Tab");
    await expect(account.locator("[data-testid='delete-account-confirm']")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(account.locator("[data-testid='delete-account-error']")).toHaveText(
      expanded("Password is required."),
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(account.locator("[data-testid='delete-account-confirm-area']")).toBeHidden();
    await expect(trigger).toBeVisible();

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

    // Mute toggles from the keyboard under its expanded name.
    const mute = widget.getByRole("button", { name: expanded("Mute") });
    const pressed = await mute.getAttribute("aria-pressed");
    await mute.focus();
    await page.keyboard.press("Space");
    await expect(mute).not.toHaveAttribute("aria-pressed", pressed ?? "");
    await page.keyboard.press("Enter");
    await expect(mute).toHaveAttribute("aria-pressed", pressed ?? "false");

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await testInfo.attach("voice-widget-expanded-940x500-20px.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
