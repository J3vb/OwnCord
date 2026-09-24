/**
 * Account-security surfaces in Settings > Account (audit batch N2, gaps #2–4):
 * profile edit (display name + about, and the username), avatar upload, TOTP
 * enable/confirm/disable, and the account-deletion confirmation.
 *
 * Every test asserts on rendered UI and on the outgoing IPC traffic the app
 * actually issued (`window.__invokeLog`, populated by the Tauri mock) rather
 * than on fixture internals, so a stubbed handler that stops sending the
 * request — or a broken render — turns the test red.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_AUTH_OK,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  openSettings,
} from "./helpers";

// ---------------------------------------------------------------------------
// Outgoing-request capture (the mock's own IPC log, no extra init script)
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly data: number[] | null;
  readonly headers: [string, string][];
}

async function fetchCalls(page: Page): Promise<FetchCall[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __invokeLog: Array<{ cmd: string; args?: { clientConfig?: FetchCall } }>;
      }
    ).__invokeLog
      .filter((e) => e.cmd === "plugin:http|fetch")
      .map((e) => e.args?.clientConfig as FetchCall),
  );
}

/** Poll until a request matching `predicate` has been sent. */
async function waitForFetch(
  page: Page,
  predicate: (call: FetchCall) => boolean,
  timeout = 5_000,
): Promise<FetchCall> {
  let found: FetchCall | undefined;
  await expect(async () => {
    found = (await fetchCalls(page)).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

function decodeBody(call: FetchCall): string | null {
  if (!Array.isArray(call.data)) return null;
  return new TextDecoder().decode(new Uint8Array(call.data));
}

function requestTo(method: string, pathSuffix: string) {
  return (call: FetchCall): boolean =>
    call.method === method && call.url.includes(`/api/v1${pathSuffix}`);
}

/** Poll until a PATCH /users/me whose JSON body satisfies `has` has been sent.
 *  The identity-key publish also PATCHes this path on `ready`, so matching on
 *  the body is the only way to pick out the profile edit. */
async function waitForProfilePatch(
  page: Page,
  has: (body: Record<string, unknown>) => boolean,
  timeout = 5_000,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  await expect(async () => {
    for (const call of await fetchCalls(page)) {
      if (!requestTo("PATCH", "/users/me")(call)) continue;
      const parsed = JSON.parse(decodeBody(call) ?? "null") as Record<string, unknown> | null;
      if (parsed !== null && has(parsed)) {
        body = parsed;
        break;
      }
    }
    expect(body).toBeDefined();
  }).toPass({ timeout });
  return body!;
}

// ---------------------------------------------------------------------------
// Routes + fixtures
// ---------------------------------------------------------------------------

const ROUTE_HEALTH = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", version: "1.0.0" },
};
const ROUTE_LOGIN = { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE };
const ROUTE_MESSAGES = { pattern: "/messages", status: 200, body: MOCK_MESSAGES };
const ROUTE_PINS = { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES };

/** The signed-in profile this suite starts from (`GET /auth/me` answers this). */
function meRoute(totpEnabled: boolean) {
  return {
    pattern: "/api/v1/auth/me",
    status: 200,
    body: { ...MOCK_AUTH_OK.payload.user, totp_enabled: totpEnabled },
  };
}

/** A 1x1 PNG — a real file the avatar uploader's `measureImage` can decode. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const AVATAR_UPLOAD = {
  pattern: "/api/v1/users/me/avatar",
  method: "POST",
  status: 200,
  body: {
    id: "abc",
    filename: "avatar.png",
    size: 68,
    mime: "image/png",
    url: "/api/v1/files/abc",
  },
};

type HttpRoute = {
  pattern: string;
  status: number;
  body: unknown;
  method?: string;
};

async function bootAccountSettings(page: Page, extraRoutes: HttpRoute[]): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [ROUTE_HEALTH, ROUTE_LOGIN, ROUTE_MESSAGES, ROUTE_PINS, ...extraRoutes],
      simulateWsFlow: true,
    }),
  );
  await page.goto("/");
  await navigateToMainPage(page);
  await openSettings(page);
}

/**
 * The delete-dialog disclosure. B7-15c (PR #1671) rewrites the exact sentence
 * to "Deletion is immediate and permanent: …" from "This action is permanent
 * and cannot be undone. …", so assert on the meaning both copies share —
 * permanence and a password that must be typed — rather than one revision's
 * wording. A dialog that dropped the warning fails either way.
 */
const DELETE_WARNING_PARTS = ["permanent", "Enter your password to confirm."];

// ---------------------------------------------------------------------------
// Profile edit (display name + about)
// ---------------------------------------------------------------------------

test.describe("Settings > Account — profile edit", () => {
  test("saving the display name and about renders the new name and PATCHes /users/me", async ({
    page,
  }) => {
    const profile = {
      ...MOCK_AUTH_OK.payload.user,
      display_name: "Ada Lovelace",
      about: "writes tests",
      totp_enabled: false,
    };
    await bootAccountSettings(page, [
      meRoute(false),
      { pattern: "/api/v1/users/me", method: "PATCH", status: 200, body: profile },
    ]);

    // Pre-filled from the signed-in user, who has neither field set.
    await expect(page.locator("[data-testid='display-name-input']")).toHaveValue("");
    await expect(page.locator("[data-testid='about-input']")).toHaveValue("");

    await page.locator("[data-testid='display-name-input']").fill("Ada Lovelace");
    await page.locator("[data-testid='about-input']").fill("writes tests");
    await page.locator("[data-testid='profile-save-btn']").click();

    // Rendered result: the card header follows the saved display name.
    await expect(page.locator(".account-header-name")).toHaveText("Ada Lovelace");
    await expect(page.locator("[data-testid='profile-error']")).toHaveText("Profile saved.");
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Profile updated" }),
    ).toBeVisible();

    // Outgoing traffic: one PATCH carrying both edited fields.
    const body = await waitForProfilePatch(page, (b) => "display_name" in b);
    expect(body).toEqual({
      display_name: "Ada Lovelace",
      about: "writes tests",
      username: "testuser",
    });
  });

  test("a rejected profile save shows the server message and keeps the form", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/users/me",
        method: "PATCH",
        status: 400,
        body: { error: "BAD_REQUEST", message: "display_name too long" },
      },
    ]);

    await page.locator("[data-testid='display-name-input']").fill("Ada");
    await page.locator("[data-testid='profile-save-btn']").click();

    await expect(page.locator("[data-testid='profile-error']")).toHaveText("display_name too long");
    await expect(page.locator("[data-testid='display-name-input']")).toHaveValue("Ada");
    await expect(page.locator(".account-header-name")).toHaveText("testuser");
    await expect(
      page.locator("[data-testid='toast']", { hasText: "display_name too long" }),
    ).toBeVisible();
  });

  test("editing the username updates the card and bounds the length locally", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/users/me",
        method: "PATCH",
        status: 200,
        body: { ...MOCK_AUTH_OK.payload.user, username: "ada", totp_enabled: false },
      },
    ]);

    await page.locator(".settings-pane.active .account-field-edit").click();
    const row = page.locator(".settings-pane.active .setting-row", {
      has: page.locator("[data-testid='username-edit-input']"),
    });
    await expect(row.locator("[data-testid='username-edit-input']")).toBeVisible();

    // Too short is refused before any request goes out.
    await row.locator("[data-testid='username-edit-input']").fill("a");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row).toContainText("Username must be 2");

    await row.locator("[data-testid='username-edit-input']").fill("ada");
    await row.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.locator(".account-field-value")).toHaveText("ada");
    await expect(page.locator(".account-header-name")).toHaveText("ada");

    const body = await waitForProfilePatch(page, (b) => b.username === "ada");
    expect(body).toEqual({ username: "ada" });
  });
});

// ---------------------------------------------------------------------------
// Avatar upload
// ---------------------------------------------------------------------------

test.describe("Settings > Account — avatar upload", () => {
  test("uploads the picked image as multipart and paints the returned avatar", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      AVATAR_UPLOAD,
      { pattern: "/api/v1/files/abc", status: 200, body: {} },
    ]);

    await page
      .locator("[data-testid='avatar-file-input']")
      .setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: PNG_1X1 });

    // The server's URL is fetched and drawn into the big avatar.
    await expect(page.locator("[data-testid='account-avatar'] img.avatar-img")).toBeAttached();
    await expect(page.locator("[data-testid='account-avatar'] img.avatar-img")).toHaveAttribute(
      "src",
      /^data:/,
    );
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Avatar updated" }),
    ).toBeVisible();
    await expect(page.locator("[data-testid='avatar-upload-btn']")).toHaveText("Change Avatar");

    // Outgoing traffic: a multipart POST carrying the file (not JSON).
    const call = await waitForFetch(page, requestTo("POST", "/users/me/avatar"));
    const contentType =
      call.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
    expect(contentType).toContain("multipart/form-data");
    const body = decodeBody(call) ?? "";
    expect(body).toContain('filename="avatar.png"');
    expect(body).toContain("image/png");
  });

  test("a failed upload surfaces the error and stays on the previous avatar", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/users/me/avatar",
        method: "POST",
        status: 400,
        body: { error: "BAD_REQUEST", message: "avatar must be a PNG, JPEG or WebP image" },
      },
    ]);

    await page
      .locator("[data-testid='avatar-file-input']")
      .setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: PNG_1X1 });

    await expect(page.locator("[data-testid='avatar-error']")).toHaveText(
      "avatar must be a PNG, JPEG or WebP image",
    );
    // The letter fallback is still what the avatar shows.
    await expect(page.locator("[data-testid='account-avatar'] img.avatar-img")).toHaveCount(0);
    await expect(page.locator("[data-testid='account-avatar']")).toHaveText("T");
    await expect(page.locator("[data-testid='avatar-upload-btn']")).toHaveText("Change Avatar");
  });
});

// ---------------------------------------------------------------------------
// 2FA enable → confirm
// ---------------------------------------------------------------------------

test.describe("Settings > Account — enable and confirm 2FA", () => {
  test("enable shows the QR URI and backup codes, confirm flips the badge to Enabled", async ({
    page,
  }) => {
    const QUIET_URI = "otpauth://totp/OwnCord:testuser?secret=JBSWY3DPEHPK3PXP";
    const CODES = ["7KQ3M-RX2WN", "P4HT9-ZC6VB"];
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/users/me/totp/enable",
        method: "POST",
        status: 200,
        body: { qr_uri: QUIET_URI, backup_codes: CODES },
      },
      { pattern: "/api/v1/users/me/totp/confirm", method: "POST", status: 200, body: {} },
    ]);

    const section = page.locator("[data-testid='totp-section']");
    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Disabled");

    // Enable reveals the password step; the QR is only shown after it succeeds.
    await section.locator("[data-testid='totp-enable-btn']").click();
    await section.locator("[data-testid='totp-password-input']").fill("password123");
    await section.locator("button", { hasText: "Submit" }).click();

    await expect(section.locator("[data-testid='totp-qr-uri']")).toHaveText(QUIET_URI);
    await expect(section.locator("[data-testid='totp-backup-codes']")).toContainText(CODES[0]!);
    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Disabled");

    const enableCall = await waitForFetch(page, requestTo("POST", "/users/me/totp/enable"));
    expect(JSON.parse(decodeBody(enableCall)!)).toEqual({ password: "password123" });

    // Confirm with a 6-digit code activates it.
    await section.locator("[data-testid='totp-code-input']").fill("123456");
    await section.locator("[data-testid='totp-confirm-btn']").click();

    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Enabled");
    await expect(section.locator("[data-testid='totp-disable-btn']")).toBeVisible();
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Two-factor authentication enabled" }),
    ).toBeVisible();

    const confirmCall = await waitForFetch(page, requestTo("POST", "/users/me/totp/confirm"));
    expect(JSON.parse(decodeBody(confirmCall)!)).toEqual({
      password: "password123",
      code: "123456",
    });
  });

  test("a malformed confirmation code is refused without a request", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/users/me/totp/enable",
        method: "POST",
        status: 200,
        body: { qr_uri: "otpauth://totp/x", backup_codes: [] },
      },
      { pattern: "/api/v1/users/me/totp/confirm", method: "POST", status: 200, body: {} },
    ]);

    const section = page.locator("[data-testid='totp-section']");
    await section.locator("[data-testid='totp-enable-btn']").click();
    await section.locator("[data-testid='totp-password-input']").fill("password123");
    await section.locator("button", { hasText: "Submit" }).click();
    await expect(section.locator("[data-testid='totp-code-input']")).toBeVisible();

    await section.locator("[data-testid='totp-code-input']").fill("12");
    await section.locator("[data-testid='totp-confirm-btn']").click();

    // The enroll form's own error element is still in the DOM (hidden), so
    // the confirm area's is the last one.
    await expect(section.locator("[data-testid='totp-error']").last()).toHaveText(
      "Please enter a valid 6-digit code.",
    );
    expect(
      (await fetchCalls(page)).some(requestTo("POST", "/users/me/totp/confirm")),
      "a malformed code must not reach the server",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2FA disable
// ---------------------------------------------------------------------------

test.describe("Settings > Account — disable 2FA", () => {
  test("disable requires the password, DELETEs /users/me/totp and shows Disabled", async ({
    page,
  }) => {
    await bootAccountSettings(page, [
      meRoute(true),
      { pattern: "/api/v1/users/me/totp", method: "DELETE", status: 200, body: {} },
    ]);

    const section = page.locator("[data-testid='totp-section']");
    // The store starts stale (auth_ok carries no totp_enabled); the /auth/me
    // refresh is what flips the badge.
    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Enabled");

    await section.locator("[data-testid='totp-disable-btn']").click();
    const password = section.locator("[data-testid='totp-password-input']");
    await expect(password).toBeVisible();

    await section.locator("button", { hasText: "Confirm Disable" }).click();
    await expect(section.locator("[data-testid='totp-error']")).toHaveText("Password is required.");
    expect(
      (await fetchCalls(page)).some(requestTo("DELETE", "/users/me/totp")),
      "an empty password must not reach the server",
    ).toBe(false);

    await password.fill("password123");
    await section.locator("button", { hasText: "Confirm Disable" }).focus();
    await page.keyboard.press("Enter");

    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Disabled");
    // The focused confirm button is disabled and then replaced; focus moves
    // to the rebuilt section rather than falling to <body>.
    await expect(section.locator("[data-testid='totp-enable-btn']")).toBeFocused();
    await expect(
      page.locator("[data-testid='toast']", { hasText: "Two-factor authentication disabled" }),
    ).toBeVisible();

    const call = await waitForFetch(page, requestTo("DELETE", "/users/me/totp"));
    expect(JSON.parse(decodeBody(call)!)).toEqual({ password: "password123" });
  });

  test("a server refusal keeps 2FA enabled and shows the reason", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(true),
      {
        pattern: "/api/v1/users/me/totp",
        method: "DELETE",
        status: 400,
        body: { error: "BAD_REQUEST", message: "Incorrect password" },
      },
    ]);

    const section = page.locator("[data-testid='totp-section']");
    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Enabled");

    await section.locator("[data-testid='totp-disable-btn']").click();
    await section.locator("[data-testid='totp-password-input']").fill("nope");
    const confirm = section.locator("button", { hasText: "Confirm Disable" });
    await confirm.focus();
    await page.keyboard.press("Enter");

    await expect(section.locator("[data-testid='totp-error']")).toHaveText("Incorrect password");
    await expect(section.locator("[data-testid='totp-status-badge']")).toHaveText("Enabled");
    // The button was disabled while the request ran; focus comes back to it
    // rather than staying on <body>.
    await expect(confirm).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

test.describe("Settings > Account — delete account", () => {
  test("discloses the erasure, requires a password, and DELETE returns to the sign-in page", async ({
    page,
  }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      { pattern: "/api/v1/auth/account", method: "DELETE", status: 200, body: {} },
    ]);

    const confirmArea = page.locator("[data-testid='delete-account-confirm-area']");
    await expect(confirmArea).toBeHidden();

    await page.locator("[data-testid='delete-account-trigger']").click();
    await expect(confirmArea).toBeVisible();
    // The disclosure is rendered, and it is the destructive copy.
    for (const part of DELETE_WARNING_PARTS) await expect(confirmArea).toContainText(part);

    // Empty password is refused locally.
    await page.locator("[data-testid='delete-account-confirm']").click();
    await expect(page.locator("[data-testid='delete-account-error']")).toHaveText(
      "Password is required.",
    );
    expect(
      (await fetchCalls(page)).some(requestTo("DELETE", "/auth/account")),
      "an empty password must not reach the server",
    ).toBe(false);

    await page.locator("[data-testid='delete-account-password']").fill("password123");
    await page.locator("[data-testid='delete-account-confirm']").click();

    const call = await waitForFetch(page, requestTo("DELETE", "/auth/account"));
    expect(JSON.parse(decodeBody(call)!)).toEqual({ password: "password123" });

    // Success clears auth and the app is back at sign-in.
    await expect(page.locator(".connect-form, .login-form")).toBeVisible({ timeout: 5_000 });
  });

  test("a refused deletion shows the reason and keeps the session", async ({ page }) => {
    await bootAccountSettings(page, [
      meRoute(false),
      {
        pattern: "/api/v1/auth/account",
        method: "DELETE",
        status: 400,
        body: { error: "BAD_REQUEST", message: "Incorrect password" },
      },
    ]);

    await page.locator("[data-testid='delete-account-trigger']").click();
    await page.locator("[data-testid='delete-account-password']").fill("nope");
    await page.locator("[data-testid='delete-account-confirm']").focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-testid='delete-account-error']")).toHaveText(
      "Incorrect password",
    );
    await expect(page.locator("[data-testid='delete-account-confirm']")).toHaveText(
      "Confirm Delete",
    );
    await expect(page.locator("[data-testid='delete-account-confirm']")).toBeFocused();
    await expect(page.locator("[data-testid='app-layout']")).toBeVisible();
  });
});
