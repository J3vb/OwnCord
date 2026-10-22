/**
 * The browser portal against a real server (WP 6.13g1). The Go server runs with
 * `server.browser_client_enabled: true`, with the web bundle embedded in its
 * binary, and every spec opens that server's own origin over its TLS: the page,
 * the REST calls and the WebSocket all come from one place, the way a member
 * reaches a portal. There is no Tauri mock and no Vite server.
 */
import { devices, type Page } from "@playwright/test";
import { test, expect, signIn, sendMessage } from "./fixtures";
import { joinVoice } from "../support/media";
import type { TestServer } from "../support/server";

const general = (page: Page) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: "general" });

/** Every credential key the browser platform keeps, in either Web Storage area. */
const credentialKeys = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    for (const area of [localStorage, sessionStorage]) {
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i);
        if (key !== null && key.startsWith("owncord:credential:")) found.push(key);
      }
    }
    return found;
  });

test("login, message, reload resumes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  // The portal fixes the host to the server it came from: no host field to fill.
  await expect(page.locator("#host")).toBeHidden();
  // A first visit starts with "Stay signed in" ticked (6.13 owner decision 3).
  await expect(page.locator("#auto-connect")).toBeChecked();
  await signIn(page, "alice");
  await expect(general(page)).toBeVisible();

  const text = `portal-message-${crypto.randomUUID()}`;
  await sendMessage(page, text);

  // "Stay signed in" keeps the token in localStorage, so a reload resumes the
  // session with no form: the stored token signs in again and the history comes back.
  await page.reload();
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
  await expect(page.locator(".msg-text", { hasText: text })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("sign out clears token", async ({ page, server }) => {
  await page.goto("/");
  await signIn(page, "alice", { staySignedIn: true });
  await expect(general(page)).toBeVisible();
  expect(await credentialKeys(page)).toHaveLength(1);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("owncord:credential:"));
    const raw = key === undefined ? null : localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as { token: string }).token;
  });
  expect(token).not.toBeNull();
  // The token is live before sign-out.
  await expect(tokenStatus(server, token!)).resolves.toBe(200);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByTestId("app-layout")).toHaveCount(0);

  // Gone from both storage areas, revoked on the server, and a reload stays on the form.
  expect(await credentialKeys(page)).toEqual([]);
  await expect.poll(() => tokenStatus(server, token!)).toBe(401);
  await page.reload();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByTestId("app-layout")).toHaveCount(0);
});

/** The status of an authenticated read made with `token`. */
async function tokenStatus(server: TestServer, token: string): Promise<number> {
  try {
    await server.api("/api/v1/channels/", undefined, token);
    return 200;
  } catch (err: unknown) {
    const match = /: (\d{3}) /.exec(err instanceof Error ? err.message : String(err));
    return match === null ? 0 : Number(match[1]);
  }
}

test.describe("phone viewport", () => {
  // The Pixel 7 profile, minus defaultBrowserType, which a describe cannot set.
  const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
  test.use(pixel7);

  test("phone viewport journey", async ({ page, server }) => {
    await server.api("/admin/api/channels", { name: "random", type: "text" }, server.owner!.token);
    await page.goto("/");
    await signIn(page);

    // The sidebar is a drawer on a phone: closed, then opened by the menu button.
    const toggle = page.getByTestId("sidebar-toggle");
    const sidebar = page.getByTestId("unified-sidebar");
    // Which channel opens first is the server's order, so go to the other one.
    const header = page.getByTestId("chat-header-name");
    await expect(header).toHaveText(/^(general|random)$/);
    const target = (await header.textContent()) === "general" ? "random" : "general";
    await expect(sidebar).not.toHaveClass(/drawer-open/);
    // The drawer controller loads on demand and binds the button once its backdrop exists.
    await expect(page.getByTestId("sidebar-drawer-backdrop")).toBeAttached();
    await toggle.tap();
    await expect(sidebar).toHaveClass(/drawer-open/);

    // Choosing a channel closes the drawer and opens that channel.
    await page.locator(".channel-item:not(.voice)").filter({ hasText: target }).tap();
    await expect(sidebar).not.toHaveClass(/drawer-open/);
    await expect(header).toHaveText(target);

    const text = `phone-message-${crypto.randomUUID()}`;
    await sendMessage(page, text);
    // Nothing spills sideways at 412 px.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});

test("stale tab after server update survives a chunk 404", async ({ page }) => {
  // What the app does today (found 2026-10-22): there is no "updated, reload"
  // prompt and no reload on a missing chunk. A lazy screen whose hashed chunk is
  // gone logs `[lazy-screen] Failed to load ...` and shows the toast "Couldn't
  // open that. Try again."; the rest of the app keeps working. This test pins
  // that graceful floor (no crash, no page error, a visible message, the app
  // still usable). When the reload prompt lands it replaces the toast assertion.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });

  await page.goto("/");
  await signIn(page);
  await expect(general(page)).toBeVisible();

  // The emoji picker is a lazy chunk the first click fetches. The server "updated":
  // the old hash is gone.
  let refused = 0;
  await page.route("**/assets/EmojiPicker-*.js", (route) => {
    refused++;
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
  const navigationsBefore = navigations;
  await page.getByRole("button", { name: "Emoji", exact: true }).click();

  await expect(page.getByText("Couldn't open that. Try again.")).toBeVisible();
  expect(refused).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  expect(navigations).toBe(navigationsBefore);
  // Still the signed-in app, and still able to send.
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await sendMessage(page, `after-stale-chunk-${crypto.randomUUID()}`);
});

test.describe("voice", () => {
  // Needs a LiveKit SFU beside the server: tests/e2e/scripts/install-livekit.mjs
  // downloads livekit-server, and OWNCORD_E2E_LIVEKIT_BINARY points at it.
  test.skip(
    !process.env.OWNCORD_E2E_LIVEKIT_BINARY,
    "needs the livekit-server binary (OWNCORD_E2E_LIVEKIT_BINARY, from tests/e2e/scripts/install-livekit.mjs), which this environment does not have",
  );
  test.use({ media: true });

  test("voice join with fake media", async ({ page }) => {
    await page.goto("/");
    await signIn(page);
    await expect(general(page)).toBeVisible();
    // Chromium's fake capture device stands in for the microphone.
    await joinVoice(page, "voice-one");
  });
});
