/**
 * Fullstack B9-16: bob files, withdraws and tracks his own appeals against the
 * real Go server. alice (the owner) moderates through the moderator API; bob
 * only ever uses the appellant routes (POST /appeals, GET /appeals/mine,
 * POST /appeals/{id}/withdraw), GET /users/me/moderation (Q6) and his own
 * appeal_status frames.
 *
 * The transport can fail a request or drop frames after the server sent them,
 * which models a failed send and a missed live update without faking the server.
 */

import { test, expect, login } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { TestServer } from "../support/server";

async function bobId(server: TestServer): Promise<number> {
  const users = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return users.find((u) => u.username === "bob")!.id;
}

async function openSafety(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Safety" }).click();
  const pane = page.locator(".safety-tab");
  await expect(pane.getByRole("heading", { name: "Appeals" })).toBeVisible();
  return pane;
}

const historyRow = (pane: Locator, reason: string) =>
  pane.locator("[data-testid^='safety-history-']", { hasText: `Reason: ${reason}` });
const appealRow = (pane: Locator, reason: string) =>
  pane.locator(".safety-appeals-list > .safety-history-row", { hasText: `Reason: ${reason}` });

/** Open the form on the history row for `reason`, type, and send. */
async function fileAppeal(pane: Locator, reason: string, text: string): Promise<void> {
  await historyRow(pane, reason).locator(".safety-appeal-open").click();
  await pane.locator("#safety-appeal-body").fill(text);
  await pane.getByRole("button", { name: "Send appeal" }).click();
}

async function appealIdFor(server: TestServer, reason: string): Promise<string> {
  const owner = server.owner!.token;
  const queue = (await server.api("/api/v1/moderation/appeals/", undefined, owner)) as {
    id: string;
    action_id: number;
  }[];
  const target = await bobId(server);
  const actions = (await server.api(
    `/api/v1/moderation/users/${target}/actions`,
    undefined,
    owner,
  )) as { id: number; reason: string }[];
  const action = actions.find((a) => a.reason === reason)!;
  return queue.find((a) => a.action_id === action.id)!.id;
}

test.describe("B9-16 personal appeals (real server)", () => {
  test("bob appeals a warning, survives a failed send, and sees review and decision across a reconnect", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    const paths: string[] = [];
    await server.api(`/api/v1/moderation/users/${target}/warn`, { reason: "Appeal me" }, owner);
    await expect(bob.getByRole("region", { name: "Moderation notices" })).toContainText(
      "Appeal me",
    );
    const pane = await openSafety(bob);

    // The first send fails at the transport: the draft stays, nothing resends.
    bobTransport.failHttpRequests(({ method, path }) => {
      paths.push(`${method} ${path}`);
      return method === "POST" && path === "/api/v1/appeals/";
    });
    await fileAppeal(pane, "Appeal me", "I was quoting\nthe rules.");
    await expect(pane.getByRole("alert")).toHaveText("Your appeal wasn't sent. Try again.");
    await expect(pane.locator("#safety-appeal-body")).toHaveValue("I was quoting\nthe rules.");
    await bob.waitForTimeout(500);
    expect(paths.filter((p) => p === "POST /api/v1/appeals/")).toHaveLength(1);

    bobTransport.failHttpRequests(({ method, path }) => {
      paths.push(`${method} ${path}`);
      return false;
    });
    await pane.getByRole("button", { name: "Send appeal" }).click();
    await expect(pane.getByRole("group", { name: /^Appeal:/ })).toBeHidden();
    await expect(appealRow(pane, "Appeal me")).toContainText("Status: open");
    // One appeal per action: the row no longer offers one, and says why.
    await expect(historyRow(pane, "Appeal me").locator(".safety-appeal-open")).toHaveCount(0);
    await expect(historyRow(pane, "Appeal me")).toContainText("Appeal: open");

    // The server recorded the text, line break sent as a space.
    const appealId = await appealIdFor(server, "Appeal me");
    const detail = (await server.api(
      `/api/v1/moderation/appeals/${appealId}`,
      undefined,
      owner,
    )) as {
      body: string;
    };
    expect(detail.body).toBe("I was quoting the rules.");

    // Live: assignment.
    await server.api(`/api/v1/moderation/appeals/${appealId}/assign`, {}, owner);
    await expect(appealRow(pane, "Appeal me")).toContainText("Status: under review");
    // Let the re-read that frame started land, so only a reconnect can bring the decision.
    await bob.waitForTimeout(1_000);

    // The decision's frame is missed; a reconnect reads the authoritative state.
    bobTransport.filterServerMessages((m) => m.type !== "appeal_status");
    await server.api(
      `/api/v1/moderation/appeals/${appealId}/decide`,
      { outcome: "overturned", note: "Fair point, lifted." },
      owner,
    );
    await bob.waitForTimeout(500);
    await expect(appealRow(pane, "Appeal me")).toContainText("Status: under review");
    await bobTransport.offline();
    await expect(bob.locator(".reconnecting-banner")).toBeVisible();
    bobTransport.online();
    await expect(bob.locator(".reconnecting-banner")).not.toBeVisible();
    bobTransport.filterServerMessages(undefined);
    await expect(appealRow(pane, "Appeal me")).toContainText("Status: overturned");
    await expect(appealRow(pane, "Appeal me")).toContainText(
      "Moderator's note: Fair point, lifted.",
    );
    // Overturning a warning acknowledges it: its notice leaves.
    await expect(bob.getByRole("region", { name: "Moderation notices" })).toBeHidden();
    await expect(pane).not.toContainText("alice");

    // Appellant privacy: only the member-safe routes, never a moderator read.
    expect(paths.filter((p) => p.includes("/api/v1/moderation/"))).toEqual([]);
    expect(paths).toContainEqual("GET /api/v1/appeals/mine");
  });

  test("withdraw after a confirmation, one appeal per action, and three a day", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    for (const reason of ["W1", "W2", "W3", "W4"]) {
      await server.api(`/api/v1/moderation/users/${target}/warn`, { reason }, owner);
    }
    const pane = await openSafety(bob);
    await expect(pane.locator(".safety-appeal-open")).toHaveCount(4);

    await fileAppeal(pane, "W1", "first");
    await expect(appealRow(pane, "W1")).toContainText("Status: open");
    await appealRow(pane, "W1")
      .getByRole("button", { name: /^Withdraw appeal/ })
      .click();
    await pane
      .getByRole("group", { name: /^Withdraw your appeal/ })
      .getByRole("button", { name: "Withdraw appeal" })
      .click();
    await expect(appealRow(pane, "W1")).toContainText("Status: withdrawn");
    await expect(appealRow(pane, "W1").getByRole("button")).toHaveCount(0);
    // A withdrawn appeal still uses the action's one appeal.
    await expect(historyRow(pane, "W1").locator(".safety-appeal-open")).toHaveCount(0);

    await fileAppeal(pane, "W2", "second");
    await expect(appealRow(pane, "W2")).toContainText("Status: open");
    await fileAppeal(pane, "W3", "third");
    await expect(appealRow(pane, "W3")).toContainText("Status: open");
    await fileAppeal(pane, "W4", "fourth");
    await expect(pane.getByRole("alert")).toHaveText(
      "You've filed 3 appeals in the last 24 hours. Try again later.",
    );
    await expect(pane.locator("#safety-appeal-body")).toHaveValue("fourth");
    await expect(appealRow(pane, "W4")).toHaveCount(0);
  });

  test("a lifted ban appears in the history and can be appealed once bob signs back in", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const target = await bobId(server);
    await server.api(
      `/admin/api/users/${target}`,
      { banned: true, ban_reason: "Raid" },
      owner,
      "PATCH",
    );
    // A banned account cannot sign in to appeal: it is out of band (B5).
    await expect(bob.locator("#host")).toBeVisible({ timeout: 30_000 });
    await server.api(`/admin/api/users/${target}`, { banned: false }, owner, "PATCH");
    await login(bob, server, "bob");

    const pane = await openSafety(bob);
    await expect(historyRow(pane, "Raid")).toContainText("Ban");
    await fileAppeal(pane, "Raid", "It was a misunderstanding.");
    await expect(appealRow(pane, "Raid")).toContainText("Status: open");
  });
});
