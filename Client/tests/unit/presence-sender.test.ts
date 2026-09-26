// OC-0156: createPresenceSender's send() clears any pending retry and
// re-arms it carrying only its own `customStatus` argument. A plain status
// change (customStatus === undefined) landing while a custom-status commit
// is still queued behind the shared limiter must not erase the queued
// custom_status — the retry must still carry the last customStatus the user
// committed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { createPresenceSender } from "@lib/presence";
import { createPresenceLimiter } from "@lib/rate-limiter";
import { saveUserStatus } from "@lib/userStatus";
import type { WsClient } from "@lib/ws";

function createMockWs(): WsClient {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    startCertListener: vi.fn().mockResolvedValue(undefined),
    onCertFirstUse: vi.fn().mockReturnValue(() => {}),
    onCertMismatch: vi.fn().mockReturnValue(() => {}),
    acceptCertFingerprint: vi.fn(),
    getState: vi.fn(() => "connected"),
    _getWs: vi.fn(() => null),
  } as unknown as WsClient;
}

/** A minimal WsClient whose `on` registry can be fired by the test, so a
 *  server `error` reply can be delivered to the sender. */
function createErrorableWs(): {
  ws: WsClient;
  sent: Array<{ type: string; payload: { status: string; custom_status?: string } }>;
  fireError: (code: string, id?: string) => void;
} {
  const sent: Array<{ type: string; payload: { status: string; custom_status?: string } }> = [];
  const listeners = new Map<string, Set<(payload: unknown, id?: string) => void>>();
  let nextId = 0;
  const ws = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn((msg: { type: string; payload: { status: string; custom_status?: string } }) => {
      sent.push(msg);
      return `id-${++nextId}`;
    }),
    on: vi.fn((type: string, listener: (payload: unknown, id?: string) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return () => listeners.get(type)?.delete(listener);
    }),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    startCertListener: vi.fn().mockResolvedValue(undefined),
    onCertFirstUse: vi.fn().mockReturnValue(() => {}),
    onCertMismatch: vi.fn().mockReturnValue(() => {}),
    acceptCertFingerprint: vi.fn(),
    getState: vi.fn(() => "connected"),
    _getWs: vi.fn(() => null),
  } as unknown as WsClient;
  return {
    ws,
    sent,
    fireError: (code, id) => {
      for (const l of listeners.get("error") ?? []) l({ code, message: "rate limited" }, id);
    },
  };
}

describe("createPresenceSender — last requested status always reaches the server (OC-0451)", () => {
  beforeEach(() => {
    localStorage.clear();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "alice", avatar: null, role: "member" },
      serverName: "TestServer",
      motd: null,
      isAuthenticated: true,
    }));
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
            customStatus: undefined,
          } as never,
        ],
      ]),
      typingUsers: new Map(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  });

  it("re-arms the retry when the queued frame is answered RATE_LIMITED, so the latest status still lands", () => {
    vi.useFakeTimers();
    const { ws, sent, fireError } = createErrorableWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    try {
      // t=0s: "dnd" consumes the shared limiter's only token.
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload.status).toBe("dnd");

      // t=0s: a second change is queued behind the closed window.
      saveUserStatus("invisible");
      sender.send("invisible");
      expect(sent).toHaveLength(1);

      // t=11s: the retry fires (10s client window + the OC-0451 margin). The
      // server, whose window started when it received the first frame a few
      // ms later, still refuses it — RATE_LIMITED on the retry's own id.
      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.payload.status).toBe("invisible");
      fireError("RATE_LIMITED", "id-2");

      // The rejection must schedule another retry a full window out instead
      // of dropping the change: the client would otherwise show and save
      // "invisible" while the server (and everyone else) kept "dnd".
      vi.advanceTimersByTime(11_000);
      expect(sent).toHaveLength(3);
      expect(sent[2]!.payload.status).toBe("invisible");
    } finally {
      sender.destroy?.();
    }
  });

  it("does not re-arm for a RATE_LIMITED reply to another producer's frame", () => {
    vi.useFakeTimers();
    const { ws, sent, fireError } = createErrorableWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    try {
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(sent).toHaveLength(1);

      // An unrelated frame's rejection (a chat send, or a second limiter the
      // server refused) must not make this sender spam presence updates.
      fireError("RATE_LIMITED", "some-other-id");
      vi.advanceTimersByTime(30_000);
      expect(sent).toHaveLength(1);
    } finally {
      sender.destroy?.();
    }
  });
});

describe("createPresenceSender — custom_status survival across supersession (OC-0156)", () => {
  beforeEach(() => {
    localStorage.clear();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 1, username: "alice", avatar: null, role: "member" },
      serverName: "TestServer",
      motd: null,
      isAuthenticated: true,
    }));
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
            customStatus: undefined,
          } as never,
        ],
      ]),
      typingUsers: new Map(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  });

  it("does not drop a queued custom_status when a later plain status change supersedes it before the retry fires", () => {
    vi.useFakeTimers();
    const ws = createMockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    try {
      // t=0s: plain status change consumes the shared limiter's only token.
      // Mirrors UserBar.ts's onStatusChange, which persists the picked
      // status before calling sender.send(status) — the queued retry's
      // `loadUserStatus()` re-read depends on that.
      saveUserStatus("idle");
      sender.send("idle");
      expect(ws.send).toHaveBeenCalledOnce();
      expect((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
        type: "presence_update",
        payload: { status: "idle" },
      });
      (ws.send as ReturnType<typeof vi.fn>).mockClear();

      // t=2s: custom-status commit — window still closed, so it queues a
      // retry carrying "Working on OwnCord".
      vi.advanceTimersByTime(2_000);
      sender.send("idle", "Working on OwnCord");
      expect(ws.send).not.toHaveBeenCalled();

      // t=4s: a plain status change (customStatus === undefined) supersedes
      // the queued retry. Mirrors UserBar.ts's onStatusChange again.
      vi.advanceTimersByTime(2_000);
      saveUserStatus("dnd");
      sender.send("dnd");
      expect(ws.send).not.toHaveBeenCalled();

      // t=11s: the coalesced retry fires (10s client window + the OC-0451
      // margin that clears the server's receipt-measured window). It must
      // still carry the custom_status text committed at t=2s — the plain
      // "dnd" call at t=4s never mentioned custom_status and must not be
      // read as "clear it".
      vi.advanceTimersByTime(7_000);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMsg = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sentMsg.type).toBe("presence_update");
      expect(sentMsg.payload.status).toBe("dnd");
      expect(sentMsg.payload.custom_status).toBe("Working on OwnCord");
    } finally {
      sender.destroy?.();
    }
  });
});
