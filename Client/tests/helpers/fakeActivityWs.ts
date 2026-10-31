import { expect, vi } from "vitest";
import type { ConnectionState } from "@lib/ws";

/**
 * A socket stand-in for the presence loops: `send` records each frame's
 * `payload[field]` under a fresh id, and the test drives connection-state and
 * `ready` events through the returned handles.
 */
export function fakeActivityWs<Value>(
  messageType: string,
  field: string,
  initial: ConnectionState = "connected",
) {
  type Sent = { readonly id: string } & Record<string, Value>;
  let state: ConnectionState = initial;
  let nextId = 1;
  const sent: Sent[] = [];
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const readyListeners = new Set<() => void>();
  const ws = {
    getState: () => state,
    send: vi.fn((msg: { type: string; payload: Record<string, Value> }) => {
      expect(msg.type).toBe(messageType);
      const id = `id-${nextId++}`;
      sent.push({ id, [field]: msg.payload[field] } as Sent);
      return id;
    }),
    onStateChange: (fn: (s: ConnectionState) => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    on: (type: string, fn: () => void) => {
      expect(type).toBe("ready");
      readyListeners.add(fn);
      return () => readyListeners.delete(fn);
    },
  };
  return {
    ws: ws as never,
    sent,
    setState(next: ConnectionState): void {
      state = next;
      for (const fn of stateListeners) fn(next);
    },
    ready(): void {
      for (const fn of readyListeners) fn();
    },
    listenerCounts(): { state: number; ready: number } {
      return { state: stateListeners.size, ready: readyListeners.size };
    },
  };
}
