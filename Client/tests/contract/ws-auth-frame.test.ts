// CONTRACT TEST. Pins the exact key set of the `auth` frame that
// Client/src/lib/ws.ts sends as the first message after the WebSocket opens
// (ws.ts:441-453) -- the client side of the same wire contract a sibling Go
// test freezes for the server. B2-2 added the `epoch` field (the wire epoch
// this client speaks, PROTOCOL_EPOCH from protocolTypes.ts); the key sets
// below include it deliberately. Any further field MUST fail here until it is
// added on purpose. Extend this file, do not replace or delete it.
//
// Assertions compare exact key sets (sorted Object.keys -- key order has no
// wire meaning), never toHaveProperty, so an unexpected added key fails just
// as loudly as a missing one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted per file; the factories resolve to the shared handles
// exported from ../unit/helpers/ws-mocks (see that module's doc comment --
// it is shared across all ws-*.test.ts files, this one included).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("../unit/helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("../unit/helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "../unit/helpers/ws-mocks";
import { createWsClient, setActiveChannelProvider } from "../../src/lib/ws";
import { PROTOCOL_EPOCH } from "../../src/lib/protocolTypes";

/** Parses the most recently sent `auth` frame (envelope + payload) from ws_send. */
function getAuthFrame(): { type: string; payload: Record<string, unknown> } {
  const authCall = mockInvoke.mock.calls.find(
    (c) =>
      c[0] === "ws_send" &&
      typeof c[1]?.message === "string" &&
      (c[1].message as string).includes('"type":"auth"'),
  );
  expect(authCall).toBeDefined();
  return JSON.parse((authCall![1] as { message: string }).message) as {
    type: string;
    payload: Record<string, unknown>;
  };
}

describe("contract: auth frame key set (epoch 1)", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    // activeChannelProvider is a module-level singleton (registered once at
    // app bootstrap in dispatcher.ts) -- reset it so state doesn't leak
    // across tests/files.
    setActiveChannelProvider(null);
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    setActiveChannelProvider(null);
    vi.useRealTimers();
  });

  it("fresh connect: envelope keys are exactly [type, payload, id], payload keys exactly [token, last_seq, epoch]", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    const frame = getAuthFrame();
    // send() (ws.ts:631-637) wraps every outgoing message with a correlation
    // `id` via `{ ...msg, id }` -- that's a generic per-send addition, not
    // part of the auth-specific payload contract, but it IS part of what
    // actually goes over the wire, so the envelope pin has three keys, not
    // the two the auth message literal at ws.ts:446-453 has on its own.
    expect(Object.keys(frame).sort()).toEqual(["id", "payload", "type"]);
    expect(frame.type).toBe("auth");
    expect(Object.keys(frame.payload).sort()).toEqual(["epoch", "last_seq", "token"]);
    expect(frame.payload.token).toBe("t");
    expect(frame.payload.last_seq).toBe(0);
    expect(frame.payload.epoch).toBe(PROTOCOL_EPOCH);
    expect(PROTOCOL_EPOCH).toBe(1);
  });

  it("resume with a registered active-channel provider: payload keys exactly [token, last_seq, active_channel_id, epoch]", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 7,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    setActiveChannelProvider(() => 42);

    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const frame = getAuthFrame();
    expect(Object.keys(frame.payload).sort()).toEqual([
      "active_channel_id",
      "epoch",
      "last_seq",
      "token",
    ]);
    expect(frame.payload.last_seq).toBe(7);
    expect(frame.payload.active_channel_id).toBe(42);
  });

  it("resume without a provider registered: payload keys stay exactly [token, last_seq, epoch]", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 3,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // No setActiveChannelProvider call -- stays null from beforeEach reset.
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");

    const frame = getAuthFrame();
    expect(Object.keys(frame.payload).sort()).toEqual(["epoch", "last_seq", "token"]);
    expect(frame.payload.last_seq).toBe(3);
  });
});
