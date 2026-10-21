/**
 * The channel row and category group builders (channelRowModel.ts): pure
 * functions of a `ChannelListInputs` snapshot plus the injected context.
 */

import { describe, it, expect } from "vitest";
import {
  categoryGroupModel,
  channelAccess,
  channelGroups,
  channelRowModel,
  visibleRows,
  type ChannelGroup,
  type ChannelListContext,
  type ChannelListInputs,
} from "../../src/features/channels/channelRowModel";
import type { VoiceRowInputs } from "../../src/features/channels/voiceRowModel";
import type { VoiceUser } from "../../src/stores/voice.store";
import { drawTextChannelRow } from "../../src/features/channels/channelRow.view";
import { shellText } from "../../src/i18n/shell";
import { Permission } from "../../src/lib/types";
import type { Channel } from "../../src/stores/channels.store";
import { assertNoStoreReads } from "../helpers/storeReadGuard";

function ch(id: number, over: Partial<Channel> = {}): Channel {
  return {
    id,
    name: `ch-${id}`,
    type: "text",
    category: null,
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...over,
  };
}

function inputs(over: Partial<ChannelListInputs> = {}): ChannelListInputs {
  return {
    channels: new Map(),
    activeChannelId: null,
    selfRole: "owner",
    roles: [],
    categories: [],
    collapsed: new Set(),
    hideMuted: false,
    mute: {},
    ...over,
  };
}

function ctx(
  muted: readonly number[] = [],
  over: Partial<ChannelListContext> = {},
): ChannelListContext {
  return {
    isMuted: (id) => muted.includes(id),
    canCreate: true,
    canReorder: true,
    canReorderCategories: true,
    ...over,
  };
}

function group(name: string | null, channels: readonly Channel[]): ChannelGroup {
  return {
    key: name,
    name,
    categoryId: 0,
    channels,
    orderIds: channels.map((c) => c.id).join(","),
  };
}

const NO_VOICE = { voiceUsers: new Map(), currentChannelId: null };

describe("text channel row model", () => {
  it("a muted plain-unread row is not unread, a muted mention is", () => {
    const g = group(null, []);
    const plain = ch(1, { unreadCount: 4 });
    const mention = ch(2, { unreadCount: 4, mentionCount: 1 });
    const list = inputs();
    expect(channelRowModel(plain, g, list, ctx([])).kind).toBe("text");
    expect(channelRowModel(plain, g, list, ctx([]))).toMatchObject({ unread: true, muted: false });
    expect(channelRowModel(plain, g, list, ctx([1]))).toMatchObject({ unread: false, muted: true });
    expect(channelRowModel(mention, g, list, ctx([2]))).toMatchObject({
      unread: true,
      muted: true,
    });
  });

  it("carries whether the row looks unread, not the count", () => {
    const g = group(null, []);
    const one = channelRowModel(ch(1, { unreadCount: 1 }), g, inputs(), ctx());
    const two = channelRowModel(ch(1, { unreadCount: 2 }), g, inputs(), ctx());
    expect(two).toEqual(one);
    expect("unreadCount" in one).toBe(false);
  });

  it("aria-description only for unread without a mention", () => {
    const g = group(null, []);
    const draw = (c: Channel, muted: number[] = []): HTMLElement => {
      const model = channelRowModel(c, g, inputs(), ctx(muted));
      if (model.kind === "voice") throw new Error("expected a text row");
      return drawTextChannelRow(model);
    };
    expect(draw(ch(1, { unreadCount: 2 })).getAttribute("aria-description")).toBe(
      shellText("channel.unread"),
    );
    expect(draw(ch(1, { unreadCount: 2, mentionCount: 1 })).hasAttribute("aria-description")).toBe(
      false,
    );
    expect(draw(ch(1, { unreadCount: 2 }), [1]).hasAttribute("aria-description")).toBe(false);
    expect(draw(ch(1)).hasAttribute("aria-description")).toBe(false);
  });

  it("an announcement channel draws as one, any other non-voice type as text", () => {
    const g = group(null, []);
    expect(channelRowModel(ch(1, { type: "announcement" }), g, inputs(), ctx()).kind).toBe(
      "announcement",
    );
    expect(channelRowModel(ch(1), g, inputs(), ctx()).kind).toBe("text");
  });

  it("is draggable only for a manager when the page wired reordering", () => {
    const g = group(null, []);
    const draggable = (list: ChannelListInputs, c: ChannelListContext): boolean =>
      channelRowModel(ch(1), g, list, c).draggable;
    expect(draggable(inputs(), ctx())).toBe(true);
    expect(draggable(inputs(), ctx([], { canReorder: false }))).toBe(false);
    expect(draggable(inputs({ selfRole: "member" }), ctx())).toBe(false);
  });

  it("a voice channel model carries no active, muted or unread", () => {
    const g = group(null, []);
    const voice = ch(3, { type: "voice", unreadCount: 5, mentionCount: 2, voiceMaxUsers: 4 });
    const model = channelRowModel(voice, g, inputs({ activeChannelId: 3 }), ctx([3]));
    expect(model.kind).toBe("voice");
    for (const field of ["active", "muted", "unread", "mentionCount", "voiceMaxUsers"]) {
      expect(field in model, field).toBe(false);
    }
    expect(Object.keys(model).toSorted()).toEqual([
      "access",
      "channelId",
      "draggable",
      "kind",
      "name",
      "nsfw",
      "orderIds",
      "private",
    ]);
  });

  it("the group's order is in every row model, so a reorder rebinds", () => {
    const a = channelRowModel(ch(1), group(null, [ch(1), ch(2)]), inputs(), ctx());
    const b = channelRowModel(ch(1), group(null, [ch(2), ch(1)]), inputs(), ctx());
    expect(a).not.toEqual(b);
  });
});

describe("channel access", () => {
  it("manageMessages has no legacy fallback, manageChannels does", () => {
    // Role "admin" with no role list: the legacy owner/admin names stand in for
    // the two derivations that have always had a fallback, never for Purge.
    expect(channelAccess({ selfRole: "admin", roles: [] })).toEqual({
      manageChannels: true,
      manageMessages: false,
      manageInvites: true,
    });
    expect(channelAccess({ selfRole: "member", roles: [] })).toEqual({
      manageChannels: false,
      manageMessages: false,
      manageInvites: false,
    });
  });

  it("follows the role's mask when the server sent a role list", () => {
    const roles = [{ id: 5, name: "Mod", color: null, permissions: Permission.MANAGE_MESSAGES }];
    expect(channelAccess({ selfRole: "mod", roles })).toEqual({
      manageChannels: false,
      manageMessages: true,
      manageInvites: false,
    });
    const owner = [{ id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR }];
    expect(channelAccess({ selfRole: "owner", roles: owner })).toEqual({
      manageChannels: true,
      manageMessages: true,
      manageInvites: true,
    });
  });
});

describe("category group model", () => {
  it("the uncategorized group draws no header fields", () => {
    const model = categoryGroupModel(
      group(null, [ch(1)]),
      inputs({ collapsed: new Set(["x"]) }),
      ctx(),
    );
    expect(model).toEqual({
      key: null,
      name: null,
      categoryId: 0,
      label: "",
      collapsed: false,
      showCreate: false,
      draggable: false,
    });
  });

  it("a named group carries its label, collapse state and whether the + shows", () => {
    const g = group("Text", [ch(1)]);
    expect(categoryGroupModel(g, inputs(), ctx())).toEqual({
      key: "Text",
      name: "Text",
      categoryId: 0,
      label: "Text",
      collapsed: false,
      showCreate: true,
      draggable: false,
    });
    expect(categoryGroupModel(g, inputs({ collapsed: new Set(["Text"]) }), ctx()).collapsed).toBe(
      true,
    );
    expect(categoryGroupModel(g, inputs(), ctx([], { canCreate: false })).showCreate).toBe(false);
    expect(categoryGroupModel(g, inputs({ selfRole: "member" }), ctx()).showCreate).toBe(false);
  });

  it("names the synthetic voice group through the catalog", () => {
    expect(categoryGroupModel(group("Voice", []), inputs(), ctx()).label).not.toBe("");
  });
});

describe("visibleRows", () => {
  const read = ch(1);
  const unread = ch(2, { unreadCount: 3 });
  const mentioned = ch(3, { mentionCount: 1 });
  const mutedUnread = ch(4, { unreadCount: 3 });
  const mutedMention = ch(5, { unreadCount: 3, mentionCount: 2 });
  const emptyVoice = ch(6, { type: "voice" });
  const busyVoice = ch(7, { type: "voice" });
  const active = ch(8);
  const all = [read, unread, mentioned, mutedUnread, mutedMention, emptyVoice, busyVoice, active];
  const g = group("Text", all);
  const busyUser: VoiceUser = {
    userId: 1,
    username: "alice",
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };
  const busy: Pick<VoiceRowInputs, "voiceUsers" | "currentChannelId"> = {
    voiceUsers: new Map([[7, new Map([[1, busyUser]])]]),
    currentChannelId: null,
  };
  const ids = (rows: readonly Channel[]): number[] => rows.map((c) => c.id);

  it("keeps the active row, any mention, an occupied voice channel and unmuted unread under a collapsed category", () => {
    const rows = visibleRows(
      g,
      inputs({ collapsed: new Set(["Text"]), activeChannelId: 8 }),
      busy,
      ctx([4, 5]),
    );
    expect(ids(rows)).toEqual([2, 3, 5, 7, 8]);
  });

  it("keeps the voice channel the user is in, even when nobody else is", () => {
    const rows = visibleRows(
      group("Text", [emptyVoice]),
      inputs({ collapsed: new Set(["Text"]) }),
      { voiceUsers: new Map(), currentChannelId: 6 },
      ctx(),
    );
    expect(ids(rows)).toEqual([6]);
  });

  it("shows everything when the category is expanded and Hide Muted is off", () => {
    expect(ids(visibleRows(g, inputs(), NO_VOICE, ctx([4, 5])))).toEqual(ids(all));
  });

  it("visibleRows with hide-muted on drops a plain muted row only", () => {
    // 4 is muted plain unread: dropped. 5 is a muted mention: kept. 1 is not muted.
    const rows = visibleRows(g, inputs({ hideMuted: true }), NO_VOICE, ctx([4, 5]));
    expect(ids(rows)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    // The active row is kept even when muted, and an occupied muted voice channel too.
    const keep = visibleRows(g, inputs({ hideMuted: true, activeChannelId: 4 }), busy, ctx([4, 7]));
    expect(ids(keep)).toContain(4);
    expect(ids(keep)).toContain(7);
  });

  it("a hidden muted channel stays in the group the drag maths sees", () => {
    const groups = channelGroups(inputs({ channels: new Map(all.map((c) => [c.id, c])) }));
    const only = groups.find((x) => x.name === null)!;
    visibleRows(only, inputs({ hideMuted: true }), NO_VOICE, ctx([4]));
    expect(only.channels.map((c) => c.id)).toContain(4);
  });
});

describe("channelGroups", () => {
  it("groups by category in display order with the order ids per group", () => {
    const channels = new Map([
      [1, ch(1, { category: "Text", position: 0 })],
      [2, ch(2, { category: "Text", position: 1 })],
      [3, ch(3, { type: "voice", position: 2 })],
      [4, ch(4, { type: "dm", position: 3 })],
    ]);
    const groups = channelGroups(inputs({ channels }));
    // D7: the synthetic Voice group sits before the categories.
    expect(groups.map((g) => [g.name, g.orderIds])).toEqual([
      ["Voice", "3"],
      ["Text", "1,2"],
    ]);
  });

  it("keys a real category by its id, so the key survives a rename", () => {
    const row = (name: string) =>
      new Map([[1, ch(1, { category: name, categoryId: 7, categoryPosition: 0 })]]);
    const before = channelGroups(inputs({ channels: row("Games") }));
    const after = channelGroups(inputs({ channels: row("Play") }));
    expect(before.map((g) => g.key)).toEqual(["cat:7"]);
    expect(after.map((g) => g.key)).toEqual(["cat:7"]);
    expect(after[0]?.name).toBe("Play");
    // Collapse is looked up by key: a set saved before the rename still hides the rows.
    const list = inputs({ channels: row("Play"), collapsed: new Set(["cat:7"]) });
    expect(categoryGroupModel(after[0]!, list, ctx()).collapsed).toBe(true);
  });
});

describe("the builders read no store", () => {
  const channels = [ch(1), ch(2, { type: "voice" }), ch(3, { unreadCount: 1 })];
  const list = inputs({ channels: new Map(channels.map((c) => [c.id, c])) });
  const g = group("Text", channels);

  it("channelAccess", () => {
    assertNoStoreReads(() => channelAccess(list));
  });
  it("channelGroups", () => {
    assertNoStoreReads(() => channelGroups(list));
  });
  it("visibleRows", () => {
    assertNoStoreReads(() => visibleRows(g, list, NO_VOICE, ctx([3])));
  });
  it("categoryGroupModel", () => {
    assertNoStoreReads(() => categoryGroupModel(g, list, ctx()));
  });
  it("channelRowModel", () => {
    for (const c of channels) assertNoStoreReads(() => channelRowModel(c, g, list, ctx([3])));
  });
});
