/**
 * B7-13 / BPR-034: a quick switch between saved profiles tears server A's
 * connection down before server B's opens, keeps A's saved sign-in, and
 * leaves the profile list intact. Counted from the Tauri mock's IPC log
 * rather than DOM timing.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE, MOCK_MESSAGES } from "./helpers";

const A = "localhost:8443";
const B = "other.example:8443";

function profile(id: string, name: string, host: string) {
  return {
    id,
    name,
    host,
    username: "testuser",
    autoConnect: false,
    rememberPassword: false,
    color: "#5865f2",
    lastConnected: null,
  };
}

/** The transport commands the app issued, in order. */
async function transportLog(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { url?: string } }> }
    ).__invokeLog
      .filter((e) => e.cmd === "ws_connect" || e.cmd === "ws_disconnect")
      .map((e) => (e.cmd === "ws_connect" ? `connect ${e.args?.url ?? ""}` : e.cmd)),
  );
}

/** Hosts whose credential the app asked to delete. */
async function deletedCredentials(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __mockDeletedCredentials?: string[] }).__mockDeletedCredentials ?? [],
  );
}

async function login(page: Page, host: string): Promise<void> {
  await page.locator("#host").fill(host);
  await page.locator("#username").fill("testuser");
  await page.locator("#password").fill("password123");
  await page.locator("button.btn-primary[type='submit']").click();
  await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });
}

test.describe("Profile switch (B7-13)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        ],
        simulateWsFlow: true,
        storedSettings: {
          "owncord:profiles": {
            schemaVersion: 1,
            profiles: [profile("pa", "Server A", A), profile("pb", "Server B", B)],
          },
        },
      }),
    );
    await page.goto("/");
  });

  test("tears A down before B connects, keeps A's sign-in and both profiles", async ({ page }) => {
    await login(page, A);
    const deletedBeforeSwitch = await deletedCredentials(page);

    await page.locator("button[title='Switch server']").click();
    const overlay = page.locator("[data-testid='quick-switch-overlay']");
    await expect(overlay).toBeVisible();
    await overlay.locator("[data-testid='server-item']", { hasText: "Server B" }).click();

    // Back on the connect page with B selected and both profiles kept.
    await expect(page.locator(".connect-form, .login-form")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("[data-testid='app-layout']")).not.toBeVisible();
    await expect(page.locator(".server-item[data-host='localhost:8443']")).toBeVisible();
    await expect(page.locator(".server-item[data-host='other.example:8443']")).toBeVisible();
    await expect(page.locator("#host")).toHaveValue(B);

    // A's transport is closed.
    let log = await transportLog(page);
    expect(log.filter((e) => e.startsWith("connect"))).toHaveLength(1);
    expect(log.at(-1)).toBe("ws_disconnect");
    // The switch itself deleted nothing (a login that declines "remember"
    // deletes on its own, before the switch).
    expect(await deletedCredentials(page)).toEqual(deletedBeforeSwitch);

    await login(page, B);

    log = await transportLog(page);
    const connects = log.flatMap((e, i) => (e.startsWith("connect") ? [i] : []));
    expect(connects).toHaveLength(2);
    expect(log[connects[0]!]).toContain("localhost");
    expect(log[connects[1]!]).toContain("other.example");
    expect(log.slice(connects[0]! + 1, connects[1]!)).toContain("ws_disconnect");
  });
});
