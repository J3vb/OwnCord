import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDm } from "../helpers/dmHarness";
import { listForwardTargets } from "../../src/features/messaging/forwardTargets";
import { channelsStore, setRoles, type Channel } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { dmStore } from "../../src/stores/dm.store";
import {
  resetBlocksStore,
  setBlockedByMe,
  setUserBlockedByThem,
} from "../../src/stores/blocks.store";

function channel(id: number, over: Partial<Channel> = {}): Channel {
  return {
    id,
    name: `chan-${id}`,
    type: "text",
    category: null,
    topic: "",
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...over,
  };
}

function seedChannels(...list: Channel[]): void {
  channelsStore.setState((s) => ({ ...s, channels: new Map(list.map((c) => [c.id, c])) }));
}

function dm(channelId: number, recipientId: number, isGroup = false) {
  const user = { id: recipientId, username: `user${recipientId}`, avatar: "", status: "online" };
  return makeDm({ channelId, recipient: user, participants: [user], isGroup });
}

const ids = (source: number, files = false): number[] =>
  listForwardTargets(source, files).map((t) => t.id);

beforeEach(() => {
  resetBlocksStore();
  dmStore.setState(() => ({ channels: [] }));
  setRoles([]);
  authStore.setState((s) => ({ ...s, user: null }));
});
afterEach(() => {
  seedChannels();
  setRoles([]);
  authStore.setState((s) => ({ ...s, user: null }));
});

describe("listForwardTargets", () => {
  it("lists text and announcement channels in position order, then DMs", () => {
    seedChannels(
      channel(3, { position: 1, type: "announcement", name: "news", category: "Info" }),
      channel(1, { position: 2 }),
      channel(2, { position: 3, type: "voice" }),
      channel(4, { position: 4, canSend: false }),
    );
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    const out = listForwardTargets(1);
    expect(out.map((t) => [t.id, t.kind, t.category])).toEqual([
      [3, "announcement", "Info"],
      [1, "text", null],
      [50, "dm", null],
    ]);
  });

  it("hides an age-restricted channel until it is acknowledged", () => {
    seedChannels(
      channel(1),
      channel(2, { nsfw: true }),
      channel(3, { nsfw: true, nsfwAcknowledged: true }),
    );
    expect(ids(1)).toEqual([1, 3]);
  });

  it("sends a labelled source only to acknowledged labelled channels, never to a DM", () => {
    seedChannels(
      channel(1, { nsfw: true, nsfwAcknowledged: true }),
      channel(2),
      channel(3, { nsfw: true, nsfwAcknowledged: true }),
    );
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    expect(ids(1)).toEqual([1, 3]);
  });

  it("drops channels, not DMs, when the role lacks ATTACH_FILES and the source has files", () => {
    seedChannels(channel(1), channel(2));
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    setRoles([{ id: 1, name: "member", color: null, permissions: 0x6, position: 1 }]);
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "me", avatar: null, role: "member" } as never,
    }));
    expect(ids(1, true)).toEqual([50]);
    expect(ids(1, false)).toEqual([1, 2, 50]);
  });

  it("hides nothing for an unknown role, even with files", () => {
    seedChannels(channel(1), channel(2));
    expect(ids(1, true)).toEqual([1, 2]);
  });

  it("skips a 1:1 DM the viewer cannot write to but keeps a group DM", () => {
    seedChannels(channel(1));
    dmStore.setState(() => ({
      channels: [dm(50, 7), dm(51, 8), dm(52, 9, true), dm(53, 10)],
    }));
    setBlockedByMe([7]);
    setUserBlockedByThem(8, true);
    setUserBlockedByThem(9, true);
    expect(ids(1)).toEqual([1, 52, 53]);
  });
});
