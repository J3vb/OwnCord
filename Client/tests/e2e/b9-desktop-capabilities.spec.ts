/**
 * B9-25: honest, actionable desktop network, notification and update
 * limitations (BPR-092, BPR-091).
 *
 * The journey: lose the server, keep "Reconnecting..." until a dial actually
 * fails, distinguish "no network at all" from "server unreachable", retry, see
 * the desktop build admit it cannot read the OS notification setting, and
 * hear/see each update phase once. These are
 * the recovery states the plan's Task 3 names, exercised through the mocked
 * desktop seam; native network/capture behaviour stays with the desktop suite.
 *
 * Accessibility evidence is automated here (names, roles, live-region once-only,
 * the 940x500 reflow). NVDA (Windows) and Orca (Linux) recordings are
 * owner-declined (2026-09-24), not pending.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  emitWsEvent,
  mockTauriFullSession,
  navigateToMainPageReady,
  openSettings,
  switchSettingsTab,
} from "./helpers";

const banner = (page: Page) => page.locator(".reconnecting-banner");
const bannerLive = (page: Page) => page.locator("[data-testid='banner-announce']");

/** Force the device's own network fact. `navigator.onLine` is read-only in a
 *  real browser, so override it before the app's listeners are wired. */
async function withDeviceOffline(page: Page, offline: boolean): Promise<void> {
  await page.addInitScript((off) => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => !off,
    });
  }, offline);
}

/** Layer a server that can go down over the base session: while
 *  `window.__serverDown` is true every dial fails, as a lost LAN server does. */
async function withLosableServer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __serverDown: boolean;
      __invokeLog: { cmd: string; args?: unknown }[];
      __tauriEmitEvent: (event: string, payload: string) => void;
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    };
    w.__serverDown = false;
    const t = w.__TAURI_INTERNALS__;
    const orig = t.invoke.bind(t);
    t.invoke = async (cmd: string, args?: unknown) => {
      if (cmd === "ws_connect" && w.__serverDown) {
        w.__invokeLog.push({ cmd, args });
        setTimeout(() => w.__tauriEmitEvent("ws-state", "closed"), 50);
        return;
      }
      return orig(cmd, args);
    };
  });
}

function setServerDown(page: Page, down: boolean): Promise<void> {
  return page.evaluate((d) => {
    (window as unknown as { __serverDown: boolean }).__serverDown = d;
  }, down);
}

function wsConnectCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __invokeLog: { cmd: string }[] }).__invokeLog.filter(
        (c) => c.cmd === "ws_connect",
      ).length,
  );
}

test.describe("B9-25 network limitations are actionable", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await withLosableServer(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("a drop says Reconnecting... until a dial fails, then offers a working Retry", async ({
    page,
  }) => {
    await setServerDown(page, true);
    await emitWsEvent(page, "ws-state", "closed");

    // No dial has failed yet: the drop alone does not prove the server is gone.
    await expect(banner(page)).toHaveText("Reconnecting...");

    await expect(banner(page)).toContainText("Can't reach this server", { timeout: 10_000 });
    const retry = banner(page).getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();

    // Retry dials at once instead of waiting out the backoff, and a failed
    // retry lands back on the same actionable notice.
    const before = await wsConnectCount(page);
    await retry.click();
    await expect.poll(() => wsConnectCount(page)).toBeGreaterThan(before);
    await expect(banner(page)).toContainText("Can't reach this server");

    // The server comes back and the next dial clears the notice.
    await setServerDown(page, false);
    await expect(banner(page)).toBeHidden({ timeout: 15_000 });
  });

  test("a disconnect while the device has no network names that, not the server", async ({
    page,
  }) => {
    await withDeviceOffline(page, true);
    await page.reload();
    await navigateToMainPageReady(page);

    await emitWsEvent(page, "ws-state", "closed");

    await expect(banner(page)).toBeVisible({ timeout: 5_000 });
    await expect(banner(page)).toContainText("This device has no network");
    // No Retry over a network the device itself does not have.
    await expect(banner(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("regaining the network re-renders the notice for the server", async ({ page }) => {
    await withDeviceOffline(page, true);
    await page.reload();
    await navigateToMainPageReady(page);
    await setServerDown(page, true);
    await emitWsEvent(page, "ws-state", "closed");
    await expect(banner(page)).toContainText("This device has no network", { timeout: 5_000 });

    await page.evaluate(() => {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
      window.dispatchEvent(new Event("online"));
    });

    await expect(banner(page)).not.toContainText("This device has no network");
  });

  test("the notice is announced once through a live region", async ({ page }) => {
    // Offline so the notice is the terminal-device wording, which is what the
    // live region must carry.
    await withDeviceOffline(page, true);
    await page.reload();
    await navigateToMainPageReady(page);

    const live = bannerLive(page);
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveText("");

    await emitWsEvent(page, "ws-state", "closed");
    await expect(live).toContainText("This device has no network");
  });

  test("the restart countdown does not re-announce every second", async ({ page }) => {
    await emitWsEvent(
      page,
      "ws-message",
      JSON.stringify({
        type: "server_restart",
        payload: { reason: "restart", delay_seconds: 5 },
      }),
    );
    const live = bannerLive(page);
    await expect(live).toHaveText("Server restarting in 5 seconds...");

    // Two countdown ticks later the visible banner has changed but the live
    // region still carries the single announcement.
    await page.waitForTimeout(2_100);
    await expect(banner(page)).toContainText("Server restarting in 3 seconds...");
    await expect(live).toHaveText("Server restarting in 5 seconds...");
  });
});

test.describe("B9-25 notification limitations are actionable", () => {
  test("the desktop build says it cannot read the system setting, with no false grant", async ({
    page,
  }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Notifications");

    const row = page.locator("[data-testid='notification-permission-row']");
    await expect(row).toContainText("OwnCord can't read your system notification setting");
    await expect(row).not.toContainText("Your system allows OwnCord");
    await expect(page.locator("[data-testid='notification-permission-allow']")).toBeHidden();
  });

  test("the permission row reflows at the 940x500 minimum window", async ({ page }) => {
    await page.setViewportSize({ width: 940, height: 500 });
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
    await openSettings(page);
    await switchSettingsTab(page, "Notifications");

    const row = page.locator("[data-testid='notification-permission-row']");
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText("check your system notification settings");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
});

test.describe("B9-25 update limitations are actionable", () => {
  /** Layer an updater mock over the base session. */
  async function mockUpdater(page: Page, available: boolean, version = "1.2.0"): Promise<void> {
    await mockTauriFullSession(page);
    await page.addInitScript(
      (cfg) => {
        const t = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__;
        const orig = t.invoke.bind(t);
        t.invoke = async (cmd: string, args?: unknown) => {
          if (cmd === "check_client_update") {
            return cfg.available
              ? {
                  available: true,
                  version: cfg.version,
                  body: "release notes",
                  manual_upgrade: false,
                }
              : { available: false, version: null, body: null, manual_upgrade: false };
          }
          return orig(cmd, args);
        };
      },
      { available, version },
    );
  }

  test("an available update is announced once when its banner appears", async ({ page }) => {
    await mockUpdater(page, true);
    await page.goto("/");
    await navigateToMainPageReady(page);

    await expect(page.locator(".update-banner-text")).toHaveText("Update v1.2.0 available");
    await expect(page.locator("[data-testid='update-announce']")).toHaveText(
      "Update v1.2.0 available",
    );
  });

  test("a manual package install states the limitation with no false update claim", async ({
    page,
  }) => {
    await mockTauriFullSession(page);
    await page.addInitScript(() => {
      const t = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const orig = t.invoke.bind(t);
      t.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === "check_client_update") {
          return { available: false, version: null, body: null, manual_upgrade: true };
        }
        return orig(cmd, args);
      };
    });
    await page.goto("/");
    await navigateToMainPageReady(page);

    await expect(page.locator(".update-banner-text")).toHaveText(
      "This install cannot update itself. Ask your server administrator for the new version.",
    );
    await expect(page.locator(".update-banner-install")).toHaveCount(0);
  });
});
