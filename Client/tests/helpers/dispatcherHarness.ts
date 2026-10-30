import { vi, expect, beforeEach, afterEach } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { messagesStore } from "../../src/stores/messages.store";
import { membersStore } from "../../src/stores/members.store";
import { voiceStore } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import { blocksStore } from "../../src/stores/blocks.store";
import { emojiStore, clearCustomEmoji } from "../../src/stores/emoji.store";
import { stickersStore, clearStickers } from "../../src/stores/stickers.store";
import { uiStore } from "../../src/stores/ui.store";
import { resetJoinRequest } from "../../src/features/voice/joinRequest";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ServerMessage } from "../../src/lib/types";
import { getLazyVoiceImportsInFlight } from "./dispatcherMocks";

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
  channelsStore.setState(() => ({
    categories: [],
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
  clearStickers();
  stickersStore.flush();
}

/**
 * How a test file reads the harness's per-test state. The file declares
 * `let mock` and `let cleanup` itself (tests reassign `cleanup` when they
 * re-wire the dispatcher with other dependencies), the harness writes them
 * through `wired` and reads the current teardown through `currentCleanup`.
 */
export interface DispatcherHarnessBinding {
  wired(mock: DispatcherMock, cleanup: () => void): void;
  currentCleanup(): () => void;
}

/**
 * Registers the shared beforeEach/afterEach for a "WS Dispatcher" describe:
 * fake timers, reset stores, a fresh mock socket with the dispatcher wired to
 * it, and teardown that first asserts no lazy voice import is still in flight.
 * Call it inside the describe, before the tests.
 */
export function useDispatcherHarness(binding: DispatcherHarnessBinding): void {
  beforeEach(() => {
    resetJoinRequest();
    vi.useFakeTimers();
    resetDispatcherStores();

    const mock = createMockWs();
    binding.wired(mock, wireDispatcher(mock.ws));
  });

  afterEach(async () => {
    await expectLazyVoiceImportsSettled();
    binding.currentCleanup()();
    vi.useRealTimers();
  });
}
