/**
 * One mixed report fixture over a publisher and a subscriber transport, read
 * through the poller: every entry kind extractMetrics sorts, with the
 * malformed and unmatched ones it must skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import * as logger from "../helpers/loggerMock";

vi.mock("@lib/logger", () => logger.loggerMock());

import {
  createConnectionStatsPoller,
  type ConnectionStats,
  type ConnectionStatsPoller,
} from "../../src/lib/voice/connectionStats";

type Entry = Record<string, unknown>;

const publisher: Entry[] = [
  {
    id: "cp1",
    type: "candidate-pair",
    currentRoundTripTime: 0.08,
    bytesSent: 1000,
    bytesReceived: 500,
  },
  {
    id: "cp2",
    type: "candidate-pair",
    currentRoundTripTime: 0.05,
    bytesSent: 3000,
    bytesReceived: "x",
  },
  { id: "cp3", type: "candidate-pair", currentRoundTripTime: 0, bytesSent: 2000 },
  { id: "out-a", type: "outbound-rtp", kind: "audio", packetsSent: 100, bytesSent: 4000 },
  { id: "out-v", type: "outbound-rtp", kind: "video", packetsSent: 50, bytesSent: 9000 },
  { id: "out-bad", type: "outbound-rtp", kind: "audio", packetsSent: "n", bytesSent: 10 },
  {
    id: "r-a",
    type: "remote-inbound-rtp",
    kind: "audio",
    localId: "out-a",
    packetsLost: 10,
    jitter: 0.02,
  },
  {
    id: "r-v",
    type: "remote-inbound-rtp",
    kind: "video",
    localId: "out-v",
    packetsLost: 99,
    jitter: 0.5,
  },
  {
    id: "r-x",
    type: "remote-inbound-rtp",
    kind: "audio",
    localId: "zzz",
    packetsLost: 5,
    jitter: 0.9,
  },
];

const subscriber: Entry[] = [
  {
    id: "in-a",
    type: "inbound-rtp",
    kind: "audio",
    packetsReceived: 300,
    packetsLost: 3,
    jitter: 0.01,
    bytesReceived: 6000,
  },
  {
    id: "in-v",
    type: "inbound-rtp",
    kind: "video",
    packetsReceived: 700,
    bytesReceived: 50000,
    jitter: 0.3,
  },
  { id: "in-empty", type: "inbound-rtp", kind: "audio" },
];

function room(...transports: Entry[][]): Room {
  const [pub, sub] = transports;
  const t = (entries: Entry[] | undefined): unknown =>
    entries === undefined
      ? undefined
      : { getStats: () => Promise.resolve(new Map(entries.map((e) => [String(e.id), e]))) };
  return { engine: { pcManager: { publisher: t(pub), subscriber: t(sub) } } } as unknown as Room;
}

describe("connection stats over a mixed report fixture", () => {
  let poller: ConnectionStatsPoller;
  let updates: ConnectionStats[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    updates = [];
  });
  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  function poll(r: Room): void {
    poller = createConnectionStatsPoller(() => r);
    poller.onUpdate((s) => updates.push(s));
    poller.start();
  }

  it("sorts every entry kind from both transports", async () => {
    poll(room(publisher, subscriber));
    await vi.advanceTimersByTimeAsync(2000);
    const s = updates[0]!;
    expect(s.rtt).toBeCloseTo(50, 5);
    expect(s.totalUp).toBe(3000);
    expect(s.totalDown).toBe(500);
    expect(s.outPackets).toBe(150);
    expect(s.inPackets).toBe(1000);
    // 4000 + 9000 + 10 bytes out and 6000 + 50000 in, over the 2 s poll.
    expect(s.outRate).toBe(6505);
    expect(s.inRate).toBe(28000);
    // Inbound audio lost 3 of 303; the far end's 10 of 100 is under the packet floor.
    expect(s.loss).toBeCloseTo((3 / 303) * 100, 8);
    // The far end's 20 ms audio jitter wins; video and unmatched reports are skipped.
    expect(s.jitter).toBeCloseTo(20, 8);
    expect(s.quality).toBe("fair");
    expect(s.available).toBe(true);
  });

  it("reads a publisher-only room, and the transports in the other order", async () => {
    poll(room(publisher));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[0]!.inPackets).toBe(0);
    expect(updates[0]!.totalDown).toBe(500);
    expect(updates[0]!.jitter).toBeCloseTo(20, 8);
    expect(updates[0]!.loss).toBe(0);
    poller.stop();
    poll(room(subscriber, publisher));
    await vi.advanceTimersByTimeAsync(2000);
    expect(updates[1]!.outPackets).toBe(150);
    expect(updates[1]!.inPackets).toBe(1000);
    expect(updates[1]!.jitter).toBeCloseTo(20, 8);
  });
});
