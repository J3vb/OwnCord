import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted per file; the factories resolve to the shared handles
// exported from ./helpers/ws-mocks (see that module's doc comment).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient, type ConnectionState, type WsClientConfig } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";

const AUTH_OK = JSON.stringify({
  type: "auth_ok",
  payload: {
    user: { id: 1, username: "a", avatar: null, role: "admin" },
    server_name: "S",
    motd: "",
  },
});

function frame(seq: number, cseq?: number, extra = ""): string {
  const head = cseq === undefined ? "" : `"cseq":${cseq},`;
  return `{${head}"seq":${seq},"type":"typing","payload":{"channel_id":1${extra}}}`;
}

function dials(): number {
  return mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect").length;
}

function authFrames(): Array<{ last_seq: number }> {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "ws_send")
    .map(
      (c) =>
        JSON.parse((c[1] as { message: string }).message) as {
          type: string;
          payload: { last_seq: number };
        },
    )
    .filter((m) => m.type === "auth")
    .map((m) => m.payload);
}

describe("cseq gap detection", () => {
  let client: ReturnType<typeof createWsClient>;
  let sample = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    sample = 0;
    client = createWsClient({ random: () => sample });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  async function connectAndAuth(
    cfg: WsClientConfig = { host: "localhost:8443", token: "t" },
  ): Promise<void> {
    client.connect(cfg);
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", AUTH_OK);
  }

  it("resumes exactly once when cseq goes 1, 2, 4", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(11, 2));
    emitTauriEvent("ws-message", frame(13, 4));
    // A second gap on the same socket does not arm a second resume.
    emitTauriEvent("ws-message", frame(15, 6));

    await vi.advanceTimersByTimeAsync(999);
    expect(dials()).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(states).toContain("reconnecting");
    expect(dials()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(1);

    // It is a resume: the auth frame carries the last seq this socket saw.
    emitTauriEvent("ws-state", "open");
    expect(authFrames().at(-1)?.last_seq).toBe(15);
  });

  it("waits a random 1-5 s before resuming", async () => {
    sample = 1;
    await connectAndAuth();
    mockInvoke.mockClear();

    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(11, 3));

    await vi.advanceTimersByTimeAsync(4_990);
    expect(dials()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(dials()).toBe(1);
  });

  it("never resumes when the server sends no cseq", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    emitTauriEvent("ws-message", frame(10));
    emitTauriEvent("ws-message", frame(11));
    emitTauriEvent("ws-message", frame(40));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(0);
  });

  it("does not resume for a contiguous count", async () => {
    await connectAndAuth();
    mockInvoke.mockClear();

    for (let i = 1; i <= 5; i++) emitTauriEvent("ws-message", frame(100 + i * 3, i));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(0);
  });

  it("counts a frame dropped for size, so it is not read as a server gap", async () => {
    await connectAndAuth({ host: "localhost:8443", token: "t", maxMessageSizeBytes: 200 });
    mockInvoke.mockClear();

    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(11, 2, `,"pad":"${"x".repeat(400)}"`));
    expectConsole("warn", /\[ws\] Message exceeds size limit, dropping/);
    emitTauriEvent("ws-message", frame(12, 3));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(0);
  });

  it("starts the count again on a new socket", async () => {
    await connectAndAuth();
    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(11, 2));

    // The socket closes and the reconnect loop opens a new one.
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(2_000);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", AUTH_OK);
    mockInvoke.mockClear();

    emitTauriEvent("ws-message", frame(12, 1));
    emitTauriEvent("ws-message", frame(13, 2));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(0);
  });

  it("drops a pending gap resume when the socket closes first", async () => {
    await connectAndAuth();
    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(12, 3));

    // The socket dies before the jitter runs out; the reconnect loop owns the
    // redial, and the stale gap timer must not add a second one.
    emitTauriEvent("ws-state", "closed");
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(dials()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(1);
  });

  it("drops a pending gap resume on logout", async () => {
    await connectAndAuth();
    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(12, 3));

    client.disconnect();
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dials()).toBe(0);
  });

  it("finishes a resume cycle: the new socket's own count raises nothing", async () => {
    await connectAndAuth();
    emitTauriEvent("ws-message", frame(10, 1));
    emitTauriEvent("ws-message", frame(12, 3));
    await vi.advanceTimersByTimeAsync(1_010);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", AUTH_OK);
    mockInvoke.mockClear();

    emitTauriEvent("ws-message", frame(13, 1));
    emitTauriEvent("ws-message", frame(14, 2));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(dials()).toBe(0);
  });

  it("waits longer for gap resumes close together, and resets after a quiet minute", async () => {
    await connectAndAuth();
    const gapThenResume = async (): Promise<number> => {
      mockInvoke.mockClear();
      emitTauriEvent("ws-message", frame(1, 1));
      emitTauriEvent("ws-message", frame(2, 3));
      let waited = 0;
      while (dials() === 0 && waited < 40_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      emitTauriEvent("ws-state", "open");
      emitTauriEvent("ws-message", AUTH_OK);
      return waited;
    };
    expect(await gapThenResume()).toBe(1_000);
    expect(await gapThenResume()).toBe(5_000);
    expect(await gapThenResume()).toBe(15_000);
    expect(await gapThenResume()).toBe(15_000);

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(16_000);
      emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    }
    expect(await gapThenResume()).toBe(1_000);
  });

  it("leaves the redial to the liveness deadline when it fires during the wait", async () => {
    sample = 1;
    await connectAndAuth();
    emitTauriEvent("ws-message", frame(10, 1));
    // The gap is the last frame; the socket then goes silent.
    emitTauriEvent("ws-message", frame(12, 3));
    mockInvoke.mockClear();
    // Liveness only counts silence once a heartbeat ping is unanswered: the
    // 30 s heartbeat pings, and 15 s later the deadline gives up. The 5 s gap
    // timer fires first and redials; the liveness path must not add a second.
    await vi.advanceTimersByTimeAsync(80_000);
    expect(dials()).toBe(1);
  });
});
