/**
 * Fullstack: warning, timeout and lifting a timeout from a report (B9-13,
 * BPR-072) on a real Go server, with the permission ladder the server applies.
 *
 * Roles: alice is the owner; bob drives the real client as a "Warden", a role
 * with MODERATE_MEMBERS and no MUTE_MEMBERS, ranked below Moderator, until the
 * owner demotes him while his frames are held back; carol files the reports;
 * dave is the subject, an ordinary member who is later ranked as bob's peer,
 * his superior and a mute-only role. No LiveKit runs here, so every timeout's
 * voice half is skipped, and the client must say so; the applied case is the
 * mocked tests/e2e/b9-moderation-actions.spec.ts. Every outcome is read back
 * from the server's own ledger. Synthetic accounts and content only.
 */

import { test, expect, login } from "./fixtures";
import { TEST_PASSWORD, type TestServer } from "../support/server";

const MODERATOR_ROLE_ID = 3;
const MEMBER_ROLE_ID = 4;
const MEMBER_BITS = 0x663;
const MUTE_MEMBERS = 0x100000;
const MODERATE_MEMBERS = 0x400000;

async function token(server: TestServer, username: string): Promise<string> {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  return auth.token as string;
}

/** POST as `auth`; the status and the server's error code. */
async function post(server: TestServer, path: string, auth: string, body: unknown = {}) {
  const response = await fetch(`${server.origin}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, code: text ? (JSON.parse(text).error as string) : "" };
}

type LedgerRow = {
  kind: string;
  report_id?: string;
  reason: string;
  expires_at?: string;
  lifted_at?: string;
};

test.describe("Moderation actions (real server)", () => {
  test("warn, time out and lift from a report; refusals and demotion come from the server", async ({
    page,
    aliceTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    // The server rate-limits registration and login: two new accounts, one login each.
    for (const name of ["carol", "dave"]) {
      await server.api("/api/v1/auth/register", {
        username: name,
        password: TEST_PASSWORD,
        invite_code: server.owner!.invite_code,
      });
    }
    const users = (await server.api("/admin/api/users", undefined, owner)) as {
      id: number;
      username: string;
    }[];
    const id = (name: string) => users.find((u) => u.username === name)!.id;
    const setRole = (userId: number, roleId: number) =>
      server.api(`/admin/api/users/${userId}`, { role_id: roleId }, owner, "PATCH");
    const role = async (name: string, permissions: number, position: number) =>
      (
        (await server.api("/admin/api/roles", { name, permissions, position }, owner)) as {
          id: number;
        }
      ).id;
    const ledger = async (userId: number) =>
      (await server.api(
        `/api/v1/moderation/users/${userId}/actions`,
        undefined,
        owner,
      )) as LedgerRow[];

    const warden = await role("Warden", MEMBER_BITS | MODERATE_MEMBERS, 50);
    const muter = await role("Muter", MEMBER_BITS | MUTE_MEMBERS, 45);
    await setRole(id("bob"), warden);

    const carol = await token(server, "carol");
    const dave = await token(server, "dave");
    const bobToken = await token(server, "bob");
    const file = async (subject: string) =>
      (
        await server.api(
          "/api/v1/reports",
          { target_type: "user", target_id: String(id(subject)), reason: "harassment", detail: "" },
          carol,
        )
      ).id as string;
    const aboutDave = await file("dave");
    const aboutAlice = await file("alice");
    const warn = (auth: string, target: string) =>
      post(server, `/api/v1/moderation/users/${id(target)}/warn`, auth, { reason: "x" });

    // The ladder, straight from the server: an ordinary member may not warn,
    // nobody may act on themselves, and the owner outranks bob.
    expect((await warn(dave, "carol")).status).toBe(403);
    expect(await warn(bobToken, "bob")).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect((await warn(bobToken, "alice")).status).toBe(403);
    expect(
      await post(server, `/api/v1/moderation/queue/${aboutAlice}/act`, bobToken, {
        kind: "timeout",
        duration_seconds: 60,
      }),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await ledger(id("alice"))).toEqual([]);

    await login(page, server, "bob");
    await page.getByTestId("moderation-btn").click();
    const center = page.getByRole("region", { name: "Moderation" });
    const rows = center.getByTestId("mod-queue-row");
    const acts = center.getByTestId("mod-report").getByTestId("mod-act");
    const status = center.getByTestId("mod-write-status");
    const alert = center.getByRole("alert").filter({ hasText: /./ });

    // Nothing to act with until bob holds the report.
    await rows.filter({ hasText: "About dave" }).click();
    await expect(center.getByRole("button", { name: "Take this report" })).toBeVisible();
    await expect(acts).toHaveCount(0);
    await center.getByRole("button", { name: "Take this report" }).click();
    await expect(status).toHaveText("You're now reviewing this report.");

    // A warning, from the keyboard, linked to the report by its public id.
    const warnReason = `synthetic warning ${crypto.randomUUID()}`;
    await acts
      .getByRole("textbox", { name: "Warning reason, shown to the member" })
      .fill(warnReason);
    await acts.getByRole("button", { name: "Issue warning" }).focus();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(
      "Warning issued. The member sees it now, or the next time they sign in.",
    );
    await expect(center.getByTestId("mod-history")).toContainText("You issued: Warning");
    expect(await ledger(id("dave"))).toEqual([
      expect.objectContaining({ kind: "warning", report_id: aboutDave, reason: warnReason }),
    ]);

    // A timeout without voice authority: the view says voice was not changed,
    // because the server said "skipped".
    await acts
      .getByRole("textbox", { name: "Timeout reason, shown to the member" })
      .fill("cool off");
    await acts.getByRole("spinbutton", { name: "Timeout length" }).fill("5");
    await acts.getByRole("button", { name: "Time out" }).click();
    await expect(status).toHaveText(
      "Timed out for 5 minutes: they can't send messages or react. Their voice wasn't changed: they weren't in a voice channel where you can moderate voice, or the mute didn't take effect.",
    );
    const timedOut = (await ledger(id("dave"))).find((r) => r.kind === "timeout")!;
    expect(timedOut).toMatchObject({ report_id: aboutDave, reason: "cool off" });
    expect(timedOut.lifted_at).toBeUndefined();
    const minutes = (Date.parse(timedOut.expires_at!) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(3);
    expect(minutes).toBeLessThanOrEqual(5);

    // Lift it through dave's own route; the ledger records it and the offer goes.
    const lift = acts.getByRole("button", { name: "Lift timeout" });
    await expect(lift).toHaveAccessibleDescription(/^This report's timeout runs until /);
    await lift.click();
    await expect(status).toHaveText("Timeout lifted: they can send messages and react again.");
    await expect(lift).toHaveCount(0);
    expect((await ledger(id("dave"))).find((r) => r.kind === "timeout")!.lifted_at).toBeTruthy();

    // dave becomes a peer, then a superior. The client can't see ranks, so it
    // still offers the action and shows the server's refusal; nothing is
    // recorded and the report stays open.
    await setRole(id("dave"), warden);
    expect((await warn(bobToken, "dave")).status).toBe(403);
    await setRole(id("dave"), MODERATOR_ROLE_ID);
    await acts.getByRole("spinbutton", { name: "Timeout length" }).fill("1");
    await acts.getByRole("combobox", { name: "Unit" }).selectOption("hours");
    await acts.getByRole("button", { name: "Time out" }).click();
    await expect(alert).toHaveText(
      "The server refused this action. You can act only on members whose role is below yours.",
    );
    await expect(status).toHaveText("");
    await expect(acts.getByRole("button", { name: "Time out" })).toBeVisible();
    expect((await ledger(id("dave"))).map((r) => r.kind).toSorted()).toEqual([
      "timeout",
      "warning",
    ]);

    // A mute-only role reaches none of this.
    await setRole(id("dave"), muter);
    expect((await warn(dave, "carol")).status).toBe(403);
    expect(
      (await post(server, `/api/v1/moderation/queue/${aboutAlice}/act`, dave, { kind: "warning" }))
        .status,
    ).toBe(403);

    // Demoted mid-submission: bob's frames are held back, so his view still
    // offers the timeout; the server refuses it and the view then clears.
    await setRole(id("dave"), MEMBER_ROLE_ID);
    await acts.getByRole("textbox", { name: "Timeout reason, shown to the member" }).fill("stale");
    aliceTransport.filterServerMessages(() => false);
    await setRole(id("bob"), MEMBER_ROLE_ID);
    await acts.getByRole("button", { name: "Time out" }).click();
    await expect(alert).toHaveText("You no longer have permission to moderate on this server.");
    await expect(center.getByTestId("mod-report")).toHaveCount(0);
    aliceTransport.filterServerMessages(undefined);
    expect((await ledger(id("dave"))).map((r) => r.kind).toSorted()).toEqual([
      "timeout",
      "warning",
    ]);
    expect(
      (
        await post(server, `/api/v1/moderation/queue/${aboutDave}/act`, bobToken, {
          kind: "warning",
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(server, `/api/v1/moderation/users/${id("dave")}/untimeout`, bobToken)).status,
    ).toBe(403);
  });
});
