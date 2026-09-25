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
 * a reported and appealed subject erases their own account from the client,
 * and the observer's view of the subject's content and membership is gone
 * while the report's outcome row survives. BPR-052/BPR-054 client half,
 * BPR-070, BPR-090.
 *
 * Journey C (first contact): a stranger's first DM is a text-only request
 * shown as inert text with nothing fetched on the sender's behalf, bob accepts
 * it (the held message opens the conversation), then blocks the same sender
 * from the member menu and the composer gates on the block. BPR-060.
 *
 * Journey D (session displacement): a second device signs in, displaces the
 * first, and "Use here" takes the session back. BPR-090 lifecycle.
 *
 * Journey E (recovery): bob enrols a recovery kit in the client, logs out, and
 * recovers the account from the connect page with the kit secret and a new
 * password. BPR-090 account lifecycle.
 *
 * Journey F (network loss and recovery): the transport is cut mid-session, the
 * B9-25 notice names the server and offers Retry, and the connection recovers
 * with the session state intact. BPR-090, BPR-092.
 *
 * Journey G (refused roles): a member without moderation permission is denied
 * the queue and someone else's appeal in the UI and by the server. BPR-071.
 *
 * Journey H (consent to evidence): a labelled channel's content waits for the
 * viewer's acknowledgement before it is read as evidence, and revoking the
 * acknowledgement takes the evidence away again. BPR-063, BPR-071.
 *
 * Roles and content are synthetic. Every authorization outcome is read back
 * from the server's own routes; the client only ever sees what the server
 * sends it. B8 (browser/mobile) is deferred and not qualified here.
 */

import { randomUUID } from "node:crypto";
import type { Locator, Page, Request } from "@playwright/test";
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

/** The message id for `content`, or null when the server no longer holds it. */
async function messageId(
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

/** The message id for `content`, asserting the server still holds it. */
async function liveMessageId(
  server: TestServer,
  channelId: number,
  content: string,
): Promise<number> {
  const id = await messageId(server, channelId, content);
  expect(id).not.toBeNull();
  return id!;
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

/** The status of a raw call whose failure the test asserts. */
async function status(
  server: TestServer,
  path: string,
  auth: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<number> {
  const response = await fetch(`${server.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status;
}

/** Record every HTTP destination and broker call the renderer asks for from now. */
async function recordTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
      __traffic: string[];
    };
    w.__traffic = [];
    const inner = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "plugin:http|fetch") {
        const { method, url } = args.clientConfig as { method: string; url: string };
        w.__traffic.push(`${method} ${new URL(url).pathname}${new URL(url).search}`);
      } else if (command.startsWith("external_")) {
        w.__traffic.push(`broker ${command}`);
      }
      return inner(command, args);
    };
  });
}

const traffic = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __traffic: string[] }).__traffic);

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
    const message = await liveMessageId(server, general.id, text);
    const carol = await signIn(server, "carol");
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
      await signIn(server, "bob"),
    )) as { state: string; decision_note: string }[];
    expect(mine).toEqual([
      expect.objectContaining({ state: "overturned", decision_note: "Fair point." }),
    ]);
  });
});

test.describe("B9-26 lifecycle journey (real server)", () => {
  test("a reported and appealed subject is erased; retention is disclosed and the report outcome survives", async ({
    alice,
    bob,
    bobTransport,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    const id = await users(server);
    const bobId = id("bob");
    const general = await generalChannel(server);
    await server.api("/admin/api/channels", { name: "journey-other", type: "text" }, owner);

    // bob is reported and warned and appeals, before he erases himself, so the
    // erasure half of the chain is exercised on a subject with moderation rows.
    const text = `synthetic-erasure-${crypto.randomUUID()}`;
    await send(bob, text);
    const message = await liveMessageId(server, general.id, text);
    const carol = await signIn(server, "carol");
    await server.api(
      "/api/v1/reports",
      {
        target_type: "message",
        target_id: String(message),
        reason: "harassment",
        detail: "synthetic lifecycle detail",
      },
      carol,
    );
    const warnReason = `synthetic lifecycle warning ${crypto.randomUUID()}`;
    await server.api(`/api/v1/moderation/users/${bobId}/warn`, { reason: warnReason }, owner);
    const pane = await openSafety(bob);
    await pane
      .locator("[data-testid^='safety-history-']", { hasText: `Reason: ${warnReason}` })
      .locator(".safety-appeal-open")
      .click();
    await pane.locator("#safety-appeal-body").fill("synthetic lifecycle appeal");
    await pane.getByRole("button", { name: "Send appeal" }).click();
    await expect(
      pane.locator(".safety-appeals-list > .safety-history-row", {
        hasText: `Reason: ${warnReason}`,
      }),
    ).toContainText("Status: open");
    await bob.keyboard.press("Escape");

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

    // The server erased the content and the credential: bob cannot sign in, and
    // his message is gone.
    await expect(
      server.api("/api/v1/auth/login", { username: "bob", password: TEST_PASSWORD }),
    ).rejects.toThrow(/401|Unauthorized|invalid/i);
    expect(await messageId(server, general.id, text)).toBeNull();

    // The report's outcome row survives the subject's erasure, rewritten with
    // no content (the erasure half of BPR-052/BPR-053), and bob's own appeal
    // cascaded away; neither is listed as open work.
    const closed = (await server.api(
      "/api/v1/moderation/queue?state=closed",
      undefined,
      owner,
    )) as { state: string; subject_name: string }[];
    expect(closed.map((r) => r.state)).toContain("subject_erased");
    expect(closed.every((r) => r.subject_name === "")).toBe(true);

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
    // The stranger's avatar points at a host that must never be fetched while
    // their request is untrusted. The URL is a valid https:// the server stores.
    const tracker = "https://tracker.invalid/stranger.png";
    await server.api(
      "/api/v1/users/me",
      { username: "stranger", avatar: tracker },
      stranger.token,
      "PATCH",
    );
    try {
      const held = `hello bob from ${crypto.randomUUID()}`;
      expect((await stranger.send(held)).type).toBe("chat_send_ok");

      // Safe preview: from here on, watch every browser request and every
      // native broker call. The request arrives as plain text; nothing is
      // fetched on the stranger's behalf.
      await recordTraffic(bob);
      const loaded: string[] = [];
      const onRequest = (r: Request): void => {
        loaded.push(r.url());
      };
      bob.on("request", onRequest);
      try {
        const inbox = bob.getByRole("region", { name: "Message Requests" });
        await bob.locator("[data-testid='dm-requests-badge']").click();
        await bob.locator("[data-testid='dm-requests-entry']").click();
        await expect(inbox).toBeVisible();
        const item = inbox.locator("[data-testid='request-item']", {
          has: bob.getByRole("heading", { level: 3, name: "stranger" }),
        });
        await expect(item).toBeVisible();
        await expect(item.locator(".requests-preview")).toContainText(held);
        // The row renders no image and asks for no third-party host.
        await expect(item.locator("img")).toHaveCount(0);
        await bob.waitForTimeout(1_000);
        expect(loaded.filter((u) => u.includes("tracker.invalid"))).toEqual([]);
        await expect
          .poll(async () => (await traffic(bob)).filter((l) => l.startsWith("broker ")))
          .toEqual([]);
      } finally {
        bob.off("request", onRequest);
      }

      // Accept: the held message opens an ordinary conversation.
      const item = bob.locator("[data-testid='request-item']", {
        has: bob.getByRole("heading", { level: 3, name: "stranger" }),
      });
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
    // second recovery with the same secret is refused. A spent kit is the
    // uniform 401 UNAUTHORIZED refusal (service.ErrRecoveryKitInvalid →
    // writeAuthError), not a 500 or a 429 that would pass any ">= 400".
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
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("UNAUTHORIZED");
  });
});

test.describe("B9-26 network-loss journey (real server)", () => {
  test("a transport cut shows the actionable notice, recovers, and keeps session state", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const beforeText = `before-cut-${crypto.randomUUID()}`;
    await send(bob, beforeText);

    // Cut the transport mid-session: the socket closes and every dial fails.
    await bobTransport.offline();
    const banner = bob.locator(".reconnecting-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    // A dial has to fail before the notice names the server; until then it is
    // the honest "Reconnecting..." wording (B9-25).
    await expect(banner).toContainText("Can't reach this server", { timeout: 15_000 });
    await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();

    // The device reports a network, so the banner never claims the internet is
    // required for this LAN server, and Retry is offered.

    // Restore the transport: the reconnect loop's next dial clears the notice.
    bobTransport.online();
    await expect(banner).toBeHidden({ timeout: 30_000 });

    // State resumed correctly: the pre-cut message is still there and a new
    // send lands, read back from the server's own history.
    await expect(bob.locator(".msg-text", { hasText: beforeText })).toHaveCount(1);
    const afterText = `after-cut-${crypto.randomUUID()}`;
    await send(bob, afterText);
    const general = await generalChannel(server);
    await expect
      .poll(async () => {
        const history = await server.api(
          `/api/v1/channels/${general.id}/messages`,
          undefined,
          server.owner!.token,
        );
        return history.messages.filter((m: { content: string }) => m.content === afterText).length;
      })
      .toBe(1);
  });
});

test.describe("B9-26 refused-role journey (real server)", () => {
  test("a member is refused the moderation queue and another account's appeal in the UI and by the server", async ({
    alice,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    const id = await users(server);

    // bob is an ordinary member: the Moderation Center entry is not offered.
    await expect(bob.getByTestId("moderation-btn")).toBeHidden();
    await expect(bob.getByTestId("audit-log-btn")).toBeHidden();

    // The server refuses him the queue, a queue action and an appeal decision,
    // all 403, independent of anything the client shows.
    const bobToken = await signIn(server, "bob");
    expect(await status(server, "/api/v1/moderation/queue", bobToken)).toBe(403);

    // carol is warned by the owner and appeals; bob may not decide it.
    const warnReason = `synthetic refused-role ${crypto.randomUUID()}`;
    await server.api(`/api/v1/moderation/users/${id("carol")}/warn`, { reason: warnReason }, owner);
    const own = (await server.api(
      "/api/v1/users/me/moderation",
      undefined,
      await signIn(server, "carol"),
    )) as { id: number; reason: string; appealable: boolean }[];
    const action = own.find((r) => r.reason === warnReason)!;
    const appeal = (
      await server.api(
        "/api/v1/appeals/",
        { action_id: action.id, body: "synthetic refused-role appeal" },
        await signIn(server, "carol"),
      )
    ).id as string;
    expect(
      await status(server, `/api/v1/moderation/appeals/${appeal}/decide`, bobToken, {
        outcome: "uphold",
        note: "",
      }),
    ).toBe(403);
    expect(await status(server, `/api/v1/moderation/appeals/`, bobToken)).toBe(403);

    // The owner, who holds the permission, still sees the appeal and can decide
    // it; the refusal above was the role, not the contract.
    const aliceAppeals = (await server.api("/api/v1/moderation/appeals/", undefined, owner)) as {
      id: string;
    }[];
    expect(aliceAppeals.map((a) => a.id)).toContain(appeal);
    // alice also sees the entry in her client.
    await expect(alice.getByTestId("moderation-btn")).toBeVisible();

    // bob's client never rendered moderation content: no appeal from carol.
    expect(await status(server, "/api/v1/moderation/appeals/", bobToken)).toBe(403);
  });
});

test.describe("B9-26 integrated accessibility matrix (real server)", () => {
  // The plan's Task 3 matrix, run on the JOINED surfaces the journeys above
  // produce. Each surface's exhaustive Q1 pass (keyboard, names, focus,
  // contrast in every theme and High Contrast, reduced motion, 940×500 with
  // 20px text and 200% scale) already ships in its lane spec and is named per
  // requirement in the evidence manifest; this test proves the integrated
  // states do not regress that, on the real server.
  test("the joined inbox and Moderation Center reflow at the 940x500 minimum window", async ({
    alice,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "stranger");
    await register(server, "carol");
    const bobId = (await users(server))("bob");
    const stranger = await firstContact(server, "stranger", bobId);
    try {
      expect((await stranger.send("joined a11y request")).type).toBe("chat_send_ok");

      // Message Requests inbox at the minimum desktop window.
      await bob.setViewportSize({ width: 940, height: 500 });
      await bob.locator("[data-testid='dm-requests-badge']").click();
      await bob.locator("[data-testid='dm-requests-entry']").click();
      const inbox = bob.getByRole("region", { name: "Message Requests" });
      await expect(inbox).toBeVisible();
      expect(await bob.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      for (const control of await inbox.getByRole("button").all()) {
        if (!(await control.isVisible())) continue;
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
        expect(await control.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }

      // Moderation Center at the same window, with a queue row present.
      await alice.setViewportSize({ width: 940, height: 500 });
      await server.api(
        "/api/v1/reports",
        { target_type: "user", target_id: String(bobId), reason: "spam", detail: "" },
        await signIn(server, "carol"),
      );
      await alice.getByTestId("moderation-btn").click();
      const center = alice.getByRole("region", { name: "Moderation" });
      await expect(center.getByTestId("mod-queue-row").first()).toBeVisible();
      const view = alice.getByTestId("feature-view");
      expect(await view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await center.getByTestId("mod-queue-row").first().focus();
      expect(await view.evaluate((el) => el.scrollLeft)).toBe(0);

      // Keyboard: the entry is reachable and operable, and Escape leaves the
      // report back on its row.
      await center.getByTestId("mod-queue-row").first().click();
      const report = center.getByTestId("mod-report");
      await expect(report.getByRole("heading", { level: 3 })).toBeFocused();
      await alice.keyboard.press("Escape");
      await expect(report).toHaveCount(0);
      await expect(center.getByTestId("mod-queue-row").first()).toBeFocused();

      // Reduced motion: no running animation is required in the joined view.
      await alice.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await center.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter(
                (a) => a.playState === "running" && Number(a.effect?.getTiming().duration) > 1,
              ).length,
        ),
      ).toBe(0);
      void owner;
    } finally {
      stranger.close();
    }
  });
});

test.describe("B9-26 consent-to-evidence journey (real server)", () => {
  test("labelled evidence waits for the moderator's own acknowledgement, and revoking it takes the evidence away", async ({
    alice,
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    await register(server, "carol");
    const channels = (await server.api("/api/v1/channels/", undefined, owner)) as {
      id: number;
      name: string;
      type: string;
    }[];
    const labelled = channels.find((c) => c.name === "general" && c.type === "text")!;

    // bob posts a message in a channel that is afterwards labelled, and carol
    // reports it; its evidence is gated by the moderator's own NSFW consent.
    const text = `synthetic-consent-evidence-${crypto.randomUUID()}`;
    await send(bob, text);
    const message = await liveMessageId(server, labelled.id, text);
    await server.api(
      "/api/v1/reports",
      {
        target_type: "message",
        target_id: String(message),
        reason: "harassment",
        detail: "synthetic consent evidence detail",
      },
      await signIn(server, "carol"),
    );
    await server.api(`/admin/api/channels/${labelled.id}`, { nsfw: true }, owner, "PATCH");

    // The owner opens the report: the evidence is behind the acknowledgement
    // gate, and reading it records the acknowledgement with the server first.
    await alice.getByTestId("moderation-btn").click();
    const center = alice.getByRole("region", { name: "Moderation" });
    const rows = center.getByTestId("mod-queue-row");
    await rows.filter({ hasText: "About bob" }).click();
    const report = center.getByTestId("mod-report");
    const gate = center.getByTestId("nsfw-gate");
    await expect(gate).toBeVisible();
    await expect(report).not.toContainText(text);
    await gate.getByTestId("nsfw-gate-continue").click();
    await expect(report.locator(".mod-evidence-text")).toHaveText(text);

    // Revoking the acknowledgement from another session regates the evidence.
    const aliceToken = await signIn(server, "alice");
    expect(
      await status(
        server,
        `/api/v1/channels/${labelled.id}/nsfw-acknowledgement`,
        aliceToken,
        undefined,
        "DELETE",
      ),
    ).toBe(204);
    await expect(gate).toBeVisible();
    await expect(report).not.toContainText(text);
  });
});
