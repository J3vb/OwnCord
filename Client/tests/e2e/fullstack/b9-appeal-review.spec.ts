/**
 * Fullstack B9-17: reviewing and deciding appeals on a real Go server, with
 * the reviewer and the appellant on screen together.
 *
 * Roles: alice is the owner and acts through the API; carol reviews in the
 * client as a "Warden" (MODERATE_MEMBERS, no Administrator) until the owner
 * demotes her while her frames are held back; bob files appeals through the
 * appellant routes and watches their status in his own Safety tab. Every
 * outcome is read back from the server. Synthetic accounts and content only.
 *
 * The sole-moderator exception can't be reached here, since the owner is
 * always another eligible moderator; Server/service/appeal_test.go's
 * TestAppeal_SoleModeratorMayDecideAndAuditSaysSo covers it.
 */

import { test, expect, login } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { TEST_PASSWORD, type TestServer } from "../support/server";

const MEMBER_ROLE_ID = 4;
const MEMBER_BITS = 0x663;
const MODERATE_MEMBERS = 0x400000;

async function token(server: TestServer, username: string): Promise<string> {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  return auth.token as string;
}

async function openSafety(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Safety" }).click();
  const pane = page.locator(".safety-tab");
  await expect(pane.getByRole("heading", { name: "Appeals" })).toBeVisible();
  return pane;
}

const appealRow = (pane: Locator, reason: string) =>
  pane.locator(".safety-appeals-list > .safety-history-row", { hasText: `Reason: ${reason}` });

type AppealState = { state: string; assignee_id: number; decision_note: string };

test.describe("B9-17 appeal review (real server)", () => {
  test("take, refuse, decide and race appeals; the appellant sees only the outcome", async ({
    page,
    aliceTransport,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    await server.api("/api/v1/auth/register", {
      username: "carol",
      password: TEST_PASSWORD,
      invite_code: server.owner!.invite_code,
    });
    const users = (await server.api("/admin/api/users", undefined, owner)) as {
      id: number;
      username: string;
    }[];
    const id = (name: string) => users.find((u) => u.username === name)!.id;
    const setRole = (userId: number, roleId: number) =>
      server.api(`/admin/api/users/${userId}`, { role_id: roleId }, owner, "PATCH");
    const warden = (
      (await server.api(
        "/admin/api/roles",
        { name: "Warden", permissions: MEMBER_BITS | MODERATE_MEMBERS, position: 50 },
        owner,
      )) as { id: number }
    ).id;
    await setRole(id("carol"), warden);
    const carolToken = await token(server, "carol");
    const bobToken = await token(server, "bob");

    /** A warning to bob from `by`, and bob's appeal against it; the appeal's public id. */
    const appealed = async (by: string, reason: string, body: string): Promise<string> => {
      await server.api(`/api/v1/moderation/users/${id("bob")}/warn`, { reason }, by);
      const own = (await server.api("/api/v1/users/me/moderation", undefined, bobToken)) as {
        id: number;
        reason: string;
      }[];
      const action = own.find((r) => r.reason === reason)!;
      return (await server.api("/api/v1/appeals/", { action_id: action.id, body }, bobToken))
        .id as string;
    };
    const appealState = async (appealId: string) =>
      (await server.api(`/api/v1/moderation/appeals/${appealId}`, undefined, owner)) as AppealState;

    const decided = await appealed(owner, "Spam links", "I was quoting the rules.");
    const raced = await appealed(owner, "Off topic", "It was on topic.");
    const ownAction = await appealed(carolToken, "Too loud", "I disagree.");

    const bobPane = await openSafety(bob);
    await expect(appealRow(bobPane, "Spam links")).toContainText("Status: open");

    await login(page, server, "carol");
    await page.getByTestId("moderation-btn").click();
    const center = page.getByRole("region", { name: "Moderation" });
    await center.getByRole("tab", { name: "Appeals" }).click();
    const rows = center.getByTestId("mod-appeal-row");
    const appeal = center.getByTestId("mod-appeal");
    const status = center.getByTestId("mod-appeal-write-status");
    const alert = center.getByRole("alert").filter({ hasText: /./ });
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("Appeal from bob");
    const open = async (appealId: string) => {
      await center.locator(`[data-appeal-id="${appealId}"]`).click();
      await expect(appeal.getByRole("heading", { level: 3 })).toBeFocused();
    };

    // Take and decide: overturn, with a note for bob. Nothing is claimed
    // before the server answers, and the result is the recorded one.
    await open(decided);
    await expect(appeal).toContainText("Appeal: Warning");
    await expect(appeal).toContainText("I was quoting the rules.");
    await appeal.getByRole("button", { name: "Take this appeal" }).click();
    await expect(status).toHaveText("You're now reviewing this appeal.");
    await expect(appealRow(bobPane, "Spam links")).toContainText("Status: under review");
    await appeal.getByRole("radio", { name: "Overturn (reverse the action)" }).check();
    await appeal.getByRole("textbox", { name: "Note to the appellant" }).fill("Fair point.");
    await appeal.getByRole("button", { name: "Record decision" }).click();
    await expect(status).toHaveText(
      "Decision recorded. The status below is what the server saved.",
    );
    await expect(appeal.getByTestId("mod-appeal-result")).toHaveText("Overturned.");
    await expect(appeal).toContainText(
      "Overturning cleared the warning from the member's notices.",
    );
    await expect(appeal.getByRole("button")).toHaveCount(0);
    expect(await appealState(decided)).toMatchObject({
      state: "overturned",
      decision_note: "Fair point.",
    });
    // The audit writer is asynchronous: wait for the decision's row.
    const decisions = async () =>
      (
        (await server.api("/admin/api/audit-log?limit=50", undefined, owner)) as {
          action: string;
          actor_id: number;
          detail: string;
        }[]
      ).filter((e) => e.action === "appeal_decide");
    await expect
      .poll(decisions)
      .toEqual([expect.objectContaining({ actor_id: id("carol"), detail: "overturned" })]);

    // bob sees the outcome and the note, never who reviewed it.
    await expect(appealRow(bobPane, "Spam links")).toContainText("Status: overturned");
    await expect(appealRow(bobPane, "Spam links")).toContainText("Moderator's note: Fair point.");
    await expect(bobPane).not.toContainText("carol");
    const mine = (await server.api("/api/v1/appeals/mine", undefined, bobToken)) as Record<
      string,
      unknown
    >[];
    for (const row of mine) {
      expect(Object.keys(row).toSorted()).toEqual(
        [
          "action_created_at",
          "action_kind",
          "action_reason",
          "created_at",
          "decided_at",
          "decision_note",
          "id",
          "state",
        ].toSorted(),
      );
    }

    // A race: bob withdraws while carol's decision form is open and her
    // frames are held. The server refuses, and the view shows its state.
    await open(raced);
    await appeal.getByRole("button", { name: "Take this appeal" }).click();
    await expect(status).toHaveText("You're now reviewing this appeal.");
    await appeal.getByRole("radio", { name: "Uphold (the action stands)" }).check();
    aliceTransport.filterServerMessages(() => false);
    await server.api(`/api/v1/appeals/${raced}/withdraw`, {}, bobToken);
    await appeal.getByRole("button", { name: "Record decision" }).click();
    await expect(alert).toHaveText(
      "Nothing was recorded: this appeal changed first. Another moderator took or decided it, or the appellant withdrew it.",
    );
    await expect(status).toHaveText("");
    await expect(appeal).toContainText("The appellant withdrew this appeal. It can't be decided.");
    aliceTransport.filterServerMessages(undefined);
    expect((await appealState(raced)).state).toBe("withdrawn");

    // carol issued this action and the owner can review its appeal: the
    // client offers Take and says the rule, the server refuses it.
    await open(ownAction);
    await expect(appeal).toContainText("You issued this action.");
    await appeal.getByRole("button", { name: "Take this appeal" }).click();
    await expect(alert).toHaveText(
      "The server refused: you issued this action and another moderator can review its appeal, so they have to.",
    );
    await expect(status).toHaveText("");
    expect(await appealState(ownAction)).toMatchObject({ state: "open", assignee_id: 0 });

    // Demoted while her frames are held: the stale view still offers Take;
    // the server refuses and the whole Moderation Center clears.
    aliceTransport.filterServerMessages(() => false);
    await setRole(id("carol"), MEMBER_ROLE_ID);
    await appeal.getByRole("button", { name: "Take this appeal" }).click();
    await expect(alert).toHaveText("You no longer have permission to moderate on this server.");
    await expect(appeal).toHaveCount(0);
    await expect(center).not.toContainText("I disagree.");
    await expect(rows).toHaveCount(0);
    aliceTransport.filterServerMessages(undefined);
    expect(await appealState(ownAction)).toMatchObject({ state: "open", assignee_id: 0 });
    const refused = await fetch(`${server.origin}/api/v1/moderation/appeals/`, {
      headers: { Authorization: `Bearer ${carolToken}` },
    });
    expect(refused.status).toBe(403);
  });
});
