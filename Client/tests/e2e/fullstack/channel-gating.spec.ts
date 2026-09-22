/**
 * Fullstack: the composer gating affordances agree with the real server
 * (batch N13 counterpart to the mocked `channel-gating.spec.ts`).
 *
 * The mocked spec proves the CLIENT gates the composer on the server's
 * `can_send` / `slow_mode` fields and on block state. This spec proves those
 * fields are not client fiction: a real Go server computes them from its own
 * permission engine and slow-mode limiter, they reach a connected client, the
 * composer follows them, and a send the composer allows really lands.
 *
 * The flows drive the real admin API (per-user channel override, channel
 * PATCH) so the server is the only source of the verdict under test.
 */

import { test, expect } from "./fixtures";
import type { TestServer } from "../support/server";

interface ChannelRow {
  readonly id: number;
  readonly name: string;
  readonly type: string;
}

interface AdminUserRow {
  readonly id: number;
  readonly username: string;
}

/** SEND_MESSAGES, the bit the per-user override denies (Server Permission). */
const SEND_MESSAGES = 0x1;

async function generalChannel(server: TestServer, token: string): Promise<ChannelRow> {
  const channels = (await server.api("/api/v1/channels/", undefined, token)) as ChannelRow[];
  const general = channels.find((c) => c.name === "general" && c.type === "text");
  if (general === undefined) throw new Error("seeded #general not found");
  return general;
}

async function bobId(server: TestServer, token: string): Promise<number> {
  const users = (await server.api("/admin/api/users", undefined, token)) as AdminUserRow[];
  const bob = users.find((u) => u.username === "bob");
  if (bob === undefined) throw new Error("seeded bob not found");
  return bob.id;
}

const composer = (page: import("@playwright/test").Page) =>
  page.locator("[data-testid='message-input'] textarea");

test.describe("Composer gating agreement (real server)", () => {
  test("bob's composer follows a per-user SEND_MESSAGES override on and off, and an allowed send lands", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const general = await generalChannel(server, owner);
    const target = await bobId(server, owner);

    await expect(composer(bob)).toBeEnabled();

    // Deny SEND_MESSAGES for bob only. RefreshChannelVisibility fans a
    // per-recipient channel_create carrying bob's fresh can_send to his live
    // connection — the composer must gate without a reconnect.
    await server.api(
      `/admin/api/channels/${general.id}/user-permissions/${target}`,
      { allow: 0, deny: SEND_MESSAGES },
      owner,
      "PUT",
    );
    await expect(composer(bob)).toBeDisabled({ timeout: 10_000 });
    await expect(composer(bob)).toHaveAttribute(
      "placeholder",
      "You don't have permission to send messages here",
    );

    // Clearing the override grants the bit back; the same targeted fan-out
    // re-enables the composer.
    await server.api(
      `/admin/api/channels/${general.id}/user-permissions/${target}`,
      undefined,
      owner,
      "DELETE",
    );
    await expect(composer(bob)).toBeEnabled({ timeout: 10_000 });

    // The enabled affordance is truthful: the server accepts the send.
    const text = `allowed-after-grant-${crypto.randomUUID()}`;
    await composer(bob).fill(text);
    await composer(bob).press("Enter");
    await expect(bob.locator(".msg-text", { hasText: text })).toBeVisible({ timeout: 10_000 });

    const history = (await server.api(
      `/api/v1/channels/${general.id}/messages`,
      undefined,
      owner,
    )) as { messages: Array<{ content: string }> };
    expect(history.messages.filter((m) => m.content === text)).toHaveLength(1);
  });

  test("slow mode set on the server gates bob's composer after one accepted send", async ({
    bob,
    server,
  }) => {
    const owner = server.owner!.token;
    const general = await generalChannel(server, owner);

    // A long window so the countdown cannot elapse before the assertion.
    await server.api(`/admin/api/channels/${general.id}`, { slow_mode: 300 }, owner, "PATCH");

    await expect(composer(bob)).toBeEnabled();
    await composer(bob).fill("first and only");
    await composer(bob).press("Enter");

    // The server accepted the send and its slow-mode limiter now refuses the
    // next one; the client mirrors that with a live countdown.
    await expect(composer(bob)).toBeDisabled({ timeout: 10_000 });
    await expect(composer(bob)).toHaveAttribute("placeholder", /^Slow mode — \d+s$/);

    const history = (await server.api(
      `/api/v1/channels/${general.id}/messages`,
      undefined,
      owner,
    )) as { messages: Array<{ content: string }> };
    expect(history.messages.filter((m) => m.content === "first and only")).toHaveLength(1);
  });
});
