import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { TEST_PASSWORD, type TestServer } from "../support/server";

type Frame = { type: string; payload?: { code?: string; message_id?: number } };

/** A raw socket signed in as `username`, for posting many messages fast. One
 *  request is in flight at a time: its reply is the frame carrying its id. A
 *  rate-limit refusal is waited out and the request resent. */
async function rawSocket(server: TestServer, username: string) {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  let pending: { id: string; resolve: (frame: Frame) => void } | null = null;
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
    async request(type: string, payload: unknown): Promise<Frame> {
      for (;;) {
        const id = crypto.randomUUID();
        const reply = new Promise<Frame>((resolve) => (pending = { id, resolve }));
        socket.send(JSON.stringify({ type, id, payload }));
        const frame = await reply;
        if (frame.payload?.code !== "RATE_LIMITED") return frame;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
    /** Post each text to `channelId`, in order; resolves to their ids. */
    async post(channelId: number, texts: readonly string[]): Promise<number[]> {
      const ids: number[] = [];
      for (const content of texts) {
        const frame = await this.request("chat_send", {
          channel_id: channelId,
          content,
          reply_to: null,
        });
        expect(frame.type).toBe("chat_send_ok");
        ids.push(frame.payload!.message_id!);
      }
      return ids;
    },
    /** Send a command whose success has no reply (chat_delete). */
    send: (type: string, payload: unknown) =>
      socket.send(JSON.stringify({ type, id: crypto.randomUUID(), payload })),
    close: () => socket.close(),
  };
}

async function generalId(server: TestServer): Promise<number> {
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  return channels.find(
    (channel: { name: string; type: string }) =>
      channel.name === "general" && channel.type === "text",
  ).id;
}

const channelItem = (page: Page, name: string) =>
  page.locator(".channel-item:not(.voice)").filter({ hasText: name });

/** Count, from now on, removals of a node whose text includes `text`. */
async function watchRemovals(page: Page, text: string): Promise<() => Promise<number>> {
  await page.evaluate((watched) => {
    const w = window as unknown as { __removals: number; __removalObserver: MutationObserver };
    w.__removals = 0;
    w.__removalObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.textContent?.includes(watched)) w.__removals++;
        }
      }
    });
    w.__removalObserver.observe(document.body, { childList: true, subtree: true });
  }, text);
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __removals: number; __removalObserver: MutationObserver };
      w.__removalObserver.disconnect();
      return w.__removals;
    });
}

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
  await bob.locator("[data-testid='msg-delete-confirm']").click();
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
  const general = { id: await generalId(server) };
  // Bob posts 120 messages from his own socket while alice has #general open,
  // so she receives every one of them live.
  const bob = await rawSocket(server, "bob");
  const id = crypto.randomUUID().slice(0, 8);
  const text = (n: number) => `seed-${id}-${n}`;
  await bob.post(
    general.id,
    Array.from({ length: 120 }, (_, i) => text(i + 1)),
  );
  bob.close();
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

test("a playing video keeps playing while bob reacts to another message 20 times", async ({
  alice,
  bob,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  // A three-second WebM, recorded in the page so nothing binary is checked in.
  const clip = await alice.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (let frame = 0; frame < 45; frame++) {
      context.fillStyle = `hsl(${frame * 8}, 80%, 50%)`;
      context.fillRect(0, 0, 64, 64);
      await new Promise((resolve) => setTimeout(resolve, 66));
    }
    recorder.stop();
    await stopped;
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const composer = alice.locator("[data-testid='message-input']");
  await composer.locator("input[type='file']").setInputFiles({
    name: `clip-${id}.webm`,
    mimeType: "video/webm",
    buffer: Buffer.from(clip),
  });
  await expect(composer.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  await composer.locator("textarea").fill(`clip-${id}`);
  await composer.locator("textarea").press("Enter");
  const bobInput = bob.locator("[data-testid='message-input'] textarea");
  await bobInput.fill(`react-${id}`);
  await bobInput.press("Enter");

  const video = alice.locator(".message", { hasText: `clip-${id}` }).locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(1);
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    v.loop = true;
    (window as unknown as { __clip: HTMLVideoElement }).__clip = v;
    await v.play();
  });

  const target = bob.locator(".message", {
    has: bob.locator(".msg-text", { hasText: `react-${id}` }),
  });
  const mine = target.locator(".reaction-chip.me");
  // Ten adds and ten removals; each waits for its own echo before the next.
  for (let round = 0; round < 10; round++) {
    await target.hover();
    await target.locator("[data-testid^='msg-react-']").click();
    await bob.locator(".reaction-picker-wrap .emoji-picker.open .ep-emoji").first().click();
    await expect(mine).toHaveCount(1);
    await mine.click();
    await expect(mine).toHaveCount(0);
  }
  const aliceTarget = alice.locator(".message", { hasText: `react-${id}` });
  await expect(aliceTarget.locator(".reaction-chip")).toHaveCount(0);

  // Every reaction re-rendered only bob's row: alice's player is the same
  // element, still in the page and still playing.
  const state = await alice.evaluate(() => {
    const v = (window as unknown as { __clip: HTMLVideoElement }).__clip;
    return { connected: v.isConnected, paused: v.paused };
  });
  expect(state).toEqual({ connected: true, paused: false });
});

test("revisiting a long channel with unread messages trims, appends and marks NEW without a rebuild", async ({
  alice,
  server,
}) => {
  await server.api("/admin/api/channels", { name: "elsewhere", type: "text" }, server.owner!.token);
  const general = await generalId(server);
  const bob = await rawSocket(server, "bob");
  // A second author with its own session: a socket as alice would take over
  // her page's (one session per account).
  await server.api("/api/v1/auth/register", {
    username: "carol",
    password: TEST_PASSWORD,
    invite_code: server.owner!.invite_code,
  });
  const carol = await rawSocket(server, "carol");
  const id = crypto.randomUUID().slice(0, 8);
  const text = (n: number) => `long-${id}-${n}.`;
  // Alice has #general open, so all 120 arrive live: her window holds them all.
  // Two authors taking turns give full-height rows, so the refetched page fills
  // more than the early-prefetch zone and the revisit alone is what is measured.
  const ids: number[] = [];
  for (let n = 1; n <= 120; n++) {
    ids.push(...(await (n % 2 === 0 ? carol : bob).post(general, [text(n)])));
  }
  carol.close();
  await expect(alice.getByText(text(120), { exact: true })).toBeVisible();

  await channelItem(alice, "elsewhere").click();
  await expect(channelItem(alice, "elsewhere")).toHaveClass(/active/);
  // While away: three new messages, and bob's message 39 (older than the page
  // the revisit refetches) is deleted.
  await bob.post(general, [text(121), text(122), text(123)]);
  bob.send("chat_delete", { message_id: ids[38] });
  // History leaves a deleted message out: the row before 40 is 38 once it lands.
  await expect
    .poll(async () => {
      const page = await server.api(
        `/api/v1/channels/${general}/messages?before=${ids[39]}&limit=1`,
        undefined,
        server.owner!.token,
      );
      return page.messages[0]?.id;
    })
    .toBe(ids[37]);
  bob.close();
  // Only the focused channel gets live messages; a full `ready` (here after a
  // restart) is what tells alice #general has unread messages.
  await server.stop();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  await server.restart();
  await expect(alice.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
    timeout: 60_000,
  });
  await expect(channelItem(alice, "general")).toHaveClass(/unread/);

  // The revisit renders the cached rows at once; the refetched latest page then
  // drops the older rows and adds the new ones, and the NEW line goes in on its
  // own. A row shown throughout is never torn down and rebuilt.
  const removals = await watchRemovals(alice, text(118));
  await channelItem(alice, "general").click();
  await expect(alice.getByText(text(123), { exact: true })).toBeVisible();
  const divider = alice.getByTestId("new-messages-divider");
  await expect(divider).toHaveCount(1);
  await expect(
    alice.locator("[data-testid='new-messages-divider'] + .message .msg-text"),
  ).toHaveText(text(121));
  await expect(alice.getByText(text(118), { exact: true })).toBeVisible();
  expect(await removals()).toBe(0);

  // Scrolling up brings the older history back, checked against the server:
  // the message deleted while away never shows.
  const scroller = alice.locator(".messages-container");
  await expect(async () => {
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(alice.getByText(text(1), { exact: true })).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // Step down until 38 and 40 are both on screen: 39 would sit between them.
  const shown = (n: number) => alice.getByText(text(n), { exact: true });
  await expect(async () => {
    await scroller.evaluate((el) => (el.scrollTop += 150));
    await expect(shown(38)).toBeInViewport({ timeout: 500 });
    await expect(shown(40)).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 30_000 });
  await expect(alice.getByText(text(39), { exact: true })).toHaveCount(0);
});
