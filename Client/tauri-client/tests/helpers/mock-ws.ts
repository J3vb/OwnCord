/**
 * Mock WebSocket client that implements the same public interface as
 * createWsClient() from @lib/ws. Used in unit and integration tests
 * to simulate server messages and inspect outbound sends without
 * requiring Tauri IPC or a real WebSocket connection.
 */

import type {
  ServerMessage,
  ClientMessage,
} from "@lib/types";
import type { ConnectionState, WsListener } from "@lib/ws";

interface SentEnvelope {
  readonly type: string;
  readonly id: string;
  readonly payload: unknown;
}

export function createMockWsClient() {
  let state: ConnectionState = "disconnected";

  const sent: SentEnvelope[] = [];
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  let idCounter = 0;

  function nextId(): string {
    idCounter += 1;
    return `mock-${idCounter}`;
  }

  function setState(newState: ConnectionState): void {
    if (state !== newState) {
      state = newState;
      for (const listener of stateListeners) {
        listener(state);
      }
    }
  }

  return {
    // ---------------------------------------------------------------
    // Public API — mirrors WsClient from @lib/ws
    // ---------------------------------------------------------------

    connect(): void {
      setState("connected");
    },

    disconnect(): void {
      setState("disconnected");
    },

    send(msg: ClientMessage): string {
      const id = nextId();
      sent.push({ type: msg.type, id, payload: msg.payload });
      return id;
    },

    on<T extends ServerMessage["type"]>(
      type: T,
      listener: WsListener<T>,
    ): () => void {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      const set = listeners.get(type)!;
      set.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        set.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },

    onStateChange(listener: (s: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    getState(): ConnectionState {
      return state;
    },

    // ---------------------------------------------------------------
    // Test-only helpers
    // ---------------------------------------------------------------

    /**
     * Simulate a server message arriving. Fires all registered listeners
     * for the given message type.
     */
    simulateMessage<T extends ServerMessage["type"]>(
      type: T,
      payload: Extract<ServerMessage, { type: T }>["payload"],
      id?: string,
    ): void {
      const typeListeners = listeners.get(type);
      if (typeListeners) {
        for (const listener of typeListeners) {
          // Cast through unknown: the generic constraints guarantee type
          // safety at call sites, but TS cannot narrow inside the loop.
          const fn = listener as unknown as (p: unknown, i?: string) => void;
          fn(payload, id);
        }
      }
    },

    /**
     * Simulate a connection state change (e.g. reconnecting, disconnected).
     */
    simulateStateChange(newState: ConnectionState): void {
      setState(newState);
    },

    /**
     * Return all messages passed to send(), in order.
     */
    getSentMessages(): readonly SentEnvelope[] {
      return sent;
    },

    /**
     * Convenience: return the last sent message, or undefined if none.
     */
    get lastSent(): SentEnvelope | undefined {
      return sent[sent.length - 1];
    },

    /**
     * Clear the sent message buffer.
     */
    clearSent(): void {
      sent.length = 0;
    },
  };
}

export type MockWsClient = ReturnType<typeof createMockWsClient>;
