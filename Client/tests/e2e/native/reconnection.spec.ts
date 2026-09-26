import { test, expect } from "../native-fixture-persistent";
import { ensureLoggedIn } from "./helpers";

test("real native transport reconnects after sockets are severed and preserves messages", async ({
  nativePage: page,
  nativeServer: server,
}) => {
  await ensureLoggedIn(page);
  await page.locator(".channel-item:not(.voice)", { hasText: "general" }).click();
  const input = page.locator("[data-testid='message-input'] textarea");
  const before = `before-outage-${crypto.randomUUID()}`;
  await input.fill(before);
  await input.press("Enter");
  await expect(page.locator(".msg-text", { hasText: before })).toHaveCount(1);
  server.network.offline();
  try {
    await expect(page.locator(".reconnecting-banner")).toBeVisible();
  } finally {
    server.network.online();
  }
  await expect(page.locator(".reconnecting-banner")).not.toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".msg-text", { hasText: before })).toHaveCount(1);
  const after = `after-outage-${crypto.randomUUID()}`;
  await input.fill(after);
  await input.press("Enter");
  await expect(page.locator(".msg-text", { hasText: after })).toHaveCount(1);
  // A rendered optimistic bubble is insufficient: read durable server history.
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (c: { name: string; type: string }) => c.name === "general" && c.type === "text",
  );
  await expect
    .poll(async () => {
      const history = await server.api(
        `/api/v1/channels/${general.id}/messages`,
        undefined,
        server.owner!.token,
      );
      return history.messages.filter((m: { content: string }) => m.content === after).length;
    })
    .toBe(1);
});
