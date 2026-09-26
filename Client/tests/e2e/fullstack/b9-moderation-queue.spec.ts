/**
 * Fullstack: the Moderation Center's queue and authorized evidence (B9-11,
 * BPR-071) on a real Go server.
 *
 * Roles: alice is the owner and the subject of the reports, carol the reporter
 * (her reports go through the server's own route), and bob the moderator
 * driving the real client, until the owner takes the role away. Who may see
 * what is the server's decision; every count and refusal below is read back
 * from its routes, and bob's HTTP sends are recorded at the transport boundary
 * so "nothing else was fetched" is observed, not assumed. Synthetic accounts
 * and content only.
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

async function status(server: TestServer, path: string, auth: string, method = "GET") {
  const response = await fetch(`${server.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}` },
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
  await expect(page.locator(".msg-text", { hasText: text })).toBeVisible();
}

const channelItem = (page: Page, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });

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

/** The message with `content` in channel `channelId`, read as the owner. */
async function messageId(server: TestServer, channelId: number, content: string): Promise<number> {
  const history = await server.api(
    `/api/v1/channels/${channelId}/messages`,
    undefined,
    server.owner!.token,
  );
  return history.messages.find((m: { content: string }) => m.content === content).id as number;
}

test.describe("Moderation Center (real server)", () => {
  test("a moderator reads the queue and permitted evidence; consent and role loss take it away", async ({
    alice,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    const id = await userIds(server);
    await setRole(server, id("bob"), MODERATOR_ROLE_ID);
    await server.api("/admin/api/channels", { name: "random", type: "text" }, owner);
    const channels = (await server.api("/api/v1/channels/", undefined, owner)) as {
      id: number;
      name: string;
      type: string;
    }[];
    const general = channels.find((c) => c.name === "general" && c.type === "text")!;
    const random = channels.find((c) => c.name === "random")!;

    // Alice posts the content carol will report: one message with a file in
    // general, one in random, which is labelled age-restricted afterwards.
    const plain = `synthetic-evidence-${crypto.randomUUID()}`;
    const restricted = `synthetic-restricted-${crypto.randomUUID()}`;
    await send(alice, plain, "synthetic-notes.txt");
    await channelItem(alice, "random").click();
    await send(alice, restricted);
    const carol = await token(server, "carol");
    await server.api(
      "/api/v1/reports",
      {
        target_type: "message",
        target_id: String(await messageId(server, general.id, plain)),
        reason: "harassment",
        detail: "synthetic reporter detail",
      },
      carol,
    );
    await server.api(
      "/api/v1/reports",
      {
        target_type: "message",
        target_id: String(await messageId(server, random.id, restricted)),
        reason: "nsfw_unlabelled",
        detail: "",
      },
      carol,
    );
    await server.api(`/admin/api/channels/${random.id}`, { nsfw: true }, owner, "PATCH");

    const bob = (bobTransport as typeof bobTransport & { page: Page }).page;
    await login(bob, server, "bob");
    const sends: string[] = [];
    bobTransport.failHttpRequests((r) => {
      sends.push(`${r.method} ${r.path}`);
      return false;
    });
    const bobToken = await token(server, "bob");

    // The entry, from the keyboard: the view takes focus on its heading.
    const entry = bob.getByTestId("moderation-btn");
    await entry.focus();
    await bob.keyboard.press("Enter");
    const center = bob.getByRole("region", { name: "Moderation" });
    await expect(center.getByRole("heading", { name: "Moderation", level: 2 })).toBeFocused();
    await expect(entry).toHaveAttribute("aria-current", "page");

    // The count and rows are the server's own answer.
    const queue = (await server.api("/api/v1/moderation/queue", undefined, bobToken)) as unknown[];
    expect(queue).toHaveLength(2);
    await expect(center.getByTestId("mod-status")).toHaveText("2 reports open or in review");
    const rows = center.getByTestId("mod-queue-row");
    await expect(rows).toHaveCount(2);

    // A report and its snapshot, as text: nothing is fetched to show it.
    const plainRow = rows.filter({ hasText: "Harassment" });
    await plainRow.focus();
    await bob.keyboard.press("Enter");
    const report = center.getByTestId("mod-report");
    await expect(report.getByRole("heading", { level: 3 })).toBeFocused();
    await expect(report.locator(".mod-evidence-reported .mod-evidence-text")).toHaveText(plain);
    await expect(report).toContainText("synthetic-notes.txt (text/plain");
    await expect(report).toContainText("Attachments are kept by reference only.");
    await expect(report).toContainText("synthetic reporter detail");
    await expect(report.locator("img, a, video, iframe")).toHaveCount(0);

    // Escape closes the report, back on its row; a second Escape leaves the view.
    await bob.keyboard.press("Escape");
    await expect(report).toHaveCount(0);
    await expect(plainRow).toBeFocused();
    await expect(center).toBeVisible();

    // Evidence from the age-restricted channel waits for bob's own consent.
    await rows.filter({ hasText: "Adult content" }).click();
    const gate = center.getByTestId("nsfw-gate");
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("random");
    await expect(center).not.toContainText(restricted);
    const beforeAck = sends.length;
    await gate.getByTestId("nsfw-gate-continue").click();
    await expect(report.locator(".mod-evidence-text")).toHaveText(restricted);
    // Consent is recorded with the server before the evidence is read again.
    const acked = sends.slice(beforeAck);
    const put = acked.indexOf(`PUT /api/v1/channels/${random.id}/nsfw-acknowledgement`);
    const reread = acked.findIndex((s) => s.startsWith("GET /api/v1/moderation/queue/"));
    expect(put).toBeGreaterThanOrEqual(0);
    expect(reread).toBeGreaterThan(put);

    // Consent withdrawn on another device: the evidence leaves at once.
    expect(
      await status(
        server,
        `/api/v1/channels/${random.id}/nsfw-acknowledgement`,
        bobToken,
        "DELETE",
      ),
    ).toBe(204);
    await expect(center).not.toContainText(restricted);
    await expect(gate).toBeVisible();

    // A new report reaches the open view through mod_queue.
    await server.api(
      "/api/v1/reports",
      { target_type: "user", target_id: String(id("alice")), reason: "spam", detail: "" },
      carol,
    );
    await expect(center.getByTestId("mod-status")).toHaveText("3 reports open or in review");

    // The smallest desktop window: nothing in the view scrolls sideways.
    await bob.setViewportSize({ width: 940, height: 500 });
    const view = bob.getByTestId("feature-view");
    expect(await view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await rows.first().focus();
    expect(await view.evaluate((el) => el.scrollLeft)).toBe(0);

    // Network: queue and report reads plus the one acknowledgement. No file,
    // no channel history, no other moderation route.
    expect(sends.filter((s) => s.includes("/files/") || s.includes("/attachments"))).toEqual([]);
    expect(
      sends.filter((s) => /\/channels\/\d+\/messages/.test(s) && s.includes(`/${random.id}/`)),
    ).toEqual([]);
    expect(
      sends.filter(
        (s) =>
          s.includes("/moderation") &&
          !/^GET \/api\/v1\/moderation\/queue(\/[0-9a-f]+)?$/.test(s) &&
          s !== "GET /api/v1/users/me/moderation",
      ),
    ).toEqual([]);

    // Role loss: the view closes, the entry goes, and nothing private stays.
    await setRole(server, id("bob"), MEMBER_ROLE_ID);
    await expect(center).toBeHidden();
    await expect(entry).toBeHidden();
    await expect(view).toBeEmpty();
    await expect(bob.getByTestId("mod-report")).toHaveCount(0);
    expect(await status(server, "/api/v1/moderation/queue", bobToken)).toBe(403);
  });

  test("a report about the viewer is never listed for them, and a member has no queue", async ({
    alice,
    bob,
    server,
  }) => {
    await register(server, "carol");
    const id = await userIds(server);
    const text = `synthetic-about-alice-${crypto.randomUUID()}`;
    await send(alice, text);
    const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
    const general = channels.find((c: { name: string }) => c.name === "general");
    const carol = await token(server, "carol");
    await server.api(
      "/api/v1/reports",
      {
        target_type: "message",
        target_id: String(await messageId(server, general.id, text)),
        reason: "spam",
        detail: "",
      },
      carol,
    );
    await server.api(
      "/api/v1/reports",
      { target_type: "user", target_id: String(id("bob")), reason: "harassment", detail: "" },
      carol,
    );

    // Alice holds the permission and is the subject of one report: her queue
    // (the server's and the view's) has only the other.
    const aliceQueue = (await server.api(
      "/api/v1/moderation/queue",
      undefined,
      server.owner!.token,
    )) as { subject_name: string }[];
    expect(aliceQueue.map((r) => r.subject_name)).toEqual(["bob"]);
    await alice.getByTestId("moderation-btn").click();
    const center = alice.getByRole("region", { name: "Moderation" });
    await expect(center.getByTestId("mod-status")).toHaveText("1 report open or in review");
    await expect(center.getByTestId("mod-queue-row")).toHaveText([
      /User reported for HarassmentAbout bob, reported by carol/,
    ]);
    await expect(center).not.toContainText(text);

    // Bob is a member: no entry, and the server refuses him the queue.
    await expect(bob.getByTestId("audit-log-btn")).toBeHidden();
    await expect(bob.getByTestId("moderation-btn")).toBeHidden();
    expect(await status(server, "/api/v1/moderation/queue", await token(server, "bob"))).toBe(403);
  });
});
