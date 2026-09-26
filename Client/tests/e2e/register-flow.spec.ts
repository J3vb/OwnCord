/**
 * E2E tests for the registration flow.
 * Covers: mode toggle, form validation, register success, register error.
 */
import { test, expect } from "./fixtures";
import { buildTauriMockScript, MOCK_LOGIN_RESPONSE } from "./helpers";

const MOCK_REGISTER_RESPONSE = {
  user: { id: 99, username: "newuser" },
  token: "register-token-abc",
};

/** A `server-info` route carrying the given registration mode. */
function serverInfoRoute(mode: string) {
  return {
    pattern: "/api/v1/server-info",
    status: 200,
    body: {
      name: "Test Server",
      protocol_epoch: 1,
      browser_client_enabled: false,
      registration_mode: mode,
    },
  };
}

async function mockRegisterSuccess(
  page: import("@playwright/test").Page,
  mode?: string,
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        ...(mode ? [serverInfoRoute(mode)] : []),
        { pattern: "/api/v1/auth/register", status: 200, body: MOCK_REGISTER_RESPONSE },
      ],
      simulateWsFlow: true,
    }),
  );
}

async function mockRegisterConflict(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        {
          pattern: "/api/v1/auth/register",
          status: 409,
          body: { error: "USERNAME_TAKEN", message: "Username already exists" },
        },
      ],
      simulateWsFlow: false,
    }),
  );
}

async function switchToRegisterMode(page: import("@playwright/test").Page): Promise<void> {
  const toggleLink = page.locator(".form-switch button");
  await toggleLink.click();
  // Verify we're in register mode
  await expect(page.locator(".btn-text")).toHaveText("Register");
}

test.describe("Register Flow — Mode Toggle", () => {
  test.beforeEach(async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
  });

  test("clicking toggle switches to register mode", async ({ page }) => {
    await switchToRegisterMode(page);

    // Invite code field should be visible
    const inviteGroup = page.locator("#invite").locator("..");
    await expect(inviteGroup).not.toHaveClass(/form-group--hidden/);
  });

  test("register mode shows invite code field", async ({ page }) => {
    await switchToRegisterMode(page);

    const inviteInput = page.locator("#invite");
    await expect(inviteInput).toBeVisible();
  });

  test("toggle back to login hides invite code field", async ({ page }) => {
    await switchToRegisterMode(page);
    // Toggle back
    const toggleLink = page.locator(".form-switch button");
    await toggleLink.click();

    await expect(page.locator(".btn-text")).toHaveText("Login");

    // Invite field parent should be hidden
    const inviteGroup = page.locator("#invite").locator("..");
    await expect(inviteGroup).toHaveClass(/form-group--hidden/);
  });
});

test.describe("Register Flow — Validation", () => {
  test.beforeEach(async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);
  });

  test("empty invite code shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    // Leave invite code empty

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Invite code is required");
  });

  test("short password shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("short");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("at least 8 characters");
  });

  test("empty username shows validation error", async ({ page }) => {
    await page.locator("#host").fill("localhost:8443");
    // Leave username empty
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Username is required");
  });

  test("empty host shows validation error", async ({ page }) => {
    // Leave host empty (clear the default)
    await page.locator("#host").fill("");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite123");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 3000 });
    await expect(errorBanner).toContainText("Server address is required");
  });
});

test.describe("Register Flow — Submission", () => {
  test("successful register transitions to connected state", async ({ page }) => {
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    await page.locator(".btn-primary[type='submit']").click();

    // Should transition to the connected overlay
    const overlay = page.locator(".connected-overlay");
    await expect(overlay).toBeVisible({ timeout: 5000 });
  });

  test("register shows loading state during submission", async ({ page }) => {
    // Hold the register HTTP response open so the in-flight loading state is
    // observable, not a race against the mock's fast reply. The wrapper
    // delays only the register fetch; every other IPC call passes straight
    // through the base mock.
    await mockRegisterSuccess(page);
    await page.addInitScript(() => {
      const t = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const orig = t.invoke.bind(t);
      const urls = new Map<number, string>();
      t.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "plugin:http|fetch") {
          const a = args as { rid?: number; clientConfig?: { url?: string } };
          const rid = (await orig(cmd, args)) as number;
          urls.set(rid, a.clientConfig?.url ?? "");
          return rid;
        }
        if (cmd === "plugin:http|fetch_send") {
          const rid = (args as { rid?: number }).rid ?? -1;
          if (urls.get(rid)?.includes("/api/v1/auth/register")) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        return orig(cmd, args);
      };
    });

    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    const submitBtn = page.locator(".btn-primary[type='submit']");
    await submitBtn.click();

    // The form enters its real loading state while the request is in flight:
    // the control disables, flags itself loading, and relabels itself.
    await expect(submitBtn).toBeDisabled({ timeout: 3_000 });
    await expect(submitBtn).toHaveClass(/loading/);
    await expect(submitBtn.locator(".btn-text")).toHaveText("Registering…");

    // And it completes into the connected overlay.
    await expect(page.locator(".connected-overlay")).toBeVisible({ timeout: 5_000 });
  });

  test("register error shows error banner", async ({ page }) => {
    await mockRegisterConflict(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("existinguser");
    await page.locator("#password").fill("password123");
    await page.locator("#invite").fill("invite-abc");

    await page.locator(".btn-primary[type='submit']").click();

    const errorBanner = page.locator(".error-banner");
    await expect(errorBanner).toHaveClass(/visible/, { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Tests: registration mode awareness (B7-15a)
//
// The connect path reads server-info's registration_mode into a per-host
// snapshot and the register form follows it: invite requires a code, open and
// approval submit without one, closed refuses and says why, and an unavailable
// mode falls back to today's invite-required form.
// ---------------------------------------------------------------------------

test.describe("Register Flow — Registration modes", () => {
  const notice = (page: import("@playwright/test").Page) => page.locator(".registration-notice");

  test("invite mode requires an invite code", async ({ page }) => {
    await mockRegisterSuccess(page, "invite");
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator(".btn-primary[type='submit']").click();

    await expect(page.locator(".error-banner")).toContainText("Invite code is required");
  });

  test("open mode submits without an invite code", async ({ page }) => {
    await mockRegisterSuccess(page, "open");
    await page.goto("/");
    await switchToRegisterMode(page);
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");

    // The invite field is hidden — no code is needed.
    await expect(page.locator("#invite").locator("..")).toHaveClass(/form-group--hidden/);

    await page.locator(".btn-primary[type='submit']").click();
    await expect(page.locator(".connected-overlay")).toBeVisible({ timeout: 5000 });
  });

  test("approval mode shows the pending-approval notice up front and submits without a code", async ({
    page,
  }) => {
    await mockRegisterSuccess(page, "approval");
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("admin must approve");

    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator(".btn-primary[type='submit']").click();
    await expect(page.locator(".connected-overlay")).toBeVisible({ timeout: 5000 });
  });

  test("closed mode disables register and states why", async ({ page }) => {
    await mockRegisterSuccess(page, "closed");
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText("Registration is closed");
    await expect(page.locator(".btn-primary[type='submit']")).toBeDisabled();
  });

  test("an unavailable server-info still requires an invite code", async ({ page }) => {
    // No server-info route: GET returns 404, so the mode is unknown. The form
    // must not silently widen registration.
    await mockRegisterSuccess(page);
    await page.goto("/");
    await switchToRegisterMode(page);

    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("newuser");
    await page.locator("#password").fill("password123");
    await page.locator(".btn-primary[type='submit']").click();

    await expect(page.locator(".error-banner")).toContainText("Invite code is required");
  });
});
