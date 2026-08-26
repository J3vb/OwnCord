import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Tests: admin panel journey (DC-04's last uncovered surface)
//
// Drives the server-embedded admin SPA (Server/admin/static/index.html)
// against a REAL server — chi router, admin gates, SQLite — started fresh by
// start-server.sh via this config's webServer hook. The tests form ONE
// stateful journey (serial, single worker): the first-run wizard creates the
// owner every later step authenticates as, which is exactly how a real
// deployment's first session goes.
//
// Spec: docs/architecture/ux/settings-and-admin.md §4 (what the admin surface
// owns) and docs/deployment.md First start.
// ---------------------------------------------------------------------------

const OWNER = { username: "e2e-owner", password: "e2e-owner-pass-123" };

test.describe.configure({ mode: "serial" });

async function navigate(page: Page, label: string): Promise<void> {
  await page.locator(".nav-item", { hasText: label }).click();
}

test.describe("Admin panel journey", () => {
  // One page for the whole journey: the SPA keeps its session in
  // localStorage, and fresh per-test contexts would drop it — forcing a
  // login per test straight into the server's 5-logins/min limiter (the
  // same reason the native suite uses its persistent fixture).
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("first-run wizard creates the owner and lands on the dashboard", async () => {
    await page.goto("/admin/");

    // Fresh database → the setup wizard. On a Playwright RETRY the owner
    // already exists (setup is one-shot server-side), so the login overlay
    // shows instead — sign in and keep the rest of the journey alive rather
    // than failing on an assertion the server can no longer satisfy.
    const setup = page.locator("#setupOverlay.visible");
    const login = page.locator("#loginOverlay.visible");
    await expect(setup.or(login).first()).toBeVisible({ timeout: 10_000 });

    if (await login.count()) {
      await page.locator("#loginUser").fill(OWNER.username);
      await page.locator("#loginPass").fill(OWNER.password);
      await page.locator("#loginBtn").click();
    } else {
      await page.locator("#wizardBox .btn-accent", { hasText: "Get Started" }).click();

      // Account step.
      await page.locator("#wizUser").fill(OWNER.username);
      await page.locator("#wizPass").fill(OWNER.password);
      await page.locator("#wizConfirm").fill(OWNER.password);

      // Advance through server/uploads/registration/review without touching
      // the prefilled values — they mirror the running config, so nothing
      // changes and the server does not restart (restart_required false).
      // Steps: 1 account → 2 server → 3 uploads/voice → 4 registration → 5
      // review; the fifth click is Finish, which disables the button into a
      // spinner while POST /admin/api/setup runs.
      const next = page.locator("#wizNextBtn");
      for (let i = 0; i < 4; i++) {
        await next.click();
      }
      await next.click(); // Finish

      await expect(page.locator("#setupSuccessOverlay")).toBeVisible({ timeout: 15_000 });
      // The invite code is the server's proof the owner + seed data exist.
      await expect(page.locator("#inviteCode")).not.toHaveText("");
      await page.locator("#setupContinueBtn").click();
    }

    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".page-title", { hasText: "Dashboard" })).toBeVisible();
  });

  test("dashboard renders live stats — exactly one registered user", async () => {
    await page.goto("/admin/");
    // Token persisted in localStorage by the wizard → straight into the app.
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    const usersCard = page.locator(".stat-card", { hasText: "Total Users" });
    await expect(usersCard.locator(".stat-card-value")).toHaveText("1");
  });

  test("channel create shows up in the channel table", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await navigate(page, "Channels");
    await page.locator("button", { hasText: "Create Channel" }).click();
    await page.locator("#chName").fill("e2e-lounge");
    await page.locator(".modal-footer .btn-accent", { hasText: "Create" }).click();

    await expect(page.locator(".tbl tbody tr", { hasText: "e2e-lounge" })).toBeVisible();
  });

  test("channel edit renames it in place", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await navigate(page, "Channels");

    const row = page.locator(".tbl tbody tr", { hasText: "e2e-lounge" }).first();
    await row.locator(".act-btn[title='Edit']").click();
    await page.locator("#chEditName").fill("e2e-lounge-renamed");
    await page.locator(".modal-footer .btn-accent", { hasText: "Save" }).click();

    await expect(page.locator(".tbl tbody tr", { hasText: "e2e-lounge-renamed" })).toBeVisible();
  });

  test("audit log records the channel mutations", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await navigate(page, "Audit Log");
    await expect(page.locator(".badge", { hasText: "channel_create" }).first()).toBeVisible();
    await expect(page.locator(".badge", { hasText: "channel_update" }).first()).toBeVisible();
  });

  test("logout returns to the login overlay; owner can sign back in", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await page.locator(".nav-item", { hasText: "Sign Out" }).click();
    await expect(page.locator("#loginOverlay")).toBeVisible();

    await page.locator("#loginUser").fill(OWNER.username);
    await page.locator("#loginPass").fill(OWNER.password);
    await page.locator("#loginBtn").click();

    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".page-title", { hasText: "Dashboard" })).toBeVisible();
  });
});
