import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { channelIdByName, channelItem } from "./serverApi";
import { rawSocket } from "../support/raw-socket";

/**
 * P4-03 step A live validation.
 *
 * The app's only focus source is `document.hasFocus()` (lib/readState.ts,
 * mirroring lib/notifications.ts). A headless browser cannot be given a real OS
 * focus transition, so the tests drive that one environment input explicitly
 * (override + a dispatched focus/blur event) while everything else — server
 * frames, stores, rendering, the mark_read on the wire — stays real.
 */
async function setFocused(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((focused) => {
    (document as unknown as { hasFocus: () => boolean }).hasFocus = () => focused;
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  }, focused);
}

// A server channel shows plain unread as the `.unread` row (bold name + pill),
// with no count; the fullstack assertions below therefore check presence only.
const unreadBadge = (page: Page, channelId: number) =>
  page.locator(`.channel-item.unread[data-channel-id="${channelId}"]`);

const evidence = (name: string) => `${process.env.OWNCORD_EVIDENCE_DIR}/${name}`;

test("unfocused message in the active channel counts unread, then refocus at the bottom marks it read", async ({
  bob,
  bobTransport,
  server,
}) => {
  const general = await channelIdByName(server, "general");
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await setFocused(bob, true);
  await expect(unreadBadge(bob, general)).toHaveCount(0);

  // Window unfocused: a message in the channel on screen must count.
  await setFocused(bob, false);
  const aliceSocket = await rawSocket(server, "alice");
  await aliceSocket.post(general, ["counted while unfocused"]);
  await expect(unreadBadge(bob, general)).toBeVisible({ timeout: 10_000 });
  await bob.screenshot({ path: evidence("p403-A-unfocused-counted.png") });

  // Refocus with the bottom in view: the channel is read and a mark_read goes out.
  const sent: string[] = [];
  bobTransport.observeClientMessages((m) => sent.push(m.type));
  await setFocused(bob, true);
  await expect(unreadBadge(bob, general)).toHaveCount(0, { timeout: 10_000 });
  expect(sent).toContain("mark_read");
  await bob.screenshot({ path: evidence("p403-B-refocused-read.png") });

  aliceSocket.close();
});

test("focused message in the active channel does not count as unread", async ({ bob, server }) => {
  const general = await channelIdByName(server, "general");
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await setFocused(bob, true);

  const aliceSocket = await rawSocket(server, "alice");
  await aliceSocket.post(general, ["on screen, focused"]);
  await expect(bob.getByText("on screen, focused")).toBeVisible({ timeout: 10_000 });
  await expect(unreadBadge(bob, general)).toHaveCount(0);

  aliceSocket.close();
});

test("an unfocused full-ready resync keeps the restated unread and sends no mark_read", async ({
  bob,
  bobTransport,
  server,
}) => {
  const general = await channelIdByName(server, "general");
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await setFocused(bob, true);
  await expect(unreadBadge(bob, general)).toHaveCount(0);

  // Drop bob's socket, unfocused; messages land in his active channel during
  // the outage; then reconnect — the ready restates them as unread.
  await setFocused(bob, false);
  await bobTransport.offline();
  const aliceSocket = await rawSocket(server, "alice");
  await aliceSocket.post(general, ["missed one"]);
  await aliceSocket.post(general, ["missed two"]);
  await aliceSocket.post(general, ["missed three"]);

  const sent: string[] = [];
  bobTransport.observeClientMessages((m) => sent.push(m.type));
  await bobTransport.online();
  await expect(bob.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
    timeout: 30_000,
  });
  await expect(unreadBadge(bob, general)).toBeVisible({ timeout: 15_000 });

  // The fix: an unfocused ready must not silently mark the unseen messages read.
  expect(sent).not.toContain("mark_read");
  await bob.screenshot({ path: evidence("p403-C-unfocused-ready-keeps-badge.png") });

  aliceSocket.close();
});

test("an unfocused mention in the active channel paints the mention badge; focused it does not", async ({
  bob,
  server,
}) => {
  const general = await channelIdByName(server, "general");
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  const mentionBadge = bob.locator(`[data-testid='channel-mentions-${general}']`);

  const aliceSocket = await rawSocket(server, "alice");
  await setFocused(bob, true);
  await aliceSocket.post(general, ["@bob on screen focused"]);
  await expect(bob.getByText("@bob on screen focused")).toBeVisible({ timeout: 10_000 });
  await expect(mentionBadge).toHaveCount(0);

  await setFocused(bob, false);
  await aliceSocket.post(general, ["@bob while away"]);
  await expect(mentionBadge).toBeVisible({ timeout: 10_000 });
  await bob.screenshot({ path: evidence("p403-E-unfocused-mention-active.png") });

  aliceSocket.close();
});

test("a never-opened channel with 100+ unread shows as unread", async ({
  bob,
  bobTransport,
  server,
}) => {
  await server.api("/admin/api/channels", { name: "flood", type: "text" }, server.owner!.token);
  const flood = await channelIdByName(server, "flood");

  // Accrue 100+ unread with the reading client disconnected, so the count can
  // only come from the server's authoritative ready snapshot (its cap is 100).
  await bobTransport.offline();
  const aliceSocket = await rawSocket(server, "alice");
  for (let i = 0; i < 101; i++) await aliceSocket.post(flood, [`flood-${i}`]);
  await bobTransport.online();
  await expect(bob.locator(".reconnecting-banner")).not.toHaveClass(/visible/, {
    timeout: 30_000,
  });

  const badge = unreadBadge(bob, flood);
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await bob.screenshot({ path: evidence("p403-D-100plus-unread.png") });

  aliceSocket.close();
});
