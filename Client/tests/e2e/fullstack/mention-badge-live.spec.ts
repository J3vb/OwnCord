import { test, expect } from "./fixtures";
import { TEST_PASSWORD, type TestServer } from "../support/server";

/** A raw server-side socket for a user, for posting/removing without stealing
 *  a page's single session. One request in flight at a time; a rate-limit
 *  refusal is waited out. */
async function rawSocket(server: TestServer, username: string) {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  let pending: { id: string; resolve: (frame: { type: string; payload?: any }) => void } | null =
    null;
  let ready!: () => void;
  const readyFrame = new Promise<void>((resolve) => (ready = resolve));
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ready") ready();
    if (pending && frame.id === pending.id) pending.resolve(frame);
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "auth", payload: { token: auth.token } }));
  await readyFrame;
  return {
    async request(type: string, payload: unknown) {
      for (;;) {
        const id = crypto.randomUUID();
        const reply = new Promise<{ type: string; payload?: any }>((resolve) => {
          pending = { id, resolve };
        });
        socket.send(JSON.stringify({ type, id, payload }));
        const frame = await reply;
        if (frame.payload?.code !== "RATE_LIMITED") return frame;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
    send: (type: string, payload: unknown) =>
      socket.send(JSON.stringify({ type, id: crypto.randomUUID(), payload })),
    close: () => socket.close(),
  };
}

async function channelIdByName(server: TestServer, name: string): Promise<number> {
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const channel = channels.find(
    (c: { name: string; type: string }) => c.name === name && c.type === "text",
  );
  if (channel === undefined) throw new Error(`no text channel named ${name}`);
  return channel.id;
}

const channelItem = (page: any, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });

test("a mention in an unfocused channel updates the badge live, and clears on its removal", async ({
  alice,
  bob,
  server,
}) => {
  // A second text channel for the mention to land in while bob is elsewhere.
  await server.api("/admin/api/channels", { name: "mentions", type: "text" }, server.owner!.token);
  const general = await channelIdByName(server, "general");
  const mentions = await channelIdByName(server, "mentions");

  // Both browsers start on the default (general) channel, which alice owns.
  await expect(channelItem(alice, "general")).toHaveClass(/active/);
  await expect(channelItem(bob, "general")).toHaveClass(/active/);

  // Bob has no badge on the mentions channel yet.
  await expect(bob.locator("[data-testid='channel-mentions-" + mentions + "']")).toHaveCount(0);

  // Alice mentions bob from a raw socket in #mentions. Bob is viewing
  // #general, so the chat_message broadcast (channel topic) never reaches him;
  // the per-user mention_count frame is the only live path.
  const aliceSocket = await rawSocket(server, "alice");
  const sent = await aliceSocket.request("chat_send", {
    channel_id: mentions,
    content: "@bob look here",
    reply_to: null,
  });
  expect(sent.type).toBe("chat_send_ok");

  // The badge appears while bob stays on #general — no re-ready, no refocus.
  const badge = bob.locator("[data-testid='channel-mentions-" + mentions + "']");
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveText("1");
  await expect(channelItem(bob, "mentions")).toHaveClass(/mentioned/);
  await bob.screenshot({
    path: process.env.OWNCORD_EVIDENCE_DIR + "/bob-unfocused-mention-badge.png",
  });

  // Deleting the mentioning message pushes the lowered total: the badge clears
  // live, still without bob ever opening #mentions.
  aliceSocket.send("chat_delete", { message_id: sent.payload!.message_id! });
  await expect(badge).toHaveCount(0, { timeout: 10_000 });
  await expect(channelItem(bob, "mentions")).not.toHaveClass(/mentioned/);

  // Sanity: the server-side total agrees with what bob now shows.
  const history = await server.api(
    `/api/v1/channels/${mentions}/messages`,
    undefined,
    server.owner!.token,
  );
  expect(
    history.messages.some((m: { content: string }) => m.content === "@bob look here"),
  ).toBe(false);

  aliceSocket.close();
  void general;
});

test("a mention in the channel the reader is viewing does not paint a badge", async ({
  alice,
  bob,
  server,
}) => {
  const general = await channelIdByName(server, "general");
  // Both start on #general; bob stays there.
  await expect(channelItem(bob, "general")).toHaveClass(/active/);

  const aliceSocket = await rawSocket(server, "alice");
  await aliceSocket.request("chat_send", {
    channel_id: general,
    content: "@bob on screen",
    reply_to: null,
  });

  // The mention arrives as an ordinary chat_message in the focused channel, so
  // the active-channel skip in the client drops the per-user frame instead of
  // painting a red badge on the channel being read.
  const badge = bob.locator("[data-testid='channel-mentions-" + general + "']");
  await expect(badge).toHaveCount(0);
  await expect(channelItem(bob, "general")).not.toHaveClass(/mentioned/);

  aliceSocket.close();
});
