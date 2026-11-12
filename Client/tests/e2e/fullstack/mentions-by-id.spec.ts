import type { Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";
import { channelIdByName, channelItem, userIds } from "./serverApi";

type StoredMessage = { content: string; mentions: number[]; mention_roles: number[] };

/** Type `text` key by key, so the composer sees each input as a person would type it. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  await page.locator("[data-testid='message-input'] textarea").pressSequentially(text);
}

/** Pick the @ list row for `token`. */
async function pick(page: Page, token: string): Promise<void> {
  const row = page.getByTestId(`mention-option-${token}`);
  await expect(row).toBeVisible();
  await row.click();
}

test("a user and a role picked from the @ list are sent by id and reach the role's holder", async ({
  page,
  aliceTransport,
  bobTransport,
  server,
}) => {
  void aliceTransport;
  const owner = server.owner!.token;
  await server.api("/admin/api/channels", { name: "mentions", type: "text" }, owner);
  const mentions = await channelIdByName(server, "mentions");
  const role = (await server.api(
    "/admin/api/roles",
    { name: "Owls", permissions: 0, position: 2, mentionable: true },
    owner,
  )) as { id: number };
  const id = await userIds(server);
  await server.api(`/admin/api/users/${id("bob")}/roles/${role.id}`, {}, owner, "PUT");

  // Both sign in after the role exists, so each ready carries it.
  const alice = page;
  const bob = (bobTransport as typeof bobTransport & { page: Page }).page;
  await login(alice, server, "alice");
  await login(bob, server, "bob");

  // Alice writes in #mentions while bob stays on #general, so bob learns of
  // the mention only through his badge.
  await channelItem(bob, "general").click();
  await expect(channelItem(bob, "general")).toHaveClass(/active/);
  await channelItem(alice, "mentions").click();
  await expect(channelItem(alice, "mentions")).toHaveClass(/active/);
  const input = alice.locator("[data-testid='message-input'] textarea");

  // A picked user goes out as <@id>.
  await typeInComposer(alice, "@bo");
  await pick(alice, "bob");
  await expect(input).toHaveValue("@bob ");
  await typeInComposer(alice, "hello");
  await input.press("Enter");
  await expect(input).toHaveValue("");

  const badge = bob.locator(`[data-testid='channel-mentions-${mentions}']`);
  await expect(badge).toHaveText("1", { timeout: 10_000 });

  // A role is offered in the @ list and goes out as <@&id>.
  await typeInComposer(alice, "ping @Ow");
  await pick(alice, "Owls");
  await expect(input).toHaveValue("ping @Owls ");
  await input.press("Enter");
  await expect(input).toHaveValue("");

  // The server stored the tokens and honoured the role.
  const history = (await server.api(`/api/v1/channels/${mentions}/messages`, undefined, owner)) as {
    messages: StoredMessage[];
  };
  const stored = new Map(history.messages.map((m) => [m.content, m]));
  const byUser = stored.get(`<@${id("bob")}> hello`);
  expect(byUser?.mentions).toEqual([id("bob")]);
  const byRole = stored.get(`ping <@&${role.id}>`);
  expect(byRole?.mention_roles).toEqual([role.id]);

  // Bob holds the role, so the role mention counts for him too.
  await expect(badge).toHaveText("2", { timeout: 10_000 });

  // Both read as names in the chat, with the role pill marked as his own.
  await channelItem(bob, "mentions").click();
  const rows = bob.locator(".msg-text");
  await expect(rows.locator(".mention", { hasText: "@bob" })).toBeVisible();
  await expect(rows.locator(".mention-role.mention-self", { hasText: "@Owls" })).toBeVisible();
  await expect(rows.filter({ hasText: "<@" })).toHaveCount(0);
  await bob.screenshot({ path: process.env.OWNCORD_EVIDENCE_DIR + "/bob-id-mentions.png" });
});
