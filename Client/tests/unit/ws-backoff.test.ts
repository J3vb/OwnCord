import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SocketCertEvent,
  SocketConnection,
  SocketConnectionState,
  SocketRetryHint,
} from "../../src/platform/contracts/socket";
import { createWsClient, type WsClient } from "../../src/lib/ws";

const { createTransport } = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("../../src/platform/desktop", () => ({
  desktop: { socket: { create: createTransport } },
}));
vi.mock("../../src/lib/logger", () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Independent transport callbacks let many real WsClients share one outage.
function transportHarness() {
  let state: (value: SocketConnectionState, hint?: SocketRetryHint) => void = () => {};
  let message: (text: string) => void = () => {};
  let mismatch: (event: SocketCertEvent) => void = () => {};
  const transport: SocketConnection = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    acceptCertificate: vi.fn(async () => {}),
    startCertListener: vi.fn(async () => {}),
    onStateChange(handler) {
      state = handler;
      return () => {};
    },
    onMessage(handler) {
      message = handler;
      return () => {};
    },
    onCertMismatch(handler) {
      mismatch = handler;
      return () => {};
    },
    onCertFirstUse: () => () => {},
  };
  createTransport.mockReturnValueOnce(transport);
  return {
    transport,
    close: (retryAfterMs?: number) => state("disconnected", { retryAfterMs }),
    authenticate() {
      state("connected");
      message(JSON.stringify({ type: "auth_ok", payload: { replay_source: "none" } }));
    },
    mismatch: () => mismatch({ host: "example.com", fingerprint: "new", status: "mismatch" }),
  };
}

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const config = { host: "example.com", token: "test", maxReconnectDelayMs: 4000 };
let clients: WsClient[];
// Inject the timer pair, so scheduling and cancellation use the same clock.
function fakeClock() {
  return {
    setTimeout: vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
  };
}
function client(options: Parameters<typeof createWsClient>[0] = {}) {
  const result = createWsClient(options);
  clients.push(result);
  result.connect(config);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  clients = [];
  createTransport.mockReset();
});
afterEach(() => {
  for (const instance of clients) instance.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RI-05 reconnect spreading", () => {
  it("spreads 256 clients across a shared outage and recovery, including at the cap", async () => {
    const clock = fakeClock();
    const random = seededRandom(5);
    const attempts: number[][] = [];
    const peers = Array.from({ length: 256 }, () => {
      const peer = transportHarness();
      const instance = client({ clock, random });
      const times: number[] = [];
      attempts.push(times);
      peer.authenticate();
      vi.mocked(peer.transport.connect).mockImplementation(async () => {
        times.push(Date.now());
        if (Date.now() < 20_000) {
          // A failed handshake reports a disconnect on its own microtask.
          queueMicrotask(() => peer.close());
        } else {
          peer.authenticate();
        }
      });
      return { ...peer, instance };
    });

    // All clients lose their established connection at exactly t=0.
    for (const peer of peers) peer.close();
    await vi.advanceTimersByTimeAsync(24_000);

    expect(peers.every(({ instance }) => instance.getState() === "connected")).toBe(true);
    const firstAttempts = attempts.map((times) => times[0]!);
    expect(Math.min(...firstAttempts)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...firstAttempts)).toBeLessThanOrEqual(1000);
    const buckets = Array.from(
      { length: 10 },
      (_, bucket) =>
        firstAttempts.filter((time) => Math.min(9, Math.floor((time - 500) / 50)) === bucket)
          .length,
    );
    expect(buckets.every((count) => count > 0)).toBe(true);
    expect(Math.max(...buckets)).toBeLessThan(50); // no synchronized retry spike

    const cappedDelays: number[] = [];
    for (const times of attempts) {
      expect(times.length).toBeGreaterThan(5); // reaches the cap during the outage
      let previous = 0;
      times.forEach((time, index) => {
        const delay = time - previous;
        const ceiling = Math.min(1000 * 2 ** index, config.maxReconnectDelayMs);
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
        if (index >= 2) cappedDelays.push(delay);
        previous = time;
      });
      expect(times.at(-1)).toBeGreaterThanOrEqual(20_000);
      expect(times.at(-1)).toBeLessThanOrEqual(24_000);
    }
    expect(new Set(cappedDelays).size).toBeGreaterThan(100);
    expect(new Set(attempts.map((times) => times.at(-1))).size).toBeGreaterThan(100);
    expect(clock.setTimeout.mock.calls.length).toBeGreaterThan(256);
    for (const [, delay] of clock.setTimeout.mock.calls) {
      expect(delay).toBeLessThanOrEqual(config.maxReconnectDelayMs);
    }
  });

  it.each([0, 0.5, 1])("keeps exponential bounds and the cap at random=%s", async (sample) => {
    const peer = transportHarness();
    const clock = fakeClock();
    client({ random: () => sample, clock });
    // No auth_ok between failures: the exponent must actually increase.
    for (let attempt = 0; attempt < 10; attempt++) {
      peer.close();
      const ceiling = Math.min(1000 * 2 ** attempt, 4000);
      const expected = ceiling / 2 + (sample * ceiling) / 2;
      expect(clock.setTimeout.mock.lastCall?.[1]).toBe(expected);
      const before = vi.mocked(peer.transport.connect).mock.calls.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(peer.transport.connect).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(peer.transport.connect).toHaveBeenCalledTimes(before + 1);
    }
  });

  it("uses production randomness when none is injected", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const peer = transportHarness();
    const clock = fakeClock();
    client({ clock });
    peer.close();
    expect(clock.setTimeout.mock.lastCall?.[1]).toBe(625);
  });

  it.each([
    [750, 750],
    [2500, 2500],
    [60_000, 4000],
    [0, 500],
    [-1, 500],
    [NaN, 500],
    [Infinity, 500],
    [undefined, 500],
  ])("bounds the transport retry hint %s to a delay of %s", async (hint, delay) => {
    const peer = transportHarness();
    const clock = fakeClock();
    client({ random: () => 0, clock });
    peer.close(hint);
    expect(clock.setTimeout.mock.lastCall?.[1]).toBe(delay);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(peer.transport.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(peer.transport.connect).toHaveBeenCalledTimes(2);
    // Hints apply only to the disconnect that supplied them.
    peer.close();
    expect(clock.setTimeout.mock.lastCall?.[1]).toBe(1000);
  });

  it.each(["logout", "certificate mismatch"])(
    "%s cancels a pending retry synchronously",
    async (reason) => {
      const peer = transportHarness();
      const clock = fakeClock();
      const instance = client({ random: () => 0.75, clock });
      peer.close(3000);
      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(1);
      if (reason === "logout") instance.disconnect();
      else peer.mismatch();
      expect(instance.getState()).toBe("disconnected");
      expect(clock.clearTimeout).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      // Subsequent transport closes cannot restart the blocked policy.
      peer.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(peer.transport.connect).toHaveBeenCalledTimes(1);
      expect(clock.setTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it("resets the jitter range on authentication and on a fresh login", async () => {
    const peer = transportHarness();
    const clock = fakeClock();
    const instance = client({ random: () => 0.5, clock });
    for (const reset of [
      () => peer.authenticate(),
      () => {
        instance.disconnect();
        instance.connect(config);
      },
    ]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        peer.close();
        await vi.advanceTimersByTimeAsync(4000);
      }
      expect(clock.setTimeout.mock.lastCall?.[1]).toBe(3000);
      reset();
      peer.close();
      expect(clock.setTimeout.mock.lastCall?.[1]).toBe(750);
      await vi.advanceTimersByTimeAsync(750);
      peer.authenticate();
    }
  });
});
