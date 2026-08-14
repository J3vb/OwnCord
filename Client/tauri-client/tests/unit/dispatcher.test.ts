import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireDispatcher, wireConnectionStatus } from "../../src/lib/dispatcher";
// Vite's `?raw` suffix inlines the file's source text as a string (see
// src/vite-env.d.ts's `vite/client` types) — used below for a structural
// bundle-hygiene assertion, without pulling in node:fs.
import dispatcherSource from "../../src/lib/dispatcher.ts?raw";
import { createMockWsClient } from "../helpers/mock-ws";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { channelsStore, setRoles, getRoleIdByName } from "../../src/stores/channels.store";
import {
  messagesStore,
  addOptimisticMessage,
  addOptimisticReaction,
  getChannelMessages,
  setMessages,
  markSendFailed,
  isChannelLoaded,
  getHistoryLoadState,
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
import { setMarkReadSender } from "../../src/lib/read-state";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ServerMessage, MessageResponse } from "../../src/lib/types";

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
  disableCamera: vi.fn(async () => {}),
  disableScreenshare: vi.fn(async () => {}),
}));
// screenShare.ts's rollback correlation is exercised at the unit level in
// screen-share-tracks.test.ts; here only the dispatcher's own reaction to it
// is under test, so the lookup itself is mocked and controlled per test.
vi.mock("@lib/screenShare", () => ({
  rollbackPendingVideo: vi.fn(() => undefined as "camera" | "screen" | undefined),
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

import { notifyIncomingMessage as mockNotifyIncomingMessage } from "../../src/lib/notifications";

import {
  setMuted as mockSetMuted,
  setDeafened as mockSetDeafened,
  leaveVoice as mockLeaveVoice,
  disableCamera as mockDisableCamera,
  disableScreenshare as mockDisableScreenshare,
} from "@lib/livekitSession";
import { rollbackPendingVideo as mockRollbackPendingVideo } from "@lib/screenShare";

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
  const stateListeners = new Set<(state: ConnectionState) => void>();

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
    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
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

  function dispatchState(state: ConnectionState): void {
    for (const listener of stateListeners) {
      listener(state);
    }
  }

  return { ws, dispatch, dispatchSendFailure, dispatchState, listeners };
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

  it("re-sends channel_focus for the active channel on auth_ok", () => {
    // The resume path can land with no ChannelTopic subscription (server
    // restart / proxy close observed before the client's reconnect) — a
    // channel already active on the client must be re-focused so the
    // channel message stream doesn't silently die.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(mock.ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
    });
  });

  it("sends no channel_focus on auth_ok when no channel is active", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: null }));

    mock.dispatch("auth_ok", {
      user: { id: 1, username: "alex", avatar: null, role: "admin" },
      server_name: "TestServer",
      motd: "Welcome!",
    });

    expect(mock.ws.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "channel_focus" }),
    );
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

  describe("chat_message notifications during a reconnect replay burst", () => {
    // ws.ts clears isReplaying() as soon as auth_ok is processed — before the
    // replay burst of chat_message frames the server sends right after it
    // even arrives — so it cannot gate notifications the way it gates the
    // unread counter above. A second auth_ok in this dispatcher's lifetime is
    // always a reconnect handshake; its timestamp is the gate instead.
    beforeEach(() => {
      vi.mocked(mockNotifyIncomingMessage).mockClear();
    });

    it("does not notify for a replay frame timestamped before the reconnect handshake", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      // Second auth_ok in the same dispatcher lifetime = a reconnect.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      mock.dispatch("chat_message", {
        id: 1,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "missed while offline",
        reply_to: null,
        attachments: [],
        timestamp: new Date(handshakeAt - 5000).toISOString(),
      });

      expect(mockNotifyIncomingMessage).not.toHaveBeenCalled();
    });

    it("still notifies for a genuinely live message after reconnecting", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      mock.dispatch("chat_message", {
        id: 2,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "live now",
        reply_to: null,
        attachments: [],
        timestamp: new Date(handshakeAt + 1000).toISOString(),
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      expect(mockNotifyIncomingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "live now" }),
      );
    });

    it("does not gate messages on the session's very first connect (no prior handshake)", () => {
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // Old timestamp, but there was no earlier auth_ok — not a reconnect.
      mock.dispatch("chat_message", {
        id: 3,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "first connect",
        reply_to: null,
        attachments: [],
        timestamp: "2020-01-01T00:00:00Z",
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
    });

    // BUG: the anchor (lastReconnectHandshakeAt) is stamped from the CLIENT's
    // Date.now(), but payload.timestamp is the SERVER's created_at — a raw
    // comparison mixes clock domains. A self-hosted server routinely runs
    // without NTP; if its clock lags the client's, every genuinely live
    // message for the drift window after every reconnect looks like it
    // predates the handshake and gets silently treated as a replay (no
    // notification, no taskbar flash) — and with persistent skew this never
    // recovers.
    it("does not misclassify a live post-reconnect message as a replay when the server clock lags (observed skew)", () => {
      const driftMs = 30_000; // server clock reads 30s behind the client's
      const t0 = Date.now();

      // First connect. A live message here establishes the observed skew
      // before any reconnect exists to misclassify.
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });
      mock.dispatch("chat_message", {
        id: 1,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "before reconnect",
        reply_to: null,
        attachments: [],
        timestamp: new Date(t0 - driftMs).toISOString(),
      });
      vi.mocked(mockNotifyIncomingMessage).mockClear();

      // Reconnect 1s later (client clock).
      vi.setSystemTime(t0 + 1000);
      const handshakeAt = Date.now();
      mock.dispatch("auth_ok", {
        user: { id: 1, username: "alex", avatar: null, role: "admin" },
        server_name: "TestServer",
        motd: "",
      });

      // A genuinely live message arrives 1s after the handshake (client
      // clock). Its server timestamp — still 30s behind — reads 29s
      // *before* the handshake in the client's own clock, which a
      // client-clock-only comparison misclassifies as a replay.
      vi.setSystemTime(handshakeAt + 1000);
      mock.dispatch("chat_message", {
        id: 2,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: "live after reconnect, server clock still lagging",
        reply_to: null,
        attachments: [],
        timestamp: new Date(Date.now() - driftMs).toISOString(),
      });

      expect(mockNotifyIncomingMessage).toHaveBeenCalledTimes(1);
      expect(mockNotifyIncomingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: "live after reconnect, server clock still lagging" }),
      );
    });
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

  describe("presence and user_update sync dmStore", () => {
    const dmChannel = {
      channelId: 50,
      recipient: { id: 10, username: "bob", avatar: "old.png", status: "online" as const },
      participants: [{ id: 10, username: "bob", avatar: "old.png", status: "online" as const }],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };

    beforeEach(() => {
      dmStore.setState(() => ({
        channels: [{ ...dmChannel, participants: [...dmChannel.participants] }],
      }));
    });

    it("updates the DM partner's status on presence, in recipient and participants", () => {
      mock.dispatch("presence", { user_id: 10, status: "dnd" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("dnd");
      expect(dm?.participants[0]?.status).toBe("dnd");
    });

    it("leaves an unrelated DM partner's status alone", () => {
      mock.dispatch("presence", { user_id: 999, status: "dnd" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.status).toBe("online");
    });

    it("updates the DM partner's username/avatar/displayName on user_update", () => {
      mock.dispatch("user_update", {
        user_id: 10,
        username: "bobby",
        avatar: "new.png",
        display_name: "Bobby",
        about: "",
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.username).toBe("bobby");
      expect(dm?.recipient.avatar).toBe("new.png");
      expect(dm?.recipient.displayName).toBe("Bobby");
      expect(dm?.participants[0]?.username).toBe("bobby");
    });

    it("clears the DM partner's nickname when user_update reports it cleared", () => {
      dmStore.setState((prev) => ({
        channels: prev.channels.map((c) => ({
          ...c,
          recipient: { ...c.recipient, displayName: "Bobby" },
          participants: c.participants.map((p) => ({ ...p, displayName: "Bobby" })),
        })),
      }));

      mock.dispatch("user_update", {
        user_id: 10,
        username: "bob",
        avatar: "old.png",
        display_name: null,
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.displayName).toBe("");
    });

    // An older or partial server omits display_name entirely; that means
    // "unchanged", not "cleared" — membersStore already guards it this way.
    it("leaves the DM partner's nickname alone when user_update omits display_name", () => {
      dmStore.setState((prev) => ({
        channels: prev.channels.map((c) => ({
          ...c,
          recipient: { ...c.recipient, displayName: "Bobby" },
          participants: c.participants.map((p) => ({ ...p, displayName: "Bobby" })),
        })),
      }));

      mock.dispatch("user_update", { user_id: 10, username: "bobby", avatar: "new.png" });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.recipient.username).toBe("bobby");
      expect(dm?.recipient.displayName).toBe("Bobby");
      expect(dm?.participants[0]?.displayName).toBe("Bobby");
    });
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

  it("ready does NOT change active channel when it is still present in the payload", () => {
    // Regression guard for the auto-select branch: an already-active channel
    // that is STILL in the new snapshot must not be reassigned to the first
    // text channel (99 sorts after 1, so a naive "pick first" would move it).
    channelsStore.setState((prev) => ({
      ...prev,
      activeChannelId: 99,
    }));

    mock.dispatch("ready", {
      channels: [
        { id: 1, name: "general", type: "text", category: null, position: 0 },
        { id: 99, name: "kept", type: "text", category: null, position: 1 },
      ],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(channelsStore.getState().activeChannelId).toBe(99);
  });

  it("ready clears the active channel when it is no longer present in the payload", () => {
    // Was locked as "does NOT change active channel when one is already
    // set" — but 99 was never actually IN that payload, so this was really
    // pinning the bug (BUG report #2): a channel deleted/closed while this
    // client was offline stayed "active" forever, leaving its message list
    // and composer mounted against a channel the server no longer knows.
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

    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("ready keeps the active DM channel when it is still present in dm_channels", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      roles: [],
      dm_channels: [
        {
          channel_id: 50,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          last_message_id: null,
          last_message: "",
          last_message_at: "",
          unread_count: 0,
        },
      ],
    });

    expect(channelsStore.getState().activeChannelId).toBe(50);
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

  it("ready with no DM channels in payload leaves dmStore empty", () => {
    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      roles: [],
    });

    expect(dmStore.getState().channels).toHaveLength(0);
  });

  it("ready with an empty dm_channels array clears stale DM rows", () => {
    // The server always sends dm_channels; [] is an authoritative "no open
    // DMs" (all closed on another device), not "nothing to say".
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

    mock.dispatch("ready", {
      channels: [],
      members: [],
      voice_states: [],
      roles: [],
      dm_channels: [],
    });

    expect(dmStore.getState().channels).toHaveLength(0);
  });

  describe("ready re-marks the active channel read", () => {
    afterEach(() => {
      setMarkReadSender(null);
    });

    it("clears the resurrected badge and advances the server read state for the focused channel", () => {
      // read_states go stale while a channel stays focused (channel_focus is
      // sent once per mount), so a full-ready resync restates non-zero counts
      // for the channel the user is currently reading.
      const sender = vi.fn();
      setMarkReadSender(sender);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      mock.dispatch("ready", {
        channels: [
          {
            id: 1,
            name: "general",
            type: "text",
            category: null,
            position: 0,
            unread_count: 4,
            mention_count: 2,
          },
        ],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.mentionCount).toBe(0);
      expect(sender).toHaveBeenCalledWith(1);
    });

    it("clears the badge for the actively viewed DM too", () => {
      const sender = vi.fn();
      setMarkReadSender(sender);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [
          {
            channel_id: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            last_message_id: 5,
            last_message: "hello",
            last_message_at: "2026-03-15T10:00:00Z",
            unread_count: 3,
            mention_count: 1,
          },
        ],
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
      expect(sender).toHaveBeenCalledWith(50);
    });

    it("does not send mark_read when no channel was active before the ready", () => {
      const sender = vi.fn();
      setMarkReadSender(sender);

      mock.dispatch("ready", {
        channels: [{ id: 1, name: "general", type: "text", category: null, position: 0 }],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      // Auto-select ran, but a first connect is not a resync — the payload's
      // counts are fresh and the user was not yet reading anything.
      expect(sender).not.toHaveBeenCalled();
    });
  });

  describe("ready reconciles the DM channelsStore mirror", () => {
    function seedDmMirrorRow(unreadCount: number, mentionCount: number): void {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(50, {
          id: 50,
          name: "bob",
          type: "dm" as const,
          category: null,
          position: 0,
          unreadCount,
          mentionCount,
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
    }

    // The mirror row is only ever created by addDmToChannelsStore (on open),
    // and setChannels' carry loop deliberately preserves dm-typed rows across
    // every ready rebuild — so a DM closed elsewhere while offline keeps a
    // phantom row here forever unless something prunes it.
    it("removes a dm-typed mirror row absent from the fresh dm_channels payload", () => {
      seedDmMirrorRow(3, 1);

      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      expect(channelsStore.getState().channels.has(50)).toBe(false);
    });

    // incrementUnread/incrementMention bump the mirror in parallel with
    // dmStore once it exists, but only dmStore is restated by `ready` — so a
    // DM read on another device keeps a stale count here that survives every
    // reconnect until this reconciles it too.
    it("restates a surviving dm-typed mirror row's unread/mention counts from the payload", () => {
      seedDmMirrorRow(9, 4);

      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [
          {
            channel_id: 50,
            recipient: { id: 10, username: "bob", avatar: "", status: "online" },
            last_message_id: null,
            last_message: "",
            last_message_at: "",
            unread_count: 0,
            mention_count: 0,
          },
        ],
      });

      const ch = channelsStore.getState().channels.get(50);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.mentionCount).toBe(0);
    });

    it("leaves a non-dm channel row's counts alone", () => {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(1, {
          id: 1,
          name: "general",
          type: "text" as const,
          category: null,
          position: 0,
          unreadCount: 5,
          mentionCount: 0,
          lastMessageId: null,
          canSend: true,
          topic: "",
          slowMode: 0,
          nsfw: false,
          voiceMaxUsers: 0,
          voiceMaxVideo: 0,
        });
        // Active channel is some other id — channel 1 must be neither
        // auto-selected (activeChannelId isn't null) nor mark-read'd (it
        // isn't the active one), both of which legitimately zero a badge on
        // their own and would otherwise be confused for this reconciliation
        // reaching into a channel type it must not touch.
        return { ...prev, channels: ch, activeChannelId: 2 };
      });

      mock.dispatch("ready", {
        channels: [
          {
            id: 1,
            name: "general",
            type: "text",
            category: null,
            position: 0,
            unread_count: 5,
            mention_count: 0,
          },
        ],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(5);
    });
  });

  describe("ready invalidates loaded message windows on a full-ready resync", () => {
    function storedMessage(id: number, channelId = 1): MessageResponse {
      return {
        id,
        channel_id: channelId,
        user: { id: 1, username: "alex", avatar: null },
        content: `msg ${id}`,
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned: false,
        edited_at: null,
        deleted: false,
        timestamp: "2026-03-15T09:00:00Z",
      };
    }

    it("leaves history alone on the session's very first ready", () => {
      setMessages(1, [storedMessage(10)], false);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    // The full-ready tier (this is the only tier that ever sends `ready`
    // again after the first) never replays chat_message frames, so every
    // channel loaded before the drop keeps a permanent hole unless its
    // window is invalidated and the one on screen is refetched.
    it("invalidates every loaded channel and refetches the active one on a second ready", async () => {
      cleanup();
      const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
      const getMessages = vi.fn().mockResolvedValue({
        messages: [storedMessage(900)],
        has_more: false,
      });
      cleanup = wireDispatcher(mock.ws, { listBlocks, getMessages });

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      setMessages(1, [storedMessage(10)], false);
      setMessages(2, [storedMessage(20, 2)], false);
      // Channel 1 must stay present in every ready payload — otherwise the
      // "channel this session was viewing is gone" branch clears
      // activeChannelId first, which would make the refetch target null for
      // reasons unrelated to what this test is pinning.
      const readyChannels = [
        { id: 1, name: "general", type: "text" as const, category: null, position: 0 },
      ];

      // First ready in this dispatcher's lifetime: initial connect.
      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });
      expect(getMessages).not.toHaveBeenCalled();

      // Second ready: a full-ready resync.
      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      // The inactive channel is invalidated but not eagerly refetched.
      expect(isChannelLoaded(2)).toBe(false);
      expect(getChannelMessages(2)).toEqual([]);

      // The active channel is refetched from the server.
      expect(getMessages).toHaveBeenCalledWith(1, { limit: 50 });
      await Promise.resolve();
      await Promise.resolve();
      expect(getChannelMessages(1).map((m) => m.id)).toEqual([900]);
      expect(isChannelLoaded(1)).toBe(true);
    });

    // BUG: invalidateLoadedMessageWindows() ran unconditionally, but the
    // refetch below it only runs when there's a resolvable active channel
    // AND api.getMessages exists (api is a Partial<...>, so it may be
    // absent). When it can't refetch, every loaded window is dropped with
    // nothing left to reload it — the mounted MessageList is stuck showing
    // only carried-through pending rows until the user navigates away and
    // back. The default wireDispatcher(mock.ws) from the outer beforeEach
    // has no `api` at all, so there is no getMessages to refetch with here.
    it("keeps loaded history across a resync when there is no getMessages to refetch it", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      setMessages(1, [storedMessage(10)], false);

      const readyChannels = [
        { id: 1, name: "general", type: "text" as const, category: null, position: 0 },
      ];

      // First ready: initial connect.
      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      // Second ready: a full-ready resync, with nothing able to refetch it.
      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    it("carries a failed optimistic row through the resync invalidation", () => {
      cleanup();
      const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
      const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
      cleanup = wireDispatcher(mock.ws, { listBlocks, getMessages });

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      setMessages(1, [storedMessage(10)], false);
      addOptimisticMessage({
        correlationId: "c1",
        channelId: 1,
        user: { id: 1, username: "alex", avatar: null },
        content: "unsent",
        replyTo: null,
        timestamp: "2026-03-15T10:00:00Z",
      });
      markSendFailed("c1", "SLOW_MODE");

      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });
      mock.dispatch("ready", {
        channels: [],
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      const msgs = getChannelMessages(1);
      expect(msgs.some((m) => m.correlationId === "c1" && m.status === "failed")).toBe(true);
    });

    // Guard added by commit 34c89fb: invalidate only runs when there IS a
    // resolvable active channel to refetch. Without it, a resync landing with
    // no active channel (e.g. logged in but nothing selected yet) would drop
    // every loaded window with nothing able to reload it — the same "stuck
    // empty" bug as the no-getMessages case above, just keyed on activeId
    // instead of api.getMessages. Pins the guard's other half and that no
    // downstream step in the ready handler assumes the invalidation ran.
    it("does not throw and leaves history untouched when no channel is active on resync", () => {
      cleanup();
      const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
      const getMessages = vi.fn().mockResolvedValue({ messages: [], has_more: false });
      cleanup = wireDispatcher(mock.ws, { listBlocks, getMessages });

      // Channel 1 is loaded but never made active — an empty `channels` list
      // on both readies means nothing ever auto-selects it.
      setMessages(1, [storedMessage(10)], false);

      expect(() => {
        mock.dispatch("ready", {
          channels: [],
          members: [],
          voice_states: [],
          roles: [],
          dm_channels: [],
        });
        mock.dispatch("ready", {
          channels: [],
          members: [],
          voice_states: [],
          roles: [],
          dm_channels: [],
        });
      }).not.toThrow();

      expect(getMessages).not.toHaveBeenCalled();
      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);
    });

    // NEW residual gap the guard move opens: invalidate and the refetch now
    // always fire together, but invalidate is synchronous while the refetch
    // is async — so a rejection lands *after* the active channel's window is
    // already dropped. The .catch only logs; without also marking the
    // channel load-errored, the mounted MessageList falls back to its empty
    // "no messages yet" welcome state (virtualItems.length === 0 and
    // historyLoadState is still idle) instead of the inline error+Retry
    // state — silently misrepresenting a failed reload as a genuinely empty
    // channel, which is exactly the kind of silent history hole B2-1 exists
    // to prevent.
    it("marks the active channel load-errored when the resync refetch rejects", async () => {
      cleanup();
      const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
      const getMessages = vi.fn().mockRejectedValue(new Error("network down"));
      cleanup = wireDispatcher(mock.ws, { listBlocks, getMessages });

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      setMessages(1, [storedMessage(10)], false);

      const readyChannels = [
        { id: 1, name: "general", type: "text" as const, category: null, position: 0 },
      ];

      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });
      mock.dispatch("ready", {
        channels: readyChannels,
        members: [],
        voice_states: [],
        roles: [],
        dm_channels: [],
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(isChannelLoaded(1)).toBe(false);
      expect(getHistoryLoadState(1)).toBe("error");
    });
  });

  it("fails every pending optimistic send when the connection drops", () => {
    addOptimisticMessage({
      correlationId: "corr-drop",
      channelId: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "in flight",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    // Reaching connected must not fail anything…
    mock.dispatchState("connected");
    expect(messagesStore.getState().messagesByChannel.get(1)![0]!.status).toBe("pending");

    // …but the connection dropping can never deliver chat_send_ok for the
    // pending frame, so the row must fail with retry instead of spinning.
    mock.dispatchState("reconnecting");

    const msg = messagesStore.getState().messagesByChannel.get(1)![0]!;
    expect(msg.status).toBe("failed");
    expect(msg.errorCode).toBe("OFFLINE");
    expect(messagesStore.getState().pendingSends.size).toBe(0);
  });

  it("rolls back every pending optimistic reaction toggle when the connection drops", () => {
    mock.dispatch("chat_message", {
      id: 900,
      channel_id: 1,
      user: { id: 1, username: "alex", avatar: null },
      content: "react to me",
      reply_to: null,
      attachments: [],
      timestamp: "2026-03-15T10:00:00Z",
    });

    addOptimisticReaction("corr-react-drop", {
      channelId: 1,
      messageId: 900,
      emoji: "👍",
      action: "add",
    });

    const before = getChannelMessages(1)[0]!.reactions.find((r) => r.emoji === "👍");
    expect(before?.count).toBe(1);
    expect(before?.me).toBe(true);
    expect(messagesStore.getState().pendingReactions?.has("corr-react-drop")).toBe(true);

    // Same reasoning as pendingSends above: the frame is gone with the dying
    // socket, so the toggle must roll back instead of leaving a permanently
    // wrong pill and a stale pendingReactions entry.
    mock.dispatchState("reconnecting");

    const after = getChannelMessages(1)[0]!.reactions.find((r) => r.emoji === "👍");
    expect(after).toBeUndefined();
    expect(messagesStore.getState().pendingReactions?.has("corr-react-drop")).toBe(false);
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

  it("syncs authStore.user.role when the member_update is about the signed-in user", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 42, username: "alice", avatar: null, role: "member" },
    }));
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
    expect(authStore.getState().user?.role).toBe("admin");
  });

  it("leaves authStore.user.role untouched for a member_update about someone else", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));

    mock.dispatch("member_update", { user_id: 42, role: "admin" });

    expect(authStore.getState().user?.role).toBe("member");
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

  // A server-initiated eviction (CONNECT_VOICE revocation sweep, channel
  // delete) has no companion teardown message — voice_leave for the local
  // user IS the signal that must also tear down the LiveKit session, or mic
  // publish + E2EE key material stay live while the UI shows not-in-voice.
  it("tears down the LiveKit session on a self voice_leave for the current channel", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
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
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).toHaveBeenCalledWith(false);
  });

  // A stale voice_leave for a channel we've already left (and rejoined
  // elsewhere) must not kill the newer join's live session.
  it("does not tear down the session for a stale voice_leave from a channel already left", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 5, username: "me", avatar: null, role: "member" },
    }));
    // Currently in channel 9 (a newer join) — the incoming voice_leave is for
    // the old channel 3.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
    }));

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).not.toHaveBeenCalled();
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

  it("wires error BANNED to disconnect the ws client (OC-0107: without this the banned token reconnects forever)", () => {
    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      user: { id: 1, username: "banned-user", avatar: null, role: "member" },
    }));

    mock.dispatch("error", {
      code: "BANNED",
      message: "You have been banned from this server",
    });

    // clearAuth() alone flips isAuthenticated, but main.ts's authStore
    // subscriber only tears down the ws (and cancels the reconnect loop) when
    // the router is already on "main". During login / auto-login / the
    // connected-overlay window it is not, so the BANNED handler itself must
    // call ws.disconnect() to set intentionalClose and stop scheduleReconnect
    // from redialing with the now-cleared but still-cached banned token.
    expect(mock.ws.disconnect).toHaveBeenCalled();
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

  it("wires error with an unrecognized code to the generic fallback banner", () => {
    // The final fallthrough is the one place every unmatched error code
    // lands (e.g. a rejected fire-and-forget chat_edit) — it must not be
    // silently dropped just because it isn't RATE_LIMITED/FORBIDDEN.
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    mock.dispatch("error", {
      code: "UNKNOWN",
      message: "Something odd",
    });

    expect(uiStore.getState().transientError).toBe("Something odd");
  });

  it("wires a BAD_REQUEST error with no pending correlation (e.g. a rejected chat_edit) to a transient error", () => {
    // chat_edit is fire-and-forget: it never enters pendingSends, so a
    // rejection's envelope id matches nothing above and used to fall through
    // this handler silently, leaving the user's edited text destroyed with
    // no error shown (only RATE_LIMITED/FORBIDDEN were bannered).
    uiStore.setState((prev) => ({ ...prev, transientError: null }));

    mock.dispatch("error", { code: "BAD_REQUEST", message: "Message too long" }, "edit-id-1");

    expect(uiStore.getState().transientError).toBe("Message too long");
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

  it("does not gate blockedByThem on a FORBIDDEN send in a group DM", () => {
    // Group DMs are exempt from block checks server-side (a group FORBIDDEN
    // means something else, e.g. stale membership) — recipient is just
    // participants[0] for a group, so flagging it here would incorrectly
    // gate an unrelated 1:1 DM with that same person.
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 8,
          recipient: { id: 5, username: "alice", avatar: "", status: "online" },
          participants: [
            { id: 5, username: "alice", avatar: "", status: "online" },
            { id: 6, username: "bob", avatar: "", status: "online" },
          ],
          name: "Crew",
          isGroup: true,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    addOptimisticMessage({
      correlationId: "corr-group",
      channelId: 8,
      user: { id: 1, username: "alex", avatar: null },
      content: "hi",
      replyTo: null,
      timestamp: "2026-03-15T10:00:00Z",
    });

    mock.dispatch("error", { code: "FORBIDDEN", message: "not a participant" }, "corr-group");

    expect(blocksStore.getState().blockedByThem.has(5)).toBe(false);
    // Still marks the row failed (existing behaviour preserved).
    expect(getChannelMessages(8)[0]!.status).toBe("failed");
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

    it("increments the DM mention badge for an incoming @mention", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 504,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey @me",
        mentions: [5],
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      // The badge must fire live: dmStore's mentionCount is what DmSidebar
      // renders (mute-immune), and channelsStore's incrementMention no-ops
      // for DM ids. Without this, the badge appears only after a reconnect.
      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.mentionCount).toBe(1);
      expect(dm?.unreadCount).toBe(1);
    });

    it("does not badge a DM mention in the focused DM", () => {
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      }));

      mock.dispatch("chat_message", {
        id: 505,
        channel_id: 50,
        user: { id: 10, username: "bob", avatar: "" },
        content: "hey @me",
        mentions: [5],
        reply_to: null,
        attachments: [],
        timestamp: "2026-03-15T10:00:00Z",
      });

      const dm = dmStore.getState().channels.find((c) => c.channelId === 50);
      expect(dm?.mentionCount).toBe(0);
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

    it("falls back to another open DM when the closed DM was active", () => {
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
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
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
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(dmStore.getState().channels.map((c) => c.channelId)).toEqual([60]);
      expect(channelsStore.getState().activeChannelId).toBe(60);
    });

    // setActiveChannel only zeroes the channelsStore mirror row's counts; a
    // DM's badge lives in dmStore (SidebarDmSection reads dmStore.unreadCount,
    // not the channelsStore mirror). Every other "open this DM" path
    // (selectDmConversation, navigateToChannel, markChannelRead) pairs
    // activation with clearDmUnread for exactly this reason — the
    // dm_channel_close fallback must too, or the badge on the DM it just
    // activated survives forever (it's now "active", so new messages take the
    // isDmActive branch and never increment it back).
    it("clears the dmStore unread badge on the DM it falls back to activating", () => {
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
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
            participants: [],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 3,
            mentionCount: 1,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(60);
      const dm = dmStore.getState().channels.find((c) => c.channelId === 60);
      expect(dm?.unreadCount).toBe(0);
      expect(dm?.mentionCount).toBe(0);
    });

    // The channelsStore mirror row for a DM is only ever synthesized by
    // addDmToChannelsStore (on open, via selectDmConversation) — a DM present
    // in dmStore from `ready` but never opened this session has none. Without
    // synthesizing it here, activating channel 60 lands on an id
    // ChannelController can't resolve and blanks the chat area permanently.
    it("synthesizes the channelsStore mirror row when falling back to a DM never opened this session", () => {
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
          {
            channelId: 60,
            recipient: { id: 11, username: "carl", avatar: "", status: "online" },
            participants: [{ id: 11, username: "carl", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 2,
            mentionCount: 1,
          },
        ],
      }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
      // Channel 60 has no channelsStore row yet — the bug this test locks.
      expect(channelsStore.getState().channels.has(60)).toBe(false);

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(60);
      const ch = channelsStore.getState().channels.get(60);
      // Without the fix, ch is undefined here — activation succeeded but the
      // row it needs to resolve a name/type from never got synthesized.
      expect(ch).toBeDefined();
      expect(ch?.type).toBe("dm");
      expect(ch?.name).toBe("carl");
      // setActiveChannel legitimately zeroes a badge on open (existing,
      // correct behavior) — this only confirms that ran against a row that
      // now actually exists, not that synthesis skipped the counts.
      expect(ch?.unreadCount).toBe(0);
    });

    it("falls back to the first text channel when the closed DM was active and no DMs remain", () => {
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
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(1, {
          id: 1,
          name: "general",
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
        return { ...prev, channels: ch, activeChannelId: 50 };
      });

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(1);
    });

    it("does not change the active channel when the closed DM was not active", () => {
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
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      mock.dispatch("dm_channel_close", { channel_id: 50 });

      expect(channelsStore.getState().activeChannelId).toBe(1);
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

    // max_video has no SFU-level enforcement — the server's VIDEO_LIMIT refusal
    // only rejects the DB write. Without a client-side rollback the refused
    // camera track keeps publishing (and streaming to everyone) while
    // voice_state says camera=false, so VIDEO_LIMIT is otherwise cosmetic.
    it("rolls back the local camera publish on VIDEO_LIMIT", async () => {
      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" });
      await vi.runAllTimersAsync();

      expect(mockDisableCamera).toHaveBeenCalled();
    });

    // A capacity refusal is about the voice channel, not about the composer,
    // so it must not also land in the login screen's transient-error slot.
    it("does not set the transient error", () => {
      uiStore.setState((prev) => ({ ...prev, transientError: null }));
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });
      expect(uiStore.getState().transientError).toBeNull();
    });

    // The sidebar/widget optimistically writes currentChannelId (voiceStatus
    // "joining") before the server answers. A first-time join has no prior
    // channel to leave, so no voice_leave ever arrives to clean that up —
    // without a rollback here, currentChannelId is stuck pointing at a
    // channel with no LiveKit session, and the sidebar's recovery click tears
    // down whatever *is* live instead.
    it("rolls back the optimistic join on a first-time CHANNEL_FULL", () => {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 5, voiceStatus: "joining" }));

      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    // A channel-*switch* refusal is different: the server leaves the old
    // channel first, whose self voice_leave already reset voiceStatus to
    // idle by the time this error lands — so the guard above is a no-op and
    // must not blow away a genuinely connected session.
    it("does not touch an already-established voice session on CHANNEL_FULL", () => {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 5, voiceStatus: "connected" }));

      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });

      expect(voiceStore.getState().currentChannelId).toBe(5);
      expect(voiceStore.getState().voiceStatus).toBe("connected");
    });
  });

  // A server refusal of voice_camera/voice_screenshare (FORBIDDEN,
  // RATE_LIMITED, INTERNAL, ...) other than VIDEO_LIMIT is otherwise
  // unhandled — the already-published track keeps streaming to every peer
  // while the store says it's off. Correlated by envelope id, exactly like
  // pendingSends/pendingReactions above, so an unrelated refusal on some
  // other action never touches video state.
  describe("voice video-enable refusal rollback", () => {
    beforeEach(() => {
      vi.mocked(mockRollbackPendingVideo).mockReset().mockReturnValue(undefined);
      vi.mocked(mockDisableCamera).mockClear();
      vi.mocked(mockDisableScreenshare).mockClear();
      uiStore.setState((prev) => ({ ...prev, transientError: null }));
    });

    it("rolls back the camera publish on a correlated refusal", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue("camera");

      mock.dispatch("error", { code: "FORBIDDEN", message: "no permission" }, "vid-1");
      await vi.runAllTimersAsync();

      expect(mockRollbackPendingVideo).toHaveBeenCalledWith("vid-1");
      expect(mockDisableCamera).toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
      expect(uiStore.getState().transientError).toBe("no permission");
    });

    it("rolls back the screenshare publish on a correlated refusal", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue("screen");

      mock.dispatch("error", { code: "RATE_LIMITED", message: "" }, "vid-2");
      await vi.runAllTimersAsync();

      expect(mockDisableScreenshare).toHaveBeenCalled();
      expect(mockDisableCamera).not.toHaveBeenCalled();
      expect(uiStore.getState().transientError).toBe("Server error");
    });

    it("leaves an uncorrelated refusal as a plain transient error — no rollback", () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue(undefined);

      mock.dispatch("error", { code: "FORBIDDEN", message: "nope" }, "unrelated-id");

      expect(mockDisableCamera).not.toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
      expect(uiStore.getState().transientError).toBe("nope");
    });
  });
});

describe("bundle hygiene", () => {
  // screenShare.ts has VALUE imports from livekit-client (~1.3 MB) at module
  // scope. dispatcher.ts is imported statically from main.ts, so a top-level
  // `import ... from "@lib/screenShare"` here drags the whole library into
  // the startup bundle — every other voice call site in this file already
  // loads its module lazily (see the livekitSession() helper), and
  // screenShare.ts's one export used here (rollbackPendingVideo) must follow
  // the same idiom instead of a static import.
  it("does not statically import screenShare — dynamic import only", () => {
    const staticImport = /^\s*import\s[^;]*from\s+["']@lib\/screenShare["']/m;
    expect(staticImport.test(dispatcherSource)).toBe(false);
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
