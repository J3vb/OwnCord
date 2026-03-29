/**
 * Integration tests — Store hydration via dispatcher.
 * Verifies that WS events, routed through wireDispatcher, correctly
 * update all domain stores (channels, members, messages, voice).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WsClient, WsListener, ConnectionState } from "@lib/ws";
import type { ServerMessage } from "@lib/types";
import { wireDispatcher } from "@lib/dispatcher";

// ── Stores ──────────────────────────────────────────────────────────
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { messagesStore, addPendingSend, addMessage } from "@stores/messages.store";
import { voiceStore } from "@stores/voice.store";
import { authStore, setAuth } from "@stores/auth.store";

// ── Mock WsClient ───────────────────────────────────────────────────

interface MockWsClient extends WsClient {
  /** Fire a server event into all registered handlers. */
  simulate(type: string, payload: unknown, id?: string): void;
  /** All messages passed to send(). */
  readonly sent: Array<{ type: string; payload: unknown }>;
}

function createMockWsClient(): MockWsClient {
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const sent: Array<{ type: string; payload: unknown }> = [];
  let currentState: ConnectionState = "connected";

  return {
    connect() {
      // no-op
    },

    disconnect() {
      // no-op
    },

    send(msg) {
      sent.push(msg as { type: string; payload: unknown });
      return crypto.randomUUID();
    },

    on<T extends ServerMessage["type"]>(
      type: T,
      listener: WsListener<T>,
    ): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const set = listeners.get(type)!;
      const wrapped = listener as unknown as WsListener<ServerMessage["type"]>;
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },

    onStateChange(listener: (s: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    onCertMismatch(): () => void {
      return () => {};
    },

    async acceptCertFingerprint(): Promise<void> {
      // no-op in mock
    },

    getState(): ConnectionState {
      return currentState;
    },

    isReplaying() {
      return false;
    },

    _getWs() {
      return null;
    },

    simulate(type: string, payload: unknown, id?: string): void {
      const typeListeners = listeners.get(type);
      if (!typeListeners) return;
      for (const listener of typeListeners) {
        (listener as (p: unknown, i?: string) => void)(payload, id);
      }
    },

    get sent() {
      return sent;
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function resetAllStores(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
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
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
}

// ── Test Suite ───────────────────────────────────────────────────────

describe("Store integration via dispatcher", () => {
  let ws: MockWsClient;
  let cleanup: () => void;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetAllStores();
    ws = createMockWsClient();
    cleanup = wireDispatcher(ws);
  });

  afterEach(() => {
    cleanup();
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Ready payload hydration
  // ────────────────────────────────────────────────────────────────

  describe("ready payload hydration", () => {
    it("populates channels, members, and voice stores from ready event", () => {
      ws.simulate("ready", {
        channels: [
          { id: 1, name: "general", type: "text", category: "Text Channels", position: 0, unread_count: 3, last_message_id: 100 },
          { id: 2, name: "random", type: "text", category: "Text Channels", position: 1, unread_count: 0, last_message_id: 50 },
          { id: 3, name: "Voice Chat", type: "voice", category: "Voice Channels", position: 0 },
        ],
        members: [
          { id: 1, username: "admin", avatar: null, role: "admin", status: "online" },
          { id: 2, username: "user1", avatar: null, role: "member", status: "idle" },
          { id: 3, username: "user2", avatar: null, role: "member", status: "offline" },
        ],
        voice_states: [
          { channel_id: 3, user_id: 1, muted: false, deafened: false },
          { channel_id: 3, user_id: 2, muted: true, deafened: false },
        ],
        roles: [
          { id: 1, name: "Admin", color: "#f1c40f", permissions: 0x3FFFFFFF },
          { id: 2, name: "Member", color: null, permissions: 0x3 },
        ],
      });

      // Channels
      const channels = channelsStore.getState().channels;
      expect(channels.size).toBe(3);
      expect(channels.get(1)?.name).toBe("general");
      // Auto-select first text channel clears its unread count
      expect(channels.get(1)?.unreadCount).toBe(0);
      expect(channels.get(3)?.type).toBe("voice");

      // Members
      const members = membersStore.getState().members;
      expect(members.size).toBe(3);
      expect(members.get(1)?.username).toBe("admin");
      expect(members.get(1)?.role).toBe("admin");
      expect(members.get(2)?.status).toBe("idle");

      // Voice
      const voiceUsers = voiceStore.getState().voiceUsers;
      const channel3Users = voiceUsers.get(3);
      expect(channel3Users).toBeDefined();
      expect(channel3Users!.size).toBe(2);
      expect(channel3Users!.get(1)?.muted).toBe(false);
      expect(channel3Users!.get(2)?.muted).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Chat message flow (unread tracking)
  // ────────────────────────────────────────────────────────────────

  describe("chat message flow", () => {
    beforeEach(() => {
      // Seed channels
      ws.simulate("ready", {
        channels: [
          { id: 1, name: "general", type: "text", category: null, position: 0, unread_count: 0 },
          { id: 2, name: "random", type: "text", category: null, position: 1, unread_count: 0 },
        ],
        members: [
          { id: 10, username: "sender", avatar: null, role: "member", status: "online" },
        ],
        voice_states: [],
        roles: [],
      });
    });

    it("adds message to store and increments unread on non-active channel", () => {
      // After ready, channel 1 is auto-selected. Send to channel 2 (non-active).
      ws.simulate("chat_message", {
        id: 100,
        channel_id: 2,
        user: { id: 10, username: "sender", avatar: null },
        content: "Hello!",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T12:00:00Z",
      });

      const messages = messagesStore.getState().messagesByChannel.get(2);
      expect(messages).toHaveLength(1);
      expect(messages![0]!.content).toBe("Hello!");

      const channel = channelsStore.getState().channels.get(2);
      expect(channel?.unreadCount).toBe(1);
    });

    it("does not increment unread when message arrives on active channel", () => {
      setActiveChannel(1);

      ws.simulate("chat_message", {
        id: 101,
        channel_id: 1,
        user: { id: 10, username: "sender", avatar: null },
        content: "Active channel message",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T12:01:00Z",
      });

      const messages = messagesStore.getState().messagesByChannel.get(1);
      expect(messages).toHaveLength(1);

      const channel = channelsStore.getState().channels.get(1);
      expect(channel?.unreadCount).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Message edit and delete
  // ────────────────────────────────────────────────────────────────

  describe("message edit and delete", () => {
    beforeEach(() => {
      // Seed a message directly
      addMessage({
        id: 200,
        channel_id: 5,
        user: { id: 1, username: "author", avatar: null },
        content: "Original content",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });
    });

    it("updates content on chat_edited event", () => {
      ws.simulate("chat_edited", {
        message_id: 200,
        channel_id: 5,
        content: "Edited content",
        edited_at: "2026-03-15T10:05:00Z",
      });

      const messages = messagesStore.getState().messagesByChannel.get(5);
      expect(messages).toHaveLength(1);
      expect(messages![0]!.content).toBe("Edited content");
      expect(messages![0]!.editedAt).toBe("2026-03-15T10:05:00Z");
    });

    it("marks message as deleted on chat_deleted event", () => {
      ws.simulate("chat_deleted", {
        message_id: 200,
        channel_id: 5,
      });

      const messages = messagesStore.getState().messagesByChannel.get(5);
      expect(messages).toHaveLength(1);
      expect(messages![0]!.deleted).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Reaction update
  // ────────────────────────────────────────────────────────────────

  describe("reaction update", () => {
    beforeEach(() => {
      // Set up auth so updateReaction knows the current user
      setAuth(
        "test-token",
        { id: 99, username: "me", avatar: null, role: "member" },
        "Test Server",
        "Welcome",
      );

      // Seed a message
      addMessage({
        id: 300,
        channel_id: 7,
        user: { id: 1, username: "someone", avatar: null },
        content: "React to this",
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T11:00:00Z",
      });
    });

    it("increases reaction count on add", () => {
      ws.simulate("reaction_update", {
        message_id: 300,
        channel_id: 7,
        emoji: "thumbsup",
        user_id: 99,
        action: "add",
      });

      const messages = messagesStore.getState().messagesByChannel.get(7);
      const msg = messages![0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.emoji).toBe("thumbsup");
      expect(msg.reactions[0]!.count).toBe(1);
      expect(msg.reactions[0]!.me).toBe(true);
    });

    it("decreases reaction count on remove and filters zero-count", () => {
      // First add
      ws.simulate("reaction_update", {
        message_id: 300,
        channel_id: 7,
        emoji: "thumbsup",
        user_id: 99,
        action: "add",
      });

      // Then remove
      ws.simulate("reaction_update", {
        message_id: 300,
        channel_id: 7,
        emoji: "thumbsup",
        user_id: 99,
        action: "remove",
      });

      const messages = messagesStore.getState().messagesByChannel.get(7);
      const msg = messages![0]!;
      // Count drops to 0, so the reaction is filtered out
      expect(msg.reactions).toHaveLength(0);
    });

    it("increments existing reaction count from another user", () => {
      // First add from user 99 (me)
      ws.simulate("reaction_update", {
        message_id: 300,
        channel_id: 7,
        emoji: "heart",
        user_id: 99,
        action: "add",
      });

      // Second add from user 50 (someone else)
      ws.simulate("reaction_update", {
        message_id: 300,
        channel_id: 7,
        emoji: "heart",
        user_id: 50,
        action: "add",
      });

      const messages = messagesStore.getState().messagesByChannel.get(7);
      const msg = messages![0]!;
      expect(msg.reactions).toHaveLength(1);
      expect(msg.reactions[0]!.count).toBe(2);
      expect(msg.reactions[0]!.me).toBe(true); // still me
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Chat send confirmation
  // ────────────────────────────────────────────────────────────────

  describe("chat send confirmation", () => {
    it("removes pending send on chat_send_ok with matching correlation ID", () => {
      const correlationId = "corr-abc-123";
      addPendingSend(correlationId, 1);

      expect(messagesStore.getState().pendingSends.has(correlationId)).toBe(true);

      ws.simulate(
        "chat_send_ok",
        { message_id: 500, timestamp: "2026-03-15T13:00:00Z" },
        correlationId,
      );

      expect(messagesStore.getState().pendingSends.has(correlationId)).toBe(false);
    });

    it("does not remove pending send when correlation ID is missing", () => {
      const correlationId = "corr-xyz-789";
      addPendingSend(correlationId, 1);

      // Simulate without an id
      ws.simulate(
        "chat_send_ok",
        { message_id: 501, timestamp: "2026-03-15T13:01:00Z" },
      );

      // Pending send remains because no correlation ID was provided
      expect(messagesStore.getState().pendingSends.has(correlationId)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Typing indicator
  // ────────────────────────────────────────────────────────────────

  describe("typing indicator", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("sets typing user in membersStore on typing event", () => {
      ws.simulate("typing", {
        channel_id: 1,
        user_id: 42,
        username: "typer",
      });

      const typing = membersStore.getState().typingUsers.get(1);
      expect(typing).toBeDefined();
      expect(typing!.has(42)).toBe(true);
    });

    it("clears typing user after 5 seconds", () => {
      ws.simulate("typing", {
        channel_id: 1,
        user_id: 42,
        username: "typer",
      });

      vi.advanceTimersByTime(5001);

      const typing = membersStore.getState().typingUsers.get(1);
      // Either the map entry is gone or the set is empty
      const hasUser = typing?.has(42) ?? false;
      expect(hasUser).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Member ban
  // ────────────────────────────────────────────────────────────────

  describe("member ban", () => {
    it("removes member from store on member_ban event", () => {
      ws.simulate("ready", {
        channels: [],
        members: [
          { id: 10, username: "innocent", avatar: null, role: "member", status: "online" },
          { id: 20, username: "troublemaker", avatar: null, role: "member", status: "online" },
        ],
        voice_states: [],
        roles: [],
      });

      expect(membersStore.getState().members.has(20)).toBe(true);

      ws.simulate("member_ban", { user_id: 20 });

      expect(membersStore.getState().members.has(20)).toBe(false);
      // Other members remain
      expect(membersStore.getState().members.has(10)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 8. Voice config and speakers
  // ────────────────────────────────────────────────────────────────

  describe("voice config and speakers", () => {
    it("stores voice config from voice_config event", () => {
      ws.simulate("voice_config", {
        channel_id: 3,
        quality: "high",
        bitrate: 128000,
        threshold_mode: "selective",
        mixing_threshold: 5,
        top_speakers: 3,
        max_users: 25,
      });

      const config = voiceStore.getState().voiceConfigs.get(3);
      expect(config).toBeDefined();
      expect(config!.quality).toBe("high");
      expect(config!.bitrate).toBe(128000);
      expect(config!.threshold_mode).toBe("selective");
      expect(config!.mixing_threshold).toBe(5);
      expect(config!.top_speakers).toBe(3);
      expect(config!.max_users).toBe(25);
    });

    it("updates speaking states from voice_speakers event", () => {
      // First seed voice users in channel 3
      ws.simulate("ready", {
        channels: [],
        members: [],
        voice_states: [
          { channel_id: 3, user_id: 1, muted: false, deafened: false },
          { channel_id: 3, user_id: 2, muted: false, deafened: false },
          { channel_id: 3, user_id: 3, muted: false, deafened: false },
        ],
        roles: [],
      });

      // User 1 and 3 are speaking
      ws.simulate("voice_speakers", {
        channel_id: 3,
        speakers: [1, 3],
        threshold_mode: "selective",
      });

      const channelUsers = voiceStore.getState().voiceUsers.get(3);
      expect(channelUsers).toBeDefined();
      expect(channelUsers!.get(1)?.speaking).toBe(true);
      expect(channelUsers!.get(2)?.speaking).toBe(false);
      expect(channelUsers!.get(3)?.speaking).toBe(true);
    });

    it("clears speaking when user is no longer in speakers list", () => {
      // Seed voice users
      ws.simulate("ready", {
        channels: [],
        members: [],
        voice_states: [
          { channel_id: 3, user_id: 1, muted: false, deafened: false },
          { channel_id: 3, user_id: 2, muted: false, deafened: false },
        ],
        roles: [],
      });

      // User 1 speaking
      ws.simulate("voice_speakers", {
        channel_id: 3,
        speakers: [1],
        threshold_mode: "forwarding",
      });

      expect(voiceStore.getState().voiceUsers.get(3)!.get(1)?.speaking).toBe(true);

      // Now nobody speaking
      ws.simulate("voice_speakers", {
        channel_id: 3,
        speakers: [],
        threshold_mode: "forwarding",
      });

      expect(voiceStore.getState().voiceUsers.get(3)!.get(1)?.speaking).toBe(false);
      expect(voiceStore.getState().voiceUsers.get(3)!.get(2)?.speaking).toBe(false);
    });
  });
});
