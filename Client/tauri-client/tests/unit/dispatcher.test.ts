import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { messagesStore } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { voiceStore } from "../../src/stores/voice.store";
import type { WsClient, WsListener } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";

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
    }));

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
