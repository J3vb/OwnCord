// `custom_status_expires_in` on presence_update (the "Clear after" choice):
// sent only with a non-empty custom status, carried by a limiter retry, and
// mirrored onto your own member entry as `customStatusExpiresAt`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  membersStore,
  updatePresence,
  applyPresenceBatch,
  type Member,
} from "@stores/members.store";
import { createPresenceSender } from "@lib/presence/presence";
import { createPresenceLimiter } from "@lib/net/rateLimiter";
import {
  loadStatusTimer,
  loadUserStatus,
  saveStatusTimer,
  saveUserStatus,
} from "@lib/presence/userStatus";
import type { WsClient } from "@lib/ws";
import { signInAs } from "../helpers/storeSeeds";

type Frame = { type: string; payload: Record<string, unknown> };

function mockWs(): { ws: WsClient; sent: Frame[] } {
  const sent: Frame[] = [];
  let n = 0;
  const ws = {
    send: vi.fn((msg: Frame) => {
      sent.push(msg);
      return `id-${++n}`;
    }),
    on: vi.fn().mockReturnValue(() => {}),
  } as unknown as WsClient;
  return { ws, sent };
}

const own = (): Member | undefined => membersStore.getState().members.get(7);

describe("presence_update custom_status_expires_in", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    signInAs(
      { id: 7, username: "alice", avatar: null, role: "member" },
      { token: "t", serverName: "S" },
    );
    membersStore.setState((p) => ({
      ...p,
      members: new Map([[7, { id: 7, username: "alice", status: "online" } as never]]),
    }));
    membersStore.flush();
  });

  afterEach(() => {
    vi.useRealTimers();
    membersStore.setState((p) => ({ ...p, members: new Map() }));
  });

  it("sends the seconds with the text and records the instant on our own entry", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online", "in a meeting", 3600);
    expect(sent[0]!.payload).toEqual({
      status: "online",
      custom_status: "in a meeting",
      custom_status_expires_in: 3600,
    });
    expect(own()?.customStatusExpiresAt).toBe("2026-10-17T11:00:00.000Z");
    sender.destroy();
  });

  it("leaves the field out for Don't clear and records no expiry", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online", "hi");
    expect(sent[0]!.payload).toEqual({ status: "online", custom_status: "hi" });
    expect(own()?.customStatusExpiresAt).toBeNull();
    sender.destroy();
  });

  it("never sends it without text (the server refuses that frame)", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online", "", 3600);
    expect(sent[0]!.payload).toEqual({ status: "online", custom_status: "" });
    sender.destroy();
  });

  it("a bare status flip says nothing about the expiry", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online", "hi", 600);
    updatePresence(7, "online", undefined);
    vi.advanceTimersByTime(11_000); // the limiter's window has reopened
    sender.send("dnd");
    expect(sent[1]!.payload).toEqual({ status: "dnd" });
    expect(own()?.customStatusExpiresAt).toBe("2026-10-17T10:10:00.000Z");
    sender.destroy();
  });

  it("a limiter retry carries the expiry, and so does a status flip coalescing onto it", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online"); // takes the token
    sender.send("online", "later", 1800); // queued behind the limiter
    saveUserStatus("dnd");
    sender.send("dnd"); // inherits the queued text and its expiry
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(12_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload).toEqual({
      status: "dnd",
      custom_status: "later",
      custom_status_expires_in: 1800,
    });
    sender.destroy();
  });

  it("a new text from the server drops our old expiry, the same text keeps it", () => {
    const { ws } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    sender.send("online", "hi", 600);
    membersStore.flush();
    updatePresence(7, "online", "hi"); // the echo of our own change
    expect(own()?.customStatusExpiresAt).toBe("2026-10-17T10:10:00.000Z");
    updatePresence(7, "online", "other device"); // another device set new text
    expect(own()?.customStatusExpiresAt).toBeNull();

    updatePresence(7, "online", "back", "2026-10-17T12:00:00Z");
    applyPresenceBatch([{ user_id: 7, status: "online", custom_status: "back" }], false);
    expect(own()?.customStatusExpiresAt).toBe("2026-10-17T12:00:00Z");
    applyPresenceBatch([{ user_id: 7, status: "online", custom_status: null }], false);
    expect(own()?.customStatusExpiresAt).toBeNull();
    sender.destroy();
  });

  it("a TIMED_OUT rollback keeps a running status timer", () => {
    const { ws, sent } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    saveUserStatus("dnd");
    saveStatusTimer("dnd", Date.now() + 3_600_000);
    updatePresence(7, "dnd");
    membersStore.flush();

    sender.send("dnd", "heads down"); // refused: the user is timed out
    expect(sent).toHaveLength(1);
    sender.rollbackRefused("id-1");

    expect(loadUserStatus()).toBe("dnd");
    expect(loadStatusTimer()).toEqual({ status: "dnd", until: Date.now() + 3_600_000 });
    expect(own()?.customStatus).toBeNull();
    sender.destroy();
  });

  it("a rollback that does change the status still ends its timer", () => {
    const { ws } = mockWs();
    const sender = createPresenceSender(ws, createPresenceLimiter());
    saveUserStatus("online");
    sender.send("dnd", "x"); // optimistic: members entry dnd, baseline online
    saveUserStatus("dnd");
    saveStatusTimer("dnd", Date.now() + 3_600_000);
    sender.rollbackRefused("id-1");
    expect(loadUserStatus()).toBe("online");
    expect(loadStatusTimer()).toBeNull();
    sender.destroy();
  });
});
