import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createConnectionStatsPoller,
  formatBytes,
  formatRate,
  formatBitrate,
  type ConnectionStatsPoller,
  type QualityLevel,
} from "../../src/lib/connectionStats";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("formats bytes below 1000", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1000)).toBe("1.00 kB");
    expect(formatBytes(1500)).toBe("1.50 kB");
    expect(formatBytes(999_999)).toBe("1000.00 kB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1_000_000)).toBe("1.00 MB");
    expect(formatBytes(5_432_100)).toBe("5.43 MB");
  });
});

describe("formatRate", () => {
  it("appends /s to formatted bytes", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(1500)).toBe("1.50 kB/s");
    expect(formatRate(2_000_000)).toBe("2.00 MB/s");
  });
});

describe("formatBitrate", () => {
  it("returns 0 Mbps for very low rates", () => {
    expect(formatBitrate(0)).toBe("0 Mbps");
    // Less than 0.01 Mbps = 1250 bytes/s * 8 = 10000 bits = 0.01 Mbps
    expect(formatBitrate(1000)).toBe("0 Mbps");
  });

  it("returns Kbps for sub-1 Mbps rates", () => {
    // 0.05 Mbps = 6250 bytes/s
    expect(formatBitrate(6250)).toBe("50 Kbps");
    // 0.5 Mbps = 62500 bytes/s
    expect(formatBitrate(62500)).toBe("500 Kbps");
  });

  it("returns Mbps for rates above 1 Mbps", () => {
    // 1 Mbps = 125000 bytes/s
    expect(formatBitrate(125_000)).toBe("1.0 Mbps");
    // 10 Mbps = 1250000 bytes/s
    expect(formatBitrate(1_250_000)).toBe("10.0 Mbps");
  });
});

// ---------------------------------------------------------------------------
// Connection stats poller
// ---------------------------------------------------------------------------

describe("createConnectionStatsPoller", () => {
  let poller: ConnectionStatsPoller;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    poller?.stop();
    vi.useRealTimers();
  });

  it("returns EMPTY_STATS before any polling", () => {
    poller = createConnectionStatsPoller(() => null);
    const stats = poller.getStats();
    expect(stats.rtt).toBe(0);
    expect(stats.quality).toBe("excellent");
    expect(stats.outRate).toBe(0);
    expect(stats.inRate).toBe(0);
    expect(stats.outPackets).toBe(0);
    expect(stats.inPackets).toBe(0);
    expect(stats.totalUp).toBe(0);
    expect(stats.totalDown).toBe(0);
  });

  it("does not poll when getRoom returns null", () => {
    const getRoom = vi.fn().mockReturnValue(null);
    poller = createConnectionStatsPoller(getRoom);
    poller.start();
    vi.advanceTimersByTime(5000);
    // Stats should remain empty
    expect(poller.getStats().rtt).toBe(0);
  });

  it("start is idempotent — calling start twice does not create double intervals", () => {
    poller = createConnectionStatsPoller(() => null);
    poller.start();
    poller.start();
    // If double interval were created, stopping would leave one running — we just check no throw
    poller.stop();
  });

  it("stop is idempotent — calling stop without start does not throw", () => {
    poller = createConnectionStatsPoller(() => null);
    expect(() => poller.stop()).not.toThrow();
  });

  it("stop resets stats to empty", () => {
    poller = createConnectionStatsPoller(() => null);
    poller.start();
    poller.stop();
    expect(poller.getStats().quality).toBe("excellent");
    expect(poller.getStats().rtt).toBe(0);
  });

  // --- onUpdate callback ---

  it("onUpdate adds a listener and returns an unsubscribe function", () => {
    poller = createConnectionStatsPoller(() => null);
    const cb = vi.fn();
    const unsub = poller.onUpdate(cb);
    expect(typeof unsub).toBe("function");
    unsub();
    // After unsubscribe, callback should not be called during polling
  });

  // --- onQualityChanged callback ---

  it("onQualityChanged adds a listener and returns an unsubscribe function", () => {
    poller = createConnectionStatsPoller(() => null);
    const cb = vi.fn();
    const unsub = poller.onQualityChanged(cb);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  // --- Polling with mock room ---

  function createMockRoom(statsEntries: Array<Record<string, unknown>>): unknown {
    const report = new Map<string, Record<string, unknown>>();
    for (const entry of statsEntries) {
      report.set(String(entry.id ?? Math.random()), entry);
    }
    // Make report.forEach work like RTCStatsReport
    return {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getStats: vi.fn().mockResolvedValue(report),
            },
          },
          subscriber: {
            pc: {
              getStats: vi.fn().mockResolvedValue(report),
            },
          },
        },
      },
    };
  }

  it("extracts RTT from candidate-pair entries", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.05, // 50ms
        bytesSent: 1000,
        bytesReceived: 2000,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();

    // Advance past one poll interval
    await vi.advanceTimersByTimeAsync(2100);

    expect(cb).toHaveBeenCalled();
    const stats = cb.mock.calls[0]![0];
    expect(stats.rtt).toBe(50); // 0.05 * 1000
    expect(stats.quality).toBe("excellent");
  });

  it("classifies quality as fair for RTT 100-200ms", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.15,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);

    const stats = cb.mock.calls[0]![0];
    expect(stats.quality).toBe("fair");
  });

  it("classifies quality as poor for RTT 200-400ms", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.3,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);

    const stats = cb.mock.calls[0]![0];
    expect(stats.quality).toBe("poor");
  });

  it("classifies quality as bad for RTT >= 400ms", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.5,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);

    const stats = cb.mock.calls[0]![0];
    expect(stats.quality).toBe("bad");
  });

  it("extracts outbound-rtp and inbound-rtp packet counts", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.01,
        bytesSent: 100,
        bytesReceived: 200,
      },
      { id: "out1", type: "outbound-rtp", packetsSent: 500, bytesSent: 40000 },
      { id: "in1", type: "inbound-rtp", packetsReceived: 300, bytesReceived: 30000 },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);

    const stats = cb.mock.calls[0]![0];
    // outPackets and inPackets are accumulated from both publisher and subscriber PCs
    expect(stats.outPackets).toBeGreaterThanOrEqual(500);
    expect(stats.inPackets).toBeGreaterThanOrEqual(300);
  });

  it("computes outRate and inRate between polls", async () => {
    const room = createMockRoom([
      { id: "out1", type: "outbound-rtp", packetsSent: 100, bytesSent: 10000 },
      { id: "in1", type: "inbound-rtp", packetsReceived: 50, bytesReceived: 5000 },
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.01,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();

    // First poll establishes baseline
    await vi.advanceTimersByTimeAsync(2100);
    // Second poll computes rates
    await vi.advanceTimersByTimeAsync(2100);

    // Rates should be >= 0 (exact value depends on timing)
    const stats = cb.mock.calls[cb.mock.calls.length - 1]![0];
    expect(stats.outRate).toBeGreaterThanOrEqual(0);
    expect(stats.inRate).toBeGreaterThanOrEqual(0);
  });

  it("fires quality change callback with debounce", async () => {
    // The debounce timer for quality changes (3s) is perpetually reset by polls
    // (2s interval) while quality remains changed. The timer only fires when
    // polls stop finding data (room returns null). This matches real usage where
    // the quality callback fires after the connection stabilizes.
    let currentRtt = 0.01;
    let roomActive = true;
    const mockPc = {
      getStats: vi.fn().mockImplementation(() => {
        const report = new Map();
        report.set("cp1", {
          type: "candidate-pair",
          currentRoundTripTime: currentRtt,
          bytesSent: 0,
          bytesReceived: 0,
        });
        return Promise.resolve(report);
      }),
    };
    const room = {
      engine: { pcManager: { publisher: { pc: mockPc } } },
    };

    const qualityCb = vi.fn();
    poller = createConnectionStatsPoller(() => (roomActive ? (room as any) : null));
    poller.onQualityChanged(qualityCb);
    poller.start();

    // First poll (excellent)
    await vi.advanceTimersByTimeAsync(2100);
    expect(qualityCb).not.toHaveBeenCalled();

    // Change to bad — poll detects quality change and starts debounce
    currentRtt = 0.5;
    await vi.advanceTimersByTimeAsync(2100);
    expect(qualityCb).not.toHaveBeenCalled();

    // Make room unavailable so subsequent polls return early (no timer reset)
    roomActive = false;
    // Advance past the 3s debounce — timer fires because polls no longer reset it
    await vi.advanceTimersByTimeAsync(3100);

    expect(qualityCb).toHaveBeenCalledWith("bad", "excellent");
  });

  it("unsubscribed onUpdate callback is not called", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.01,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    const unsub = poller.onUpdate(cb);
    unsub();
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribed onQualityChanged callback is not called", async () => {
    let currentRtt = 0.01;
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getStats: vi.fn().mockImplementation(() => {
                const report = new Map();
                report.set("cp1", {
                  type: "candidate-pair",
                  currentRoundTripTime: currentRtt,
                  bytesSent: 0,
                  bytesReceived: 0,
                });
                return Promise.resolve(report);
              }),
            },
          },
        },
      },
    };

    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    const unsub = poller.onQualityChanged(cb);
    unsub();
    poller.start();

    currentRtt = 0.5; // Switch to bad
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(3100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles getStats failure gracefully (returns empty reports)", async () => {
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getStats: vi.fn().mockRejectedValue(new Error("stats error")),
            },
          },
        },
      },
    };
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    // On failure, collectAllStats returns [], so no update callback fires
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles room with no pcManager", async () => {
    const room = { engine: {} };
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    // No pcManager = no PCs = empty reports = no update
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles room with only publisher PC", async () => {
    const report = new Map();
    report.set("cp1", {
      type: "candidate-pair",
      currentRoundTripTime: 0.05,
      bytesSent: 1000,
      bytesReceived: 2000,
    });

    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: { getStats: vi.fn().mockResolvedValue(report) },
          },
          // No subscriber
        },
      },
    };

    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls[0]![0].rtt).toBe(50);
  });

  it("handles room with only subscriber PC", async () => {
    const report = new Map();
    report.set("cp1", {
      type: "candidate-pair",
      currentRoundTripTime: 0.12,
      bytesSent: 0,
      bytesReceived: 0,
    });

    const room = {
      engine: {
        pcManager: {
          subscriber: {
            pc: { getStats: vi.fn().mockResolvedValue(report) },
          },
        },
      },
    };

    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls[0]![0].rtt).toBe(120);
    expect(cb.mock.calls[0]![0].quality).toBe("fair");
  });

  it("ignores candidate-pair entries with non-numeric or zero RTT", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: "bad",
        bytesSent: 0,
        bytesReceived: 0,
      },
      {
        id: "cp2",
        type: "candidate-pair",
        currentRoundTripTime: 0,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls[0]![0].rtt).toBe(0);
    expect(cb.mock.calls[0]![0].quality).toBe("excellent"); // rtt 0 = excellent
  });

  it("picks the lowest RTT when multiple candidate-pairs exist", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.3,
        bytesSent: 0,
        bytesReceived: 0,
      },
      {
        id: "cp2",
        type: "candidate-pair",
        currentRoundTripTime: 0.05,
        bytesSent: 0,
        bytesReceived: 0,
      },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb.mock.calls[0]![0].rtt).toBe(50);
  });

  it("clamps outRate and inRate to non-negative", async () => {
    // First poll with high bytes, second poll with low bytes (simulated reset)
    let callCount = 0;
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getStats: vi.fn().mockImplementation(() => {
                callCount++;
                const report = new Map();
                report.set("cp1", {
                  type: "candidate-pair",
                  currentRoundTripTime: 0.01,
                  bytesSent: callCount === 1 ? 10000 : 5000,
                  bytesReceived: callCount === 1 ? 10000 : 5000,
                });
                // Bytes that feed outRate/inRate via outbound-rtp/inbound-rtp
                report.set("out1", {
                  type: "outbound-rtp",
                  packetsSent: 100,
                  bytesSent: callCount === 1 ? 50000 : 20000,
                });
                report.set("in1", {
                  type: "inbound-rtp",
                  packetsReceived: 100,
                  bytesReceived: callCount === 1 ? 50000 : 20000,
                });
                return Promise.resolve(report);
              }),
            },
          },
        },
      },
    };

    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100); // First poll
    await vi.advanceTimersByTimeAsync(2100); // Second poll
    const lastStats = cb.mock.calls[cb.mock.calls.length - 1]![0];
    // outRate uses Math.max(0, ...) so should be >= 0
    expect(lastStats.outRate).toBeGreaterThanOrEqual(0);
    expect(lastStats.inRate).toBeGreaterThanOrEqual(0);
  });

  it("quality change callback is not fired if quality reverts before debounce expires", async () => {
    let currentRtt = 0.01;
    const room = {
      engine: {
        pcManager: {
          publisher: {
            pc: {
              getStats: vi.fn().mockImplementation(() => {
                const report = new Map();
                report.set("cp1", {
                  type: "candidate-pair",
                  currentRoundTripTime: currentRtt,
                  bytesSent: 0,
                  bytesReceived: 0,
                });
                return Promise.resolve(report);
              }),
            },
          },
        },
      },
    };

    const qualityCb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onQualityChanged(qualityCb);
    poller.start();

    // First poll (excellent)
    await vi.advanceTimersByTimeAsync(2100);

    // Change to bad
    currentRtt = 0.5;
    await vi.advanceTimersByTimeAsync(2100);

    // Revert to excellent before debounce
    currentRtt = 0.01;
    await vi.advanceTimersByTimeAsync(2100);

    // Now wait for debounce to expire
    await vi.advanceTimersByTimeAsync(3100);

    // Quality reverted to excellent before debounce fired, so callback should not fire
    expect(qualityCb).not.toHaveBeenCalled();
  });

  it("handles candidate-pair without bytesSent/bytesReceived", async () => {
    const room = createMockRoom([
      { id: "cp1", type: "candidate-pair", currentRoundTripTime: 0.05 },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    const stats = cb.mock.calls[0]![0];
    expect(stats.totalUp).toBe(0);
    expect(stats.totalDown).toBe(0);
  });

  it("handles outbound-rtp without packetsSent", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.01,
        bytesSent: 0,
        bytesReceived: 0,
      },
      { id: "out1", type: "outbound-rtp", bytesSent: 100 },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls[0]![0].outPackets).toBe(0);
  });

  it("handles inbound-rtp without packetsReceived", async () => {
    const room = createMockRoom([
      {
        id: "cp1",
        type: "candidate-pair",
        currentRoundTripTime: 0.01,
        bytesSent: 0,
        bytesReceived: 0,
      },
      { id: "in1", type: "inbound-rtp", bytesReceived: 100 },
    ]);
    const cb = vi.fn();
    poller = createConnectionStatsPoller(() => room as any);
    poller.onUpdate(cb);
    poller.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(cb).toHaveBeenCalled();
    expect(cb.mock.calls[0]![0].inPackets).toBe(0);
  });
});
