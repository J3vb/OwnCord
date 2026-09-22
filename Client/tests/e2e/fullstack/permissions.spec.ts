/**
 * Fullstack: rank enforcement on the real server (batch N3 counterpart).
 *
 * The mocked `admin-moderation.spec.ts` proves the client sends the right
 * moderation request. This spec proves the SERVER is the authority on the rank
 * rule the client cannot evaluate: a moderator may moderate a lower-ranked
 * member, and is refused on a peer or higher rank even though the client shows
 * them the menu item. Both directions run through the real member context menu
 * against a real Go server, and every assertion is checked back against the
 * server's own user list.
 */

import { test, expect, login } from "./fixtures";
import type { TestServer } from "../support/server";
import type { Page } from "@playwright/test";

interface AdminUser {
  readonly id: number;
  readonly username: string;
  readonly role_id: number;
  readonly banned: boolean;
  readonly ban_reason?: string;
  readonly ban_expires?: string;
}

/** Roles seeded by migration 001: Owner pos 100, Moderator pos 60, Member pos 40. */
const MODERATOR_ROLE_ID = 3;

/** Open a member row's context menu at a safe coordinate.
 *
 * The menu is `position:fixed` at the click point and the rows sit low in the
 * sidebar, so a real right-click puts the lower items below the viewport and
 * the test would measure layout rather than behaviour. Dispatch the same
 * `contextmenu` event the browser would, from a safe point: `MemberList`'s real
 * handler builds and positions the menu exactly as a click there would. */
async function openMemberMenu(page: Page, userId: number) {
  const row = page.locator(`[data-testid='member-${userId}']`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.evaluate((el) =>
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 640,
        clientY: 80,
        button: 2,
      }),
    ),
  );
  const menu = page.locator(".context-menu").first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}

async function listUsers(server: TestServer, token: string): Promise<AdminUser[]> {
  return (await server.api("/admin/api/users", undefined, token)) as AdminUser[];
}

test.describe("Moderation rank enforcement (real server)", () => {
  test("a moderator can ban a lower-ranked member but is refused on the owner", async ({
    alice,
    bob,
    server,
  }) => {
    void alice;
    const owner = server.owner!.token;

    // A lower-ranked member to moderate. Seeded registration mode is invite.
    await server.api("/api/v1/auth/register", {
      username: "carol",
      password: "OwnCord-E2E-pass-123!",
      invite_code: server.owner!.invite_code,
    });

    // Promote bob (id 2) to Moderator via the real admin route, then log bob
    // back in so his roster includes carol and his own role is Moderator.
    const before = await listUsers(server, owner);
    const bobUser = before.find((u) => u.username === "bob")!;
    const carolUser = before.find((u) => u.username === "carol")!;
    await server.api(
      `/admin/api/users/${bobUser.id}`,
      { role_id: MODERATOR_ROLE_ID },
      owner,
      "PATCH",
    );
    await login(bob, server, "bob");
    // The promotion reaches the client as member_update; the menu only shows
    // Ban once authStore.user.role reflects Moderator. That it appears at all
    // is the positive control for the refusals below.
    const menu = await openMemberMenu(bob, carolUser.id);
    await expect(menu.locator(".context-menu__item", { hasText: /^Ban$/ })).toBeVisible();

    // Positive: ban carol (Member, lower rank) — succeeds on the server.
    await menu.locator(".context-menu__item", { hasText: /^Ban$/ }).click();
    await menu.locator("[data-testid='ban-reason-input']").fill("e2e lower-rank ban");
    await menu.locator("[data-testid='ban-confirm']").click();
    await expect(bob.locator("[data-testid='toast']", { hasText: "Banned carol" })).toBeVisible({
      timeout: 10_000,
    });

    const afterBan = await listUsers(server, owner);
    const carolAfter = afterBan.find((u) => u.username === "carol")!;
    expect(carolAfter.banned).toBe(true);
    expect(carolAfter.ban_reason).toBe("e2e lower-rank ban");

    // Negative: the same moderator targets the Owner (higher rank). The client
    // shows the item — it cannot evaluate rank — and the server refuses.
    const ownerUser = afterBan.find((u) => u.username === "alice")!;
    const ownerMenu = await openMemberMenu(bob, ownerUser.id);
    await ownerMenu.locator(".context-menu__item", { hasText: /^Ban$/ }).click();
    await ownerMenu.locator("[data-testid='ban-confirm']").click();
    await expect(
      bob.locator("[data-testid='toast']", { hasText: "equal or higher rank" }),
    ).toBeVisible({ timeout: 10_000 });

    const afterRefusal = await listUsers(server, owner);
    expect(afterRefusal.find((u) => u.username === "alice")!.banned).toBe(false);
  });

  test("force logout of a higher-ranked peer is refused by the server", async ({
    alice,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const users = await listUsers(server, owner);
    const bobUser = users.find((u) => u.username === "bob")!;
    const aliceUser = users.find((u) => u.username === "alice")!;
    await server.api(
      `/admin/api/users/${bobUser.id}`,
      { role_id: MODERATOR_ROLE_ID },
      owner,
      "PATCH",
    );
    await login(bob, server, "bob");

    const menu = await openMemberMenu(bob, aliceUser.id);
    const logout = menu.locator("[data-testid='force-logout']");
    await expect(logout).toBeVisible();
    await logout.click();
    await expect(logout).toHaveText("Log them out?");
    await logout.click();

    await expect(
      bob.locator("[data-testid='toast']", { hasText: "equal or higher rank" }),
    ).toBeVisible({ timeout: 10_000 });

    // Alice's session still works: the force-logout never landed.
    await expect(alice.locator("[data-testid='app-layout']")).toBeVisible();
  });
});
