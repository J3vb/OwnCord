import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  joinVoiceChannelByName,
  mockTauriConnect,
  mockTauriConnectWith2FA,
  mockTauriFullSessionWithMessages,
  mockTauriFullSessionWithMessagesAndEcho,
  mockTauriFullSessionWithVoice,
  mockTauriLoginError,
  navigateToMainPage,
  navigateToMainPageReady,
  openSettings,
  submitLogin,
  switchSettingsTab,
} from "./helpers";

// ---------------------------------------------------------------------------
// Automated accessibility scan (axe-core, WCAG 2.0 A and AA) over the main
// screens of the mocked app, plus one keyboard-only journey.
//
// Violations of impact serious or critical are counted per page, as rule id
// to number of offending nodes, and compared with a11y-baseline.json. The
// baseline only shrinks: a new rule or a higher count fails, and so does a
// lower count or a rule that is gone, until the baseline is lowered.
//
//   A11Y_BASELINE_UPDATE=1 npx playwright test a11y-scan   # rewrite the file
//
// The admin panel is served by the real server and is covered by the
// admin config (tests/e2e/admin), not by this mocked suite.
// ---------------------------------------------------------------------------

const BASELINE_PATH = join(import.meta.dirname, "a11y-baseline.json");
const UPDATE = process.env.A11Y_BASELINE_UPDATE === "1";

type Counts = Record<string, number>;
type Baseline = Record<string, Counts>;

const SETTINGS_TABS = [
  "Account",
  "Privacy & safety",
  "My uploads",
  "Appearance",
  "Accessibility",
  "Voice & video",
  "Text & images",
  "Notifications",
  "Keybinds",
  "Advanced",
  "Diagnostics & logs",
  "About",
] as const;

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function sortedObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Rewrites the baseline with this page's counts; an empty page drops its key. */
function writeBaselineEntry(key: string, counts: Counts): void {
  const next = readBaseline();
  if (Object.keys(counts).length === 0) delete next[key];
  else next[key] = sortedObject(counts);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedObject(next), null, 2)}\n`);
}

async function measure(page: Page): Promise<Counts> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const counts: Counts = {};
  for (const violation of results.violations) {
    if (violation.impact !== "serious" && violation.impact !== "critical") continue;
    counts[violation.id] = violation.nodes.length;
  }
  return sortedObject(counts);
}

/** Fails on any serious or critical drift from the baseline, in either direction. */
async function scan(page: Page, key: string): Promise<void> {
  const counts = await measure(page);
  if (UPDATE) {
    writeBaselineEntry(key, counts);
    return;
  }
  const baseline = readBaseline()[key] ?? {};
  const worse: string[] = [];
  const better: string[] = [];
  for (const rule of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const found = counts[rule] ?? 0;
    const allowed = baseline[rule] ?? 0;
    if (found > allowed) worse.push(`${rule}: ${found} nodes, baseline ${allowed}`);
    if (found < allowed) better.push(`${rule}: ${found} nodes, baseline ${allowed}`);
  }
  expect
    .soft(worse, `${key}: new or increased serious/critical accessibility violations`)
    .toEqual([]);
  expect
    .soft(
      better,
      `${key}: fewer violations than the baseline. Lower tests/e2e/a11y-baseline.json ` +
        "(A11Y_BASELINE_UPDATE=1) so it can only shrink",
    )
    .toEqual([]);
}

async function openMain(page: Page): Promise<void> {
  await mockTauriFullSessionWithMessages(page);
  await page.goto("/");
  await navigateToMainPageReady(page);
}

// Tests in this file share one baseline file, so they run in order in one
// worker; a failing page does not stop the ones after it.
test.describe.configure({ mode: "default" });

test.describe("A11y scan: pages", () => {
  test("connect page", async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();
    await expect(page.locator(".server-item").first()).toBeVisible();
    await scan(page, "connect");
  });

  test("sign-in with an error", async ({ page }) => {
    await mockTauriLoginError(page);
    await page.goto("/");
    await submitLogin(page);
    await expect(
      page.locator(".connect-page [role='alert'], .connect-page .error"),
    ).not.toHaveCount(0);
    await scan(page, "sign-in-error");
  });

  test("sign-in with two-factor prompt", async ({ page }) => {
    await mockTauriConnectWith2FA(page);
    await page.goto("/");
    await submitLogin(page);
    await expect(page.locator(".totp-overlay")).not.toHaveClass(/totp-overlay--hidden/);
    await scan(page, "sign-in-2fa");
  });

  test("main channel view", async ({ page }) => {
    await openMain(page);
    await expect(page.locator("[data-testid='message-101']")).toBeVisible();
    await scan(page, "main");
  });

  test("create channel dialog", async ({ page }) => {
    await openMain(page);
    await page.locator("[data-testid='create-channel-text-channels']").click();
    await expect(page.locator("[data-testid='create-channel-modal']")).toBeVisible();
    await scan(page, "create-channel");
  });

  test("invite dialog", async ({ page }) => {
    await openMain(page);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(page.locator(".invite-item").first()).toBeVisible();
    await scan(page, "invite");
  });

  test("call view", async ({ page }) => {
    await mockTauriFullSessionWithVoice(page);
    await page.goto("/");
    await navigateToMainPage(page);
    await joinVoiceChannelByName(page);
    await scan(page, "call");
  });
});

test("settings: every tab", async ({ page }) => {
  await openMain(page);
  await openSettings(page);
  const names = await page
    .locator(".settings-sidebar button.settings-nav-item")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
  // A new tab must be added to the list so it is scanned.
  expect(names.filter((n) => n !== "Log out")).toEqual([...SETTINGS_TABS]);

  for (const tab of SETTINGS_TABS) {
    await switchSettingsTab(page, tab);
    await scan(page, `settings/${tab}`);
  }
});

// ---------------------------------------------------------------------------
// Keyboard-only journey
// ---------------------------------------------------------------------------

/** Tabs forward until the focused element matches `selector`, within `limit` presses. */
async function tabTo(page: Page, selector: string, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`${selector} was not reached by Tab`);
}

test.describe("A11y scan: keyboard journey", () => {
  test("sign in, send a message and open and close a dialog with the keyboard only", async ({
    page,
  }) => {
    await mockTauriFullSessionWithMessagesAndEcho(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();

    // Fill the three fields by tabbing between them.
    const fields = [
      ["host", "localhost:8443"],
      ["username", "testuser"],
      ["password", "password123"],
    ] as const;
    for (const [id, value] of fields) {
      await tabTo(page, `#${id}`, 40);
      await page.keyboard.press("Control+a");
      await page.keyboard.type(value);
    }
    // Shift+Tab goes back to the username and Tab forward again lands on the password.
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#username")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#password")).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-testid='msg-textarea']")).toBeVisible();

    // Tab to the composer and send.
    await tabTo(page, "[data-testid='msg-textarea']");
    await page.keyboard.type("Sent with the keyboard");
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".message .msg-text", { hasText: "Sent with the keyboard" }),
    ).toBeVisible();

    // Reach the settings button, open it, and check focus is visible.
    await tabTo(page, "button[aria-label='Settings']");
    await expect(page.locator("button[aria-label='Settings']")).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-testid='settings-overlay']")).toHaveClass(/open/);
    const inside = await page.evaluate(
      () => document.querySelector(".settings-panel")?.contains(document.activeElement) ?? false,
    );
    expect(inside).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid='settings-overlay']")).not.toHaveClass(/open/);
    await expect(page.locator("button[aria-label='Settings']")).toBeFocused();
  });
});
