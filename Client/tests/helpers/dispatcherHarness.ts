import { vi, expect, beforeEach, afterEach } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { authStore, type AuthState } from "../../src/stores/auth.store";
import { voiceStore, type VoiceState } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import { blocksStore } from "../../src/stores/blocks.store";
import { emojiStore, clearCustomEmoji } from "../../src/stores/emoji.store";
import { stickersStore, clearStickers } from "../../src/stores/stickers.store";
import { uiStore } from "../../src/stores/ui.store";
import { resetJoinRequest } from "../../src/features/voice/joinRequest";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";
import type { DmChannel } from "../../src/stores/dm.store";
import { dmRecipient, makeDm } from "./dmHarness";
import { channelsStore, type Channel, type ChannelsState } from "../../src/stores/channels.store";
import { membersStore, type Member } from "../../src/stores/members.store";
import { getLazyVoiceImportsInFlight } from "./dispatcherMocks";
import { resetMessagesState, resetMembersState } from "./storeResets";
import { makeChannelRow, resetChannelsState, resetVoiceState } from "./storeSeeds";

// Suppress console output from every dispatcher test file that loads the harness.
vi.spyOn(console, "info").mockImplementation(() => {});

/**
 * Create a mock WsClient that stores listener registrations
 * and provides a `dispatch` helper to fire events.
 */
export function createMockWs() {
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  const sendFailureListeners = new Set<(id: string, code: string) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  const ws: WsClient = {
    ping: vi.fn(async () => {}),
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
    onServerBusy: vi.fn(() => () => {}),
    onCertMismatch: vi.fn(() => () => {}),
    acceptCertFingerprint: vi.fn(async () => {}),
    getConnectFailureCode: vi.fn(() => null),
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

export type DispatcherMock = ReturnType<typeof createMockWs>;

/**
 * Fire-and-forget `livekitSession()` imports started by a test must land while
 * the file's mocks are still registered, not after teardown.
 */
export async function expectLazyVoiceImportsSettled(): Promise<void> {
  await vi.dynamicImportSettled();
  expect(
    getLazyVoiceImportsInFlight(),
    "a lazy voice-module import must settle before the test ends, or it outlives the environment (CI 'Errors 4 errors')",
  ).toBe(0);
}

/** Reset every store the dispatcher writes to, back to its initial state. */
export function resetDispatcherStores(): void {
  authStore.setState(() => ({
    token: "test-token",
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
  resetChannelsState();
  resetMessagesState();
  resetMembersState();
  resetVoiceState();
  dmStore.setState(() => ({ channels: [] }));
  blocksStore.setState(() => ({ blockedByMe: new Set(), blockedByThem: new Set() }));
  uiStore.setState((prev) => ({ ...prev, transientError: null }));
  clearCustomEmoji();
  emojiStore.flush();
  clearStickers();
  stickersStore.flush();
}

/** The mock socket of the running test; the harness replaces it before each test. */
export let mock: DispatcherMock;

/** Tears down the dispatcher wired to `mock`; `replaceDispatcher` swaps it. */
export let cleanup: () => void;

/**
 * Tears down the dispatcher the harness wired and wires a new one to the same
 * socket with `api`, so a test can hand it REST fakes.
 */
export function replaceDispatcher(api?: Parameters<typeof wireDispatcher>[1]): void {
  cleanup();
  cleanup = wireDispatcher(mock.ws, api);
}

/**
 * Registers the shared beforeEach/afterEach for a "WS Dispatcher" describe:
 * fake timers, reset stores, a fresh mock socket with the dispatcher wired to
 * it, and teardown that first asserts no lazy voice import is still in flight.
 * Call it inside the describe, before the tests.
 */
export function useDispatcherHarness(): void {
  beforeEach(() => {
    resetJoinRequest();
    vi.useFakeTimers();
    resetDispatcherStores();

    mock = createMockWs();
    cleanup = wireDispatcher(mock.ws);
  });

  afterEach(async () => {
    await expectLazyVoiceImportsSettled();
    cleanup();
    vi.useRealTimers();
  });
}

type Fields = Record<string, unknown>;

/** A `ready` payload with every list empty; `overrides` replaces or adds fields. */
export function readyEvent(overrides: Fields = {}): Fields {
  return { channels: [], members: [], voice_states: [], roles: [], ...overrides };
}

/** A text channel as `ready` ships it (id 1, "general"). */
export function readyChannel(overrides: Fields = {}): Fields {
  return { id: 1, name: "general", type: "text", category: null, position: 0, ...overrides };
}

/** A DM channel as `ready` ships it (id 50, with bob). */
export function readyDm(overrides: Fields = {}): Fields {
  return {
    channel_id: 50,
    recipient: { id: 10, username: "bob", avatar: "", status: "online" },
    last_message_id: null,
    last_message: "",
    last_message_at: "",
    unread_count: 0,
    ...overrides,
  };
}

/** A DM row as dmStore holds it (id 50, with bob). */
export function dmRow(overrides: Partial<DmChannel> = {}): DmChannel {
  return makeDm({ channelId: 50, recipient: dmRecipient(10, "bob"), ...overrides });
}

/** An `auth_ok` payload for admin "alex" on "TestServer". */
export function authOkEvent(overrides: Fields = {}): Fields {
  return {
    user: { id: 1, username: "alex", avatar: null, role: "admin" },
    server_name: "TestServer",
    motd: "",
    ...overrides,
  };
}

/** Make member "me" (id 5) the signed-in user, leaving the rest of authStore alone. */
export function setMeUser(): void {
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 5, username: "me", avatar: null, role: "member" },
  }));
}

export function setActiveChannel(id: number | null): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: id }));
}

/** A channel row as channelsStore holds it: an empty text channel the user can send in. */
export const channelRow = makeChannelRow;

/** Add `rows` to channelsStore; `extra` overrides other fields of the state. */
export function seedChannels(rows: readonly Channel[], extra: Partial<ChannelsState> = {}): void {
  channelsStore.setState((prev) => {
    const ch = new Map(prev.channels);
    for (const row of rows) ch.set(row.id, row);
    return { ...prev, channels: ch, ...extra };
  });
}

/** A member as `ready` ships it: online, role "member". */
export function readyMember(overrides: Fields = {}): Fields {
  return { avatar: null, role: "member", status: "online", ...overrides };
}

/** An online member with no role beyond "member". */
export function memberRow(overrides: Pick<Member, "id" | "username"> & Partial<Member>): Member {
  return { avatar: null, role: "member", status: "online", ...overrides };
}

/** Add `rows` to membersStore. */
export function seedMembers(rows: readonly Member[]): void {
  membersStore.setState((prev) => {
    const m = new Map(prev.members);
    for (const row of rows) m.set(row.id, row);
    return { ...prev, members: m };
  });
}

/** Merge `patch` into voiceStore, leaving every other field as it is. */
export function patchVoice(patch: Partial<VoiceState>): void {
  voiceStore.setState((prev) => ({ ...prev, ...patch }));
}

/** Merge `patch` into authStore, leaving every other field as it is. */
export function patchAuth(patch: Partial<AuthState>): void {
  authStore.setState((prev) => ({ ...prev, ...patch }));
}

/** A `chat_message` payload; `overrides` names at least id, channel_id, user and content. */
export function chatMessageEvent(overrides: Fields): Fields {
  return {
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T10:00:00Z",
    ...overrides,
  };
}

/** Replace dmStore's DM list with `rows`. */
export function seedDms(rows: readonly DmChannel[]): void {
  dmStore.setState(() => ({ channels: [...rows] }));
}

/** A `voice_state` payload for a user with nothing muted, speaking or streaming. */
export function voiceStateEvent(overrides: Fields): Fields {
  return {
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...overrides,
  };
}
