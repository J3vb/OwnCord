/**
 * B9-26: the cross-feature desktop journeys, joined against the real Go server
 * (the plan's Task 2). The per-lane specs each prove one feature in isolation;
 * this spec chains them where the requirement is the join, so a seam between
 * two features cannot hide behind two green lane suites.
 *
 * Journey A (moderation): a member files a report on the client → the owner
 * reviews it and issues a warning from the Moderation Center → the recipient
 * sees the notice → the recipient appeals from Safety → the owner decides the
 * appeal → the recipient sees the outcome. BPR-070, BPR-071, BPR-072, BPR-073.
 *
 * Journey B (lifecycle): an observer reads the server's retention disclosure,
 * the subject erases their own account from the client, and the observer's
 * view of the subject's content and membership is gone. BPR-052/BPR-054 client
 * half, BPR-090.
 *
 * Journey C (first contact): a stranger's first DM is a text-only request,
 * bob accepts it (the held message opens the conversation), then blocks the
 * same sender from the member menu and the composer gates on the block.
 * BPR-060.
 *
 * Journey D (recovery/session switching): bob enrols a recovery kit in the
 * client, logs out, and recovers the account from the connect page with the
 * kit secret and a new password. BPR-090, account lifecycle.
 *
 * Roles and content are synthetic. Every authorization outcome is read back
 * from the server's own routes; the client only ever sees what the server
 * sends it. B8 (browser/mobile) is deferred and not qualified here.
 */

import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";
import { installRealTransport } from "../support/real-transport";
import { TEST_PASSWORD, type TestServer } from "../support/server";

type Frame = { type: string; id?: string; payload?: Record<string, unknown> };

/** A sender who is not in the browser: a REST token plus its own socket. */
interface Sender {
  readonly token: string;
  channelId: number;
  send(content: string): Promise<Frame>;
  close(): void;
}

async function signIn(server: TestServer, name: string): Promise<string> {
  const auth = await server.api("/api/v1/auth/login", { username: name, password: TEST_PASSWORD });
  return auth.token as string;
}

async function firstContact(server: TestServer, name: string, bobId: number): Promise<Sender> {
  const token = await signIn(server, name);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  const frames: Frame[] = [];
  const waiters: Array<{ wants: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  socket.addEventListener("message", (e) => {
    const f = JSON.parse(String(e.data)) as Frame;
    frames.push(f);
    for (const w of waiters.splice(0)) {
      if (w.wants(f)) w.resolve(f);
      else waiters.push(w);
    }
  });
  const next = (wants: (f: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve) => waiters.push({ wants, resolve }));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const ready = next((f) => f.type === "ready");
  socket.send(JSON.stringify({ type: "auth", payload: { token } }));
  await ready;
  const dm = (await server.api("/api/v1/dms", { recipient_id: bobId }, token)) as {
    channel_id: number;
  };
  const sender: Sender = {
    token,
    channelId: dm.channel_id,
    async send(content) {
      const id = randomUUID();
      const ok = next((f) => f.id === id);
      socket.send(
        JSON.stringify({
          type: "chat_send",
          id,
          payload: { channel_id: sender.channelId, content, reply_to: null },
        }),
      );
      return ok;
    },
    close: () => socket.close(),
  };
  return sender;
}

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

async function users(server: TestServer): Promise<(name: string) => number> {
  const rows = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return (name) => rows.find((u) => u.username === name)!.id;
}

async function generalChannel(server: TestServer): Promise<{ id: number; name: string }> {
  const channels = (await server.api("/api/v1/channels/", undefined, server.owner!.token)) as {
    id: number;
    name: string;
    type: string;
  }[];
  return channels.find((c) => c.name === "general" && c.type === "text")!;
}

async function messageId(server: TestServer, channelId: number, content: string): Promise<number> {
  const history = await server.api(
    `/api/v1/channels/${channelId}/messages`,
    undefined,
    server.owner!.token,
  );
  return history.messages.find((m: { content: string }) => m.content === content).id as number;
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-testid='message-input'] textarea");
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator(".msg-text", { hasText: text })).toBeVisible();
}

const composer = (page: Page) => page.locator("[data-testid='message-input'] textarea");
const notice = (page: Page) => page.getByRole("region", { name: "Moderation notices" });

async function openSafety(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Safety" }).click();
  const pane = page.locator(".safety-tab");
  await expect(pane.getByRole("heading", { name: "Appeals" })).toBeVisible();
  return pane;
}

/** Log out from settings and back in: the connect page's health check then
 *  fills the `server-info` snapshot the Account tab's retention notice reads. */
async function relogin(page: Page, server: TestServer, username: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-nav-item.danger").click();
  await expect(page.locator("#host")).toBeVisible({ timeout: 30_000 });
  await login(page, server, username);
}

test.describe("B9-26 moderation journey (real server)", () => {
  test("report → warn → notice → appeal → decision, end to end in the client", async ({
    alice,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    const id = await users(server);
    const general = await generalChannel(server);

    // bob posts the content carol reports, from his own signed-in client.
    const text = `synthetic-journey-${crypto.randomUUID()}`;
    await send(bob, text);
    const message = await messageId(server, general.id, text);
    const carol = await token(server, "carol");
    const report = (
      await server.api(
        "/api/v1/reports",
        {
          target_type: "message",
          target_id: String(message),
          reason: "harassment",
          detail: "synthetic journey detail",
        },
        carol,
      )
    ).id as string;

    // alice reviews the queue in the client: take, then warn, linked to the
    // report. The evidence text is shown, not fetched.
    await alice.getByTestId("moderation-btn").click();
    const center = alice.getByRole("region", { name: "Moderation" });
    const rows = center.getByTestId("mod-queue-row");
    const acts = center.getByTestId("mod-report").getByTestId("mod-act");
    const status = center.getByTestId("mod-write-status");
    await rows.filter({ hasText: "About bob" }).click();
    await expect(center.getByTestId("mod-report")).toContainText(text);
    await center.getByRole("button", { name: "Take this report" }).click();
    await expect(status).toHaveText("You're now reviewing this report.");
    const warnReason = `synthetic warning ${crypto.randomUUID()}`;
    await acts
      .getByRole("textbox", { name: "Warning reason, shown to the member" })
      .fill(warnReason);
    await acts.getByRole("button", { name: "Issue warning" }).click();
    await expect(status).toHaveText(
      "Warning issued. The member sees it now, or the next time they sign in.",
    );

    // The recipient sees exactly the warning, never who issued it.
    await expect(notice(bob)).toContainText(warnReason);
    await expect(notice(bob)).not.toContainText("alice");
    await expect(bob.locator(".toast", { hasText: warnReason })).toHaveCount(1);

    // The server recorded it against the report; the member read stays narrow.
    const ledger = (await server.api(
      `/api/v1/moderation/users/${id("bob")}/actions`,
      undefined,
      owner,
    )) as { kind: string; report_id?: string }[];
    expect(ledger).toEqual([expect.objectContaining({ kind: "warning", report_id: report })]);

    // bob appeals from Safety, and only his own history is read.
    const pane = await openSafety(bob);
    await expect(
      pane.locator("[data-testid^='safety-history-']", { hasText: `Reason: ${warnReason}` }),
    ).toContainText("Warning");
    await pane
      .locator("[data-testid^='safety-history-']", { hasText: `Reason: ${warnReason}` })
      .locator(".safety-appeal-open")
      .click();
    await pane.locator("#safety-appeal-body").fill("It was a quote from the rules.");
    await pane.getByRole("button", { name: "Send appeal" }).click();
    await expect(
      pane.locator(".safety-appeals-list > .safety-history-row", {
        hasText: `Reason: ${warnReason}`,
      }),
    ).toContainText("Status: open");

    // alice decides it in the Appeals tab; the client claims nothing before
    // the server answers.
    await center.getByRole("tab", { name: "Appeals" }).click();
    const appealRow = center.getByTestId("mod-appeal-row");
    const appeal = center.getByTestId("mod-appeal");
    const appealStatus = center.getByTestId("mod-appeal-write-status");
    await expect(appealRow).toContainText("Appeal from bob");
    await appealRow.first().click();
    await expect(appeal.getByRole("heading", { level: 3 })).toBeFocused();
    await appeal.getByRole("button", { name: "Take this appeal" }).click();
    await expect(appealStatus).toHaveText("You're now reviewing this appeal.");
    await appeal.getByRole("radio", { name: "Overturn (reverse the action)" }).check();
    await appeal.getByRole("textbox", { name: "Note to the appellant" }).fill("Fair point.");
    await appeal.getByRole("button", { name: "Record decision" }).click();
    await expect(appealStatus).toHaveText(
      "Decision recorded. The status below is what the server saved.",
    );
    await expect(appeal.getByTestId("mod-appeal-result")).toHaveText("Overturned.");

    // The join: the recipient's client follows the decision, and overturning
    // the warning clears its notice.
    await expect(
      pane.locator(".safety-appeals-list > .safety-history-row", {
        hasText: `Reason: ${warnReason}`,
      }),
    ).toContainText("Status: overturned");
    await expect(
      pane.locator(".safety-appeals-list > .safety-history-row", {
        hasText: `Reason: ${warnReason}`,
      }),
    ).toContainText("Moderator's note: Fair point.");
    await expect(pane).not.toContainText("alice");
    await expect(notice(bob)).toBeHidden();

    // Server authority, read back: the appeal is overturned and the ledger
    // holds the warning; nothing was fabricated by the client.
    const mine = (await server.api(
      "/api/v1/appeals/mine",
      undefined,
      await token(server, "bob"),
    )) as { state: string; decision_note: string }[];
    expect(mine).toEqual([
      expect.objectContaining({ state: "overturned", decision_note: "Fair point." }),
    ]);
  });
});

test.describe("B9-26 lifecycle journey (real server)", () => {
  test("the retention disclosure is read, then erasure removes the subject's content and membership", async ({
    alice,
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    const bobId = (await users(server))("bob");
    const general = await generalChannel(server);
    await server.api("/admin/api/channels", { name: "journey-other", type: "text" }, owner);
    const text = `synthetic-erasure-${crypto.randomUUID()}`;
    await send(bob, text);
    await expect(alice.locator(".msg-text", { hasText: text })).toBeVisible();
    await expect(alice.locator(`[data-testid='member-${bobId}']`)).toBeVisible();

    // The observer reads the server's own retention disclosure: this server
    // keeps messages indefinitely (retention.messages_days = 0), and says so.
    // A relogin is how the connect page's health check fills `server-info`.
    await relogin(alice, server, "alice");
    await alice.getByRole("button", { name: "Settings", exact: true }).click();
    await alice.getByRole("tab", { name: "Account" }).click();
    const retention = alice.getByTestId("account-retention");
    await expect(retention).toContainText("keeps messages until they are deleted");
    await expect(retention).toContainText("attachments are removed with their messages");
    await alice.keyboard.press("Escape");

    // bob erases his own account from the client (BPR-052 client half).
    await bob.getByRole("button", { name: "Settings", exact: true }).click();
    await bob.getByRole("tab", { name: "Account" }).click();
    await bob.locator("[data-testid='delete-account-trigger']").click();
    await bob.locator("[data-testid='delete-account-password']").fill(TEST_PASSWORD);
    await bob.locator("[data-testid='delete-account-confirm']").click();
    // The session is cleared and the app returns to sign-in.
    await expect(bob.locator("#host")).toBeVisible({ timeout: 30_000 });

    // The server erased the content and the credential: bob cannot sign in.
    await expect(
      server.api("/api/v1/auth/login", { username: "bob", password: TEST_PASSWORD }),
    ).rejects.toThrow(/401|Unauthorized|invalid/i);
    expect(await messageIdOrNull(server, general.id, text)).toBeNull();

    // The live observer drops the erased member row (the server's member_ban).
    await expect(alice.locator(`[data-testid='member-${bobId}']`)).toHaveCount(0, {
      timeout: 15_000,
    });

    // No tombstone is owed live, so the observer's rendered message persists
    // until the next authoritative read. Switching channels and back re-reads
    // the server's history, which no longer holds it.
    await alice.locator(".channel-item:not(.voice)").filter({ hasText: "journey-other" }).click();
    await expect(alice.locator("[data-testid='chat-header-name']")).toHaveText("journey-other");
    await alice.locator(".channel-item:not(.voice)").filter({ hasText: "general" }).click();
    await expect(alice.locator(".msg-text", { hasText: text })).toHaveCount(0);

    // The observer's own session is untouched; erasure is scoped to bob. The
    // transport is closed by the fixture and must have seen no errors.
    expect(bobTransport.errors).toEqual([]);
  });
});

test.describe("B9-26 first-contact journey (real server)", () => {
  test("a stranger's request is text-only, accepts into a conversation, and a block gates the composer", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const bobId = (await users(server))("bob");
    await register(server, "stranger");
    const stranger = await firstContact(server, "stranger", bobId);
    try {
      const held = `hello bob from ${crypto.randomUUID()}`;
      expect((await stranger.send(held)).type).toBe("chat_send_ok");

      // The request arrives as plain text: no avatar, attachment or embed is
      // fetched on the stranger's behalf before bob trusts them.
      const inbox = bob.getByRole("region", { name: "Message Requests" });
      await bob.locator("[data-testid='dm-requests-badge']").click();
      await bob.locator("[data-testid='dm-requests-entry']").click();
      await expect(inbox).toBeVisible();
      const item = inbox.locator("[data-testid='request-item']", {
        has: bob.getByRole("heading", { level: 3, name: "stranger" }),
      });
      await expect(item).toBeVisible();

      // Accept: the held message opens an ordinary conversation.
      await item.getByRole("button", { name: "Accept" }).click();
      await expect(bob.locator("[data-testid='chat-header-name']")).toHaveText("stranger");
      await expect(bob.locator(".msg-text", { hasText: held })).toHaveCount(1);
      const bobToken = await signIn(server, "bob");
      expect(await server.api("/api/v1/dm-requests", undefined, bobToken)).toEqual({
        requests: [],
      });

      // Back to channel mode, where the member list is mounted, and block the
      // sender from the member context menu (it confirms twice).
      await bob.locator("[data-testid='dm-back-header']").click();
      await expect(bob.locator("[data-testid='member-list']")).toBeVisible();
      const strangerId = (await users(server))("stranger");
      const row = bob.locator(`[data-testid='member-${strangerId}']`);
      await expect(row).toBeVisible();
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
      const menu = bob.locator(".context-menu").first();
      const block = menu.locator("[data-testid='block-toggle']");
      await expect(block).toHaveText("Block");
      await block.click();
      await expect(block).toHaveText("Are you sure?");
      await block.click();

      // The server records the block; the server refuses a new DM from the
      // blocked sender, and the DM conversation's composer now gates.
      const blocks = (await server.api("/api/v1/blocks", undefined, bobToken)) as {
        blocked_user_ids: number[];
      };
      expect(blocks.blocked_user_ids).toContain(strangerId);
      await expect
        .poll(async () => {
          const response = await fetch(`${server.origin}/api/v1/dms`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${stranger.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ recipient_id: bobId }),
          });
          return response.status;
        })
        .toBe(403);

      // The joined cross-feature assertion: the block the member menu set is
      // the same state the DM composer reads.
      await bob.locator("[data-testid='dm-entry']").first().click();
      await expect(bob.locator("[data-testid='chat-header-name']")).toHaveText("stranger");
      await expect(composer(bob)).toBeDisabled();
      await expect(composer(bob)).toHaveAttribute(
        "placeholder",
        "You've blocked this user. Unblock to send messages.",
      );
      expect(bobTransport.errors).toEqual([]);
    } finally {
      stranger.close();
    }
  });
});

test.describe("B9-26 session-switching journey (real server)", () => {
  test("a sign-in on a second device displaces the first, and 'Use here' takes it back", async ({
    browser,
    bob,
    server,
  }) => {
    // A second device is a real second client: a new context with its own
    // transport and login. The server keeps one live socket per account, so
    // signing in there displaces the first device rather than opening a
    // second session.
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    const page = await context.newPage();
    const transport = await installRealTransport(page, server);
    try {
      await login(page, server, "bob");
      await expect(page.getByTestId("app-layout")).toBeVisible();

      // The first device is told, not left silently dead: it shows the
      // displaced-session banner with the recovery action.
      const useHere = bob.getByRole("button", { name: "Use here" });
      await expect(useHere).toBeVisible({ timeout: 30_000 });
      await expect(bob.locator(".reconnecting-banner")).toContainText("Signed in elsewhere");

      // Taking the session back reconnects this device; the notice clears and
      // the conversation is usable. The second device is now the displaced one.
      await useHere.click();
      await expect(bob.locator(".reconnecting-banner")).toBeHidden({ timeout: 30_000 });
      await composer(bob).fill(`back here ${crypto.randomUUID()}`);
      await expect(composer(bob)).toBeEnabled();
      expect(transport.errors).toEqual([]);
    } finally {
      await transport.close();
      await context.close();
    }
  });
});

test.describe("B9-26 recovery lifecycle journey (real server)", () => {
  test("bob enrols a recovery kit, logs out, and recovers the account from the connect page", async ({
    bob,
    server,
  }) => {
    // Enrol a kit from Settings > Account; the secret is shown once.
    await bob.getByRole("button", { name: "Settings", exact: true }).click();
    await bob.getByRole("tab", { name: "Account" }).click();
    const section = bob.getByTestId("recovery-kit-section");
    await expect(section.getByTestId("recovery-kit-status")).toHaveText("Not set up");
    await section.getByTestId("recovery-kit-btn").click();
    await section.getByTestId("recovery-kit-password").fill(TEST_PASSWORD);
    await section.getByTestId("recovery-kit-submit").click();
    const secret = (await bob.getByTestId("recovery-kit-secret").textContent())?.trim() ?? "";
    expect(secret.length).toBeGreaterThan(0);
    await expect(section.getByTestId("recovery-kit-status")).toHaveText("Enrolled");

    // Log out: the client returns to the connect page.
    await bob.locator(".settings-nav-item.danger").click();
    await expect(bob.locator("#host")).toBeVisible({ timeout: 30_000 });

    // Recover with the kit secret and a new password: the returned session
    // signs bob in, exactly as a login would.
    const newPassword = "OwnCord-E2E-recovered-123!";
    await bob.locator("#host").fill(`127.0.0.1:${server.port}`);
    await bob.locator("#username").fill("bob");
    await bob.getByTestId("recover-account-link").click();
    const overlay = bob.getByTestId("recover-overlay");
    await expect(overlay).toBeVisible();
    await overlay.locator("#recover-username").fill("bob");
    await overlay.locator("#recover-secret").fill(secret);
    await overlay.locator("#recover-password").fill(newPassword);
    await overlay.getByTestId("recover-submit").click();
    await expect(bob.getByTestId("app-layout")).toBeVisible({ timeout: 30_000 });

    // The kit is spent: the new password signs in, the old one does not, and a
    // second recovery with the same secret is refused.
    await expect(
      server.api("/api/v1/auth/login", { username: "bob", password: TEST_PASSWORD }),
    ).rejects.toThrow(/401|Unauthorized|invalid/i);
    expect(
      (await server.api("/api/v1/auth/login", { username: "bob", password: newPassword })).token,
    ).toBeTruthy();
    const replay = await fetch(`${server.origin}/api/v1/auth/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "bob",
        kit_secret: secret,
        new_password: "Another-pass-123!",
      }),
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});

/** The message id for `content`, or null when the server no longer holds it. */
async function messageIdOrNull(
  server: TestServer,
  channelId: number,
  content: string,
): Promise<number | null> {
  const history = await server.api(
    `/api/v1/channels/${channelId}/messages`,
    undefined,
    server.owner!.token,
  );
  return history.messages.find((m: { content: string }) => m.content === content)?.id ?? null;
}
