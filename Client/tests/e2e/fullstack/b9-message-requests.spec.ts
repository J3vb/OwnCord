/**
 * Fullstack B9-6: accept, ignore, delete and block Message Requests against
 * the real Go server (BPR-060). bob decides in the client; the senders are
 * scripted over REST and their own WebSocket, so what they could observe —
 * their frames, GET /dms and their DM history — is read straight off the
 * server.
 *
 * "Another device" is a second REST session for bob. It has no socket, so
 * bob never has two active sockets; its decisions reach the client only
 * through the server's dm_request frame, which the transport can drop.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";

// Four senders need more sign-ups and sign-ins than one IP gets a minute.
const test = base.extend({
  server: async ({}, use, info) => {
    const server = await startTestServer({
      env: { ...process.env, OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER: "10" },
    });
    try {
      await use(server);
    } finally {
      await info.attach("server-log", { body: server.log(), contentType: "text/plain" });
      await server.close();
    }
  },
});

type Frame = { type: string; payload?: Record<string, unknown> };

/** A sender who is not in the browser: a REST token plus its own socket. */
interface Sender {
  readonly name: string;
  readonly token: string;
  readonly frames: Frame[];
  /** The DM channel with bob, once the first message is sent. */
  channelId: number;
  send(content: string): Promise<Frame>;
  close(): void;
}

async function signUp(server: TestServer, name: string): Promise<void> {
  const invite = (await server.api("/api/v1/invites", {}, server.owner!.token)) as { code: string };
  await server.api("/api/v1/auth/register", {
    username: name,
    password: TEST_PASSWORD,
    invite_code: invite.code,
  });
}

async function signIn(server: TestServer, name: string): Promise<string> {
  const r = (await server.api("/api/v1/auth/login", {
    username: name,
    password: TEST_PASSWORD,
  })) as {
    token: string;
  };
  return r.token;
}

async function connect(server: TestServer, name: string): Promise<Sender> {
  const token = await signIn(server, name);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  const frames: Frame[] = [];
  const waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  socket.addEventListener("message", (e) => {
    const f = JSON.parse(String(e.data)) as Frame;
    frames.push(f);
    for (const w of waiters.splice(0)) {
      if (w.match(f)) w.resolve(f);
      else waiters.push(w);
    }
  });
  const next = (match: (f: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve) => waiters.push({ match, resolve }));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const ready = next((f) => f.type === "ready");
  socket.send(JSON.stringify({ type: "auth", payload: { token } }));
  await ready;
  const sender: Sender = {
    name,
    token,
    frames,
    channelId: 0,
    async send(content) {
      const id = randomUUID();
      const ok = next((f) => (f as { id?: string }).id === id);
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

/** `name` opens a DM with bob and sends a first message: a request in bob's inbox. */
async function firstContact(server: TestServer, name: string, bobId: number): Promise<Sender> {
  const s = await connect(server, name);
  const dm = (await server.api("/api/v1/dms", { recipient_id: bobId }, s.token)) as {
    channel_id: number;
  };
  s.channelId = dm.channel_id;
  const ok = await s.send(`hello bob, this is ${name}`);
  expect(ok.type).toBe("chat_send_ok");
  return s;
}

/** Everything the sender's REST view can tell them about the conversation. */
async function senderView(server: TestServer, s: Sender): Promise<string> {
  const dms = await server.api("/api/v1/dms", undefined, s.token);
  const history = await server.api(`/api/v1/channels/${s.channelId}/messages`, undefined, s.token);
  return JSON.stringify({ dms, history });
}

async function userId(server: TestServer, name: string): Promise<number> {
  const users = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return users.find((u) => u.username === name)!.id;
}

const inbox = (page: Page) => page.getByRole("region", { name: "Message Requests" });
const item = (page: Page, name: string) =>
  inbox(page).locator("[data-testid='request-item']", {
    has: page.getByRole("heading", { level: 3, name }),
  });
const outcome = (page: Page) => page.locator("[data-testid='requests-outcome']");

async function openInbox(page: Page, count: number): Promise<void> {
  await page.locator("[data-testid='dm-requests-badge']").click();
  const entry = page.locator("[data-testid='dm-requests-entry']");
  await expect(entry).toHaveText(`Message Requests (${count})`);
  await entry.click();
  await expect(inbox(page)).toBeVisible();
}

test.describe("B9-6 Message Request decisions (real server)", () => {
  test("bob accepts one request and ignores, deletes and blocks others; Ignore and Delete stay silent", async ({
    bob,
    server,
  }, testInfo) => {
    const bobId = await userId(server, "bob");
    for (const name of ["carol", "dave", "erin"]) await signUp(server, name);
    const alice = await firstContact(server, "alice", bobId);
    const carol = await firstContact(server, "carol", bobId);
    const dave = await firstContact(server, "dave", bobId);
    const erin = await firstContact(server, "erin", bobId);
    try {
      await openInbox(bob, 4);
      await expect(inbox(bob).locator("[data-testid='request-item']")).toHaveCount(4);

      // What carol and dave can see while their requests are pending.
      const carolBefore = await senderView(server, carol);
      const daveBefore = await senderView(server, dave);
      const carolFrames = carol.frames.length;
      const daveFrames = dave.frames.length;

      // Ignore, by keyboard.
      await item(bob, "carol").getByRole("button", { name: "Ignore" }).focus();
      await bob.keyboard.press("Enter");
      await expect(item(bob, "carol")).toHaveCount(0);
      await expect(outcome(bob)).toHaveText("Ignored carol's request.");
      // Focus moved to the next request instead of falling to the page.
      await expect(bob.locator(":focus")).toHaveText("Accept");
      await testInfo.attach("b9-6-after-ignore.png", {
        body: await bob.screenshot(),
        contentType: "image/png",
      });

      // Delete, confirmed in the dialog.
      await item(bob, "dave").getByRole("button", { name: "Delete…" }).click();
      const del = bob.getByRole("dialog", { name: "Delete this request?" });
      await expect(del).toContainText("dave is not told.");
      await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
      await testInfo.attach("b9-6-delete-dialog.png", {
        body: await bob.screenshot(),
        contentType: "image/png",
      });
      await del.getByRole("button", { name: "Delete request" }).click();
      await expect(item(bob, "dave")).toHaveCount(0);
      await expect(outcome(bob)).toHaveText("Deleted dave's request.");

      // Block, confirmed.
      await item(bob, "erin").getByRole("button", { name: "Block…" }).click();
      await bob
        .getByRole("dialog", { name: "Block erin?" })
        .getByRole("button", { name: "Block" })
        .click();
      await expect(item(bob, "erin")).toHaveCount(0);
      await expect(outcome(bob)).toHaveText("Blocked erin and removed their request.");

      // Accept: the ordinary conversation opens with alice's held message.
      await item(bob, "alice").getByRole("button", { name: "Accept" }).click();
      await expect(inbox(bob)).toBeHidden();
      await expect(bob.locator("[data-testid='chat-header-name']")).toHaveText("alice");
      await expect(bob.locator(".msg-text", { hasText: "hello bob, this is alice" })).toHaveCount(
        1,
      );
      await expect(bob.locator("[data-testid='message-input'] textarea")).toBeFocused();
      await testInfo.attach("b9-6-accepted-conversation.png", {
        body: await bob.screenshot(),
        contentType: "image/png",
      });

      // The server agrees, and accepted alice now reaches bob live.
      const bobToken = await signIn(server, "bob");
      expect(await server.api("/api/v1/dm-requests", undefined, bobToken)).toEqual({
        requests: [],
      });
      const blocks = (await server.api("/api/v1/blocks", undefined, bobToken)) as {
        blocked_user_ids: number[];
      };
      expect(blocks.blocked_user_ids).toEqual([await userId(server, "erin")]);
      await alice.send("now we can talk");
      await expect(bob.locator(".msg-text", { hasText: "now we can talk" })).toHaveCount(1);

      // Ignore and Delete told carol and dave nothing: no frame, and the
      // same REST view as while pending (docs/api.md, decision 5).
      const leaked = (s: Sender, from: number): Frame[] =>
        s.frames
          .slice(from)
          .filter(
            (f) =>
              f.type.startsWith("dm_") ||
              f.type === "error" ||
              JSON.stringify(f.payload ?? {}).includes(`"channel_id":${s.channelId}`),
          );
      expect(leaked(carol, carolFrames)).toEqual([]);
      expect(leaked(dave, daveFrames)).toEqual([]);
      expect(await senderView(server, carol)).toBe(carolBefore);
      expect(await senderView(server, dave)).toBe(daveBefore);
    } finally {
      for (const s of [alice, carol, dave, erin]) s.close();
    }
  });

  test("decisions from another device and a lost answer reconcile without inventing trust", async ({
    bob,
    bobTransport,
    server,
  }) => {
    const bobId = await userId(server, "bob");
    await signUp(server, "carol");
    const alice = await firstContact(server, "alice", bobId);
    const carol = await firstContact(server, "carol", bobId);
    try {
      await openInbox(bob, 2);
      const other = await signIn(server, "bob"); // the other device, REST only
      const requests = (await server.api("/api/v1/dm-requests", undefined, other)) as {
        requests: { id: number; sender: { username: string } }[];
      };
      const idOf = (name: string): number =>
        requests.requests.find((r) => r.sender.username === name)!.id;

      // The other device ignores carol's while this device's frame is lost:
      // the row is still here, and deciding it loses the race (409).
      bobTransport.filterServerMessages((m) => m.type !== "dm_request");
      await server.api(`/api/v1/dm-requests/${idOf("carol")}/ignore`, {}, other);
      await expect(item(bob, "carol")).toHaveCount(1);
      await item(bob, "carol").getByRole("button", { name: "Accept" }).click();
      await expect(outcome(bob)).toHaveText(
        "carol's request was already handled, perhaps on another device. The list was refreshed.",
      );
      // The refetch removed it, and nothing opened a conversation with carol.
      await expect(item(bob, "carol")).toHaveCount(0);
      await expect(inbox(bob)).toBeVisible();

      // Accept alice's, but lose every frame the server sends about it
      // (dm_request, dm_channel_open): the 200 alone decides, and the
      // conversation opens from the server's GET /dms, not from the request.
      bobTransport.filterServerMessages(
        (m) => m.type !== "dm_request" && m.type !== "dm_channel_open",
      );
      await item(bob, "alice").getByRole("button", { name: "Accept" }).click();
      await expect(bob.locator("[data-testid='chat-header-name']")).toHaveText("alice");
      await expect(bob.locator(".msg-text", { hasText: "hello bob, this is alice" })).toHaveCount(
        1,
      );
      bobTransport.filterServerMessages(undefined);

      // A reconnect after the commit brings back neither request.
      await bobTransport.offline();
      await expect(bob.locator(".reconnecting-banner")).toBeVisible();
      bobTransport.online();
      await expect(bob.locator(".reconnecting-banner")).not.toBeVisible();
      await alice.send("still here after your reconnect");
      await expect(
        bob.locator(".msg-text", { hasText: "still here after your reconnect" }),
      ).toHaveCount(1);
      await expect(bob.locator("[data-testid='dm-requests-badge']")).toBeHidden();
      expect(await server.api("/api/v1/dm-requests", undefined, other)).toEqual({ requests: [] });
    } finally {
      alice.close();
      carol.close();
    }
  });
});
