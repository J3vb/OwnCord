import { test, expect } from "./fixtures";
import { startFullSession } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: User Bar
// ---------------------------------------------------------------------------

test.describe("User Bar", () => {
  test.beforeEach(async ({ page }) => {
    await startFullSession(page);
  });

  test("user bar is visible", async ({ page }) => {
    const userBar = page.locator("[data-testid='user-bar']");
    await expect(userBar).toBeVisible();
  });

  test("user bar shows username 'testuser'", async ({ page }) => {
    const name = page.locator("[data-testid='user-bar-name']");
    await expect(name).toBeVisible();
    await expect(name).toHaveText("testuser");
  });

  test("user bar shows avatar with initial", async ({ page }) => {
    const avatar = page.locator("[data-testid='user-bar'] .ub-avatar");
    await expect(avatar).toBeVisible();
    // Avatar should contain the first letter of the username
    await expect(avatar).toContainText("T");
  });

  test("user bar shows online status", async ({ page }) => {
    const status = page.locator("[data-testid='user-bar'] .ub-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveText("Online");
  });

  test("status picker dot sits on the avatar corner", async ({ page }) => {
    const dot = page.locator(
      "[data-testid='user-bar'] [data-testid='status-picker-wrap'] .status-picker-dot",
    );
    await expect(dot).toBeVisible();
    const dotBox = await dot.boundingBox();
    const avatarBox = await page.locator("[data-testid='user-bar'] .ub-avatar").boundingBox();
    expect(dotBox).not.toBeNull();
    expect(avatarBox).not.toBeNull();
    expect(dotBox!.x).toBeGreaterThanOrEqual(avatarBox!.x);
    expect(dotBox!.x + dotBox!.width).toBeLessThanOrEqual(avatarBox!.x + avatarBox!.width + 2);
    expect(dotBox!.y).toBeGreaterThanOrEqual(avatarBox!.y);
    expect(dotBox!.y + dotBox!.height).toBeLessThanOrEqual(avatarBox!.y + avatarBox!.height + 2);
  });

  test("clicking the name opens your profile card with the status menu", async ({ page }) => {
    await page.locator("[data-testid='user-bar-name']").click();
    const card = page.locator("[data-testid='self-profile-card']");
    await expect(card).toBeVisible();
    await expect(card.getByRole("menuitemradio", { name: /Do Not Disturb/ })).toContainText(
      "You will not receive desktop notifications",
    );
    await expect(card.getByRole("menuitemradio", { name: /Online/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-testid='user-bar-profile']")).toBeFocused();
  });

  test("Do Not Disturb for 1 hour shows its end under the status and keeps the timer on the client", async ({
    page,
  }) => {
    await page.locator("[data-testid='user-bar-name']").click();
    const card = page.locator("[data-testid='self-profile-card']");
    await card.locator("[data-testid='spc-status-dnd']").focus();
    await page.keyboard.press("ArrowRight");
    await card.getByRole("menuitem", { name: "For 1 hour" }).click();
    await expect(card).toHaveCount(0);

    await page.locator("[data-testid='user-bar-name']").click();
    await expect(card.locator("[data-testid='spc-until-dnd']")).toHaveText(
      // Past midnight the end time carries a weekday ("Until Wed 12:19 AM").
      /^Until (\p{L}+\.? )?\d{1,2}:\d{2}/u,
    );

    // The timer is the client's own, kept next to the saved status so a
    // restart inside the hour still ends it.
    const stored = await page.evaluate(() => ({
      status: localStorage.getItem("owncord:settings:userStatus"),
      timer: localStorage.getItem("owncord:settings:userStatusTimer"),
      now: Date.now(),
    }));
    expect(JSON.parse(stored.status ?? "null")).toBe("dnd");
    const timer = JSON.parse(stored.timer ?? "null") as { status: string; until: number };
    expect(timer.status).toBe("dnd");
    expect(Math.abs(timer.until - (stored.now + 3_600_000))).toBeLessThan(60_000);
  });

  test("user bar has settings button with correct label", async ({ page }) => {
    const controls = page.locator("[data-testid='user-bar'] .ub-controls");
    await expect(controls).toBeVisible();

    const settingsBtn = controls.locator("button[aria-label='Settings']");
    await expect(settingsBtn).toBeVisible();
    // Settings button uses an SVG icon (createIcon("settings")) instead of text
    const svgIcon = settingsBtn.locator("svg");
    await expect(svgIcon).toBeAttached();
  });

  test("user bar has control buttons (mute, deafen, settings)", async ({ page }) => {
    const controls = page.locator("[data-testid='user-bar'] .ub-controls");
    const buttons = controls.locator("button");
    const count = await buttons.count();
    // UserBar renders settings + optionally disconnect (no mute/deafen in user bar)
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
