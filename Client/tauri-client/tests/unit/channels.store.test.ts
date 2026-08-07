import { describe, it, expect, beforeEach } from "vitest";
import {
  channelsStore,
  setChannels,
  setRoles,
  getRoleIdByName,
  addChannel,
  updateChannel,
  updateChannelPosition,
  removeChannel,
  setActiveChannel,
  getActiveChannel,
  getChannelsByCategory,
  getKnownCategories,
  displayCategoryOf,
  UNCATEGORIZED_VOICE_CATEGORY,
  incrementUnread,
  incrementMention,
  clearUnread,
  getUnreadOnOpen,
} from "../../src/stores/channels.store";
import type { ReadyChannel, ChannelCreatePayload, ChannelUpdatePayload } from "../../src/lib/types";

function resetStore(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
}

const readyChannels: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text",
    position: 0,
    unread_count: 3,
    last_message_id: 100,
  },
  { id: 2, name: "voice-lobby", type: "voice", category: "Voice", position: 0 },
  {
    id: 3,
    name: "announcements",
    type: "announcement",
    category: "Text",
    position: 1,
    unread_count: 0,
    last_message_id: 50,
  },
];

describe("channels store", () => {
  beforeEach(() => {
    resetStore();
  });

  it("has empty initial state", () => {
    const state = channelsStore.getState();
    expect(state.channels.size).toBe(0);
    expect(state.activeChannelId).toBeNull();
  });

  describe("setChannels", () => {
    it("populates channels from ready payload", () => {
      setChannels(readyChannels);
      const state = channelsStore.getState();

      expect(state.channels.size).toBe(3);

      const general = state.channels.get(1);
      expect(general).toEqual({
        id: 1,
        name: "general",
        type: "text",
        category: "Text",
        position: 0,
        unreadCount: 3,
        mentionCount: 0,
        lastMessageId: 100,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });

      const voice = state.channels.get(2);
      expect(voice).toEqual({
        id: 2,
        name: "voice-lobby",
        type: "voice",
        category: "Voice",
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
    });

    it("defaults unread_count to 0 and last_message_id to null", () => {
      setChannels([{ id: 10, name: "test", type: "text", category: null, position: 0 }]);
      const ch = channelsStore.getState().channels.get(10);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.lastMessageId).toBeNull();
    });

    it("carries synthesized DM rows across a ready rebuild", () => {
      setChannels(readyChannels);
      // A DM row is synthesized client-side (selectDmConversation); the ready
      // payload never restates it, so a rebuild must not destroy it.
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(99, {
          id: 99,
          name: "bob",
          type: "dm",
          category: null,
          topic: "",
          position: 0,
          unreadCount: 0,
          mentionCount: 0,
          lastMessageId: null,
          canSend: true,
          slowMode: 0,
          nsfw: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        });
        return { ...prev, channels: next };
      });

      setChannels(readyChannels);

      const dm = channelsStore.getState().channels.get(99);
      expect(dm?.type).toBe("dm");
      expect(dm?.name).toBe("bob");
    });
  });

  describe("addChannel", () => {
    it("adds a new channel", () => {
      setChannels(readyChannels);

      const payload: ChannelCreatePayload = {
        id: 4,
        name: "new-channel",
        type: "text",
        category: "Text",
        position: 2,
      };
      addChannel(payload);

      const state = channelsStore.getState();
      expect(state.channels.size).toBe(4);

      const added = state.channels.get(4);
      expect(added).toEqual({
        id: 4,
        name: "new-channel",
        type: "text",
        category: "Text",
        position: 2,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
    });

    it("does not mutate the previous channels map", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels;

      addChannel({ id: 5, name: "extra", type: "text", category: null, position: 0 });
      const after = channelsStore.getState().channels;

      expect(before).not.toBe(after);
      expect(before.size).toBe(3);
      expect(after.size).toBe(4);
    });

    it("preserves per-user fields on a re-sent channel_create (idempotent add)", () => {
      // The server re-broadcasts channel_create on role/override edits with
      // the note "Idempotent add on the client" — the broadcast carries no
      // per-user fields, so a re-add must not reset them.
      setChannels(readyChannels); // channel 1: unreadCount 3, lastMessageId 100
      incrementMention(1);
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, { ...prev.channels.get(1)!, canSend: false });
        return { ...prev, channels: next };
      });

      addChannel({ id: 1, name: "general-renamed", type: "text", category: "Text", position: 0 });

      const ch = channelsStore.getState().channels.get(1)!;
      expect(ch.name).toBe("general-renamed"); // payload fields still apply
      expect(ch.unreadCount).toBe(3);
      expect(ch.mentionCount).toBe(1);
      expect(ch.lastMessageId).toBe(100);
      expect(ch.canSend).toBe(false);
    });

    // v017: can_send used to be computed only in the ready payload, so a role
    // or override edit left every connected client's composer on its stale
    // connect-time verdict until the socket was rebuilt. The targeted
    // channel_create from RefreshChannelVisibility now carries this viewer's
    // own verdict, and it must win over the retained value.
    it("applies can_send from a targeted channel_create", () => {
      setChannels(readyChannels); // channel 1 starts canSend: true

      addChannel({
        id: 1,
        name: "general",
        type: "text",
        category: "Text",
        position: 0,
        can_send: false,
      });

      expect(channelsStore.getState().channels.get(1)!.canSend).toBe(false);
    });

    it("re-grants can_send when a permission edit restores posting", () => {
      setChannels(readyChannels);
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, { ...prev.channels.get(1)!, canSend: false });
        return { ...prev, channels: next };
      });

      addChannel({
        id: 1,
        name: "general",
        type: "text",
        category: "Text",
        position: 0,
        can_send: true,
      });

      expect(channelsStore.getState().channels.get(1)!.canSend).toBe(true);
    });
  });

  describe("updateChannel", () => {
    it("updates name immutably", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels.get(1);

      const update: ChannelUpdatePayload = { id: 1, name: "renamed" };
      updateChannel(update);

      const after = channelsStore.getState().channels.get(1);
      expect(after?.name).toBe("renamed");
      expect(after?.position).toBe(0); // unchanged
      expect(before).not.toBe(after);
    });

    it("updates position immutably", () => {
      setChannels(readyChannels);

      updateChannel({ id: 1, position: 5 });

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.position).toBe(5);
      expect(ch?.name).toBe("general"); // unchanged
    });

    it("updates both name and position", () => {
      setChannels(readyChannels);

      updateChannel({ id: 1, name: "new-name", position: 10 });

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.name).toBe("new-name");
      expect(ch?.position).toBe(10);
    });

    it("is a no-op for unknown channel id", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannel({ id: 999, name: "ghost" });

      const after = channelsStore.getState();
      expect(after).toBe(before);
    });
  });

  describe("removeChannel", () => {
    it("removes a channel", () => {
      setChannels(readyChannels);

      removeChannel(1);

      const state = channelsStore.getState();
      expect(state.channels.size).toBe(2);
      expect(state.channels.has(1)).toBe(false);
    });

    it("clears activeChannelId if removed channel was active", () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);

      removeChannel(1);

      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("preserves activeChannelId if removed channel was not active", () => {
      setChannels(readyChannels);
      setActiveChannel(2);

      removeChannel(1);

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });
  });

  describe("setActiveChannel", () => {
    it("sets active channel id", () => {
      setChannels(readyChannels);

      setActiveChannel(2);

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });

    it("sets active channel to null", () => {
      setChannels(readyChannels);
      setActiveChannel(1);

      setActiveChannel(null);

      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it("clears unread count for the activated channel", () => {
      setChannels(readyChannels);
      // channel 1 starts with unreadCount: 3
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(3);

      setActiveChannel(1);

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    });

    it("does not mutate channels map when clearing unread", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels;

      setActiveChannel(1);

      const after = channelsStore.getState().channels;
      expect(before).not.toBe(after);
      // other channels unchanged
      expect(after.get(2)).toBe(before.get(2));
    });

    it("skips channels map update when unread is already 0", () => {
      setChannels(readyChannels);
      // channel 2 has unreadCount: 0
      const before = channelsStore.getState().channels;

      setActiveChannel(2);

      const after = channelsStore.getState().channels;
      expect(before).toBe(after);
    });
  });

  describe("getActiveChannel", () => {
    it("returns null when no active channel", () => {
      expect(getActiveChannel()).toBeNull();
    });

    it("returns the active Channel object", () => {
      setChannels(readyChannels);
      setActiveChannel(1);

      const active = getActiveChannel();
      expect(active).toEqual({
        id: 1,
        name: "general",
        type: "text",
        category: "Text",
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: 100,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
    });

    it("returns null if activeChannelId refers to a non-existent channel", () => {
      setActiveChannel(999);

      expect(getActiveChannel()).toBeNull();
    });
  });

  describe("getChannelsByCategory", () => {
    it("groups channels by category and sorts by position", () => {
      setChannels(readyChannels);

      const grouped = getChannelsByCategory();

      expect(grouped.size).toBe(2);

      const textChannels = grouped.get("Text");
      expect(textChannels).toHaveLength(2);
      expect(textChannels?.[0]?.name).toBe("general"); // position 0
      expect(textChannels?.[1]?.name).toBe("announcements"); // position 1

      const voiceChannels = grouped.get("Voice");
      expect(voiceChannels).toHaveLength(1);
      expect(voiceChannels?.[0]?.name).toBe("voice-lobby");
    });

    it("handles null category", () => {
      setChannels([{ id: 1, name: "uncategorized", type: "text", category: null, position: 0 }]);

      const grouped = getChannelsByCategory();
      expect(grouped.has(null)).toBe(true);
      expect(grouped.get(null)).toHaveLength(1);
    });

    it("returns empty map when no channels", () => {
      const grouped = getChannelsByCategory();
      expect(grouped.size).toBe(0);
    });

    // No category name is magic: a voice channel groups under whatever it
    // carries, and text/voice channels share a category happily.
    it("groups a voice channel under an arbitrary category alongside text", () => {
      setChannels([
        { id: 1, name: "chat", type: "text", category: "Gaming", position: 0 },
        { id: 2, name: "lounge", type: "voice", category: "Gaming", position: 1 },
      ]);

      const grouped = getChannelsByCategory();
      expect(grouped.size).toBe(1);
      expect(grouped.get("Gaming")?.map((c) => c.name)).toEqual(["chat", "lounge"]);
    });

    it("falls back to a Voice group only for uncategorized voice channels", () => {
      setChannels([
        { id: 1, name: "loose-text", type: "text", category: null, position: 0 },
        { id: 2, name: "loose-voice", type: "voice", category: null, position: 1 },
        { id: 3, name: "blank-voice", type: "voice", category: "", position: 2 },
      ]);

      const grouped = getChannelsByCategory();
      expect(grouped.get(null)?.map((c) => c.name)).toEqual(["loose-text"]);
      expect(grouped.get(UNCATEGORIZED_VOICE_CATEGORY)?.map((c) => c.name)).toEqual([
        "loose-voice",
        "blank-voice",
      ]);
    });

    it("keeps DM channels out of every group", () => {
      setChannels([
        { id: 1, name: "chat", type: "text", category: "Gaming", position: 0 },
        { id: 2, name: "dm", type: "dm", category: null, position: 0 },
      ]);
      const grouped = getChannelsByCategory();
      expect(grouped.size).toBe(1);
      expect(grouped.has(null)).toBe(false);
    });
  });

  describe("displayCategoryOf", () => {
    it("prefers the channel's own category over the voice fallback", () => {
      setChannels([{ id: 1, name: "lounge", type: "voice", category: "Gaming", position: 0 }]);
      const channel = channelsStore.getState().channels.get(1)!;
      expect(displayCategoryOf(channel)).toBe("Gaming");
    });

    it("returns null for an uncategorized text channel", () => {
      setChannels([{ id: 1, name: "loose", type: "text", category: null, position: 0 }]);
      const channel = channelsStore.getState().channels.get(1)!;
      expect(displayCategoryOf(channel)).toBeNull();
    });
  });

  describe("getKnownCategories", () => {
    it("returns distinct non-empty categories, sorted, DMs excluded", () => {
      setChannels([
        { id: 1, name: "a", type: "text", category: "Zeta", position: 0 },
        { id: 2, name: "b", type: "voice", category: "Alpha", position: 1 },
        { id: 3, name: "c", type: "text", category: "Alpha", position: 2 },
        { id: 4, name: "d", type: "text", category: null, position: 3 },
        { id: 5, name: "e", type: "text", category: "", position: 4 },
        { id: 6, name: "dm", type: "dm", category: "Hidden", position: 5 },
      ]);

      expect(getKnownCategories()).toEqual(["Alpha", "Zeta"]);
    });

    it("returns an empty list when nothing is categorized", () => {
      setChannels([{ id: 1, name: "a", type: "text", category: null, position: 0 }]);
      expect(getKnownCategories()).toEqual([]);
    });
  });

  describe("mention counts", () => {
    it("reads mention_count from the ready payload", () => {
      setChannels([{ ...readyChannels[0]!, unread_count: 5, mention_count: 2 }]);
      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(2);
    });

    it("defaults to 0 when an older server omits mention_count", () => {
      setChannels(readyChannels);
      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    });

    it("increments the mention count for a non-active channel", () => {
      setChannels(readyChannels);

      incrementMention(1);
      incrementMention(1);

      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(2);
    });

    it("skips increment for the active channel", () => {
      setChannels(readyChannels);
      setActiveChannel(1);

      incrementMention(1);

      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    });

    it("is a no-op for an unknown channel id", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      incrementMention(999);

      expect(channelsStore.getState()).toBe(before);
    });

    it("clears on activation alongside unread", () => {
      setChannels([{ ...readyChannels[0]!, unread_count: 5, mention_count: 2 }]);

      setActiveChannel(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.mentionCount).toBe(0);
      expect(ch?.unreadCount).toBe(0);
    });

    it("clears via clearUnread", () => {
      setChannels([{ ...readyChannels[0]!, unread_count: 5, mention_count: 2 }]);

      clearUnread(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.mentionCount).toBe(0);
      expect(ch?.unreadCount).toBe(0);
    });

    it("leaves a mention-only channel's badge clearing to activation", () => {
      setChannels([{ ...readyChannels[0]!, unread_count: 0, mention_count: 3 }]);

      // Previously setActiveChannel bailed early when unreadCount was 0; a
      // mention-only channel must still have its badge cleared.
      setActiveChannel(1);

      expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    });
  });

  describe("incrementUnread", () => {
    it("increments unread count for a channel", () => {
      setChannels(readyChannels);

      incrementUnread(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(4); // was 3
    });

    it("skips increment for the active channel", () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      // setActiveChannel clears unread, so it's now 0
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);

      incrementUnread(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(0); // unchanged — active channel skips increment
    });

    it("is a no-op for unknown channel id", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      incrementUnread(999);

      expect(channelsStore.getState()).toBe(before);
    });
  });

  describe("clearUnread", () => {
    it("resets unread count to 0", () => {
      setChannels(readyChannels);
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(3);

      clearUnread(1);

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    });

    it("is a no-op for unknown channel id", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      clearUnread(999);

      expect(channelsStore.getState()).toBe(before);
    });
  });

  describe("setRoles", () => {
    it("stores roles from ready payload", () => {
      const roles = [
        { id: 1, name: "admin", color: "#ff0000", permissions: 0 },
        { id: 2, name: "member", color: "#00ff00", permissions: 0 },
      ];
      setRoles(roles);
      expect(channelsStore.getState().roles).toEqual(roles);
    });

    it("replaces existing roles", () => {
      setRoles([{ id: 1, name: "admin", color: "#ff0000", permissions: 0 }]);
      setRoles([{ id: 2, name: "member", color: "#00ff00", permissions: 0 }]);
      expect(channelsStore.getState().roles).toHaveLength(1);
      expect(channelsStore.getState().roles[0]!.name).toBe("member");
    });
  });

  describe("getRoleIdByName", () => {
    it("returns role id for matching name (case-insensitive)", () => {
      setRoles([
        { id: 1, name: "Admin", color: "#ff0000", permissions: 0 },
        { id: 2, name: "Member", color: "#00ff00", permissions: 0 },
      ]);
      expect(getRoleIdByName("admin")).toBe(1);
      expect(getRoleIdByName("ADMIN")).toBe(1);
      expect(getRoleIdByName("member")).toBe(2);
    });

    it("returns undefined for non-existent role", () => {
      setRoles([{ id: 1, name: "admin", color: "#ff0000", permissions: 0 }]);
      expect(getRoleIdByName("moderator")).toBeUndefined();
    });

    it("returns undefined when no roles set", () => {
      expect(getRoleIdByName("admin")).toBeUndefined();
    });

    // Role CRUD makes the list mutable at runtime, so these lookups have to
    // track a replacement list rather than the one shipped in `ready`.
    it("resolves a custom role added after the initial role list", () => {
      setRoles([{ id: 4, name: "Member", color: null, permissions: 0 }]);
      expect(getRoleIdByName("contractor")).toBeUndefined();

      setRoles([
        { id: 4, name: "Member", color: null, permissions: 0 },
        { id: 9, name: "Contractor", color: "#123456", permissions: 3, position: 30 },
      ]);
      // Case-insensitive, which is safe because the server enforces role names
      // to be unique case-insensitively (migration 023).
      expect(getRoleIdByName("contractor")).toBe(9);
      expect(getRoleIdByName("CONTRACTOR")).toBe(9);
    });

    it("stops resolving a role's old name after it is renamed", () => {
      setRoles([{ id: 9, name: "Contractor", color: null, permissions: 0 }]);
      expect(getRoleIdByName("contractor")).toBe(9);

      setRoles([{ id: 9, name: "Partner", color: null, permissions: 0 }]);
      expect(getRoleIdByName("contractor")).toBeUndefined();
      expect(getRoleIdByName("partner")).toBe(9);
    });
  });

  describe("updateChannelPosition", () => {
    it("updates a channel position", () => {
      setChannels(readyChannels);

      updateChannelPosition(1, 5);

      expect(channelsStore.getState().channels.get(1)?.position).toBe(5);
    });

    it("is a no-op for unknown channel id", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannelPosition(999, 5);

      expect(channelsStore.getState()).toBe(before);
    });

    it("is a no-op when position is already the same", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannelPosition(1, 0); // position 0 is already set

      expect(channelsStore.getState()).toBe(before);
    });

    it("produces a new channel object (immutable)", () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels.get(1);

      updateChannelPosition(1, 10);

      const after = channelsStore.getState().channels.get(1);
      expect(before).not.toBe(after);
      expect(after?.position).toBe(10);
    });
  });

  describe("getChannelsByCategory — DM filtering", () => {
    it("excludes DM channels from category grouping", () => {
      setChannels([
        { id: 1, name: "general", type: "text", category: "Text", position: 0 },
        { id: 2, name: "dm-channel", type: "dm", category: null, position: 0 },
      ]);

      const grouped = getChannelsByCategory();
      // DM channels should be filtered out
      expect(grouped.size).toBe(1);
      expect(grouped.has("Text")).toBe(true);
      // Verify the DM is not in any group
      for (const channels of grouped.values()) {
        expect(channels.every((ch) => ch.type !== "dm")).toBe(true);
      }
    });
  });

  describe("getChannelsByCategory — sort order", () => {
    it("sorts channels within same category by position", () => {
      setChannels([
        { id: 1, name: "c-channel", type: "text", category: "Text", position: 2 },
        { id: 2, name: "a-channel", type: "text", category: "Text", position: 0 },
        { id: 3, name: "b-channel", type: "text", category: "Text", position: 1 },
      ]);

      const grouped = getChannelsByCategory();
      const textChannels = grouped.get("Text")!;
      expect(textChannels[0]!.name).toBe("a-channel");
      expect(textChannels[1]!.name).toBe("b-channel");
      expect(textChannels[2]!.name).toBe("c-channel");
    });
  });

  describe("setActiveChannel — edge case: unknown channel with unread=0", () => {
    it("sets activeChannelId even for a channel not in the map", () => {
      setActiveChannel(999);
      expect(channelsStore.getState().activeChannelId).toBe(999);
    });
  });

  // The badge is cleared the moment a channel is opened, which destroys the
  // only record of where the reader had got to. MessageList needs that number
  // to place the "NEW" divider, so setActiveChannel snapshots it first.
  describe("getUnreadOnOpen", () => {
    it("is 0 for a channel that was never opened", () => {
      setChannels(readyChannels);
      expect(getUnreadOnOpen(1)).toBe(0);
    });

    it("captures the unread count as it was before the visit cleared it", () => {
      setChannels(readyChannels); // channel 1 starts at 3 unread
      incrementUnread(1);
      incrementUnread(1);

      setActiveChannel(1);

      expect(getUnreadOnOpen(1)).toBe(5);
      // …and the badge itself is gone.
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    });

    it("resets to 0 on the next visit, which is what clears the divider", () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      expect(getUnreadOnOpen(1)).toBe(3);

      setActiveChannel(null);
      setActiveChannel(1);

      expect(getUnreadOnOpen(1)).toBe(0);
    });

    it("is per channel", () => {
      setChannels(readyChannels);
      incrementUnread(3);
      incrementUnread(3);

      setActiveChannel(1);
      setActiveChannel(3);

      expect(getUnreadOnOpen(1)).toBe(3);
      expect(getUnreadOnOpen(3)).toBe(2);
    });

    // A fresh ready payload restates unread from the server; a snapshot from
    // the previous connection describes a read position that no longer applies.
    it("is dropped by a new ready payload", () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      expect(getUnreadOnOpen(1)).toBe(3);

      setChannels(readyChannels);

      expect(getUnreadOnOpen(1)).toBe(0);
    });
  });

  describe("updateChannel — no changes", () => {
    it("still creates new object when neither name nor position is provided", () => {
      setChannels(readyChannels);

      updateChannel({ id: 1 } as ChannelUpdatePayload);

      // Channel should still exist with original values
      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.name).toBe("general");
      expect(ch?.position).toBe(0);
    });
  });
  // ─── Channel feature flags ───────────────────────────────────────────────
  //
  // nsfw and the two voice limits arrive in `ready`, in channel_create and in
  // channel_update, and the store is what the sidebar and the edit modal read.
  // The interesting cases are all about ABSENCE: an older server omits the
  // keys, and a partial channel_update carries only what changed.

  describe("channel feature flags", () => {
    it("reads the flags out of the ready payload", () => {
      setChannels([
        {
          id: 1,
          name: "spicy",
          type: "text",
          category: null,
          position: 0,
          nsfw: true,
        },
        {
          id: 2,
          name: "lounge",
          type: "voice",
          category: null,
          position: 1,
          voice_max_users: 5,
          voice_max_video: 2,
        },
      ]);

      const spicy = channelsStore.getState().channels.get(1);
      expect(spicy?.nsfw).toBe(true);
      expect(spicy?.voiceMaxUsers).toBe(0);

      const lounge = channelsStore.getState().channels.get(2);
      expect(lounge?.nsfw).toBe(false);
      expect(lounge?.voiceMaxUsers).toBe(5);
      expect(lounge?.voiceMaxVideo).toBe(2);
    });

    it("defaults to unflagged and unlimited when a server omits the keys", () => {
      setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.nsfw).toBe(false);
      expect(ch?.voiceMaxUsers).toBe(0);
      expect(ch?.voiceMaxVideo).toBe(0);
    });

    it("reads the flags off a channel_create broadcast", () => {
      addChannel({
        id: 9,
        name: "lounge",
        type: "voice",
        category: null,
        position: 0,
        nsfw: true,
        voice_max_users: 4,
        voice_max_video: 1,
      } as ChannelCreatePayload);

      const ch = channelsStore.getState().channels.get(9);
      expect(ch?.nsfw).toBe(true);
      expect(ch?.voiceMaxUsers).toBe(4);
      expect(ch?.voiceMaxVideo).toBe(1);
    });

    it("applies a channel_update that flips the flags", () => {
      setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);

      updateChannel({
        id: 1,
        nsfw: true,
        slow_mode: 30,
        voice_max_users: 7,
        voice_max_video: 3,
      } as ChannelUpdatePayload);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.nsfw).toBe(true);
      expect(ch?.slowMode).toBe(30);
      expect(ch?.voiceMaxUsers).toBe(7);
      expect(ch?.voiceMaxVideo).toBe(3);
    });

    it("clears the flag when a channel_update says false", () => {
      setChannels([
        { id: 1, name: "spicy", type: "text", category: null, position: 0, nsfw: true },
      ]);

      updateChannel({ id: 1, nsfw: false } as ChannelUpdatePayload);

      expect(channelsStore.getState().channels.get(1)?.nsfw).toBe(false);
    });

    // An older server's channel_update carries only name/position. Treating the
    // missing keys as "cleared" would drop the flag on the first rename.
    it("leaves flags alone when a partial update omits them", () => {
      setChannels([
        {
          id: 1,
          name: "spicy",
          type: "text",
          category: null,
          position: 0,
          nsfw: true,
          slow_mode: 15,
          voice_max_users: 6,
        },
      ]);

      updateChannel({ id: 1, name: "spicier" } as ChannelUpdatePayload);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.name).toBe("spicier");
      expect(ch?.nsfw).toBe(true);
      expect(ch?.slowMode).toBe(15);
      expect(ch?.voiceMaxUsers).toBe(6);
    });

    it("moves a channel between categories on a channel_update", () => {
      setChannels([{ id: 1, name: "general", type: "text", category: "Chat", position: 0 }]);

      updateChannel({ id: 1, category: "Hangout" } as ChannelUpdatePayload);

      expect(channelsStore.getState().channels.get(1)?.category).toBe("Hangout");
    });

    // "" is a real value — it is how a channel becomes uncategorized — so it
    // must not be confused with "the server did not send a category".
    it("uncategorizes on an empty-string category", () => {
      setChannels([{ id: 1, name: "general", type: "text", category: "Chat", position: 0 }]);

      updateChannel({ id: 1, category: "" } as ChannelUpdatePayload);

      expect(channelsStore.getState().channels.get(1)?.category).toBe("");
    });

    it("keeps the store immutable across a flag update", () => {
      setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
      const before = channelsStore.getState().channels.get(1);

      updateChannel({ id: 1, nsfw: true } as ChannelUpdatePayload);

      const after = channelsStore.getState().channels.get(1);
      expect(after).not.toBe(before);
      expect(before?.nsfw).toBe(false);
    });
  });
});
