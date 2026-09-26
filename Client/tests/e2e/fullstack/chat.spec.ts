import { test, expect, login } from "./fixtures";

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
  // A deliberate shutdown signs users out; a transport interruption above
  // resumes automatically. Assert each supported lifecycle explicitly.
  await expect(bob.locator("#host")).toBeVisible();
  await server.restart();
  await login(alice, server, "alice");
  await login(bob, server, "bob");
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
