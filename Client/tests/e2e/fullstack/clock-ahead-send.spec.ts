import { test, expect, login } from "./fixtures";
import { generalMessagesWith } from "./serverApi";

const TEN_MINUTES = 10 * 60 * 1000;

test("a device whose clock runs 10 minutes ahead of the server can still send", async ({
  page,
  aliceTransport,
  bob,
  server,
}) => {
  const ids: unknown[] = [];
  aliceTransport.observeClientMessages((frame) => {
    if (frame.type === "chat_send") ids.push(frame.payload?.client_message_id);
  });
  // Alice's browser runs fast; the server's clock is right.
  await page.clock.install({ time: Date.now() + TEN_MINUTES });
  await login(page, server, "alice");

  const content = `fast-clock-${crypto.randomUUID()}`;
  const input = page.locator("[data-testid='message-input'] textarea");
  await input.fill(content);
  await input.press("Enter");

  await expect(bob.locator(".msg-text", { hasText: content })).toHaveCount(1);
  await expect(page.locator(".msg-text", { hasText: content })).toHaveCount(1);
  await expect(page.locator(".msg-send-retry")).toHaveCount(0);
  expect(await generalMessagesWith(server, content)).toHaveLength(1);

  // The id carries the server's time, not the device's.
  expect(ids).toHaveLength(1);
  const stamped = Number(String(ids[0]).split(":", 1)[0]);
  expect(Math.abs(stamped - Date.now())).toBeLessThan(60_000);
});
