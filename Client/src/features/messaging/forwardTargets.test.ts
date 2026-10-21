import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelsStore, setRoles, type Channel } from "../../stores/channels.store";
import { blocksStore, resetBlocksStore, setBlockedByMe } from "../../stores/blocks.store";
import { dmStore, type DmChannel } from "../../stores/dm.store";
import { authStore } from "../../stores/auth.store";
import {
  MAX_FORWARD_TARGETS,
  filterForwardTargets,
  listForwardTargets,
  pruneSelection,
  toggleForwardTarget,
  type ForwardTarget,
} from "./forwardTargets";

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

function dm(channelId: number, userId: number, over: Partial<DmChannel> = {}): DmChannel {
  const user = { id: userId, username: `user${userId}`, avatar: "", status: "online" };
  return {
    channelId,
    recipient: user,
    participants: [user],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function setChannels(...chs: Channel[]): void {
  channelsStore.setState((s) => ({ ...s, channels: new Map(chs.map((c) => [c.id, c])) }));
}
const ids = (ts: readonly ForwardTarget[]): number[] => ts.map((t) => t.id);

const role = (permissions: number) => ({
  id: 1,
  name: "member",
  color: null,
  permissions,
  position: 1,
});

describe("listForwardTargets with files", () => {
  beforeEach(() => {
    setChannels(channel(1), channel(2), channel(3, { canSend: false }));
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    resetBlocksStore();
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "me", avatar: null, role: "member" },
    }));
  });
  afterEach(() => {
    setRoles([]);
    authStore.setState((s) => ({ ...s, user: null }));
  });

  it("hides channels, not DMs, when the viewer's role lacks ATTACH_FILES", () => {
    setRoles([role(0x2 | 0x4)] as never);
    expect(ids(listForwardTargets(1, true))).toEqual([50]);
    expect(ids(listForwardTargets(1, false))).toEqual([1, 2, 50]);
  });

  it("keeps channels with ATTACH_FILES, and when the role is unknown", () => {
    setRoles([role(0x20)] as never);
    expect(ids(listForwardTargets(1, true))).toEqual([1, 2, 50]);
    setRoles([]);
    expect(ids(listForwardTargets(1, true))).toEqual([1, 2, 50]);
  });

  it("never offers a channel the server marks unsendable (archived folds into canSend)", () => {
    setRoles([role(0x20)] as never);
    expect(ids(listForwardTargets(1, true))).not.toContain(3);
  });
});

describe("listForwardTargets", () => {
  beforeEach(() => {
    setChannels();
    dmStore.setState(() => ({ channels: [] }));
    resetBlocksStore();
  });

  it("offers text and announcement channels the viewer can post in, then DMs", () => {
    setChannels(
      channel(2, { type: "announcement" }),
      channel(1),
      channel(3, { type: "voice" }),
      channel(4, { canSend: false }),
    );
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    const out = listForwardTargets(1);
    expect(out.map((t) => [t.id, t.kind])).toEqual([
      [1, "text"],
      [2, "announcement"],
      [50, "dm"],
    ]);
    expect(out[2]!.name).toBe("user7");
  });

  it("hides a 1:1 DM with a blocked user but keeps a group DM", () => {
    dmStore.setState(() => ({
      channels: [dm(50, 7), dm(51, 8, { isGroup: true, participants: [], name: "crew" })],
    }));
    setBlockedByMe([7]);
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(true);
    expect(ids(listForwardTargets(1))).toEqual([51]);
  });

  it("from a labelled source offers only acknowledged labelled channels, no DMs", () => {
    setChannels(
      channel(1, { nsfw: true, nsfwAcknowledged: true }),
      channel(2, { nsfw: true, nsfwAcknowledged: true }),
      channel(3, { nsfw: true, nsfwAcknowledged: false }),
      channel(4),
    );
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    expect(ids(listForwardTargets(1))).toEqual([1, 2]);
  });

  it("from an unlabelled source still hides labelled channels not acknowledged", () => {
    setChannels(
      channel(1),
      channel(2, { nsfw: true, nsfwAcknowledged: true }),
      channel(3, { nsfw: true }),
    );
    expect(ids(listForwardTargets(1))).toEqual([1, 2]);
  });

  it("treats a DM source as unlabelled", () => {
    setChannels(channel(1, { nsfw: true, nsfwAcknowledged: true }), channel(2));
    dmStore.setState(() => ({ channels: [dm(50, 7)] }));
    expect(ids(listForwardTargets(50))).toEqual([1, 2, 50]);
  });
});

const t = (id: number, name: string): ForwardTarget => ({ id, name, kind: "text", category: null });

describe("filterForwardTargets", () => {
  const all = [t(1, "general"), t(2, "a-general-b"), t(3, "random"), t(4, "gen")];

  it("keeps everything for a blank query", () => {
    expect(filterForwardTargets(all, "  ")).toBe(all);
  });

  it("ranks prefix matches ahead of substring matches, each in list order", () => {
    expect(ids(filterForwardTargets(all, "GEN"))).toEqual([1, 4, 2]);
  });

  it("drops names that do not match", () => {
    expect(ids(filterForwardTargets(all, "zzz"))).toEqual([]);
  });
});

describe("selection", () => {
  it("caps at five targets and ignores a sixth", () => {
    let sel: readonly number[] = [];
    for (let i = 1; i <= MAX_FORWARD_TARGETS; i++) sel = toggleForwardTarget(sel, i);
    expect(sel).toEqual([1, 2, 3, 4, 5]);
    expect(toggleForwardTarget(sel, 6)).toBe(sel);
  });

  it("takes a picked target back off, which frees a slot at the cap", () => {
    const full = [1, 2, 3, 4, 5];
    const after = toggleForwardTarget(full, 3);
    expect(after).toEqual([1, 2, 4, 5]);
    expect(toggleForwardTarget(after, 9)).toEqual([1, 2, 4, 5, 9]);
  });

  it("prunes ids no longer offered and keeps the array when nothing changed", () => {
    const offered: ForwardTarget[] = [{ id: 1, name: "a", kind: "text", category: null }];
    const same = [1];
    expect(pruneSelection(same, offered)).toBe(same);
    expect(pruneSelection([1, 2], offered)).toEqual([1]);
  });
});
