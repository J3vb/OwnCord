import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test as base, expect, login } from "./fixtures";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";

export const MODERATOR_ROLE_ID = 3;
export const MEMBER_ROLE_ID = 4;

/** A REST token for `username`. */
export async function signIn(server: TestServer, username: string): Promise<string> {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  return auth.token as string;
}

export async function register(server: TestServer, username: string): Promise<void> {
  await server.api("/api/v1/auth/register", {
    username,
    password: TEST_PASSWORD,
    invite_code: server.owner!.invite_code,
  });
}

/** Looks a member's id up by name, from the owner's user list. */
export async function userIds(server: TestServer): Promise<(name: string) => number> {
  const users = (await server.api("/admin/api/users", undefined, server.owner!.token)) as {
    id: number;
    username: string;
  }[];
  return (name) => users.find((u) => u.username === name)!.id;
}

export async function setRole(server: TestServer, userId: number, roleId: number): Promise<void> {
  await server.api(`/admin/api/users/${userId}`, { role_id: roleId }, server.owner!.token, "PATCH");
}

/** POST as `auth`; the status and the server's error code. */
export async function post(server: TestServer, path: string, auth: string, body: unknown = {}) {
  const response = await fetch(`${server.origin}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, code: text ? (JSON.parse(text).error as string) : "" };
}

export async function generalChannel(server: TestServer): Promise<{ id: number; name: string }> {
  const channels = (await server.api("/api/v1/channels/", undefined, server.owner!.token)) as {
    id: number;
    name: string;
    type: string;
  }[];
  return channels.find((c) => c.name === "general" && c.type === "text")!;
}

/** The message id for `content`, or null when the server no longer holds it. */
export async function messageId(
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
export async function liveMessageId(
  server: TestServer,
  channelId: number,
  content: string,
): Promise<number> {
  const id = await messageId(server, channelId, content);
  expect(id).not.toBeNull();
  return id!;
}

export const channelItem = (page: Page, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });

export const composer = (page: Page) => page.locator("[data-testid='message-input'] textarea");

/** Types `text` into the composer (after attaching `file`, if any) and presses Enter. */
export async function sendMessage(page: Page, text: string, file?: string): Promise<void> {
  const input = page.locator("[data-testid='message-input']");
  if (file !== undefined) {
    await input.locator("input[type='file']").setInputFiles({
      name: file,
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic attachment"),
    });
    await expect(input.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  }
  await input.locator("textarea").fill(text);
  await input.locator("textarea").press("Enter");
}

/** `sendMessage`, then waits for the message to show in the list. */
export async function sendAndSee(page: Page, text: string, file?: string): Promise<void> {
  await sendMessage(page, text, file);
  await expect(page.locator(".msg-text", { hasText: text })).toBeVisible();
}

export async function openSafety(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Privacy & Safety" }).click();
  const pane = page.locator(".safety-tab");
  await expect(pane.getByRole("heading", { name: "Appeals" })).toBeVisible();
  return pane;
}

export const appealRow = (pane: Locator, reason: string) =>
  pane.locator(".safety-appeals-list > .safety-history-row", { hasText: `Reason: ${reason}` });

/** Log out from settings and back in: a full ready, and a store cleared by sign-out. */
export async function relogin(page: Page, server: TestServer, username: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-nav-item.danger").click();
  // Log Out asks first.
  await page.locator("[data-testid='logout-confirm']").click();
  await expect(page.locator("#host")).toBeVisible({ timeout: 30_000 });
  await login(page, server, username);
}

export type Frame = { type: string; id?: string; payload?: Record<string, unknown> };

/** A sender who is not in the browser: a REST token plus its own socket. */
export interface Sender {
  readonly name: string;
  readonly token: string;
  readonly frames: Frame[];
  channelId: number;
  send(content: string): Promise<Frame>;
  close(): void;
}

/** Signs `name` in over REST and opens an authenticated socket for them. */
export async function connectSender(server: TestServer, name: string): Promise<Sender> {
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
  const sender: Sender = {
    name,
    token,
    frames,
    channelId: 0,
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

/** Opens a DM from `sender` to the member `recipientId` and points the sender at it. */
export async function openDm(
  server: TestServer,
  sender: Sender,
  recipientId: number,
): Promise<void> {
  const dm = (await server.api("/api/v1/dms", { recipient_id: recipientId }, sender.token)) as {
    channel_id: number;
  };
  sender.channelId = dm.channel_id;
}

/** Creates a role and returns its id. */
export async function createRole(
  server: TestServer,
  name: string,
  permissions: number,
  position: number,
): Promise<number> {
  const role = (await server.api(
    "/admin/api/roles",
    { name, permissions, position },
    server.owner!.token,
  )) as { id: number };
  return role.id;
}

export async function channelIdByName(server: TestServer, name: string): Promise<number> {
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const channel = channels.find(
    (c: { name: string; type: string }) => c.name === name && c.type === "text",
  );
  if (channel === undefined) throw new Error(`no text channel named ${name}`);
  return channel.id;
}

export const generalId = (server: TestServer): Promise<number> =>
  channelIdByName(server, "general");

/** The messages in #general whose content is `content`, read as the owner. */
export async function generalMessagesWith(server: TestServer, content: string): Promise<unknown[]> {
  const history = await server.api(
    `/api/v1/channels/${await generalId(server)}/messages`,
    undefined,
    server.owner!.token,
  );
  return history.messages.filter((message: { content: string }) => message.content === content);
}

/** A test whose server tolerates the many sign-ups and sign-ins of a multi-user run. */
export const relaxedAuthTest = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
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
