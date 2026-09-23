/**
 * Fullstack B9-15: a moderated member's notices and restrictions against the
 * real Go server (owner decisions Q4 and Q6). alice (the owner) acts through
 * the moderator API; bob only ever sees what his own session is sent:
 * ready.notices, the targeted mod_action frame and GET /users/me/moderation.
 *
 * The transport can drop frames after the server sent them, which models a
 * missed live update without faking the server.
 */

import { test, expect, login } from "./fixtures";
import type { Page } from "@playwright/test";
import type { TestServer } from "../support/server";

async function bobId(server: TestServer): Promise<number> {
  const users = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return users.find((u) => u.username === "bob")!.id;
}

/** Log out from settings and sign in again: a full ready, and a store cleared by sign-out. */
async function relogin(page: Page, server: TestServer): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-nav-item.danger").click();
  await expect(page.locator("#host")).toBeVisible({ timeout: 30_000 });
  await login(page, server, "bob");
}

const banner = (page: Page) => page.getByRole("region", { name: "Moderation notices" });
const composer = (page: Page) => page.locator("[data-testid='message-input'] textarea");

test.describe("B9-15 moderation notices (real server)", () => {
  test("a warning reaches bob live and after a missed frame, and his acknowledgement is recorded", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    const paths: string[] = [];
    // Spy only: record every REST path bob's client calls, fail none.
    bobTransport.failHttpRequests(({ method, path }) => {
      paths.push(`${method} ${path}`);
      return false;
    });

    await server.api(`/api/v1/moderation/users/${target}/warn`, { reason: "Live: no spam" }, owner);
    await expect(banner(bob)).toContainText("Reason: Live: no spam");
    await expect(bob.locator(".toast", { hasText: "Live: no spam" })).toHaveCount(1);

    // Miss the next live frame, then reconnect: the warning still arrives.
    bobTransport.filterServerMessages((m) => m.type !== "mod_action");
    await server.api(
      `/api/v1/moderation/users/${target}/warn`,
      { reason: "Missed: be kind" },
      owner,
    );
    await bobTransport.offline();
    await expect(bob.locator(".reconnecting-banner")).toBeVisible();
    bobTransport.online();
    await expect(bob.locator(".reconnecting-banner")).not.toBeVisible();
    await expect(banner(bob)).toContainText("Reason: Missed: be kind");
    bobTransport.filterServerMessages(undefined);

    // Oldest first; the recipient never sees who acted.
    await expect(banner(bob).locator(".moderation-notice").first()).toContainText("Live: no spam");
    await expect(banner(bob)).not.toContainText("alice");

    // Acknowledge both. The server records each, and neither returns after a
    // full reconnect (a fresh sign-in delivers ready.notices again).
    for (let i = 0; i < 2; i++) {
      await banner(bob).getByRole("button", { name: "Acknowledge" }).first().click();
    }
    await expect(banner(bob)).toBeHidden();
    const ledger = (await server.api(
      `/api/v1/moderation/users/${target}/actions`,
      undefined,
      owner,
    )) as { kind: string; acknowledged_at?: string }[];
    const warnings = ledger.filter((a) => a.kind === "warning");
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w.acknowledged_at).toBeTruthy();
    await relogin(bob, server);
    await expect(composer(bob)).toBeEnabled();
    await expect(banner(bob)).toBeHidden();

    // Recipient privacy: only the member-safe routes, never a moderator read.
    expect(paths.filter((p) => p.includes("/api/v1/moderation/"))).toEqual([]);
    expect(paths).toContainEqual(expect.stringMatching(/^GET \/api\/v1\/users\/me\/moderation$/));
    expect(paths).toContainEqual(
      expect.stringMatching(/^POST \/api\/v1\/users\/me\/notices\/\d+\/ack$/),
    );
  });

  test("a live timeout gates the composer with the server's expiry and its lift re-enables it", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    await server.api(
      `/api/v1/moderation/users/${target}/timeout`,
      { reason: "Cool off", duration_seconds: 600 },
      owner,
    );
    await expect(composer(bob)).toBeDisabled();
    await expect(composer(bob)).toHaveAttribute("placeholder", /^You can't send messages until /);
    await expect(bob.locator(".toast", { hasText: /^You're timed out until / })).toHaveCount(1);
    await expect(banner(bob)).toBeHidden(); // timeouts are not banners (Q4)
    await server.api(`/api/v1/moderation/users/${target}/untimeout`, {}, owner);
    await expect(composer(bob)).toBeEnabled();
    await expect(composer(bob)).toHaveAttribute("placeholder", "Message #general");
  });

  test("a missed timeout frame is learnt from the refused send and survives a reconnect", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    // Let sign-in's own history read land first, so only the refusal can
    // tell the client about the timeout below.
    await bob.waitForTimeout(1_000);
    bobTransport.filterServerMessages((m) => m.type !== "mod_action");
    await server.api(
      `/api/v1/moderation/users/${target}/timeout`,
      { reason: "Again", duration_seconds: 600 },
      owner,
    );
    await expect(composer(bob)).toBeEnabled();
    await composer(bob).fill("hello while timed out");
    await composer(bob).press("Enter");
    await expect(composer(bob)).toHaveAttribute("placeholder", /^You can't send messages until /);
    bobTransport.filterServerMessages(undefined);

    // A full reconnect keeps the timeout and its expiry (GET /users/me/moderation).
    await relogin(bob, server);
    await expect(composer(bob)).toBeDisabled();
    await expect(composer(bob)).toHaveAttribute("placeholder", /^You can't send messages until /);

    await bob.getByRole("button", { name: "Settings" }).click();
    await bob.getByRole("tab", { name: "Safety" }).click();
    const pane = bob.locator(".safety-tab");
    await expect(pane).toContainText(/You're timed out until .+ You can't send messages/);
    await expect(pane.locator(".safety-history-row")).toHaveCount(1);
    await expect(pane).toContainText("Reason: Again");
    await expect(pane).not.toContainText("alice");
  });
});
