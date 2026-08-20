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

      // t=10s: the coalesced retry fires. It must still carry the
      // custom_status text committed at t=2s — the plain "dnd" call at t=4s
      // never mentioned custom_status and must not be read as "clear it".
      vi.advanceTimersByTime(6_000);

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
