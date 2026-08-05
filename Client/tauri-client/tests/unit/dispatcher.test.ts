import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireDispatcher, wireConnectionStatus } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { channelsStore, setRoles, getRoleIdByName } from "../../src/stores/channels.store";
import {
  messagesStore,
  addOptimisticMessage,
  getChannelMessages,
} from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { voiceStore } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import { blocksStore } from "../../src/stores/blocks.store";
import {
  emojiStore,
  setCustomEmoji,
  clearCustomEmoji,
  listCustomEmoji,
  resolveEmoji,
} from "../../src/stores/emoji.store";
import { uiStore } from "../../src/stores/ui.store";
import {
  clearReactionUsersCache,
  getCachedReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../src/components/message-list/reaction-tooltip";
import type { WsClient, WsListener } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";

// Mock notifications and livekitSession to avoid side effects
vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
}));
vi.mock("@lib/livekitSession", () => ({
  handleVoiceToken: vi.fn(async () => {}),
  handleParticipantLeft: vi.fn(async () => {}),
  handleE2EEAnnounce: vi.fn(async () => {}),
  handleE2EEOffer: vi.fn(async () => {}),
  leaveVoice: vi.fn(),
  cleanupAll: vi.fn(),
  isVoiceConnected: vi.fn(() => false),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
}));
// F3: the ready handler publishes our identity key. Mock the orchestrator so
// the wiring is asserted without real keygen/keyring.
const mockShowToast = vi.fn();
vi.mock("@lib/toast", () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

vi.mock("@lib/identity", () => ({
  ensureIdentityKeyPublished: vi.fn(async () => true),
}));

import { ensureIdentityKeyPublished as _ensureIdentityKeyPublished } from "../../src/lib/identity";
const mockEnsurePublished = vi.mocked(_ensureIdentityKeyPublished);

import { setMuted as mockSetMuted, setDeafened as mockSetDeafened } from "@lib/livekitSession";

// Suppress console output
vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

/**
 * Create a mock WsClient that stores listener registrations
 * and provides a `dispatch` helper to fire events.
 */
function createMockWs() {
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  const sendFailureListeners = new Set<(id: string, code: string) => void>();

  const ws: WsClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => "test-id"),
    on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        listeners.get(type)?.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },
    onStateChange: vi.fn(() => () => {}),
    onSendFailure(listener: (id: string, code: string) => void): () => void {
      sendFailureListeners.add(listener);
      return () => sendFailureListeners.delete(listener);
    },
    startCertListener: vi.fn(async () => {}),
    onCertFirstUse: vi.fn(() => () => {}),
    onCertMismatch: vi.fn(() => () => {}),
    acceptCertFingerprint: vi.fn(async () => {}),
    getState: vi.fn(() => "disconnected" as const),
    isReplaying: vi.fn(() => false),
    _getWs: vi.fn(() => null),
  };

  function dispatch(type: string, payload: unknown, id?: string): void {
    const set = listeners.get(type);
    if (set) {
      for (const listener of set) {
        (listener as (p: unknown, id?: string) => void)(payload, id);
      }
    }
  }

  function dispatchSendFailure(id: string, code: string): void {
    for (const listener of sendFailureListeners) {
      listener(id, code);
    }
  }

  return { ws, dispatch, dispatchSendFailure, listeners };
}

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Reset all stores to initial state
    authStore.setState(() => ({
      token: "test-token",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    channelsStore.setState(() => ({
      channels: new Map(),
      activeChannelId: null,
      roles: [],
    }));
    messagesStore.setState(() => ({
      messagesByChannel: new Map(),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    membersStore.setState(() => ({
      members: new Map(),
      typingUsers: new Map(),
    }));
    voiceStore.setState(() => ({
      currentChannelId: null,
      voiceUsers: new Map(),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    dmStore.setState(() => ({ channels: [] }));
    blocksStore.setState(() => ({ blockedByMe: new Set(), blockedByThem: new Set() }));
    uiStore.setState((prev) => ({ ...prev, transientError: null }));
    clearCustomEmoji();
    emojiStore.flush();

    mock = createMockWs();
    cleanup = wireDispatcher(mock.ws);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("wires auth_ok to auth store", () => {
    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    const state = authStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.username).toBe("alex");
    expect(state.serverName).toBe("TestServer");
  });

  it("wires auth_error to clear auth", () => {
    mock.dispatch("auth_error", { message: "Invalid token" });
    expect(authStore.getState().isAuthenticated).toBe(false);
  });

  it("wires ready to channels, members, and voice stores", () => {
    mock.dispatch("ready", {
      channels: [
        { id: 1, name: "general", type: "text", category: null, position: 0 },
        { id: 2, name: "voice", type: "voice", category: null, position: 1 },
      ],
      members: [{ id: 1, username: "alex", avatar: null, role: "admin", status: "online" }],
      voice_states: [{ channel_id: 2, user_id: 1, muted: false, deafened: false }],
      roles: [],
    });

    expect(channelsStore.getState().channels.size).toBe(2);
    expect(membersStore.getState().members.size).toBe(1);
    expect(voiceStore.getState().voiceUsers.size).toBe(1);
  });

  it("wires chat_message to messages store", () => {
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "Hello world",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toHaveLength(1);
    expect(msgs![0]!.content).toBe("Hello world");
  });

  it("wires chat_message to increment unread for non-active channel", () => {
    // Set up a channel first
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "off-topic",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch, activeChannelId: 1 }; // active is channel 1
    });

    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 5, // different from active
      user: { id: 2, username: "bob", avatar: null },
      content: "ping",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    const ch = channelsStore.getState().channels.get(5);
    expect(ch?.unreadCount).toBe(1);
  });

  describe("mention counts", () => {
    function seedChannel(): void {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(5, {
          id: 5,
          name: "off-topic",
          type: "text" as const,
          category: null,
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
        return { ...prev, channels: ch, activeChannelId: 1 };
      });
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alex", avatar: null, role: "member" },
      }));
    }

    function incoming(extra: Record<string, unknown>): void {
      mock.dispatch("chat_message", {
        id: 200,
        channel_id: 5,
        user: { id: 2, username: "bob", avatar: null },
        content: "ping",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
        ...extra,
      });
    }

    it("increments when the message names the current user", () => {
      seedChannel();
      incoming({ content: "ping @alex", mentions: [1] });
      const ch = channelsStore.getState().channels.get(5);
      expect(ch?.mentionCount).toBe(1);
      expect(ch?.unreadCount).toBe(1);
    });

    it("increments for an honoured @everyone", () => {
      seedChannel();
      incoming({ content: "@everyone", mentions_everyone: true });
      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(1);
    });

    it("does not increment for someone else's mention", () => {
      seedChannel();
      incoming({ content: "ping @bob", mentions: [2] });
      const ch = channelsStore.getState().channels.get(5);
      expect(ch?.mentionCount).toBe(0);
      expect(ch?.unreadCount).toBe(1);
    });

    it("does not increment for an @everyone the sender could not send", () => {
      seedChannel();
      incoming({ content: "@everyone", mentions_everyone: false });
      expect(channelsStore.getState().channels.get(5)?.mentionCount).toBe(0);
    });
  });

  it("wires presence to members store", () => {
    // Add a member first
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("presence", { user_id: 1, status: "idle" });
    expect(membersStore.getState().members.get(1)?.status).toBe("idle");
  });

  it("carries a custom status on presence, and leaves it alone when omitted", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("presence", { user_id: 1, status: "idle", custom_status: "afk" });
    expect(membersStore.getState().members.get(1)?.customStatus).toBe("afk");

    // A bare status flip (what the auto-idle timer sends) must not blank it.
    mock.dispatch("presence", { user_id: 1, status: "online" });
    expect(membersStore.getState().members.get(1)?.customStatus).toBe("afk");

    // An explicit null clears it.
    mock.dispatch("presence", { user_id: 1, status: "online", custom_status: null });
    expect(membersStore.getState().members.get(1)?.customStatus).toBeNull();
  });

  it("wires user_update display_name into the member store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(1, { id: 1, username: "alex", avatar: null, role: "admin", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("user_update", {
      user_id: 1,
      username: "alex",
      avatar: "/api/v1/files/abc",
      display_name: "Alex A.",
      about: "hi",
    });
    const member = membersStore.getState().members.get(1);
    expect(member?.displayName).toBe("Alex A.");
    expect(member?.avatar).toBe("/api/v1/files/abc");
  });

  it("wires typing to members store", () => {
    mock.dispatch("typing", { channel_id: 1, user_id: 42, username: "bob" });
    const typing = membersStore.getState().typingUsers.get(1);
    expect(typing?.has(42)).toBe(true);
  });

  it("wires channel_create to channels store", () => {
    mock.dispatch("channel_create", {
      id: 10,
      name: "new-channel",
      type: "text",
      category: "General",
      position: 5,
    });

    expect(channelsStore.getState().channels.has(10)).toBe(true);
  });

  it("wires channel_delete to channels store", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "doomed",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch };
    });

    mock.dispatch("channel_delete", { id: 10 });
    expect(channelsStore.getState().channels.has(10)).toBe(false);
  });

  it("wires member_join to members store, using the payload's status", () => {
    mock.dispatch("member_join", {
      user: { id: 99, username: "newuser", avatar: null, role: "member" },
      status: "online",
    });
    expect(membersStore.getState().members.get(99)).toMatchObject({ status: "online" });
  });

  it("renders an invisible member_join as offline, not online", () => {
    // The server broadcasts an invisible connector's join as "offline" (the
    // viewer-safe collapse) — the client must render exactly that, not
    // assume a join always means online.
    mock.dispatch("member_join", {
      user: { id: 100, username: "ghost", avatar: null, role: "member" },
      status: "offline",
    });
    expect(membersStore.getState().members.get(100)).toMatchObject({ status: "offline" });
  });

  it("defaults a member_join with no status field to offline, not online", () => {
    // An older server that has not shipped the status field yet must fail
    // safe — omission must never be read as "online".
    mock.dispatch("member_join", {
      user: { id: 101, username: "legacy-server-user", avatar: null, role: "member" },
    });
    expect(membersStore.getState().members.get(101)).toMatchObject({ status: "offline" });
  });

  it("wires chat_send_ok to confirmSend in messages store", () => {
    // Add a pending send (correlationId -> channelId)
    messagesStore.setState((prev) => {
      const pending = new Map(prev.pendingSends);
      pending.set("corr-123", 1);
      return { ...prev, pendingSends: pending };
    });

    expect(messagesStore.getState().pendingSends.has("corr-123")).toBe(true);

    mock.dispatch(
      "chat_send_ok",
      { message_id: 500, timestamp: "2026-03-15T10:00:00Z" },
      "corr-123",
    );

    expect(messagesStore.getState().pendingSends.has("corr-123")).toBe(false);
  });

  it("wires member_ban to remove member from members store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(77, {
        id: 77,
        username: "banned-user",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_ban", { user_id: 77 });
    expect(membersStore.getState().members.has(77)).toBe(false);
  });

  it("wires member_leave to members store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(99, {
        id: 99,
        username: "bye",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_leave", { user_id: 99 });
    expect(membersStore.getState().members.has(99)).toBe(false);
  });

  it("wires voice_state to voice store", () => {
    mock.dispatch("voice_state", {
      channel_id: 2,
      user_id: 1,
      username: "alex",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    const users = voiceStore.getState().voiceUsers.get(2);
    expect(users?.get(1)?.muted).toBe(true);
  });

  it("wires ready with DM channels in payload", () => {
    mock.dispatch("ready", {
      channels: [{ id: 1, name: "general", type: "text", category: null, position: 0 }],
      members: [],
      voice_states: [],
      roles: [{ id: 1, name: "admin", permissions: 0x7fffffff }],
      dm_channels: [
        {
          channel_id: 100,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          last_message_id: 5,
          last_message: "hello",
          last_message_at: "2026-03-15T10:00:00Z",
          unread_count: 2,
        },
      ],
    });

    const dms = dmStore.getState().channels;
    expect(dms).toHaveLength(1);
    expect(dms[0]!.channelId).toBe(100);
    expect(dms[0]!.recipient.username).toBe("bob");
    expect(dms[0]!.unreadCount).toBe(2);
  });

  it("ready auto-selects first text channel when no active channel", () => {
    mock.dispatch("ready", {
      channels: [
        { id: 5, name: "voice-only", type: "voice", category: null, position: 0 },
        { id: 7, name: "general", type: "text", category: null, position: 1 },
      ],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(channelsStore.getState().activeChannelId).toBe(7);
  });

  it("ready does NOT change active channel when one is already set", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      activeChannelId: 99,
    }));

    mock.dispatch("ready", {
      channels: [{ id: 1, name: "general", type: "text", category: null, position: 0 }],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(channelsStore.getState().activeChannelId).toBe(99);
  });

  it("ready with no text channels does not set active", () => {
    mock.dispatch("ready", {
      channels: [{ id: 5, name: "voice-only", type: "voice", category: null, position: 0 }],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("ready with no DM channels in payload skips setDmChannels", () => {
    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(dmStore.getState().channels).toHaveLength(0);
  });

  it("wires chat_edited to messages store", () => {
    // First add a message
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "original",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("chat_edited", {
      message_id: 100,
      channel_id: 1,
      content: "edited content",
      edited_at: "2026-03-15T10:01:00Z",
    });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toBeDefined();
    const edited = msgs!.find((m) => m.id === 100);
    expect(edited?.content).toBe("edited content");
  });

  it("wires chat_deleted to messages store", () => {
    mock.dispatch("chat_message", {
      id: 100,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "doomed",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("chat_deleted", { message_id: 100, channel_id: 1 });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    const found = msgs?.find((m) => m.id === 100);
    expect(found?.deleted).toBe(true);
  });

  it("wires chat_bulk_deleted to messages store", () => {
    for (const id of [100, 101, 102]) {
      mock.dispatch("chat_message", {
        id,
        channel_id: 1,
        user: { id: 1, username: "alex", avatar: null },
        content: `spam ${id}`,
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });
    }

    mock.dispatch("chat_bulk_deleted", { channel_id: 1, ids: [102, 101] });

    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs?.find((m) => m.id === 102)?.deleted).toBe(true);
    expect(msgs?.find((m) => m.id === 101)?.deleted).toBe(true);
    // Tombstones, not removals: the rows and their content survive.
    expect(msgs).toHaveLength(3);
    expect(msgs?.find((m) => m.id === 102)?.content).toBe("spam 102");
    // An id outside the purge is untouched.
    expect(msgs?.find((m) => m.id === 100)?.deleted).toBe(false);
  });

  it("ignores chat_bulk_deleted for an unloaded channel and an empty id list", () => {
    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "keep",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });
    const before = messagesStore.getState().messagesByChannel;

    mock.dispatch("chat_bulk_deleted", { channel_id: 99, ids: [1, 2, 3] });
    mock.dispatch("chat_bulk_deleted", { channel_id: 1, ids: [] });

    // No-op dispatches must not churn the map identity (re-render trigger).
    expect(messagesStore.getState().messagesByChannel).toBe(before);
    expect(messagesStore.getState().messagesByChannel.get(1)?.[0]?.deleted).toBe(false);
  });

  it("wires chat_send_ok without id does not crash", () => {
    expect(() => {
      mock.dispatch("chat_send_ok", { message_id: 500, timestamp: "2026-03-15T10:00:00Z" });
    }).not.toThrow();
  });

  it("wires reaction_update to messages store", () => {
    // Seed current user
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
    }));

    mock.dispatch("chat_message", {
      id: 200,
      channel_id: 1,
      user: { id: 2, username: "bob", avatar: null },
      content: "react to me",
      reply_to: null,
      attachments: [],
      reactions: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("reaction_update", {
      message_id: 200,
      channel_id: 1,
      emoji: "thumbsup",
      user_ids: [1, 2],
      count: 2,
    });

    // Verify it doesn't crash (the actual reaction update is in messages store)
    const msgs = messagesStore.getState().messagesByChannel.get(1);
    expect(msgs).toBeDefined();
  });

  // The who-reacted tooltip caches reactor lists per message+emoji; a
  // reaction_update on that message makes every one of them stale.
  it("invalidates the who-reacted cache for the message a reaction_update names", async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 1, username: "alice", avatar: "" }]);
    setReactionUsersFetcher(fetcher as never);
    clearReactionUsersCache();

    await loadReactionUsers(1, 200, "👍");
    await loadReactionUsers(1, 201, "👍");
    expect(getCachedReactionUsers(200, "👍")).toHaveLength(1);

    mock.dispatch("reaction_update", {
      message_id: 200,
      channel_id: 1,
      emoji: "👍",
      user_id: 2,
      action: "add",
    });

    expect(getCachedReactionUsers(200, "👍")).toBeUndefined();
    // Other messages' caches are untouched.
    expect(getCachedReactionUsers(201, "👍")).toHaveLength(1);
    setReactionUsersFetcher(null);
  });

  it("wires channel_update to channels store", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "old-name",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch };
    });

    mock.dispatch("channel_update", {
      id: 10,
      name: "new-name",
      type: "text",
      category: "General",
      position: 3,
    });

    const ch = channelsStore.getState().channels.get(10);
    expect(ch?.name).toBe("new-name");
  });

  it("wires channel_delete and redirects to first text channel when active is deleted", () => {
    mockShowToast.mockClear();
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
        type: "text" as const,
        category: null,
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
      ch.set(20, {
        id: 20,
        name: "fallback",
        type: "text" as const,
        category: null,
        position: 1,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().channels.has(10)).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBe(20);
    // The redirect must say why it happened (ux/channels-members-dms §1.2).
    expect(mockShowToast).toHaveBeenCalledWith("This channel was deleted", "info");
  });

  it("wires channel_delete without a toast when a non-active channel is deleted", () => {
    mockShowToast.mockClear();
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
        type: "text" as const,
        category: null,
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
      ch.set(20, {
        id: 20,
        name: "background",
        type: "text" as const,
        category: null,
        position: 1,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 20 });

    expect(channelsStore.getState().channels.has(20)).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBe(10);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("wires channel_delete sets active to null when no text channels remain", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "only-ch",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("wires member_update to update role", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(42, {
        id: 42,
        username: "alice",
        avatar: null,
        role: "member",
        status: "online" as const,
      });
      return { ...prev, members: m };
    });

    mock.dispatch("member_update", { user_id: 42, role: "admin" });
    expect(membersStore.getState().members.get(42)?.role).toBe("admin");
  });

  it("wires roles_update to replace the role list", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [
        { id: 1, name: "Owner", color: "#E74C3C", permissions: 0x40000000, position: 100 },
        { id: 9, name: "Contractor", color: "#123456", permissions: 0x3, position: 30 },
      ],
    }));

    // A role was deleted and another recolored server-side. Replacing rather
    // than merging is the point: the deleted role must not survive.
    mock.dispatch("roles_update", {
      roles: [
        { id: 1, name: "Owner", color: "#FF0000", permissions: 0x40000000, position: 100 },
        { id: 4, name: "Member", color: null, permissions: 0x3, position: 40, is_default: true },
      ],
    });

    const roles = channelsStore.getState().roles;
    expect(roles.map((r) => r.id)).toEqual([1, 4]);
    expect(roles[0]?.color).toBe("#FF0000");
    expect(roles.some((r) => r.name === "Contractor")).toBe(false);
  });

  it("makes a role created by roles_update immediately assignable", () => {
    // The Change Role menu resolves a role by name, so a role created in the
    // admin panel has to be resolvable from the broadcast alone — without this
    // assigning a freshly created role needed a reconnect.
    setRoles([{ id: 4, name: "Member", color: null, permissions: 0x3, position: 40 }]);
    expect(getRoleIdByName("contractor")).toBeUndefined();

    mock.dispatch("roles_update", {
      roles: [
        { id: 4, name: "Member", color: null, permissions: 0x3, position: 40, is_default: true },
        { id: 9, name: "Contractor", color: "#123456", permissions: 0x3, position: 30 },
      ],
    });

    expect(getRoleIdByName("contractor")).toBe(9);
  });

  it("treats a roles_update with no roles field as an empty list", () => {
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [{ id: 1, name: "Owner", color: null, permissions: 0 }],
    }));

    mock.dispatch("roles_update", {} as { roles: [] });

    expect(channelsStore.getState().roles).toEqual([]);
  });

  it("wires emoji_update to replace the custom-emoji set", () => {
    setCustomEmoji([
      { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
      { id: 2, shortcode: "gone", url: "/api/v1/emoji/2/image" },
    ]);
    emojiStore.flush();

    // The deleted emoji must not survive the replace — the whole point of
    // sending the set rather than a delta.
    mock.dispatch("emoji_update", {
      emoji: [
        { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
        { id: 3, shortcode: "party", url: "/api/v1/emoji/3/image" },
      ],
    });
    emojiStore.flush();

    expect(listCustomEmoji().map((e) => e.shortcode)).toEqual(["wave", "party"]);
    expect(resolveEmoji("gone")).toBeNull();
    expect(resolveEmoji("party")?.id).toBe(3);
  });

  it("treats an emoji_update with no emoji field as an empty set", () => {
    setCustomEmoji([{ id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();

    mock.dispatch("emoji_update", {} as { emoji: [] });
    emojiStore.flush();

    expect(listCustomEmoji()).toEqual([]);
  });

  it("wires voice_state and auto-joins if current user", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 5,
      username: "me",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  it("wires voice_state does NOT auto-join for other users", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 99,
      username: "other",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("wires voice_leave and clears local voice state if current user kicked", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    // First join voice
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 3,
    }));

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("wires voice_leave does NOT clear local state for other users", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 3,
    }));

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 99,
    });

    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  it("mirrors a moderator mute/deafen into the local flags and honors it", async () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 5,
      username: "me",
      muted: true,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
      server_deafened: true,
    });

    const state = voiceStore.getState();
    expect(state.localServerMuted).toBe(true);
    expect(state.localServerDeafened).toBe(true);

    // Deafen is client-enforced: the session must stop playing remote audio.
    await vi.runAllTimersAsync();
    expect(vi.mocked(mockSetDeafened)).toHaveBeenCalledWith(true);
    expect(vi.mocked(mockSetMuted)).toHaveBeenCalledWith(true);
  });

  it("does not set the local moderator flags from another user's voice_state", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 99,
      username: "other",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });

    expect(voiceStore.getState().localServerMuted).not.toBe(true);
    expect(voiceStore.getState().voiceUsers.get(3)?.get(99)?.serverMuted).toBe(true);
  });

  it("wires voice_moved to a leave + re-join of the destination channel", async () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));

    mock.dispatch("voice_moved", { to_channel_id: 7 });
    await vi.runAllTimersAsync();

    expect(voiceStore.getState().currentChannelId).toBe(7);
    expect(mock.ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_join", payload: { channel_id: 7 } }),
    );
  });

  it("wires voice_disconnected to clearing the local voice session", async () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));

    mock.dispatch("voice_disconnected", { channel_id: 3, reason: "kicked" });
    await vi.runAllTimersAsync();

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("wires voice_config to voice store", () => {
    mock.dispatch("voice_config", {
      channel_id: 3,
      max_bitrate: 128000,
    });

    const configs = voiceStore.getState().voiceConfigs;
    expect(configs.get(3)).toBeDefined();
  });

  it("wires voice_speakers to voice store", () => {
    voiceStore.setState((prev) => {
      const users = new Map(
        [1, 2, 4].map((userId) => [
          userId,
          {
            userId,
            username: `user${userId}`,
            muted: false,
            deafened: false,
            speaking: false,
            camera: false,
            screenshare: false,
          },
        ]),
      );
      const voiceUsers = new Map(prev.voiceUsers);
      voiceUsers.set(3, users);
      return { ...prev, voiceUsers };
    });

    mock.dispatch("voice_speakers", {
      channel_id: 3,
      speakers: [1, 2, 3],
    });

    const users = voiceStore.getState().voiceUsers.get(3);
    expect(users?.get(1)?.speaking).toBe(true);
    expect(users?.get(2)?.speaking).toBe(true);
    expect(users?.get(4)?.speaking).toBe(false);
  });

  it("wires voice_token to handleVoiceToken", async () => {
    const { handleVoiceToken } = await import("@lib/livekitSession");

    mock.dispatch("voice_token", {
      token: "lk-token",
      url: "wss://livekit.example.com",
      channel_id: 3,
      direct_url: "wss://direct.example.com",
    });

    // livekitSession is dynamically imported by the handler, so the call
    // lands after the import promise resolves.
    await vi.waitFor(() => {
      expect(handleVoiceToken).toHaveBeenCalledWith(
        "lk-token",
        "wss://livekit.example.com",
        3,
        "wss://direct.example.com",
        undefined,
      );
    });
  });

  it("wires server_restart to transient error", () => {
    mock.dispatch("server_restart", {
      reason: "update",
      delay_seconds: 10,
    });

    const error = uiStore.getState().transientError;
    expect(error).toContain("Server is restarting");
    expect(error).toContain("update");
  });

  it("wires server_restart with null reason to maintenance", () => {
    mock.dispatch("server_restart", {
      reason: null,
      delay_seconds: 5,
    });

    const error = uiStore.getState().transientError;
    expect(error).toContain("maintenance");
  });

  it("wires server_restart shutdown to sign-out and call-state reset", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "call-user", avatar: null, role: "member" },
    }));
    // Simulate a live call with webcam and screenshare on.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 42,
      voiceStatus: "connected",
      localCamera: true,
      localScreenshare: true,
    }));

    mock.dispatch("server_restart", { reason: "shutdown", delay_seconds: 5 });

    // Kicked back to login: auth cleared, reason preserved so the logout
    // wiring keeps the saved credential.
    expect(authStore.getState().isAuthenticated).toBe(false);
    expect(authStore.getState().logoutReason).toBe("server_shutdown");
    expect(uiStore.getState().transientError).toContain("shut down");

    // Call settings reset to their normal state.
    const voice = voiceStore.getState();
    expect(voice.currentChannelId).toBeNull();
    expect(voice.voiceStatus).toBe("idle");
    expect(voice.localCamera).toBe(false);
    expect(voice.localScreenshare).toBe(false);
  });

  it("keeps the session for non-shutdown server_restart reasons", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "stay-user", avatar: null, role: "member" },
    }));

    mock.dispatch("server_restart", { reason: "update", delay_seconds: 5 });

    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("wires error BANNED to clear auth and show error", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "banned-user", avatar: null, role: "member" },
    }));

    mock.dispatch("error", {
      code: "BANNED",
      message: "You have been banned from this server",
    });

    expect(authStore.getState().isAuthenticated).toBe(false);
    const error = uiStore.getState().transientError;
    expect(error).toContain("banned");
  });

  it("wires error BANNED with empty message uses default", () => {
    mock.dispatch("error", { code: "BANNED", message: "" });
    const error = uiStore.getState().transientError;
    expect(error).toBe("You have been banned");
  });

  it("wires error RATE_LIMITED to transient error", () => {
    mock.dispatch("error", {
      code: "RATE_LIMITED",
      message: "Too many requests",
    });

    const error = uiStore.getState().transientError;
    expect(error).toBe("Too many requests");
  });

  it("wires error FORBIDDEN to transient error", () => {
    mock.dispatch("error", {
      code: "FORBIDDEN",
      message: "Insufficient permissions",
    });

    const error = uiStore.getState().transientError;
    expect(error).toBe("Insufficient permissions");
  });

  it("wires error RATE_LIMITED with empty message uses default", () => {
    mock.dispatch("error", { code: "RATE_LIMITED", message: "" });
    const error = uiStore.getState().transientError;
    expect(error).toBe("Server error");
  });

  it("wires error with unknown code does not set transient error", () => {
    // Clear any previous errors
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    mock.dispatch("error", {
      code: "UNKNOWN",
      message: "Something odd",
    });

    expect(uiStore.getState().transientError).toBeNull();
  });

  it("wires an error carrying a pending send id to mark that row failed (not a toast)", () => {
    messagesStore.setState(() => ({
      messagesByChannel: new Map(),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map(),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    addOptimisticMessage({
      correlationId: "corr-1",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // Error echoes the request id → the specific row is marked failed…
    mock.dispatch("error", { code: "SLOW_MODE", message: "slow down" }, "corr-1");

    const row = getChannelMessages(7)[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("SLOW_MODE");
    // …and it is not surfaced as a global transient error.
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("gates the DM composer (blockedByThem) when a DM send is refused with FORBIDDEN", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 7,
          recipient: { id: 5, username: "alice", avatar: "", status: "online" },
          participants: [],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    addOptimisticMessage({
      correlationId: "corr-dm",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "blocked" }, "corr-dm");

    expect(blocksStore.getState().blockedByThem.has(5)).toBe(true);
    // Still marks the row failed (existing behaviour preserved).
    expect(getChannelMessages(7)[0]!.status).toBe("failed");
  });

  it("does not gate on a FORBIDDEN send outside a DM channel", () => {
    // channel 7 is not in dmStore → no block state is inferred.
    addOptimisticMessage({
      correlationId: "corr-nondm",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "nope" }, "corr-nondm");

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
  });

  it("on ready publishes the client's identity key when the server copy is stale", async () => {
    cleanup(); // tear down the no-api dispatcher wired in beforeEach
    mockEnsurePublished.mockClear();
    const updateProfile = vi.fn().mockResolvedValue({});
    const getConfig = vi.fn(() => ({
      host: "chat.example",
      token: "[redacted]" as string | undefined,
    }));
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    cleanup = wireDispatcher(mock.ws, { listBlocks, updateProfile, getConfig });

    // We are user 7, "alex"; the server holds no identity key for us yet.
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 7, username: "alex", avatar: null, role: "member" },
    }));

    mock.dispatch("ready", {
      channels: [],
      members: [
        {
          id: 7,
          username: "alex",
          avatar: null,
          role: "member",
          status: "online",
          identity_public_key: null,
        },
      ],
      voice_states: [],
      roles: [],
    });

    await Promise.resolve();
    expect(mockEnsurePublished).toHaveBeenCalledWith(
      "chat.example",
      "alex",
      null,
      expect.any(Function),
    );
    // The publish closure must route through api.updateProfile (server requires
    // the username, injected by the orchestrator's caller).
    const closure = mockEnsurePublished.mock.calls[0]![3] as (d: {
      identity_public_key: string;
    }) => Promise<unknown>;
    await closure({ identity_public_key: "k" });
    expect(updateProfile).toHaveBeenCalledWith({ identity_public_key: "k" });
  });

  it("on ready loads the custom-emoji set from the REST list", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listEmoji = vi
      .fn()
      .mockResolvedValue([{ id: 4, shortcode: "wave", url: "/api/v1/emoji/4/image" }]);
    cleanup = wireDispatcher(mock.ws, { listBlocks, listEmoji });

    mock.dispatch("ready", { channels: [], members: [], voice_states: [], roles: [] });

    expect(listEmoji).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    emojiStore.flush();
    expect(resolveEmoji("wave")?.id).toBe(4);
  });

  it("survives a failed emoji load — shortcodes just stay plain text", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listEmoji = vi.fn().mockRejectedValue(new Error("offline"));
    cleanup = wireDispatcher(mock.ws, { listBlocks, listEmoji });

    mock.dispatch("ready", { channels: [], members: [], voice_states: [], roles: [] });
    await Promise.resolve();
    await Promise.resolve();
    emojiStore.flush();
    expect(listCustomEmoji()).toEqual([]);
  });

  it("on ready clears being-blocked state and refreshes blocked-by-me via api", async () => {
    cleanup(); // tear down the no-api dispatcher wired in beforeEach
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [11, 22] });
    cleanup = wireDispatcher(mock.ws, { listBlocks });

    // Pre-seed a stale being-blocked entry that a fresh ready must clear.
    blocksStore.setState(() => ({ blockedByMe: new Set(), blockedByThem: new Set([5]) }));

    mock.dispatch("ready", { channels: [], members: [], voice_states: [], roles: [] });

    expect(blocksStore.getState().blockedByThem.size).toBe(0);
    expect(listBlocks).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect([...blocksStore.getState().blockedByMe]).toEqual([11, 22]);
  });

  it("wires a local transport send failure to mark the pending row failed", () => {
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    addOptimisticMessage({
      correlationId: "corr-2",
      channelId: 7,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // ws_send rejected locally (outbound channel full) → the row fails with retry…
    mock.dispatchSendFailure("corr-2", "NETWORK");

    const row = getChannelMessages(7)[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("NETWORK");
    // …and no global transient error is raised.
    expect(uiStore.getState().transientError).toBeNull();
  });

  it("ignores a transport send failure for an id with no pending send (fire-and-forget)", () => {
    const before = messagesStore.getState();

    mock.dispatchSendFailure("typing-id", "NETWORK");

    // No store mutation: fire-and-forget sends (typing, presence…) stay silent.
    expect(messagesStore.getState()).toBe(before);
  });

  it("does not increment unread for own messages", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
    }));

    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "other-ch",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    mock.dispatch("chat_message", {
      id: 300,
      channel_id: 5,
      user: { id: 1, username: "alex", avatar: null },
      content: "my own message",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(0);
  });

  it("does not increment unread during replay", () => {
    (mock.ws.isReplaying as ReturnType<typeof vi.fn>).mockReturnValue(true);

    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(5, {
        id: 5,
        name: "other-ch",
        type: "text" as const,
        category: null,
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
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    mock.dispatch("chat_message", {
      id: 300,
      channel_id: 5,
      user: { id: 2, username: "bob", avatar: null },
      content: "replayed message",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(0);

    (mock.ws.isReplaying as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  describe("chat_message DM store updates", () => {
    const dmChannel = {
      channelId: 50,
      recipient: { id: 10, username: "bob", avatar: "", status: "online" as const },
      participants: [],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };

    beforeEach(() => {
      dmStore.setState(() => ({ channels: [{ ...dmChannel }] }));
    });

    it("updates DM last message with unread for non-active, non-own message", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 500,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey there",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("hey there");
      expect(dm?.unreadCount).toBe(1);
    });

    it("updates DM preview (no unread) for own message", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 501,
        channel_id: 50,
        user: { id: 5, username: "me", avatar: null },
        content: "my DM reply",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("my DM reply");
      expect(dm?.unreadCount).toBe(0);
    });

    it("updates DM preview (no unread) when DM channel is active", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 502,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "active DM msg",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("active DM msg");
      expect(dm?.unreadCount).toBe(0);
    });

    it("updates DM preview (no unread) during replay", () => {
      (mock.ws.isReplaying as ReturnType<typeof vi.fn>).mockReturnValue(true);

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 503,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "replayed DM",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dms = dmStore.getState().channels;
      const dm = dms.find((c) => c.channelId === 50);
      expect(dm?.lastMessage).toBe("replayed DM");
      expect(dm?.unreadCount).toBe(0);

      (mock.ws.isReplaying as ReturnType<typeof vi.fn>).mockReturnValue(false);
    });
  });

  // ── DM events ─────────────────────────────────────────

  describe("DM events", () => {
    it("should call addDmChannel on dm_channel_open", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 50,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const channels = dmStore.getState().channels;
      expect(channels).toHaveLength(1);
      expect(channels[0]!.channelId).toBe(50);
      expect(channels[0]!.recipient.username).toBe("bob");
    });

    // A pre-group server sends only `recipient`, which for it IS the whole
    // membership — so the fallback has to be a one-element list, not an empty
    // one, or every group-aware call site breaks against an old server.
    it("treats a recipient-only payload as a one-person participant list", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 50,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const dm = dmStore.getState().channels[0]!;
      expect(dm.participants).toHaveLength(1);
      expect(dm.participants[0]!.id).toBe(10);
      expect(dm.isGroup).toBe(false);
      expect(dm.name).toBe("");
    });

    it("maps a group dm_channel_open with its full participant list", () => {
      mock.dispatch("dm_channel_open", {
        channel_id: 51,
        recipient: { id: 10, username: "bob", avatar: "", status: "online" },
        recipients: [
          { id: 10, username: "bob", avatar: "", status: "online", display_name: "Bobby" },
          { id: 11, username: "cat", avatar: "", status: "idle" },
        ],
        name: "Crew",
        is_group: true,
        last_message_id: null,
        last_message: "",
        last_message_at: "",
        unread_count: 0,
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 51)!;
      expect(dm.isGroup).toBe(true);
      expect(dm.name).toBe("Crew");
      expect(dm.participants.map((p) => p.id)).toEqual([10, 11]);
      expect(dm.participants[0]!.displayName).toBe("Bobby");
      // The compat recipient is the first of the list, so an older render path
      // still shows somebody rather than nothing.
      expect(dm.recipient.id).toBe(10);
    });

    it("should call removeDmChannel on dm_channel_close", () => {
      // Seed a DM channel first
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });
      expect(dmStore.getState().channels).toHaveLength(0);
    });
  });

  it("auth_ok with null token uses empty string fallback", () => {
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("ready with undefined roles uses empty array fallback", () => {
    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      // roles is intentionally undefined
    });

    // Should not crash, roles should be empty
    expect(channelsStore.getState().roles).toEqual([]);
  });

  it("reaction_update with no user in auth uses 0 as fallback", () => {
    authStore.setState(() => ({
      token: "t",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));

    // Just dispatch without crashing
    expect(() => {
      mock.dispatch("reaction_update", {
        message_id: 200,
        channel_id: 1,
        emoji: "thumbsup",
        user_ids: [1],
        count: 1,
      });
    }).not.toThrow();
  });

  it("voice_leave with no user in auth uses 0 as fallback userId", () => {
    authStore.setState(() => ({
      token: "t",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));

    expect(() => {
      mock.dispatch("voice_leave", {
        channel_id: 3,
        user_id: 99,
      });
    }).not.toThrow();
  });

  it("ready sends voice_leave when user appears in voice_states but LiveKit is disconnected", () => {
    // A fresh reload always starts with an idle voice session — the stale case.
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "idle" }));

    // Set up auth so the current user ID is 42
    authStore.setState(() => ({
      token: "test-token",
      user: { id: 42, username: "ghost", avatar: null, role: "member" },
      serverName: "Test",
      motd: "",
      isAuthenticated: true,
    }));

    mock.dispatch("ready", {
      channels: [{ id: 1, name: "general", type: "text", category: "", position: 0 }],
      members: [],
      voice_states: [{ user_id: 42, channel_id: 10, muted: false, deafened: false }],
      roles: [],
      dm_channels: [],
    });

    // The dispatcher should detect stale voice state and send voice_leave
    expect(mock.ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_leave", payload: {} }),
    );
    // And clear the local voice channel
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("ready does NOT send voice_leave when LiveKit IS connected", () => {
    // A non-idle voice status means livekitSession is driving a live/pending
    // session (the lazily-loaded module's store-backed "connected" flag).
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));

    authStore.setState(() => ({
      token: "test-token",
      user: { id: 42, username: "active", avatar: null, role: "member" },
      serverName: "Test",
      motd: "",
      isAuthenticated: true,
    }));

    mock.dispatch("ready", {
      channels: [{ id: 1, name: "general", type: "text", category: "", position: 0 }],
      members: [],
      voice_states: [{ user_id: 42, channel_id: 10, muted: false, deafened: false }],
      roles: [],
      dm_channels: [],
    });

    // voice_leave should NOT be sent — the LiveKit room is active
    const sendCalls = (mock.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const voiceLeaveSent = sendCalls.some(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.type === "voice_leave",
    );
    expect(voiceLeaveSent).toBe(false);
  });

  it("ready does NOT send voice_leave when user is NOT in voice_states", () => {
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "idle" }));

    authStore.setState(() => ({
      token: "test-token",
      user: { id: 42, username: "notinvoice", avatar: null, role: "member" },
      serverName: "Test",
      motd: "",
      isAuthenticated: true,
    }));

    mock.dispatch("ready", {
      channels: [{ id: 1, name: "general", type: "text", category: "", position: 0 }],
      members: [],
      voice_states: [{ user_id: 99, channel_id: 10, muted: false, deafened: false }],
      roles: [],
      dm_channels: [],
    });

    // voice_leave should NOT be sent — user 42 is not in voice_states
    const sendCalls = (mock.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const voiceLeaveSent = sendCalls.some(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.type === "voice_leave",
    );
    expect(voiceLeaveSent).toBe(false);
  });

  it("unknown event type does not throw", () => {
    expect(() => {
      mock.dispatch("totally_unknown_server_event", { some: "data" });
    }).not.toThrow();
  });

  it("cleanup removes all listeners", () => {
    cleanup();

    // After cleanup, dispatching should not affect stores
    mock.dispatch("chat_message", {
      id: 999,
      channel_id: 1,
      user: { id: 1, username: "ghost", avatar: null },
      content: "should not appear",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T12:00:00Z",
    });

    expect(messagesStore.getState().messagesByChannel.get(1)).toBeUndefined();
  });

  // ─── Voice capacity refusals ────────────────────────────────────────────
  //
  // The server owns voice_max_users / voice_max_video and answers an over-limit
  // join with CHANNEL_FULL (or an over-limit camera with VIDEO_LIMIT). The
  // client deliberately does not pre-block the click — its participant list can
  // lag, and a refusal it invented would be uncorrectable — so the only thing
  // standing between the user and a silent no-op is this toast.

  describe("voice capacity errors", () => {
    beforeEach(() => {
      mockShowToast.mockClear();
    });

    it("surfaces CHANNEL_FULL as a toast", () => {
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "voice channel is full" });
      expect(mockShowToast).toHaveBeenCalledWith("voice channel is full", "error");
    });

    it("falls back to a readable message when the server sends none", () => {
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "" });
      expect(mockShowToast).toHaveBeenCalledWith("That voice channel is full", "error");
    });

    it("surfaces VIDEO_LIMIT as a toast", () => {
      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" });
      expect(mockShowToast).toHaveBeenCalledWith(
        "That voice channel has reached its video limit",
        "error",
      );
    });

    // A capacity refusal is about the voice channel, not about the composer,
    // so it must not also land in the login screen's transient-error slot.
    it("does not set the transient error", () => {
      uiStore.setState((prev) => ({ ...prev, transientError: null }));
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });
      expect(uiStore.getState().transientError).toBeNull();
    });
  });
});

describe("wireConnectionStatus", () => {
  beforeEach(() => {
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
  });

  it("writes ws state changes into ui.store.connectionStatus via the 5→3 mapping", () => {
    const mockWs = createMockWsClient();
    const unsub = wireConnectionStatus(mockWs);

    mockWs.simulateStateChange("connecting");
    expect(uiStore.getState().connectionStatus).toBe("reconnecting");

    mockWs.simulateStateChange("authenticating");
    expect(uiStore.getState().connectionStatus).toBe("reconnecting");

    mockWs.simulateStateChange("connected");
    expect(uiStore.getState().connectionStatus).toBe("connected");

    mockWs.simulateStateChange("disconnected");
    expect(uiStore.getState().connectionStatus).toBe("disconnected");

    unsub();
    mockWs.simulateStateChange("connected");
    expect(uiStore.getState().connectionStatus).toBe("disconnected");
  });
});
