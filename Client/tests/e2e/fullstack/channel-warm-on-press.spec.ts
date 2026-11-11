import { test, expect } from "./fixtures";
import { channelIdByName, channelItem } from "./serverApi";
import { rawSocket } from "../support/raw-socket";
import { recordTraffic, traffic } from "../support/real-transport";
import type { Page } from "@playwright/test";

async function pressOn(page: Page, name: string) {
  const box = (await channelItem(page, name).boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
}

const pageReads = (page: Page, channelId: number) =>
  traffic(page).then((lines) =>
    lines.filter((l) => l.startsWith(`GET /api/v1/channels/${channelId}/messages?`)),
  );

test("a message posted between the press and the click is on screen after the open", async ({
  bob,
  bobTransport,
  server,
}) => {
  await server.api("/admin/api/channels", { name: "warm", type: "text" }, server.owner!.token);
  const warm = await channelIdByName(server, "warm");
  const alice = await rawSocket(server, "alice");
  await alice.post(warm, ["before the press"]);
  await recordTraffic(bob);

  // The first page is read at the press and its answer held back until after
  // the click, so the message posted in between is in neither that page nor
  // the live feed (the channel is not focused yet).
  const release = bobTransport.holdHttpResponses(
    ({ path }) => path.includes(`/channels/${warm}/messages`) && !path.includes("after="),
  );
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await pressOn(bob, "warm");
  await expect.poll(() => pageReads(bob, warm)).toHaveLength(1);

  await alice.post(warm, ["between press and click"]);
  await bob.mouse.up();
  await expect(channelItem(bob, "warm")).toHaveClass(/active/);
  release();

  const messages = bob.locator(".messages-container .message");
  await expect(messages.filter({ hasText: "before the press" })).toHaveCount(1);
  await expect(messages.filter({ hasText: "between press and click" })).toHaveCount(1);
  const reads = await pageReads(bob, warm);
  expect(reads).toHaveLength(2);
  expect(reads[0]).toContain("limit=50");
  expect(reads[1]).toContain("limit=100");
  alice.close();
});

test("a press that ends away from the row opens nothing and shows nothing", async ({
  bob,
  server,
}) => {
  await server.api("/admin/api/channels", { name: "warm", type: "text" }, server.owner!.token);
  const warm = await channelIdByName(server, "warm");
  await recordTraffic(bob);

  await pressOn(bob, "warm");
  await expect.poll(() => pageReads(bob, warm)).toHaveLength(1);
  await bob.mouse.move(600, 400);
  await bob.mouse.up();

  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await expect(channelItem(bob, "warm")).not.toHaveClass(/active/);
  expect(await pageReads(bob, warm)).toHaveLength(1);
});
