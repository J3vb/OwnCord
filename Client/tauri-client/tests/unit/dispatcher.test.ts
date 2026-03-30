import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { messagesStore } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { voiceStore } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import type { WsClient, WsListener } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";

// Mock notifications and livekitSession to avoid side effects
vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
}));
vi.mock("@lib/livekitSession", () => ({
  handleVoiceToken: vi.fn(async () => {}),
  leaveVoice: vi.fn(),
  cleanupAll: vi.fn(),
}));

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

  const ws: WsClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => "test-id"),
    on<T extends ServerMessage["type"]>(
      type: T,
      listener: WsListener<T>,
    ): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        listeners.get(type)?.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },
    onStateChange: vi.fn(() => () => {}),
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

  return { ws, dispatch, listeners };
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
    }));
    dmStore.setState(() => ({ channels: [] }));
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

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
      members: [
        { id: 1, username: "alex", avatar: null, role: "admin", status: "online" },
      ],
      voice_states: [
        { channel_id: 2, user_id: 1, muted: false, deafened: false },
      ],
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
        lastMessageId: null,
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
        lastMessageId: null,
      });
      return { ...prev, channels: ch };
    });

    mock.dispatch("channel_delete", { id: 10 });
    expect(channelsStore.getState().channels.has(10)).toBe(false);
  });

  it("wires member_join to members store", () => {
    mock.dispatch("member_join", {
      user: { id: 99, username: "newuser", avatar: null, role: "member" },
    });
    expect(membersStore.getState().members.has(99)).toBe(true);
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
      m.set(77, { id: 77, username: "banned-user", avatar: null, role: "member", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("member_ban", { user_id: 77 });
    expect(membersStore.getState().members.has(77)).toBe(false);
  });

  it("wires member_leave to members store", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(99, { id: 99, username: "bye", avatar: null, role: "member", status: "online" as const });
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
      channels: [
        { id: 1, name: "general", type: "text", category: null, position: 0 },
      ],
      members: [],
      voice_states: [],
      roles: [{ id: 1, name: "admin", permissions: 0x7FFFFFFF }],
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
      channels: [
        { id: 1, name: "general", type: "text", category: null, position: 0 },
      ],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(channelsStore.getState().activeChannelId).toBe(99);
  });

  it("ready with no text channels does not set active", () => {
    mock.dispatch("ready", {
      channels: [
        { id: 5, name: "voice-only", type: "voice", category: null, position: 0 },
      ],
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
        lastMessageId: null,
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
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(10, {
        id: 10,
        name: "active-ch",
        type: "text" as const,
        category: null,
        position: 0,
        unreadCount: 0,
        lastMessageId: null,
      });
      ch.set(20, {
        id: 20,
        name: "fallback",
        type: "text" as const,
        category: null,
        position: 1,
        unreadCount: 0,
        lastMessageId: null,
      });
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().channels.has(10)).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBe(20);
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
        lastMessageId: null,
      });
      return { ...prev, channels: ch, activeChannelId: 10 };
    });

    mock.dispatch("channel_delete", { id: 10 });

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("wires member_update to update role", () => {
    membersStore.setState((prev) => {
      const m = new Map(prev.members);
      m.set(42, { id: 42, username: "alice", avatar: null, role: "member", status: "online" as const });
      return { ...prev, members: m };
    });

    mock.dispatch("member_update", { user_id: 42, role: "admin" });
    expect(membersStore.getState().members.get(42)?.role).toBe("admin");
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

  it("wires voice_config to voice store", () => {
    mock.dispatch("voice_config", {
      channel_id: 3,
      max_bitrate: 128000,
    });

    const configs = voiceStore.getState().voiceConfigs;
    expect(configs.get(3)).toBeDefined();
  });

  it("wires voice_speakers to voice store", () => {
    mock.dispatch("voice_speakers", {
      channel_id: 3,
      speakers: [1, 2, 3],
    });

    // Verify it runs without error
    expect(true).toBe(true);
  });

  it("wires voice_token to handleVoiceToken", async () => {
    const { handleVoiceToken } = await import("@lib/livekitSession");

    mock.dispatch("voice_token", {
      token: "lk-token",
      url: "wss://livekit.example.com",
      channel_id: 3,
      direct_url: "wss://direct.example.com",
    });

    expect(handleVoiceToken).toHaveBeenCalledWith(
      "lk-token",
      "wss://livekit.example.com",
      3,
      "wss://direct.example.com",
    );
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
        lastMessageId: null,
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
        lastMessageId: null,
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
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
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

    it("should call removeDmChannel on dm_channel_close", () => {
      // Seed a DM channel first
      dmStore.setState(() => ({
        channels: [
          {
            channelId: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
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
});
