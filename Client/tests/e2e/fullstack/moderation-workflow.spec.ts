/**
 * Fullstack: taking, noting and closing a report with its immutable history
 * (B9-12, BPR-071) on a real Go server.
 *
 * Roles: alice is the owner and a second moderator, racing bob through the
 * server's own routes; bob is the moderator driving the real client, until the
 * owner takes the role away; carol and dave file the reports and are their
 * subjects. Bob's mod_queue frames are held back while alice races him,
 * so his view is honestly stale and the server's 409 decides. Every refusal is
 * read back from the server. Synthetic accounts and content only.
 */

import type { Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";
import { TEST_PASSWORD, type TestServer } from "../support/server";

const MODERATOR_ROLE_ID = 3;
const MEMBER_ROLE_ID = 4;

async function token(server: TestServer, username: string): Promise<string> {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  return auth.token as string;
}

async function register(server: TestServer, username: string): Promise<void> {
  await server.api("/api/v1/auth/register", {
    username,
    password: TEST_PASSWORD,
    invite_code: server.owner!.invite_code,
  });
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

async function userIds(server: TestServer): Promise<(name: string) => number> {
  const users = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return (name) => users.find((u) => u.username === name)!.id;
}

async function setRole(server: TestServer, userId: number, roleId: number): Promise<void> {
  await server.api(`/admin/api/users/${userId}`, { role_id: roleId }, server.owner!.token, "PATCH");
}

async function reportUser(
  server: TestServer,
  reporterToken: string,
  subjectId: number,
  reason: string,
): Promise<string> {
  const filed = await server.api(
    "/api/v1/reports",
    { target_type: "user", target_id: String(subjectId), reason, detail: "" },
    reporterToken,
  );
  return filed.id as string;
}

type QueueRow = { id: string; subject_name: string; reporter_name: string };

test.describe("Moderation review workflow (real server)", () => {
  test("take, note and close a report while a second moderator races; history stays", async ({
    alice,
    bobTransport,
    server,
  }) => {
    void alice;
    const owner = server.owner!.token;
    for (const name of ["carol", "dave"]) await register(server, name);
    const id = await userIds(server);
    await setRole(server, id("bob"), MODERATOR_ROLE_ID);

    // One login per account: the server rate-limits logins.
    const carol = await token(server, "carol");
    const bobToken = await token(server, "bob");
    const reportA = await reportUser(server, carol, id("dave"), "harassment");
    const reportB = await reportUser(server, await token(server, "dave"), id("carol"), "spam");
    const reportAboutBob = await reportUser(server, carol, id("bob"), "other");
    const reportE = await reportUser(server, carol, id("alice"), "other");
    const reportByBob = await reportUser(server, bobToken, id("dave"), "spam");

    const bob = (bobTransport as typeof bobTransport & { page: Page }).page;
    await login(bob, server, "bob");

    // The report about bob is never listed for him, and his writes on it are
    // indistinguishable from a missing report.
    const bobQueue = (await server.api(
      "/api/v1/moderation/queue",
      undefined,
      bobToken,
    )) as QueueRow[];
    expect(bobQueue.map((r) => r.id)).not.toContain(reportAboutBob);
    for (const op of ["assign", "notes", "close"]) {
      const res = await post(server, `/api/v1/moderation/queue/${reportAboutBob}/${op}`, bobToken, {
        body: "x",
        outcome: "no_action",
      });
      expect(res.status).toBe(404);
    }

    await bob.getByTestId("moderation-btn").click();
    const center = bob.getByRole("region", { name: "Moderation" });
    await expect(center.getByTestId("mod-status")).toHaveText("4 reports open or in review");
    const rows = center.getByTestId("mod-queue-row");
    const report = center.getByTestId("mod-report");
    const work = report.getByTestId("mod-work");

    // Reporter-as-moderator: bob's own filing offers no review, and the server
    // refuses it anyway.
    await rows.filter({ hasText: "About dave, reported by bob" }).click();
    await expect(work).toContainText(
      "You sent this report, so another moderator has to review it.",
    );
    await expect(work.getByRole("button")).toHaveCount(0);
    await expect(report).toContainText(
      "Internal notes are hidden from you because you sent this report.",
    );
    expect(await post(server, `/api/v1/moderation/queue/${reportByBob}/assign`, bobToken)).toEqual({
      status: 403,
      code: "SELF_REVIEW",
    });

    // Take report A from the keyboard.
    const rowA = rows.filter({ hasText: "About dave, reported by carol" });
    await rowA.focus();
    await bob.keyboard.press("Enter");
    const take = work.getByRole("button", { name: "Take this report" });
    await take.focus();
    await bob.keyboard.press("Enter");
    await expect(center.getByTestId("mod-write-status")).toHaveText(
      "You're now reviewing this report.",
    );
    await expect(work).toContainText("You're reviewing this report.");
    await expect(report.locator(".mod-report-facts")).toContainText("Assigned tobob");

    // A note: line breaks become spaces, the server keeps it, the history says so.
    const noteText = `synthetic note ${crypto.randomUUID()}`;
    const noteBox = work.getByRole("textbox", { name: "Internal note" });
    await noteBox.fill(`${noteText}\nsecond line`);
    await work.getByRole("button", { name: "Add note" }).click();
    await expect(center.getByTestId("mod-write-status")).toHaveText("Note added.");
    await expect(report.locator(".mod-note-body")).toHaveText(`${noteText} second line`);
    await expect(noteBox).toHaveValue("");
    await expect(report.getByTestId("mod-history")).toContainText("You added an internal note");

    // Race 1: alice closes A while bob, who no longer hears mod_queue, writes a
    // second note. The server refuses his note; his view shows why.
    bobTransport.filterServerMessages((m) => m.type !== "mod_queue");
    await noteBox.fill("a note that loses the race");
    await server.api(`/api/v1/moderation/queue/${reportA}/close`, { outcome: "actioned" }, owner);
    await work.getByRole("button", { name: "Add note" }).click();
    await expect(center.getByRole("alert").filter({ hasText: /./ })).toContainText(
      "Your note wasn't saved: this report was closed.",
    );
    await expect(report).toHaveCount(0);
    await expect(rowA).toHaveCount(0);

    // Race 2: alice takes B first; bob's stale Take gets the server's 409 and
    // the fresh read shows her claim.
    await rows.filter({ hasText: "About carol, reported by dave" }).click();
    await expect(work.getByRole("button", { name: "Take this report" })).toBeVisible();
    await server.api(`/api/v1/moderation/queue/${reportB}/assign`, {}, owner);
    await work.getByRole("button", { name: "Take this report" }).click();
    await expect(center.getByRole("alert").filter({ hasText: /./ })).toContainText(
      "Another moderator took this report first.",
    );
    await expect(work).toContainText("Another moderator is reviewing this report.");
    await expect(work.getByRole("button")).toHaveCount(0);
    await expect(report.locator(".mod-report-facts")).toContainText("Assigned toalice");
    bobTransport.filterServerMessages(undefined);

    // The closed report's history, under Show: Closed, is the server's.
    await center.getByLabel("Show").selectOption("closed");
    await rows.filter({ hasText: "About dave, reported by carol" }).click();
    const serverView = (await server.api(
      `/api/v1/moderation/queue/${reportA}`,
      undefined,
      bobToken,
    )) as { events: { action: string }[]; notes: { body: string }[] };
    expect(serverView.events.map((e) => e.action)).toEqual([
      "created",
      "assigned",
      "noted",
      "closed",
    ]);
    expect(serverView.notes.map((n) => n.body)).toEqual([`${noteText} second line`]);
    const historyItems = report.getByTestId("mod-history").locator(".mod-history-what");
    await expect(historyItems).toHaveText([
      "Report sent for Harassment",
      "You took the report",
      "You added an internal note",
      "alice closed the report: Action taken",
    ]);
    await expect(report.locator(".mod-note-body")).toHaveText([`${noteText} second line`]);
    // Immutable: nothing in the closed report can be typed into or pressed.
    await expect(report.locator("textarea, input, button")).toHaveCount(0);
    await expect(work).toContainText("A closed report can't be reopened or changed.");

    // The smallest desktop window: nothing scrolls sideways.
    await bob.setViewportSize({ width: 940, height: 500 });
    const view = bob.getByTestId("feature-view");
    expect(await view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

    // Demotion mid-draft: the view, the draft and every report go; the server
    // refuses every write.
    await bob.setViewportSize({ width: 1280, height: 720 });
    await center.getByLabel("Show").selectOption("");
    await rows.filter({ hasText: "About alice, reported by carol" }).click();
    await work.getByRole("button", { name: "Take this report" }).click();
    await expect(work.getByRole("textbox", { name: "Internal note" })).toBeVisible();
    await work.getByRole("textbox", { name: "Internal note" }).fill("synthetic unsaved draft");
    await setRole(server, id("bob"), MEMBER_ROLE_ID);
    await expect(center).toBeHidden();
    await expect(view).toBeEmpty();
    await expect(bob.getByText("synthetic unsaved draft")).toHaveCount(0);
    for (const op of ["assign", "notes", "close"]) {
      const res = await post(server, `/api/v1/moderation/queue/${reportE}/${op}`, bobToken, {
        body: "x",
        outcome: "no_action",
      });
      expect(res.status).toBe(403);
    }
  });
});
