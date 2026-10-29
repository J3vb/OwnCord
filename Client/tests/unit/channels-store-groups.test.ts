import { beforeEach, describe, expect, it } from "vitest";
import {
  addChannel,
  categoryGroups,
  channelsStore,
  getKnownCategories,
  getPointerOnOpen,
  groupLabel,
  nextPositionInCategory,
  nextPositionInCategoryNamed,
  resetChannelsStore,
  setActiveChannel,
  setCategories,
  setChannels,
  setMentionCount,
  setNsfwAcknowledged,
  updateChannel,
  type Channel,
} from "@stores/channels.store";
import type { ReadyChannel } from "@lib/types";

function text(id: number, position: number, extra: Partial<ReadyChannel> = {}): ReadyChannel {
  return { id, name: `c${id}`, type: "text", category: null, position, ...extra };
}

function voice(id: number, position: number, extra: Partial<ReadyChannel> = {}): ReadyChannel {
  return { id, name: `v${id}`, type: "voice", category: null, position, ...extra };
}

function channel(id: number): Channel {
  const found = channelsStore.getState().channels.get(id);
  if (found === undefined) throw new Error(`no channel ${id}`);
  return found;
}

function groupKeys(): Array<string | null> {
  return categoryGroups(channelsStore.getState().channels).map((g) => g.key);
}

beforeEach(() => {
  resetChannelsStore();
});

describe("nsfw acknowledgement", () => {
  it("is acknowledged only for a labelled channel the server says is acknowledged", () => {
    setChannels([
      text(1, 0, { nsfw: true, nsfw_acknowledged: true }),
      text(2, 1, { nsfw: true }),
      text(3, 2, { nsfw: true, nsfw_acknowledged: false }),
      text(4, 3, { nsfw: false, nsfw_acknowledged: true }),
      text(5, 4),
    ]);
    expect([1, 2, 3, 4, 5].map((id) => channel(id).nsfwAcknowledged)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("keeps a known acknowledgement when a re-sent channel_create keeps the label", () => {
    setChannels([text(1, 0, { nsfw: true, nsfw_acknowledged: true })]);
    addChannel({ id: 1, name: "c1", type: "text", category: null, position: 0, nsfw: true });
    expect(channel(1).nsfwAcknowledged).toBe(true);
  });

  it("does not invent an acknowledgement for a labelled channel that had none", () => {
    setChannels([text(1, 0, { nsfw: true })]);
    addChannel({ id: 1, name: "c1", type: "text", category: null, position: 0, nsfw: true });
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });

  it("drops the acknowledgement when channel_create clears the label", () => {
    setChannels([text(1, 0, { nsfw: true, nsfw_acknowledged: true })]);
    addChannel({ id: 1, name: "c1", type: "text", category: null, position: 0, nsfw: false });
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });

  it("reads an acknowledgement on a channel that carries no label as not acknowledged", () => {
    setChannels([text(1, 0, { nsfw_acknowledged: true })]);
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });

  it("drops a known acknowledgement when channel_create omits the label", () => {
    setChannels([text(1, 0, { nsfw: true, nsfw_acknowledged: true })]);
    addChannel({ id: 1, name: "c1", type: "text", category: null, position: 0 });
    expect(channel(1).nsfw).toBe(false);
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });

  it("starts a brand-new unlabelled channel unacknowledged", () => {
    addChannel({ id: 9, name: "new", type: "text", category: null, position: 0 });
    expect(channel(9).nsfwAcknowledged).toBe(false);
  });

  it("is recorded and revoked for a labelled channel", () => {
    setChannels([text(1, 0, { nsfw: true })]);
    setNsfwAcknowledged(1, true);
    expect(channel(1).nsfwAcknowledged).toBe(true);
    setNsfwAcknowledged(1, false);
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });

  it("changes nothing when the answer is already what the store holds", () => {
    setChannels([text(1, 0, { nsfw: true }), text(2, 1, { nsfw: true, nsfw_acknowledged: true })]);
    const before = channelsStore.getState();
    setNsfwAcknowledged(1, false);
    setNsfwAcknowledged(2, true);
    expect(channelsStore.getState()).toBe(before);
  });

  it("ignores an unknown or unlabelled channel", () => {
    setChannels([text(1, 0)]);
    const before = channelsStore.getState();
    setNsfwAcknowledged(1, true);
    setNsfwAcknowledged(99, true);
    expect(channelsStore.getState()).toBe(before);
  });

  it("drops the acknowledgement when channel_update clears the label and keeps it while the label stays", () => {
    setChannels([text(1, 0, { nsfw: true, nsfw_acknowledged: true })]);
    updateChannel({ id: 1, nsfw: true });
    expect(channel(1).nsfwAcknowledged).toBe(true);
    updateChannel({ id: 1, nsfw: false });
    expect(channel(1).nsfwAcknowledged).toBe(false);
  });
});

const cat = (id: number, position: number) => ({ id, name: `cat${id}`, position });

describe("setCategories", () => {
  it("orders by position, then id", () => {
    setCategories([cat(1, 2), cat(2, 1), cat(5, 3), cat(4, 3), cat(3, 3)]);
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([2, 1, 3, 4, 5]);
  });

  it("orders ties by id even when the ids arrive in reverse", () => {
    setCategories([cat(9, 0), cat(2, 0)]);
    expect(channelsStore.getState().categories.map((c) => c.id)).toEqual([2, 9]);
  });

  it("leaves the caller's list in the order it was given", () => {
    const given = [cat(2, 5), cat(1, 1)];
    setCategories(given);
    expect(given.map((c) => c.id)).toEqual([2, 1]);
  });
});

describe("read-position snapshots", () => {
  it("drops the pointer snapshot when a fresh ready payload arrives", () => {
    setChannels([text(1, 0, { last_read_message_id: 40 })]);
    setActiveChannel(1);
    expect(getPointerOnOpen(1)).toBe(40);
    setChannels([text(1, 0, { last_read_message_id: 55 })]);
    expect(getPointerOnOpen(1)).toBeUndefined();
  });

  it("drops the pointer snapshot on reset", () => {
    setChannels([text(1, 0, { last_read_message_id: 40 })]);
    setActiveChannel(1);
    resetChannelsStore();
    expect(getPointerOnOpen(1)).toBeUndefined();
  });
});

describe("channel_update leaves absent fields alone", () => {
  beforeEach(() => {
    setChannels([
      text(1, 0, {
        topic: "topic",
        category: "Cat",
        category_id: 4,
        category_position: 7,
        slow_mode: 9,
        voice_max_users: 3,
        voice_max_video: 2,
        afk: true,
        private: true,
        nsfw: true,
      }),
    ]);
  });

  it("changes only the name when only the name is sent", () => {
    updateChannel({ id: 1, name: "renamed" });
    expect(channel(1)).toMatchObject({
      name: "renamed",
      topic: "topic",
      category: "Cat",
      categoryId: 4,
      categoryPosition: 7,
      position: 0,
      slowMode: 9,
      voiceMaxUsers: 3,
      voiceMaxVideo: 2,
      afk: true,
      isPrivate: true,
      nsfw: true,
    });
  });

  it("applies each field that is sent, including falsy ones", () => {
    updateChannel({
      id: 1,
      topic: "",
      category_id: 0,
      category_position: 0,
      position: 0,
      slow_mode: 0,
      voice_max_users: 0,
      voice_max_video: 0,
      afk: false,
      private: false,
      nsfw: false,
    });
    expect(channel(1)).toMatchObject({
      topic: "",
      categoryId: 0,
      categoryPosition: 0,
      slowMode: 0,
      voiceMaxUsers: 0,
      voiceMaxVideo: 0,
      afk: false,
      isPrivate: false,
      nsfw: false,
    });
  });

  it("applies new numeric values for the category and capacity fields", () => {
    updateChannel({
      id: 1,
      category_id: 8,
      category_position: 2,
      voice_max_video: 6,
      afk: false,
      topic: "new topic",
    });
    expect(channel(1)).toMatchObject({
      categoryId: 8,
      categoryPosition: 2,
      voiceMaxVideo: 6,
      afk: false,
      topic: "new topic",
    });
  });
});

describe("setMentionCount", () => {
  it("leaves the state untouched when the count is already what the server says", () => {
    setChannels([text(1, 0, { mention_count: 3 })]);
    const before = channelsStore.getState();
    setMentionCount(1, 3);
    expect(channelsStore.getState()).toBe(before);
  });
});

describe("groupLabel", () => {
  it("names the synthetic voice group through the catalog and every other group by its name", () => {
    expect(groupLabel({ key: "Voice", name: "Voice" })).toBe("Voice");
    expect(groupLabel({ key: "cat:1", name: "Text" })).toBe("Text");
    expect(groupLabel({ key: "Text", name: "Text" })).toBe("Text");
  });

  it("does not treat a group that merely carries the voice key as the synthetic one", () => {
    expect(groupLabel({ key: "Voice", name: "Lounge" })).toBe("Lounge");
  });

  it("is empty for the uncategorized text group", () => {
    expect(groupLabel({ key: null, name: null })).toBe("");
  });
});

describe("nextPositionInCategory", () => {
  it("is 0 when there are no channels", () => {
    expect(nextPositionInCategory(0, "text")).toBe(0);
    expect(nextPositionInCategory(5, "voice")).toBe(0);
    expect(nextPositionInCategoryNamed("", "text")).toBe(0);
  });

  it("lands one past the highest position in the category", () => {
    setChannels([
      text(1, 2, { category: "A", category_id: 1 }),
      text(2, 7, { category: "A", category_id: 1 }),
      text(3, 4, { category: "A", category_id: 1 }),
      text(4, 20, { category: "B", category_id: 2 }),
    ]);
    expect(nextPositionInCategory(1, "text")).toBe(8);
    expect(nextPositionInCategory(2, "text")).toBe(21);
  });

  it("uses the last-seen position of the group only when it is the highest", () => {
    setChannels([
      text(1, 9, { category: "A", category_id: 1 }),
      text(2, 1, { category: "A", category_id: 1 }),
    ]);
    expect(nextPositionInCategory(1, "text")).toBe(10);
  });

  it("puts a category with no channels at the bottom of the whole list", () => {
    setChannels([
      text(1, 3, { category: "A", category_id: 1 }),
      text(2, 9, { category: "B", category_id: 2 }),
      text(3, 5, { category: "C", category_id: 3 }),
    ]);
    expect(nextPositionInCategory(77, "text")).toBe(10);
  });

  it("counts a group whose highest position is 0", () => {
    setChannels([
      text(1, 0, { category: "A", category_id: 1 }),
      text(2, 9, { category: "B", category_id: 2 }),
    ]);
    expect(nextPositionInCategory(1, "text")).toBe(1);
  });

  it("ignores DM rows", () => {
    setChannels([text(1, 3, { category: "A", category_id: 1 })]);
    channelsStore.setState((prev) => {
      const next = new Map(prev.channels);
      next.set(50, { ...channel(1), id: 50, type: "dm", position: 99 });
      return { ...prev, channels: next };
    });
    expect(nextPositionInCategory(1, "text")).toBe(4);
    expect(nextPositionInCategory(88, "text")).toBe(4);
  });

  it("files an uncategorized text channel with the other uncategorized text channels", () => {
    setChannels([text(1, 2), text(2, 6, { category: "A", category_id: 1 }), voice(3, 40)]);
    expect(nextPositionInCategory(0, "text")).toBe(3);
  });

  it("files an uncategorized voice channel with the synthetic voice group", () => {
    setChannels([text(1, 2), voice(2, 11), text(3, 30, { category: "A", category_id: 1 })]);
    expect(nextPositionInCategory(0, "voice")).toBe(12);
  });

  it("counts a real category named Voice apart from the synthetic group by id", () => {
    setChannels([voice(1, 4), text(2, 8, { category: "Voice", category_id: 5 })]);
    expect(nextPositionInCategory(5, "text")).toBe(9);
    expect(nextPositionInCategory(0, "voice")).toBe(5);
  });

  it("finds a legacy name-only group by its name", () => {
    setChannels([text(1, 3, { category: "Old" }), text(2, 8, { category: "Other" })]);
    expect(nextPositionInCategoryNamed("Old", "text")).toBe(4);
  });

  it("files a legacy empty name by the channel type", () => {
    setChannels([text(1, 3), voice(2, 8), text(3, 12, { category: "Old" })]);
    expect(nextPositionInCategoryNamed("", "text")).toBe(4);
    expect(nextPositionInCategoryNamed("", "voice")).toBe(9);
  });
});

describe("getKnownCategories", () => {
  it("leaves out the uncategorized text group and the synthetic voice group", () => {
    setChannels([
      text(1, 0),
      voice(2, 1),
      text(3, 2, { category: "A", category_id: 4, category_position: 1 }),
    ]);
    expect(getKnownCategories([])).toEqual([{ id: 4, name: "A" }]);
  });

  it("keeps a real category that is named Voice", () => {
    setChannels([text(1, 0, { category: "Voice", category_id: 4 }), voice(2, 1)]);
    expect(getKnownCategories([])).toEqual([{ id: 4, name: "Voice" }]);
  });
});

describe("categoryGroups ordering and kinds", () => {
  it("puts uncategorized text first, then the synthetic voice group, then real categories, then legacy names", () => {
    setChannels([
      text(1, 0, { category: "Legacy" }),
      text(2, 1, { category: "Real", category_id: 3, category_position: 1 }),
      voice(3, 2),
      text(4, 3),
    ]);
    expect(groupKeys()).toEqual([null, "Voice", "cat:3", "Legacy"]);
  });

  it("describes each kind of group", () => {
    setChannels([
      text(1, 0),
      voice(2, 1),
      text(3, 2, { category: "Real", category_id: 3, category_position: 1 }),
      text(4, 3, { category: "Legacy" }),
    ]);
    expect(
      categoryGroups(channelsStore.getState().channels).map((g) => [g.key, g.name, g.categoryId]),
    ).toEqual([
      [null, null, 0],
      ["Voice", "Voice", 0],
      ["cat:3", "Real", 3],
      ["Legacy", "Legacy", 0],
    ]);
  });

  it("does not take a legacy category for the synthetic voice group", () => {
    setChannels([
      text(1, 0, { category: "Real", category_id: 3, category_position: 1 }),
      text(2, 1, { category: "Legacy" }),
      voice(3, 2),
    ]);
    expect(groupKeys()).toEqual(["Voice", "cat:3", "Legacy"]);
  });

  it("does not take a text channel in a category named Voice for the synthetic voice group", () => {
    setChannels([
      text(1, 0, { category: "Real", category_id: 3, category_position: 1 }),
      text(2, 1, { category: "Voice" }),
      voice(3, 2),
    ]);
    const groups = categoryGroups(channelsStore.getState().channels);
    // Both land under the key "Voice"; the first channel to name it decides what it is.
    expect(groups.map((g) => g.key)).toEqual(["cat:3", "Voice"]);
    expect(groups[1]?.channels.map((c) => c.id)).toEqual([2, 3]);
  });

  it("treats a voice channel whose category name is empty as the synthetic group", () => {
    setChannels([voice(1, 0, { category: "" })]);
    expect(groupKeys()).toEqual(["Voice"]);
  });

  it("names a real category from a channel with no category text as empty", () => {
    setChannels([text(1, 0, { category_id: 6, category_position: 2 })]);
    const groups = categoryGroups(channelsStore.getState().channels);
    expect(groups.map((g) => [g.key, g.name, g.categoryId])).toEqual([["cat:6", "", 6]]);
  });

  it("orders real categories by their position", () => {
    setChannels([
      text(1, 0, { category: "B", category_id: 2, category_position: 9 }),
      text(2, 1, { category: "A", category_id: 1, category_position: 4 }),
    ]);
    expect(groupKeys()).toEqual(["cat:1", "cat:2"]);
  });

  it("orders real categories of equal position by id", () => {
    setChannels([
      text(1, 0, { category: "B", category_id: 8, category_position: 4 }),
      text(2, 1, { category: "A", category_id: 3, category_position: 4 }),
    ]);
    expect(groupKeys()).toEqual(["cat:3", "cat:8"]);
  });

  it("keeps legacy name groups in the order of their first channel", () => {
    setChannels([
      text(1, 0, { category: "Zed" }),
      text(2, 1, { category: "Alpha" }),
      text(3, 2, { category: "Mid" }),
    ]);
    expect(groupKeys()).toEqual(["Zed", "Alpha", "Mid"]);
  });

  it("merges channels that share a category id into one group", () => {
    setChannels([
      text(1, 0, { category: "B", category_id: 2, category_position: 0 }),
      text(2, 1, { category: "A", category_id: 2, category_position: 0 }),
    ]);
    expect(groupKeys()).toEqual(["cat:2"]);
  });

  it("adds the manager's empty categories and lets their list rename and reposition the rest", () => {
    setChannels([text(1, 0, { category: "Old name", category_id: 3, category_position: 9 })]);
    const groups = categoryGroups(channelsStore.getState().channels, [
      { id: 3, name: "New name", position: 5 },
      { id: 4, name: "Empty", position: 1 },
    ]);
    expect(groups.map((g) => [g.key, g.name, g.channels.length])).toEqual([
      ["cat:4", "Empty", 0],
      ["cat:3", "New name", 1],
    ]);
  });

  it("puts text channels before voice inside a group, each in position order", () => {
    setChannels([
      voice(1, 0, { category: "A", category_id: 1 }),
      text(2, 1, { category: "A", category_id: 1 }),
      voice(3, 2, { category: "A", category_id: 1 }),
      text(4, 3, { category: "A", category_id: 1 }),
    ]);
    const groups = categoryGroups(channelsStore.getState().channels);
    expect(groups[0]?.channels.map((c) => c.id)).toEqual([2, 4, 1, 3]);
  });
});
