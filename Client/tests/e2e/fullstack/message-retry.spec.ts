import { test, expect, login } from "./fixtures";

test("a recovered send retries the original logical message after its acknowledgment is lost", async ({
  alice,
  bob,
  aliceTransport,
  server,
}) => {
  const content = `retry-once-${crypto.randomUUID()}`;
  const commands: Array<{ id?: string; logicalId: unknown }> = [];
  aliceTransport.observeClientMessages((frame) => {
    if (frame.type === "chat_send" && frame.payload?.content === content) {
      commands.push({ id: frame.id, logicalId: frame.payload.client_message_id });
    }
  });
  // The server commits the message and Bob receives it. Alice loses both ways
  // to learn that it succeeded, as can happen just before a process exits.
  aliceTransport.filterServerMessages((frame) => {
    if (frame.type === "chat_send_ok") return false;
    return frame.type !== "chat_message" || frame.payload?.content !== content;
  });
  await alice.locator("[data-testid='message-input'] textarea").fill(content);
  await alice.locator("[data-testid='message-input'] textarea").press("Enter");
  await expect(bob.locator(".msg-text", { hasText: content })).toHaveCount(1);
  expect(commands).toHaveLength(1);
  expect(commands[0]!.logicalId).toMatch(/^\d{13}:[0-9a-f-]{36}$/);

  // A new document destroys frontend state. Only the native persistence
  // boundary in the transport survives, just as the encrypted native store does.
  aliceTransport.filterServerMessages();
  await login(alice, server, "alice");
  const retry = alice.locator(".msg-send-retry");
  await expect(retry).toHaveCount(1);
  // Restoration never silently sends text.
  expect(commands).toHaveLength(1);
  await retry.click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]!.logicalId).toBe(commands[0]!.logicalId);
  expect(commands[1]!.id).not.toBe(commands[0]!.id);
  await expect(retry).toHaveCount(0);
  await expect(alice.locator(".msg-text", { hasText: content })).toHaveCount(1);
  await expect(bob.locator(".msg-text", { hasText: content })).toHaveCount(1);

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
    history.messages.filter((message: { content: string }) => message.content === content),
  ).toHaveLength(1);

  // The acknowledgment removes encrypted pending data as well as the failed UI.
  await login(alice, server, "alice");
  await expect(alice.locator(".msg-send-retry")).toHaveCount(0);
  await expect(alice.locator(".msg-text", { hasText: content })).toHaveCount(1);
});
