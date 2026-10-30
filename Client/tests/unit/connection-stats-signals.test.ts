/**
 * Connection stats poller: quality thresholds, RTT selection, byte/packet
 * accounting, the audio-only loss and jitter sources, transfer rates and the
 * quality-change debounce lifecycle. Complements connection-stats.test.ts with
 * exact boundary values and exact computed figures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";

const { logMock, createLoggerMock } = vi.hoisted(() => {
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logMock, createLoggerMock: vi.fn(() => logMock) };
});

vi.mock("@lib/logger", () => ({ createLogger: createLoggerMock }));

import {
  createConnectionStatsPoller,
  qualityFromSignals,
  type ConnectionStats,
  type ConnectionStatsPoller,
  type QualityLevel,
} from "../../src/lib/voice/connectionStats";

type Entry = Record<string, unknown>;

/** A room whose subscriber transport answers with the entries `read()` returns. */
function liveRoom(read: () => Entry[], onRead?: () => void): Room {
  const room = {
    engine: {
      pcManager: {
        subscriber: {
          getStats: () => {
            onRead?.();
            return Promise.resolve(
              new Map(read().map((e, i) => [typeof e.id === "string" ? e.id : `e${String(i)}`, e])),
            );
          },
        },
      },
    },
  };
  return room as unknown as Room;
}

function cp(rttSeconds: number, extra: Entry = {}): Entry {
  return { type: "candidate-pair", currentRoundTripTime: rttSeconds, ...extra };
}

describe("connection stats logging", () => {
  it("names its logger 'connection-stats' so these messages are filterable", () => {
    expect(createLoggerMock).toHaveBeenCalledWith("connection-stats");
  });
});

describe("qualityFromSignals boundaries", () => {
  const cases: Array<[string, number, number, number, QualityLevel]> = [
    ["rtt just under 100", 99.9, 0, 0, "excellent"],
    ["rtt exactly 100", 100, 0, 0, "fair"],
    ["rtt just under 200", 199.9, 0, 0, "fair"],
    ["rtt exactly 200", 200, 0, 0, "poor"],
    ["rtt just under 400", 399.9, 0, 0, "poor"],
    ["rtt exactly 400", 400, 0, 0, "bad"],
    ["loss just under 1", 0, 0.99, 0, "excellent"],
    ["loss exactly 1", 0, 1, 0, "fair"],
    ["loss just under 5", 0, 4.99, 0, "fair"],
    ["loss exactly 5", 0, 5, 0, "poor"],
    ["loss just under 10", 0, 9.99, 0, "poor"],
    ["loss exactly 10", 0, 10, 0, "bad"],
    ["jitter just under 20", 0, 0, 19.9, "excellent"],
    ["jitter exactly 20", 0, 0, 20, "fair"],
    ["jitter just under 50", 0, 0, 49.9, "fair"],
    ["jitter exactly 50", 0, 0, 50, "poor"],
    ["jitter just under 100", 0, 0, 99.9, "poor"],
    ["jitter 99", 0, 0, 99, "poor"],
    ["jitter exactly 100", 0, 0, 100, "bad"],
  ];

  it.each(cases)("%s", (_label, rtt, loss, jitter, expected) => {
    expect(qualityFromSignals(rtt, loss, jitter)).toBe(expected);
  });

  it("reads the worst signal whichever position it is in", () => {
    expect(qualityFromSignals(150, 12, 30)).toBe("bad");
    expect(qualityFromSignals(500, 0, 30)).toBe("bad");
    expect(qualityFromSignals(250, 2, 30)).toBe("poor");
    expect(qualityFromSignals(30, 2, 60)).toBe("poor");
  });
});

describe("connection stats poller figures", () => {
  let poller: ConnectionStatsPoller;
  let updates: ConnectionStats[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    updates = [];
    logMock.info.mockClear();
    logMock.warn.mockClear();
  });

  afterEach(() => {
    poller?.stop();
    vi.useRealTimers();
  });

  function run(room: Room): void {
    poller = createConnectionStatsPoller(() => room);
    poller.onUpdate((s) => updates.push(s));
    poller.start();
  }

  it("keeps the lowest positive RTT whichever order the pairs arrive in", async () => {
    run(liveRoom(() => [cp(0.05, { id: "a" }), cp(0.2, { id: "b" })]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.rtt).toBeCloseTo(50, 5);
    poller.stop();

    run(liveRoom(() => [cp(0.2, { id: "a" }), cp(0.05, { id: "b" })]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[1]!.rtt).toBeCloseTo(50, 5);
  });

  it("does not let an unmeasured (zero) or negative RTT replace a measured one", async () => {
    run(liveRoom(() => [cp(0.08, { id: "a" }), cp(0, { id: "b" }), cp(-0.01, { id: "c" })]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.rtt).toBeCloseTo(80, 5);
  });

  it("reports zero RTT when the only pair is negative", async () => {
    run(liveRoom(() => [cp(-0.01, { id: "a" })]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.rtt).toBe(0);
  });

  it("totals are the largest bytes sent and received across candidate pairs", async () => {
    run(
      liveRoom(() => [
        cp(0.01, { id: "a", bytesSent: 5000, bytesReceived: 1000 }),
        cp(0.01, { id: "b", bytesSent: 1000, bytesReceived: 5000 }),
        cp(0.01, { id: "c", bytesSent: 2000, bytesReceived: 2000 }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.totalUp).toBe(5000);
    expect(updates[0]!.totalDown).toBe(5000);
  });

  it("counts packets only from outbound and inbound RTP entries", async () => {
    run(
      liveRoom(() => [
        cp(0.01, { id: "cp" }),
        { id: "o", type: "outbound-rtp", kind: "video", packetsSent: 30, bytesSent: 300 },
        { id: "i", type: "inbound-rtp", kind: "video", packetsReceived: 20, bytesReceived: 200 },
        { id: "dc", type: "data-channel", packetsSent: 77, packetsReceived: 88 },
        { id: "t", type: "transport", bytesSent: 9999, bytesReceived: 8888 },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.outPackets).toBe(30);
    expect(updates[0]!.inPackets).toBe(20);
    // Non-RTP entries add nothing to the transfer rate either: 300 B / 2 s.
    expect(updates[0]!.outRate).toBe(150);
    expect(updates[0]!.inRate).toBe(100);
  });

  it("computes exact transfer rates from the byte deltas between polls", async () => {
    let out = 10_000;
    let inn = 4_000;
    run(
      liveRoom(() => [
        { id: "o", type: "outbound-rtp", kind: "video", packetsSent: 1, bytesSent: out },
        { id: "i", type: "inbound-rtp", kind: "video", packetsReceived: 1, bytesReceived: inn },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.outRate).toBe(5000);
    expect(updates[0]!.inRate).toBe(2000);

    out = 30_000;
    inn = 10_000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[1]!.outRate).toBe(10_000);
    expect(updates[1]!.inRate).toBe(3000);
  });

  it("reports zero rates, not infinite ones, when no time has passed since the last sample", async () => {
    const t0 = Date.now();
    run(
      liveRoom(
        () => [
          { id: "o", type: "outbound-rtp", kind: "video", packetsSent: 1, bytesSent: 8000 },
          { id: "i", type: "inbound-rtp", kind: "video", packetsReceived: 1, bytesReceived: 6000 },
        ],
        () => vi.setSystemTime(t0),
      ),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.outRate).toBe(0);
    expect(updates[0]!.inRate).toBe(0);
  });

  it("takes the worst jitter among audio streams, not the last one seen", async () => {
    run(
      liveRoom(() => [
        cp(0.01, { id: "cp" }),
        {
          id: "a1",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 500,
          packetsLost: 0,
          jitter: 0.08,
        },
        {
          id: "a2",
          type: "inbound-rtp",
          kind: "audio",
          packetsReceived: 500,
          packetsLost: 0,
          jitter: 0.01,
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.jitter).toBeCloseTo(80, 5);
    expect(updates[0]!.quality).toBe("poor");
  });

  describe("the far end's audio report of our stream", () => {
    const base = (): Entry[] => [
      cp(0.01, { id: "cp" }),
      { id: "out-audio", type: "outbound-rtp", kind: "audio", packetsSent: 1000 },
      { id: "out-video", type: "outbound-rtp", kind: "video", packetsSent: 1000 },
    ];

    it("is used when it is a remote-inbound audio entry", async () => {
      run(
        liveRoom(() => [
          ...base(),
          {
            id: "ri",
            type: "remote-inbound-rtp",
            kind: "audio",
            localId: "out-audio",
            packetsLost: 120,
            jitter: 0.03,
          },
        ]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates[0]!.loss).toBeCloseTo(12, 5);
      expect(updates[0]!.jitter).toBeCloseTo(30, 5);
    });

    it("ignores a remote-inbound video entry even when it points at an audio stream", async () => {
      run(
        liveRoom(() => [
          ...base(),
          {
            id: "ri",
            type: "remote-inbound-rtp",
            kind: "video",
            localId: "out-audio",
            packetsLost: 500,
            jitter: 0.5,
          },
        ]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates[0]!.loss).toBe(0);
      expect(updates[0]!.jitter).toBe(0);
      expect(updates[0]!.quality).toBe("excellent");
    });

    it("ignores an audio entry that is not a remote-inbound report", async () => {
      run(
        liveRoom(() => [
          ...base(),
          {
            id: "other",
            type: "outbound-rtp",
            kind: "audio",
            localId: "out-audio",
            packetsSent: 10,
            packetsLost: 500,
            jitter: 0.5,
          },
        ]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates[0]!.loss).toBe(0);
      expect(updates[0]!.jitter).toBe(0);
    });

    it("does not match a report to an outbound video stream", async () => {
      run(
        liveRoom(() => [
          ...base(),
          {
            id: "ri",
            type: "remote-inbound-rtp",
            kind: "audio",
            localId: "out-video",
            packetsLost: 500,
            jitter: 0.5,
          },
        ]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates[0]!.loss).toBe(0);
      expect(updates[0]!.jitter).toBe(0);
    });
  });

  it("logs when the transport statistics cannot be read, and returns no update", async () => {
    const room = {
      engine: {
        pcManager: {
          subscriber: { getStats: () => Promise.reject(new Error("sdk changed")) },
        },
      },
    } as unknown as Room;
    run(room);
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalledWith(
      "Failed to access peer connection stats — LiveKit SDK internals may have changed",
    );
  });

  it("logs the poller starting and stopping once each", () => {
    run(liveRoom(() => []));
    poller.start();
    expect(logMock.info).toHaveBeenCalledTimes(1);
    expect(logMock.info).toHaveBeenCalledWith("Starting connection stats poller");
    poller.stop();
    expect(logMock.info).toHaveBeenLastCalledWith("Stopping connection stats poller");
  });
});

describe("connection stats quality-change debounce", () => {
  let poller: ConnectionStatsPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    poller?.stop();
    vi.useRealTimers();
  });

  it("arms one timer at the first poll that sees a change, not one per poll", async () => {
    let rtt = 0.5;
    const changes: Array<[QualityLevel, QualityLevel]> = [];
    poller = createConnectionStatsPoller(() => liveRoom(() => [cp(rtt, { id: "a" })]));
    poller.onQualityChanged((q, p) => changes.push([q, p]));
    poller.start();

    await vi.advanceTimersByTimeAsync(2000); // poll 1: bad, timer due at 5000
    await vi.advanceTimersByTimeAsync(2000); // poll 2: still bad
    await vi.advanceTimersByTimeAsync(1000); // 5000: first timer fires
    expect(changes).toEqual([["bad", "excellent"]]);

    rtt = 0.01;
    await vi.advanceTimersByTimeAsync(1000); // poll 3 at 6000: back to excellent
    await vi.advanceTimersByTimeAsync(1500); // 7500: the new change is still debouncing
    expect(changes).toEqual([["bad", "excellent"]]);

    await vi.advanceTimersByTimeAsync(1600); // 9100: its own timer has fired
    expect(changes).toEqual([
      ["bad", "excellent"],
      ["excellent", "bad"],
    ]);
  });

  it("a stopped and restarted poller starts a fresh debounce window", async () => {
    const changes: Array<[QualityLevel, QualityLevel]> = [];
    poller = createConnectionStatsPoller(() => liveRoom(() => [cp(0.5, { id: "a" })]));
    poller.onQualityChanged((q, p) => changes.push([q, p]));
    poller.start();

    await vi.advanceTimersByTimeAsync(2000); // poll at 2000: bad, timer due at 5000
    await vi.advanceTimersByTimeAsync(500);
    poller.stop();
    poller.start();

    await vi.advanceTimersByTimeAsync(2000); // poll at 4500: bad again, new timer due at 7500
    await vi.advanceTimersByTimeAsync(600); // 5100: the old timer must be gone
    expect(changes).toEqual([]);

    await vi.advanceTimersByTimeAsync(2500); // 7600
    expect(changes).toEqual([["bad", "excellent"]]);
  });

  it("starts the window at the poll that sees the change, not at an earlier steady poll", async () => {
    let rtt = 0.01;
    const changes: Array<[QualityLevel, QualityLevel]> = [];
    poller = createConnectionStatsPoller(() => liveRoom(() => [cp(rtt, { id: "a" })]));
    poller.onQualityChanged((q, p) => changes.push([q, p]));
    poller.start();

    await vi.advanceTimersByTimeAsync(2000); // poll 1 at 2000: unchanged
    rtt = 0.5;
    await vi.advanceTimersByTimeAsync(2000); // poll 2 at 4000: bad, window due at 7000
    await vi.advanceTimersByTimeAsync(1500); // 5500
    expect(changes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1600); // 7100
    expect(changes).toEqual([["bad", "excellent"]]);
  });

  it("drops a pending window when the quality is back before it elapses, so the next change gets a full one", async () => {
    // Polls that overlap: the answers arrive late and out of step with the
    // 2000 ms ticks, which is what lets a stale window outlive its poll.
    const pending: Array<(entries: Map<string, Entry>) => void> = [];
    const room = {
      engine: {
        pcManager: {
          subscriber: {
            getStats: () => new Promise<Map<string, Entry>>((resolve) => pending.push(resolve)),
          },
        },
      },
    } as unknown as Room;
    const answer = (index: number, rtt: number): void => {
      pending[index]!(new Map([["a", cp(rtt, { id: "a" })]]));
    };
    const changes: Array<[QualityLevel, QualityLevel]> = [];
    poller = createConnectionStatsPoller(() => room);
    poller.onQualityChanged((q, p) => changes.push([q, p]));
    poller.start();

    await vi.advanceTimersByTimeAsync(2000); // poll 1 asks
    await vi.advanceTimersByTimeAsync(2000); // poll 2 asks (4000)
    answer(0, 0.5); // bad: window due at 7000
    await vi.advanceTimersByTimeAsync(0);
    answer(1, 0.01); // back to excellent: the window is dropped
    await vi.advanceTimersByTimeAsync(2000); // poll 3 asks (6000)
    answer(2, 0.5); // bad again: a fresh window, due at 9000
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1500); // 7500
    expect(changes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1600); // 9100
    expect(changes).toEqual([["bad", "excellent"]]);
  });
});
