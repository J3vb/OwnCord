import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  selectDmConversation,
  addDmToChannelsStore,
  handleCreateDm,
  buildDmConversations,
  type DmHelperDeps,
} from "../../src/pages/main-page/SidebarDmHelpers";
import { channelsStore, setActiveChannel } from "../../src/stores/channels.store";
import { dmStore, addDmChannel } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import { uiStore } from "../../src/stores/ui.store";
import type { DmChannel } from "../../src/stores/dm.store";

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

function resetStores(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  dmStore.setState(() => ({ channels: [] }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    transientError: null,
    persistentError: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
  }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDmChannel(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 100,
    recipient: {
      id: 10,
      username: "Alice",
      avatar: "",
      status: "online",
    },
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DmHelperDeps> = {}): DmHelperDeps {
  return {
    api: {
      createDm: vi.fn().mockResolvedValue({
        channel_id: 200,
        recipient: { id: 20, username: "Bob", avatar: "", status: "online" },
      }),
    } as unknown as DmHelperDeps["api"],
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
    getChannelBeforeDm: vi.fn().mockReturnValue(null),
    setChannelBeforeDm: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarDmHelpers", () => {
  beforeEach(() => {
    resetStores();
  });

  // -------------------------------------------------------------------------
  // addDmToChannelsStore
  // -------------------------------------------------------------------------

  describe("addDmToChannelsStore", () => {
    it("adds a DM channel to channelsStore when it does not exist", () => {
      const dm = makeDmChannel({ channelId: 100, unreadCount: 3 });
      addDmToChannelsStore(dm);

      const ch = channelsStore.getState().channels.get(100);
      expect(ch).toBeDefined();
      expect(ch!.id).toBe(100);
      expect(ch!.name).toBe("Alice");
      expect(ch!.type).toBe("dm");
      expect(ch!.category).toBeNull();
      expect(ch!.position).toBe(0);
      expect(ch!.unreadCount).toBe(3);
    });

    it("does not overwrite an existing channel with a non-empty name", () => {
      // Pre-populate with a channel that already has a name
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(100, {
          id: 100,
          name: "ExistingName",
          type: "dm",
          category: null,
          position: 0,
          unreadCount: 0,
          lastMessageId: null,
        });
        return { ...prev, channels: next };
      });

      const dm = makeDmChannel({ channelId: 100 });
      addDmToChannelsStore(dm);

      // Name should remain unchanged
      const ch = channelsStore.getState().channels.get(100);
      expect(ch!.name).toBe("ExistingName");
    });

    it("overwrites an existing channel with an empty name", () => {
      // Pre-populate with a channel that has an empty name (server sends DMs with name='')
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(100, {
          id: 100,
          name: "",
          type: "dm",
          category: null,
          position: 0,
          unreadCount: 0,
          lastMessageId: null,
        });
        return { ...prev, channels: next };
      });

      const dm = makeDmChannel({ channelId: 100 });
      addDmToChannelsStore(dm);

      // Name should be updated to recipient username
      const ch = channelsStore.getState().channels.get(100);
      expect(ch!.name).toBe("Alice");
    });
  });

  // -------------------------------------------------------------------------
  // selectDmConversation
  // -------------------------------------------------------------------------

  describe("selectDmConversation", () => {
    it("saves current non-DM channel before switching", () => {
      // Set a text channel as active
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, {
          id: 1,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          unreadCount: 0,
          lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 1 };
      });

      const deps = makeDeps();
      const dm = makeDmChannel();
      selectDmConversation(dm, deps);

      expect(deps.setChannelBeforeDm).toHaveBeenCalledWith(1);
    });

    it("does not save channel if current channel is a DM", () => {
      // Set a DM channel as active
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(50, {
          id: 50,
          name: "OtherDm",
          type: "dm",
          category: null,
          position: 0,
          unreadCount: 0,
          lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 50 };
      });

      const deps = makeDeps();
      const dm = makeDmChannel();
      selectDmConversation(dm, deps);

      expect(deps.setChannelBeforeDm).not.toHaveBeenCalled();
    });

    it("does not save channel when no active channel", () => {
      const deps = makeDeps();
      const dm = makeDmChannel();
      selectDmConversation(dm, deps);

      expect(deps.setChannelBeforeDm).not.toHaveBeenCalled();
    });

    it("sets activeDmUserId in UI store", () => {
      const deps = makeDeps();
      const dm = makeDmChannel({
        recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
      });
      selectDmConversation(dm, deps);

      expect(uiStore.getState().activeDmUserId).toBe(10);
    });

    it("switches sidebar mode to dms", () => {
      const deps = makeDeps();
      const dm = makeDmChannel();
      selectDmConversation(dm, deps);

      expect(uiStore.getState().sidebarMode).toBe("dms");
    });

    it("clears DM unread count", () => {
      // Add a DM channel with unreads
      addDmChannel(makeDmChannel({ channelId: 100, unreadCount: 5 }));

      const deps = makeDeps();
      selectDmConversation(makeDmChannel({ channelId: 100, unreadCount: 5 }), deps);

      const dmChannels = dmStore.getState().channels;
      const dm = dmChannels.find((c) => c.channelId === 100);
      expect(dm!.unreadCount).toBe(0);
    });

    it("adds DM channel to channelsStore and sets it as active", () => {
      const deps = makeDeps();
      const dm = makeDmChannel({ channelId: 100 });
      selectDmConversation(dm, deps);

      const ch = channelsStore.getState().channels.get(100);
      expect(ch).toBeDefined();
      expect(channelsStore.getState().activeChannelId).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // handleCreateDm
  // -------------------------------------------------------------------------

  describe("handleCreateDm", () => {
    it("creates a DM via API and switches to it", async () => {
      const deps = makeDeps();
      await handleCreateDm(20, deps);

      expect(deps.api.createDm).toHaveBeenCalledWith(20);

      // Should have added to DM store
      const dmChannels = dmStore.getState().channels;
      expect(dmChannels.length).toBe(1);
      expect(dmChannels[0]!.channelId).toBe(200);
      expect(dmChannels[0]!.recipient.username).toBe("Bob");

      // Should have switched sidebar mode to dms
      expect(uiStore.getState().sidebarMode).toBe("dms");
    });

    it("uses member store status as fallback when API returns no status", async () => {
      // Add a member with a known status
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [20, { id: 20, username: "Bob", avatar: null, role: "member", status: "idle" as const }],
        ]),
      }));

      const mockApi = {
        createDm: vi.fn().mockResolvedValue({
          channel_id: 200,
          recipient: { id: 20, username: "Bob", avatar: "", status: undefined },
        }),
      };
      const deps = makeDeps({ api: mockApi as unknown as DmHelperDeps["api"] });

      await handleCreateDm(20, deps);

      const dmChannels = dmStore.getState().channels;
      expect(dmChannels[0]!.recipient.status).toBe("idle");
    });

    it("falls back to 'offline' when neither API nor member store has status", async () => {
      const mockApi = {
        createDm: vi.fn().mockResolvedValue({
          channel_id: 200,
          recipient: { id: 999, username: "Unknown", avatar: "", status: undefined },
        }),
      };
      const deps = makeDeps({ api: mockApi as unknown as DmHelperDeps["api"] });

      await handleCreateDm(999, deps);

      const dmChannels = dmStore.getState().channels;
      expect(dmChannels[0]!.recipient.status).toBe("offline");
    });

    it("shows error toast on API failure", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        createDm: vi.fn().mockRejectedValue(new Error("Network error")),
      };
      const deps = makeDeps({
        api: mockApi as unknown as DmHelperDeps["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      });

      await handleCreateDm(20, deps);

      expect(mockShow).toHaveBeenCalledWith("Network error", "error");
    });

    it("shows generic error toast for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        createDm: vi.fn().mockRejectedValue("string error"),
      };
      const deps = makeDeps({
        api: mockApi as unknown as DmHelperDeps["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      });

      await handleCreateDm(20, deps);

      expect(mockShow).toHaveBeenCalledWith("Failed to create DM", "error");
    });

    it("handles null toast gracefully on error", async () => {
      const mockApi = {
        createDm: vi.fn().mockRejectedValue(new Error("fail")),
      };
      const deps = makeDeps({
        api: mockApi as unknown as DmHelperDeps["api"],
        getToast: vi.fn().mockReturnValue(null),
      });

      // Should not throw
      await handleCreateDm(20, deps);
    });
  });

  // -------------------------------------------------------------------------
  // buildDmConversations
  // -------------------------------------------------------------------------

  describe("buildDmConversations", () => {
    it("returns empty array when no DM channels exist", () => {
      const result = buildDmConversations(null);
      expect(result).toEqual([]);
    });

    it("maps DM channels to DmConversation objects", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "alice.png", status: "online" },
          lastMessage: "Hello!",
          lastMessageAt: "2025-01-01T00:00:00Z",
          unreadCount: 3,
        }),
      );

      const result = buildDmConversations(null);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        userId: 10,
        username: "Alice",
        avatar: "alice.png",
        status: "online",
        lastMessage: "Hello!",
        timestamp: "2025-01-01T00:00:00Z",
        unread: true,
        active: false,
      });
    });

    it("marks conversation as active when userId matches activeDmUserId", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
        }),
      );

      const result = buildDmConversations(10);
      expect(result[0]!.active).toBe(true);
    });

    it("does not mark conversation as active when userId does not match", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
        }),
      );

      const result = buildDmConversations(999);
      expect(result[0]!.active).toBe(false);
    });

    it("uses 'No messages yet' when lastMessage is empty", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          lastMessage: "",
        }),
      );

      const result = buildDmConversations(null);
      expect(result[0]!.lastMessage).toBe("No messages yet");
    });

    it("sets unread to false when unreadCount is 0", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          unreadCount: 0,
        }),
      );

      const result = buildDmConversations(null);
      expect(result[0]!.unread).toBe(false);
    });

    it("uses avatar null when avatar is empty string", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
        }),
      );

      const result = buildDmConversations(null);
      expect(result[0]!.avatar).toBeNull();
    });

    it("defaults status to 'offline' when status is undefined", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: {
            id: 10,
            username: "Alice",
            avatar: "",
            status: undefined as unknown as string,
          },
        }),
      );

      const result = buildDmConversations(null);
      expect(result[0]!.status).toBe("offline");
    });

    it("handles multiple DM channels", () => {
      addDmChannel(
        makeDmChannel({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
        }),
      );
      addDmChannel(
        makeDmChannel({
          channelId: 101,
          recipient: { id: 11, username: "Bob", avatar: "", status: "idle" },
        }),
      );

      const result = buildDmConversations(11);
      expect(result).toHaveLength(2);
      // Bob was added second so goes first (addDmChannel prepends)
      const bob = result.find((c) => c.username === "Bob");
      const alice = result.find((c) => c.username === "Alice");
      expect(bob!.active).toBe(true);
      expect(alice!.active).toBe(false);
    });
  });
});
