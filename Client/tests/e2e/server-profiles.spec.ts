/**
 * Server profiles — the connect page's saved-server surface (audit gap #13).
 *
 * Covers the Add Server modal (including the shared host validator that
 * OC-0187 unified with api.ts's setConfig), the quick-switch "Add new server"
 * row, the per-profile auto-login toggle, deleting a profile, the owncord://
 * invite deep-link prefill, and the sidebar's audit-log entry point.
 *
 * Everything asserts on rendered UI or outgoing IPC (`__invokeLog`), never on
 * mock internals. The deep-link frames go through the real plugin listener
 * (`deep-link://new-url`), not a shortcut.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  mockTauriConnect,
  mockTauriFullSession,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  submitLogin,
} from "./helpers";

const HOST = "staging.example:8443";

function profile(id: string, name: string, host: string, autoConnect = false) {
  return {
    id,
    name,
    host,
    username: "testuser",
    autoConnect,
    rememberPassword: false,
    color: "#5865f2",
    lastConnected: null,
  };
}

function storedProfiles(profiles: unknown[]) {
  return { "owncord:profiles": { schemaVersion: 1, profiles } };
}

interface InvokeEntry {
  cmd: string;
  args?: { url?: string; value?: { profiles?: Array<{ host: string; autoConnect: boolean }> } };
}

/** The profile list as last written by a `save_settings` IPC. */
async function lastSavedProfiles(
  page: Page,
): Promise<Array<{ host: string; autoConnect: boolean }>> {
  return page.evaluate(() => {
    const log = (window as unknown as { __invokeLog: InvokeEntry[] }).__invokeLog;
    const saves = log.filter((e) => e.cmd === "save_settings");
    const last = saves.at(-1);
    return (last?.args?.value?.profiles ?? []) as Array<{ host: string; autoConnect: boolean }>;
  });
}

/** Deliver an owncord:// URL through the real deep-link plugin listener. */
async function emitDeepLink(page: Page, urls: string[]): Promise<void> {
  await page.waitForFunction(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).__tauriEventListeners?.["deep-link://new-url"]?.length ?? 0) > 0,
  );
  await page.evaluate(
    (u) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__tauriEmitEvent("deep-link://new-url", u),
    urls,
  );
}

// ---------------------------------------------------------------------------
// Add Server modal + host validation
// ---------------------------------------------------------------------------

test.describe("Server profiles — Add Server modal", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();
  });

  const openModal = async (page: Page) => {
    await page.locator(".btn-add-server").click();
    await expect(page.locator("#add-server-title")).toBeVisible();
  };
  const nameInput = (page: Page) => page.locator(".modal input[placeholder='My Server']");
  const hostInput = (page: Page) => page.locator(".modal input[placeholder='example.com:8443']");
  const saveButton = (page: Page) => page.locator(".modal .modal-footer button.btn-primary");

  test("opens with name and host fields", async ({ page }) => {
    await openModal(page);
    await expect(page.locator("#add-server-title")).toHaveText("Add Server");
    await expect(nameInput(page)).toBeVisible();
    await expect(hostInput(page)).toBeVisible();
    await expect(page.locator(".modal .modal-footer button.btn-ghost")).toHaveText("Cancel");
  });

  test("rejects an invalid host and keeps the modal open", async ({ page }) => {
    await openModal(page);
    await nameInput(page).fill("Bad Server");
    await hostInput(page).fill("http://example.com/path");
    await saveButton(page).click();

    // The validator marked the field invalid, the modal stayed up, and no
    // profile was added — the add was gated, not merely announced.
    expect(await hostInput(page).evaluate((el) => (el as HTMLInputElement).checkValidity())).toBe(
      false,
    );
    await expect(page.locator("#add-server-title")).toBeVisible();
    await expect(page.locator(".server-item", { hasText: "Bad Server" })).toHaveCount(0);
  });

  test("adds a profile with a valid host, closing the modal and persisting it", async ({
    page,
  }) => {
    await openModal(page);
    await nameInput(page).fill("Staging");
    await hostInput(page).fill(HOST);
    await saveButton(page).click();

    await expect(page.locator("#add-server-title")).toBeHidden();
    const row = page.locator(`.server-item[data-host='${HOST}']`);
    await expect(row).toBeVisible();
    await expect(row.locator(".srv-name")).toHaveText("Staging");

    await expect
      .poll(async () => (await lastSavedProfiles(page)).some((p) => p.host === HOST))
      .toBe(true);
    // A profile added by hand never starts out as the auto-login target.
    expect((await lastSavedProfiles(page)).find((p) => p.host === HOST)?.autoConnect).toBe(false);
  });

  test("accepts a bare IPv6 host through the shared validator", async ({ page }) => {
    // OC-0187: api.ts accepted IPv6 but the modal's private regex did not, so
    // an IPv6 server could be logged into but never saved.
    await openModal(page);
    await nameInput(page).fill("V6");
    await hostInput(page).fill("2001:db8::1");
    await saveButton(page).click();

    await expect(page.locator("#add-server-title")).toBeHidden();
    await expect(page.locator(".server-item[data-host='2001:db8::1']")).toBeVisible();
  });

  test("cancel closes without adding a profile", async ({ page }) => {
    await openModal(page);
    await nameInput(page).fill("Discarded");
    await hostInput(page).fill("discarded.example:8443");
    await page.locator(".modal .modal-footer button.btn-ghost").click();

    await expect(page.locator("#add-server-title")).toBeHidden();
    await expect(page.locator(".server-item", { hasText: "Discarded" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Quick-switch "Add new server"
// ---------------------------------------------------------------------------

test.describe("Server profiles — quick-switch add", () => {
  test("the quick-switch Add new server row returns to the connect page", async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
          { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
          { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
        ],
        simulateWsFlow: true,
        storedSettings: storedProfiles([
          profile("pa", "Server A", "localhost:8443"),
          profile("pb", "Server B", "other.example:8443"),
        ]),
      }),
    );
    await page.goto("/");
    await submitLogin(page);
    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });

    await page.locator("button[title='Switch server']").click();
    const overlay = page.locator("[data-testid='quick-switch-overlay']");
    await expect(overlay).toBeVisible();
    await expect(
      overlay.locator("[data-testid='server-item']", { hasText: "Server B" }),
    ).toBeVisible();

    await overlay.locator("[data-testid='add-server-btn']").click();

    // The overlay tears down and the app lands back on the connect page —
    // still signed out of the departed server, ready to add another.
    await expect(overlay).toBeHidden();
    await expect(page.locator(".connect-page")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='app-layout']")).toBeHidden();

    // And the add path the row points at actually works from here.
    await page.locator(".btn-add-server").click();
    await expect(page.locator("#add-server-title")).toBeVisible();
    await page.locator(".modal input[placeholder='My Server']").fill("From Quick Switch");
    await page.locator(".modal input[placeholder='example.com:8443']").fill("fresh.example:8443");
    await page.locator(".modal .modal-footer button.btn-primary").click();
    await expect(page.locator(".server-item[data-host='fresh.example:8443']")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Per-profile auto-login toggle + delete
// ---------------------------------------------------------------------------

test.describe("Server profiles — row actions", () => {
  const A = "a.example:8443";
  const B = "b.example:8443";
  const C = "c.example:8443";

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      buildTauriMockScript({
        httpRoutes: [
          { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        ],
        simulateWsFlow: false,
        storedSettings: storedProfiles([
          profile("pa", "Server A", A),
          profile("pb", "Server B", B),
          profile("pc", "Server C", C, true),
        ]),
      }),
    );
    await page.goto("/");
    await expect(page.locator(`.server-item[data-host='${A}'] .srv-btn.auto-login`)).toBeVisible();
  });

  const toggle = (page: Page, host: string) =>
    page.locator(`.server-item[data-host='${host}'] .srv-btn.auto-login`);

  test("enabling auto-login marks the row and persists it as the only target", async ({ page }) => {
    await expect(toggle(page, A)).toHaveAttribute("aria-label", "Enable auto-login");
    await toggle(page, A).click();

    await expect(toggle(page, A)).toHaveAttribute("aria-label", "Disable auto-login");
    await expect(toggle(page, A)).toHaveClass(/active/);

    await expect
      .poll(async () => (await lastSavedProfiles(page)).find((p) => p.host === A)?.autoConnect)
      .toBe(true);
    expect((await lastSavedProfiles(page)).find((p) => p.host === B)?.autoConnect).toBe(false);
  });

  test("enabling auto-login on one profile clears it from the other", async ({ page }) => {
    await toggle(page, A).click();
    await expect(toggle(page, A)).toHaveClass(/active/);

    await toggle(page, B).click();

    await expect(toggle(page, B)).toHaveClass(/active/);
    await expect(toggle(page, A)).not.toHaveClass(/active/);
    await expect(page.locator(".srv-btn.auto-login.active")).toHaveCount(1);

    await expect
      .poll(async () => (await lastSavedProfiles(page)).find((p) => p.host === B)?.autoConnect)
      .toBe(true);
    expect((await lastSavedProfiles(page)).find((p) => p.host === A)?.autoConnect).toBe(false);
  });

  test("a profile saved with autoConnect renders as the active auto-login row", async ({
    page,
  }) => {
    await expect(toggle(page, C)).toHaveClass(/active/);
    await expect(toggle(page, C)).toHaveAttribute("aria-label", "Disable auto-login");
    await expect(page.locator(".srv-btn.auto-login.active")).toHaveCount(1);
  });

  test("clicking a profile row fills the connect form with its host", async ({ page }) => {
    await page.locator(`.server-item[data-host='${B}'] .srv-info`).click();
    await expect(page.locator("#host")).toHaveValue(B);
  });

  test("delete removes the row and persists the removal", async ({ page }) => {
    await page.locator(`.server-item[data-host='${A}'] .srv-btn.danger`).click();

    await expect(page.locator(`.server-item[data-host='${A}']`)).toHaveCount(0);
    await expect(page.locator(`.server-item[data-host='${B}']`)).toBeVisible();

    await expect
      .poll(async () => (await lastSavedProfiles(page)).map((p) => p.host))
      .toEqual([B, C]);
  });
});

// ---------------------------------------------------------------------------
// Invite deep-link prefill
// ---------------------------------------------------------------------------

test.describe("Server profiles — invite deep link", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();
  });

  test("an invite link switches to register and pre-fills code and host", async ({ page }) => {
    await emitDeepLink(page, ["owncord://invite/abc123?host=invite.example:8443"]);

    await expect(page.locator(".btn-text")).toHaveText("Register");
    await expect(page.locator("#invite")).toHaveValue("abc123");
    await expect(page.locator("#host")).toHaveValue("invite.example:8443");
    await expect(page.locator("#invite").locator("..")).not.toHaveClass(/form-group--hidden/);
  });

  test("a bare-code link pre-fills only the invite code", async ({ page }) => {
    await emitDeepLink(page, ["owncord://abc999"]);

    await expect(page.locator(".btn-text")).toHaveText("Register");
    await expect(page.locator("#invite")).toHaveValue("abc999");
    // No host in the link, so the address is left for the user to fill.
    await expect(page.locator("#host")).toHaveValue("");
  });

  test("a message permalink is not treated as an invite", async ({ page }) => {
    await emitDeepLink(page, ["owncord://message/12/345"]);

    // Negative case proved meaningful by the same emit path succeeding below.
    await expect(page.locator(".btn-text")).toHaveText("Login");
    await expect(page.locator("#invite")).toHaveValue("");

    await emitDeepLink(page, ["owncord://invite/after-message"]);
    await expect(page.locator(".btn-text")).toHaveText("Register");
    await expect(page.locator("#invite")).toHaveValue("after-message");
  });
});

// ---------------------------------------------------------------------------
// Audit-log button
// ---------------------------------------------------------------------------

test.describe("Server profiles — audit-log entry point", () => {
  test("is visible to an admin and opens the admin panel's audit section", async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await submitLogin(page);
    await expect(page.locator("[data-testid='app-layout']")).toBeVisible({ timeout: 15_000 });

    const auditBtn = page.locator("[data-testid='audit-log-btn']");
    await expect(auditBtn).toBeVisible();
    await auditBtn.click();

    // Routed through the native opener, deep-linked to the audit section.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const log = (window as unknown as { __invokeLog: InvokeEntry[] }).__invokeLog;
          return log
            .filter((e) => e.cmd === "plugin:opener|open_url")
            .map((e) => e.args?.url ?? "");
        }),
      )
      .toContain("https://localhost:8443/admin#audit");
  });
});
