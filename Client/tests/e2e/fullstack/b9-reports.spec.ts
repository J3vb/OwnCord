/**
 * Fullstack: local report intake and the reporter's own status (B9-10,
 * BPR-070) on a real Go server.
 *
 * Roles: alice is the subject (her message, her attachment, her account), bob
 * the reporter driving the real client, carol a bystander member and dave a
 * moderator. Every assertion about who can see what is read back from the
 * server's own routes. The client's HTTP sends are recorded at the transport
 * boundary, which already refuses any origin but this server, so the record
 * shows every report went only to this server and nothing read the
 * moderation queue. Synthetic accounts and content only.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { TEST_PASSWORD, type TestServer } from "../support/server";

const MODERATOR_ROLE_ID = 3;
/** GET /reports/mine's documented fields; anything else is over-disclosure. */
const SUMMARY_FIELDS = [
  "closed_at",
  "created_at",
  "id",
  "outcome",
  "reason",
  "state",
  "target_type",
];

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

/** A raw call whose status the test asserts, unlike server.api, which throws. */
async function status(server: TestServer, path: string, auth: string, body?: unknown) {
  const response = await fetch(`${server.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status;
}

async function send(page: Page, text: string, file?: string): Promise<void> {
  const composer = page.locator("[data-testid='message-input']");
  if (file !== undefined) {
    await composer.locator("input[type='file']").setInputFiles({
      name: file,
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic attachment"),
    });
    await expect(composer.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  }
  await composer.locator("textarea").fill(text);
  await composer.locator("textarea").press("Enter");
}

/** The Report button on the row showing `text`, focused and pressed from the keyboard. */
async function openMessageReport(page: Page, text: string): Promise<Locator> {
  const button = page
    .locator(".message", { hasText: text })
    .locator("[data-testid^='msg-report-']");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Report message" })).toBeVisible();
  return button;
}

async function submit(page: Page, reason: string, target?: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: /^Report / });
  if (target !== undefined) await dialog.getByRole("radio", { name: target }).check();
  await dialog.getByRole("radio", { name: reason }).check();
  await dialog.getByRole("button", { name: "Send report" }).press("Enter");
  return dialog;
}

const sent = (page: Page) =>
  page.locator("[data-testid='toast']", { hasText: "Report sent." }).last();

test.describe("Local report intake (real server)", () => {
  test("a member reports a message, an attachment and a user, and sees only their own status", async ({
    alice,
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    await register(server, "dave");
    const users = (await server.api("/admin/api/users", undefined, owner)) as {
      id: number;
      username: string;
    }[];
    const id = (name: string) => users.find((u) => u.username === name)!.id;
    await server.api(
      `/admin/api/users/${id("dave")}`,
      { role_id: MODERATOR_ROLE_ID },
      owner,
      "PATCH",
    );

    const sends: string[] = [];
    bobTransport.failHttpRequests((r) => {
      sends.push(`${r.method} ${r.path}`);
      return false;
    });

    const text = `synthetic-report-target-${crypto.randomUUID()}`;
    await send(alice, text, "synthetic-notes.txt");
    await expect(bob.locator(".message", { hasText: text })).toBeVisible();

    // Cancel sends nothing and puts focus back on the Report button.
    const opener = await openMessageReport(bob, text);
    await bob.keyboard.press("Escape");
    await expect(bob.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(sends.filter((s) => s.startsWith("POST /api/v1/reports"))).toEqual([]);

    // The message itself; completion closes the form and returns focus.
    await openMessageReport(bob, text);
    await bob.getByRole("textbox", { name: "Details (optional)" }).fill("synthetic detail");
    await submit(bob, "Harassment");
    await expect(sent(bob)).toBeVisible();
    await expect(bob.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    // A second report on the same message is the server's duplicate refusal.
    await openMessageReport(bob, text);
    const duplicate = await submit(bob, "Spam");
    await expect(
      duplicate.getByRole("alert").filter({ hasText: "already have an open report" }),
    ).toBeVisible();
    await duplicate.getByRole("button", { name: "Cancel" }).click();

    // One of its attachments, by its upload id.
    await openMessageReport(bob, text);
    await submit(bob, "Spam", "The attachment synthetic-notes.txt");
    await expect(bob.getByRole("dialog")).toHaveCount(0);
    await expect(sent(bob)).toBeVisible();

    // The author, from the member list's profile.
    const row = bob.locator(`[data-testid='member-${id("alice")}']`);
    await row.focus();
    await bob.keyboard.press("Enter");
    await bob.getByTestId("upp-report-btn").click();
    await submit(bob, "Something else");
    await expect(bob.getByRole("dialog")).toHaveCount(0);
    await expect(sent(bob)).toBeVisible();

    // My reports: the three summaries, and nothing a moderator sees.
    await bob.locator("button[aria-label='Settings']").click();
    await bob.getByRole("tab", { name: "Safety" }).click();
    const mine = bob.getByRole("region", { name: "My reports" });
    await expect(mine.locator(".my-reports-what")).toHaveText([
      "User reported for Something else",
      "Attachment reported for Spam",
      "Message reported for Harassment",
    ]);
    await expect(mine.locator(".my-reports-state")).toHaveText(Array(3).fill("Waiting for review"));
    await expect(mine).not.toContainText("dave");
    await expect(mine).not.toContainText("synthetic detail");

    // The summary route's fields are exactly the documented allowlist.
    const bobToken = await token(server, "bob");
    const summary = (await server.api("/api/v1/reports/mine", undefined, bobToken)) as Record<
      string,
      unknown
    >[];
    expect(summary).toHaveLength(3);
    for (const r of summary) expect(Object.keys(r).sort()).toEqual(SUMMARY_FIELDS);

    // Role isolation, from the server: the moderator sees all three with the
    // actual targets; the subject's queue excludes reports about her; a
    // bystander member has none of her own and no queue at all.
    const channels = await server.api("/api/v1/channels/", undefined, owner);
    const general = channels.find((c: { name: string; type: string }) => c.name === "general");
    const history = await server.api(`/api/v1/channels/${general.id}/messages`, undefined, owner);
    const target = history.messages.find((m: { content: string }) => m.content === text);
    const queue = (await server.api(
      "/api/v1/moderation/queue",
      undefined,
      await token(server, "dave"),
    )) as { target_type: string; target_ref: string; subject_name: string }[];
    expect(queue.map((q) => [q.target_type, q.target_ref]).sort()).toEqual(
      [
        ["attachment", target.attachments[0].id],
        ["message", String(target.id)],
        ["user", String(id("alice"))],
      ].sort(),
    );
    expect(await server.api("/api/v1/moderation/queue", undefined, owner)).toEqual([]);
    const carol = await token(server, "carol");
    expect(await server.api("/api/v1/reports/mine", undefined, carol)).toEqual([]);
    expect(await status(server, "/api/v1/moderation/queue", carol)).toBe(403);

    // Network destinations: the client wrote reports and read its own
    // summary on this server, and never touched the moderation queue. The
    // Safety tab's only moderation read is the caller's own history (B9-15).
    const moderationReads = new Set(sends.filter((s) => s.includes("/moderation")));
    expect([...moderationReads]).toEqual(["GET /api/v1/users/me/moderation"]);
    const reportSends = sends.filter((s) => s.includes("/reports"));
    expect(reportSends).toEqual([
      "POST /api/v1/reports",
      "POST /api/v1/reports",
      "POST /api/v1/reports",
      "POST /api/v1/reports",
      "GET /api/v1/reports/mine",
    ]);
  });

  test("a removed target and the report quota are refused with their own explanations", async ({
    alice,
    bob,
    server,
  }) => {
    const text = `synthetic-removed-target-${crypto.randomUUID()}`;
    await send(alice, text);
    await expect(bob.locator(".message", { hasText: text })).toBeVisible();

    // Bob opens the form; alice deletes the message before he sends it.
    await openMessageReport(bob, text);
    const own = alice.locator(".message", { hasText: text });
    await own.hover();
    const del = own.locator("[data-testid^='msg-delete-']");
    await del.click();
    await del.click();
    await expect(bob.locator(".message", { hasText: text })).toHaveCount(0);
    const dialog = await submit(bob, "Spam");
    await expect(dialog.getByRole("alert").filter({ hasText: "it was deleted" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Five attempts per ten minutes: that was one; spend four more directly.
    const bobToken = await token(server, "bob");
    for (let i = 0; i < 4; i++) {
      const code = await status(server, "/api/v1/reports", bobToken, {
        target_type: "user",
        target_id: "999999",
        reason: "spam",
        detail: "",
      });
      expect(code).toBe(404);
    }
    const next = `synthetic-quota-target-${crypto.randomUUID()}`;
    await send(alice, next);
    await openMessageReport(bob, next);
    const limited = await submit(bob, "Spam");
    await expect(limited.getByRole("alert").filter({ hasText: "too many reports" })).toBeVisible();
    expect(await server.api("/api/v1/reports/mine", undefined, bobToken)).toEqual([]);
  });
});
