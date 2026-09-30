import { test, expect } from "./fixtures";

test("two users receive exactly one message across transport loss and server restart", async ({
  alice,
  bob,
  aliceTransport,
  server,
}) => {
  const text = `durable-message-${crypto.randomUUID()}`;
  const input = alice.locator("[data-testid='message-input'] textarea");
  await input.fill(text);
  await input.press("Enter");
  const received = bob.locator(".msg-text", { hasText: text });
  await expect(received).toHaveCount(1);

  await aliceTransport.offline();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  const reply = `while-offline-${crypto.randomUUID()}`;
  await bob.locator("[data-testid='message-input'] textarea").fill(reply);
  await bob.locator("[data-testid='message-input'] textarea").press("Enter");
  aliceTransport.online();
  await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
  await expect(alice.locator(".msg-text", { hasText: reply })).toHaveCount(1);
  await expect(alice.locator(".msg-text", { hasText: text })).toHaveCount(1);

  await server.stop();
  // A server stop (systemd/Docker restart) keeps the session (Q4): each client
  // stays on the main page, never the login form, and resumes on its own
  // once the server is back — just like the transport interruption above.
  await expect(bob.locator(".reconnecting-banner")).toBeVisible();
  await expect(bob.getByTestId("app-layout")).toBeVisible();
  await expect(bob.locator("#host")).toHaveCount(0);
  await server.restart();
  for (const page of [alice, bob]) {
    await expect(page.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
      timeout: 60_000,
    });
    await expect(page.locator("#password")).toHaveCount(0);
    await expect(
      page.locator(".channel-item.active:not(.voice)").filter({ hasText: "general" }),
    ).toBeVisible();
  }
  await expect(received).toHaveCount(1);
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (channel: { name: string; type: string }) =>
      channel.name === "general" && channel.type === "text",
  );
  const history = await server.api(
    `/api/v1/channels/${general.id}/messages`,
    undefined,
    server.owner!.token,
  );
  expect(
    history.messages.filter((message: { content: string }) => message.content === text),
  ).toHaveLength(1);
  const after = `after-restart-${crypto.randomUUID()}`;
  await input.fill(after);
  await input.press("Enter");
  await expect(bob.locator(".msg-text", { hasText: after })).toHaveCount(1);
});

test("the network coming back redials at once instead of waiting out the backoff", async ({
  alice,
  aliceTransport,
}) => {
  const banner = alice.locator(".reconnecting-banner");
  await aliceTransport.offline();
  await expect(banner).toBeVisible();
  // Long enough for the reconnect backoff to grow well past the 3 s below.
  await alice.waitForTimeout(20_000);
  aliceTransport.online();
  await alice.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(banner).not.toBeVisible({ timeout: 3_000 });
});

test("revoking channel visibility reaches an already connected member", async ({
  alice,
  bob,
  server,
}) => {
  void alice;
  const owner = server.owner!.token;
  const channels = await server.api("/api/v1/channels/", undefined, owner);
  const general = channels.find(
    (channel: { name: string; type: string }) =>
      channel.name === "general" && channel.type === "text",
  );
  const members = await server.api("/admin/api/users", undefined, owner);
  const member = members.find((user: { username: string }) => user.username === "bob");
  await expect(bob.locator(".channel-item:not(.voice)", { hasText: "general" })).toBeVisible();
  // READ_MESSAGES = bit one. Exercise the per-user permission mutation + WS fanout.
  await server.api(
    `/admin/api/channels/${general.id}/user-permissions/${member.id}`,
    { allow: 0, deny: 2 },
    owner,
    "PUT",
  );
  await expect(bob.locator(".channel-item:not(.voice)", { hasText: "general" })).toHaveCount(0);
  const auth = await server.api("/api/v1/auth/login", {
    username: "bob",
    password: "OwnCord-E2E-pass-123!",
  });
  const response = await fetch(`${server.origin}/api/v1/channels/${general.id}/messages`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(response.status).toBe(403);
  await server.api(
    `/admin/api/channels/${general.id}/user-permissions/${member.id}`,
    undefined,
    owner,
    "DELETE",
  );
  await expect(bob.locator(".channel-item:not(.voice)", { hasText: "general" })).toBeVisible();
});

test("revisiting a channel shows what changed while away and keeps unchanged rows", async ({
  alice,
  bob,
  server,
}) => {
  await server.api("/admin/api/channels", { name: "elsewhere", type: "text" }, server.owner!.token);
  const channel = (page: typeof alice, name: string) =>
    page.locator(".channel-item:not(.voice)").filter({ hasText: name });
  const row = (page: typeof alice, text: string) =>
    page.locator(".message", { has: page.locator(".msg-text", { hasText: text }) });
  const open = async (name: string) => {
    await channel(alice, name).click();
    await expect(channel(alice, name)).toHaveClass(/active/);
  };
  const bobInput = bob.locator("[data-testid='message-input'] textarea");
  // The composer drops a submit within its 200 ms double-send guard, so press
  // Enter until the text lands; once it has, the composer is empty and Enter
  // is a no-op.
  const submit = async (text: string) => {
    await bobInput.fill(text);
    await expect(async () => {
      await bobInput.press("Enter");
      await expect(bob.locator(".msg-text", { hasText: text })).toHaveCount(1, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
  };
  const id = crypto.randomUUID().slice(0, 8);
  const keep = `keep-${id}`;
  const before = `original-${id}`;
  const after = `rewritten-${id}`;
  const gone = `doomed-${id}`;
  const fresh = `fresh-${id}`;
  const later = `later-${id}`;

  await expect(channel(alice, "elsewhere")).toBeVisible();
  for (const text of [keep, before, gone]) await submit(text);
  await expect(row(alice, gone)).toHaveCount(1);

  // Away while bob posts. The revisit renders the rows that arrived live at
  // once, and the refetched page only adds the new one: the row that did not
  // change is never torn down and rebuilt.
  await open("elsewhere");
  await alice.evaluate((text) => {
    const w = window as unknown as { __keepRemovals: number; __keepObserver: MutationObserver };
    w.__keepRemovals = 0;
    w.__keepObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.textContent?.includes(text)) w.__keepRemovals++;
        }
      }
    });
    w.__keepObserver.observe(document.body, { childList: true, subtree: true });
  }, keep);
  await submit(later);
  await open("general");
  await expect(row(alice, later)).toHaveCount(1);
  await expect(row(alice, keep)).toHaveCount(1);
  const removals = await alice.evaluate(() => {
    const w = window as unknown as { __keepRemovals: number; __keepObserver: MutationObserver };
    w.__keepObserver.disconnect();
    return w.__keepRemovals;
  });
  expect(removals).toBe(0);

  // Away again: bob posts one message, edits one and deletes one.
  await open("elsewhere");
  await submit(fresh);
  const edited = row(bob, before);
  await edited.hover();
  await edited.locator("[data-testid^='msg-edit-']").click();
  await submit(after);
  const doomed = row(bob, gone);
  await doomed.hover();
  const del = doomed.locator("[data-testid^='msg-delete-']");
  await del.click();
  await del.click();
  await expect(row(bob, gone)).toHaveCount(0);

  await open("general");
  await expect(row(alice, fresh)).toHaveCount(1);
  await expect(row(alice, after)).toHaveCount(1);
  await expect(row(alice, before)).toHaveCount(0);
  await expect(row(alice, gone)).toHaveCount(0);
});

test("a server restart keeps the reader where they were in older history", async ({
  alice,
  aliceTransport,
  server,
}) => {
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (channel: { name: string; type: string }) =>
      channel.name === "general" && channel.type === "text",
  );
  // Bob posts 120 messages from his own socket while alice has #general open,
  // so she receives every one of them live.
  const auth = await server.api("/api/v1/auth/login", {
    username: "bob",
    password: "OwnCord-E2E-pass-123!",
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  // One send is in flight at a time: its reply is the frame carrying its id.
  let pending: {
    id: string;
    resolve: (frame: { type: string; payload?: { code?: string } }) => void;
  } | null = null;
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
  const id = crypto.randomUUID().slice(0, 8);
  const text = (n: number) => `seed-${id}-${n}`;
  for (let n = 1; n <= 120; n++) {
    // The server allows ten sends a second; wait out a refusal and resend.
    for (;;) {
      const requestId = crypto.randomUUID();
      const reply = new Promise<{ type: string; payload?: { code?: string } }>(
        (resolve) => (pending = { id: requestId, resolve }),
      );
      socket.send(
        JSON.stringify({
          type: "chat_send",
          id: requestId,
          payload: { channel_id: general.id, content: text(n), reply_to: null },
        }),
      );
      const frame = await reply;
      if (frame.type === "chat_send_ok") break;
      expect(frame.payload?.code).toBe("RATE_LIMITED");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  socket.close();
  await expect(alice.getByText(text(120), { exact: true })).toBeVisible();

  // Alice scrolls back to message 30.
  await alice.locator(".messages-container").evaluate((el) => {
    el.scrollTop = 0;
  });
  const reading = alice.getByText(text(30), { exact: true });
  await reading.scrollIntoViewIfNeeded();
  await expect(reading).toBeInViewport();

  // The restart ends in a full `ready`, whose history refetch splices into
  // what alice already has instead of replacing it with the latest page.
  await server.stop();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  // HTTP runs over the test transport, not the page: watch it there.
  let refetched!: () => void;
  const refetch = new Promise<void>((resolve) => (refetched = resolve));
  aliceTransport.failHttpRequests(({ path, method }) => {
    if (method === "GET" && path === `/api/v1/channels/${general.id}/messages`) refetched();
    return false;
  });
  await server.restart();
  await refetch;
  await expect(alice.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
    timeout: 60_000,
  });
  // The request is out; give its page time to land and splice in.
  await alice.waitForTimeout(2_000);
  await expect(reading).toBeInViewport();
  await expect(alice.locator(".messages-loading")).toHaveCount(0);
});
