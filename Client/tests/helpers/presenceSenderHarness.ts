import { afterEach, beforeEach, vi } from "vitest";
import { membersStore } from "@stores/members.store";
import { createPresenceSender } from "@lib/presence/presence";
import { createPresenceLimiter, type RateLimiter } from "@lib/net/rateLimiter";
import type { WsClient } from "@lib/ws";
import { resetMembersState } from "./storeResets";
import { resetAuthState, signInAs } from "./storeSeeds";

type PresenceFrame = { type: string; payload: { status: string; custom_status?: string } };

/** The WsClient members every fake carries besides `send` and `on`. */
function inertWsMembers() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    startCertListener: vi.fn().mockResolvedValue(undefined),
    onCertFirstUse: vi.fn().mockReturnValue(() => {}),
    onServerBusy: vi.fn().mockReturnValue(() => {}),
    onCertMismatch: vi.fn().mockReturnValue(() => {}),
    acceptCertFingerprint: vi.fn(),
    getState: vi.fn(() => "connected"),
    _getWs: vi.fn(() => null),
  };
}

export function createMockWs(): WsClient {
  return {
    ...inertWsMembers(),
    send: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
  } as unknown as WsClient;
}

/** A minimal WsClient whose `on` registry can be fired by the test, so a
 *  server `error` reply can be delivered to the sender. */
export function createErrorableWs(returnIds = true): {
  ws: WsClient;
  sent: PresenceFrame[];
  fireError: (code: string, id?: string) => void;
} {
  const sent: PresenceFrame[] = [];
  const listeners = new Map<string, Set<(payload: unknown, id?: string) => void>>();
  let nextId = 0;
  const ws = {
    ...inertWsMembers(),
    send: vi.fn((msg: PresenceFrame) => {
      sent.push(msg);
      return returnIds ? `id-${++nextId}` : undefined;
    }),
    on: vi.fn((type: string, listener: (payload: unknown, id?: string) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return () => listeners.get(type)?.delete(listener);
    }),
  } as unknown as WsClient;
  return {
    ws,
    sent,
    fireError: (code, id) => {
      for (const l of listeners.get("error") ?? []) l({ code, message: "rate limited" }, id);
    },
  };
}

/** Signs in as alice and registers the per-test seed and reset hooks. */
export function usePresenceFixture(customStatus: string | undefined): void {
  beforeEach(() => {
    localStorage.clear();
    signInAs(
      { id: 1, username: "alice", avatar: null, role: "member" },
      { serverName: "TestServer" },
    );
    membersStore.setState(() => ({
      members: new Map([
        [
          1,
          {
            id: 1,
            username: "alice",
            displayName: null,
            avatar: null,
            role: "member",
            status: "online",
            customStatus,
          } as never,
        ],
      ]),
      typingUsers: new Map(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAuthState();
    resetMembersState();
  });
}

type SenderContext = ReturnType<typeof createErrorableWs> & {
  sender: ReturnType<typeof createPresenceSender>;
};

/** Builds a sender over an errorable fake socket, runs the body, and always destroys it. */
export function withSender(
  options: { fakeTimers?: boolean; returnIds?: boolean; limiter?: RateLimiter },
  body: (ctx: SenderContext) => void,
): void {
  if (options.fakeTimers) vi.useFakeTimers();
  const socket = createErrorableWs(options.returnIds);
  const sender = createPresenceSender(socket.ws, options.limiter ?? createPresenceLimiter());
  try {
    body({ ...socket, sender });
  } finally {
    sender.destroy();
  }
}
