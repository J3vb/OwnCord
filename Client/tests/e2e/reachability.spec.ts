/**
 * Reachability: every entry point the left panel and the rail give to a view
 * or action is visible, scrolls into view and takes keyboard focus, in Classic
 * and in Command Deck. It pins today's entry points before later phases move
 * them: each phase edits its own Deck rows here, and Phase 5 replaces the rail
 * rows with tab rows.
 *
 * A target is "reached" when it is visible, `expectReachable` puts it in the
 * viewport and `focus()` leaves it focused. Opening a view is then followed
 * where the target opens a content view.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { BASE_SESSION_ROUTES, buildTauriMockScript, navigateToMainPageReady } from "./helpers";
import { expectReachable } from "./support/a11yHarness";

const DEV_KEY = "owncord:settings:developerMode";
const LAYOUT_KEY = "owncord:settings:screenLayout";

const OTHER_HOST = "other.example:8443";

type Layout = "classic" | "deck";

/** Developer mode on and the layout stored as Deck, once: a reload must not put it back. */
async function seedDeckOnce(page: Page): Promise<void> {
  await page.addInitScript(
    ([dev, layout]) => {
      if (sessionStorage.getItem("reachability-seeded") !== null) return;
      sessionStorage.setItem("reachability-seeded", "1");
      localStorage.setItem(dev, JSON.stringify(true));
      localStorage.setItem(layout, JSON.stringify("deck"));
    },
    [DEV_KEY, LAYOUT_KEY] as const,
  );
}

const PENDING_REQUEST = {
  id: 2,
  channel_id: 202,
  sender: { id: 12, username: "stranger", display_name: "A Stranger", avatar: "" },
  preview: { message_id: 902, content: "hello", timestamp: "2026-09-05T12:00:00Z" },
  created_at: "2026-09-05T12:00:00Z",
};

/** A signed-in session with one pending request, the moderation routes and a second saved server. */
async function boot(page: Page, layout: Layout): Promise<void> {
  if (layout === "deck") await seedDeckOnce(page);
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        ...BASE_SESSION_ROUTES,
        { pattern: "/api/v1/dm-requests", status: 200, body: { requests: [PENDING_REQUEST] } },
        { pattern: "/api/v1/moderation/queue", method: "GET", status: 200, body: [] },
        { pattern: "/api/v1/moderation/appeals", method: "GET", status: 200, body: [] },
      ],
      simulateWsFlow: true,
      storedSettings: {
        "owncord:profiles": {
          schemaVersion: 1,
          profiles: [
            {
              id: "pb",
              name: "Server B",
              host: OTHER_HOST,
              username: "testuser",
              autoConnect: false,
              rememberPassword: false,
              color: "#5865f2",
              lastConnected: null,
            },
          ],
        },
      },
    }),
  );
  await page.goto("/");
  await navigateToMainPageReady(page);
  const deck = await page.evaluate(() =>
    document.documentElement.classList.contains("layout-deck"),
  );
  expect(deck).toBe(layout === "deck");
}

/** Visible, in the viewport, and able to take keyboard focus. */
async function expectReached(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expectReachable(target);
  await target.focus();
  await expect(target).toBeFocused();
}

const region = (page: Page, name: string) => page.getByRole("region", { name });

for (const layout of ["classic", "deck"] as const) {
  test.describe(layout, () => {
    test.beforeEach(async ({ page }) => {
      await boot(page, layout);
    });

    test("the default user may moderate, audit and invite", async ({ page }) => {
      // A fixture change that takes a permission away must fail here, not
      // hide the rows the tests below reach.
      await expect(page.getByTestId("moderation-btn")).toBeVisible();
      await expect(page.getByTestId("audit-log-btn")).toBeVisible();
      await expect(page.getByTestId("invite-btn")).toBeVisible();
    });

    test("Moderation is reached from the header and opens its view", async ({ page }) => {
      const btn = page.getByTestId("moderation-btn");
      await expectReached(btn);
      await page.keyboard.press("Enter");
      await expect(region(page, "Moderation")).toBeVisible();
    });

    test("Audit Log and Invite are reached from the header", async ({ page }) => {
      await expectReached(page.getByTestId("audit-log-btn"));
      await expectReached(page.getByTestId("invite-btn"));
    });

    test("People is reached through Home and opens its view", async ({ page }) => {
      if (layout === "classic") await page.getByTestId("server-rail-home").click();
      const people = page.getByTestId("dm-people-entry");
      await expectReached(people);
      await page.keyboard.press("Enter");
      await expect(region(page, "People")).toBeVisible();
    });

    test("Message requests is reached through Home and opens its view", async ({ page }) => {
      if (layout === "classic") await page.getByTestId("server-rail-home").click();
      const requests = page.getByTestId("dm-requests-entry");
      await expect(requests).toHaveAccessibleName("Message requests, 1 waiting");
      await expectReached(requests);
      await page.keyboard.press("Enter");
      await expect(region(page, "Message Requests")).toBeVisible();
    });

    if (layout === "deck") {
      test("the server menu button is reached from the strip and opens the menu", async ({
        page,
      }) => {
        const btn = page.getByTestId("server-menu-btn");
        await expectReached(btn);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("menu")).toBeVisible();
        await expect(btn).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByTestId("server-menu-notifications")).toBeVisible();
      });

      test("the Direct button is reached and Enter moves focus to the Direct folder header", async ({
        page,
      }) => {
        await expectReached(page.getByTestId("deck-direct"));
        await page.keyboard.press("Enter");
        await expect(page.locator(".server-tree-direct-head")).toBeFocused();
      });
    }

    test("the rail's Home, saved servers and Add are reached", async ({ page }) => {
      await expectReached(page.getByTestId("server-rail-home"));
      const servers = page.getByTestId("server-rail-server");
      expect(await servers.count()).toBeGreaterThanOrEqual(2);
      await expect(
        page.locator(`[data-testid='server-rail-server'][data-host='${OTHER_HOST}']`),
      ).toBeVisible();
      for (const server of await servers.all()) await expectReached(server);
      await expectReached(page.getByTestId("server-rail-add"));
    });
  });
}
