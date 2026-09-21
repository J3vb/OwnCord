import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { buildTauriMockScript, emitWsEvent, submitLogin, MOCK_LOGIN_RESPONSE } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: incompatible protocol epoch (B7-12, PRD BPR-033; spec:
// docs/architecture/ux/connection-and-auth.md §2.1)
//
// The connect path probes GET /api/v1/server-info beside the health check and
// derives compatibility from protocol_epoch vs PROTOCOL_EPOCH. The badge is
// ADVISORY — it never disables Connect — and the notice appears only for the
// host the user selects or tries to connect to, or for the WebSocket refusal.
// In every case the state must name which side updates, offer the update exit
// when the client is the older side, and be exitable.
// ---------------------------------------------------------------------------

const ROUTE_HEALTH = {
  pattern: "/api/v1/health",
  status: 200,
  body: { status: "ok", uptime: 10, online_users: 0 },
};

const ROUTE_LOGIN = { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE };

/** A server that speaks a NEWER epoch than this client build (1). */
const ROUTE_SERVER_INFO_NEWER = {
  pattern: "/api/v1/server-info",
  status: 200,
  body: { name: "Future Server", protocol_epoch: 2, browser_client_enabled: false },
};

/** A compatible server: the notice must stay hidden. */
const ROUTE_SERVER_INFO_COMPATIBLE = {
  pattern: "/api/v1/server-info",
  status: 200,
  body: { name: "Test Server", protocol_epoch: 1, browser_client_enabled: false },
};

async function mockConnect(page: Page, serverInfoRoute: unknown): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [ROUTE_HEALTH, ROUTE_LOGIN, serverInfoRoute as typeof ROUTE_HEALTH],
      simulateWsFlow: false,
    }),
  );
}

const notice = (page: Page): ReturnType<Page["locator"]> => page.locator(".incompatible-notice");
const badge = (page: Page): ReturnType<Page["locator"]> => page.locator(".srv-compat-badge");

test.describe("Incompatible protocol epoch", () => {
  test("a client-older server is badged and, once selected, states the requirement and is exitable", async ({
    page,
  }) => {
    await mockConnect(page, ROUTE_SERVER_INFO_NEWER);
    await page.goto("/");

    // The advisory badge appears from the background preflight.
    await expect(badge(page).first()).toHaveText("Client update needed", { timeout: 10_000 });

    // The notice stays hidden until the user selects the host.
    await expect(notice(page)).not.toHaveClass(/visible/);

    await page.locator(".server-item").first().click();

    await expect(notice(page)).toHaveClass(/visible/);
    await expect(notice(page)).toContainText("update the client");
    await expect(page.locator(".incompatible-notice-update")).toBeVisible();

    // Exitable: leave the state and the server list stays usable.
    await page.locator(".incompatible-notice-leave").click();
    await expect(notice(page)).not.toHaveClass(/visible/);

    await page.locator(".server-item").first().click();
    await expect(page.locator("#host")).toHaveValue("localhost:8443");
  });

  test("at the 940px minimum window the notice sits above the form without squeezing it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 940, height: 600 });
    await mockConnect(page, ROUTE_SERVER_INFO_NEWER);
    await page.goto("/");
    await expect(badge(page).first()).toHaveText("Client update needed", { timeout: 10_000 });
    const hostBefore = (await page.locator("#host").boundingBox())!;

    await page.locator(".server-item").first().click();
    await expect(notice(page)).toHaveClass(/visible/);

    const box = (await notice(page).boundingBox())!;
    const host = (await page.locator("#host").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(host.y);
    expect(host.width).toBe(hostBefore.width);
  });

  test("a compatible server raises no badge and no notice", async ({ page }) => {
    await mockConnect(page, ROUTE_SERVER_INFO_COMPATIBLE);
    await page.goto("/");

    await page.locator(".server-item").first().click();
    await expect(page.locator("#host")).toHaveValue("localhost:8443");

    await expect(badge(page).first()).toHaveText("");
    await expect(notice(page)).not.toHaveClass(/visible/);
  });

  test("a WS protocol refusal states the requirement on the connect page", async ({ page }) => {
    await mockConnect(page, ROUTE_SERVER_INFO_COMPATIBLE);
    await page.goto("/");
    await page.locator("#host").fill("localhost:8443");
    await page.locator("#username").fill("testuser");
    await page.locator("#password").fill("password123");

    // Drive the login so the WS client is live, then refuse its epoch.
    await submitLogin(page);

    await emitWsEvent(
      page,
      "ws-message",
      JSON.stringify({
        type: "auth_error",
        payload: {
          message: "this client speaks protocol epoch 1 but the server needs 2; update the client",
          code: "protocol_epoch_unsupported",
          client_epoch: 1,
          server_epoch: 2,
          min_epoch: 2,
        },
      }),
    );

    await expect(notice(page)).toHaveClass(/visible/, { timeout: 10_000 });
    await expect(notice(page)).toContainText("update the client");
  });
});
