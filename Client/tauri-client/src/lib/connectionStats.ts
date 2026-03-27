// Connection stats poller — extracts WebRTC metrics from LiveKit Room
import type { Room } from "livekit-client";
import { createLogger } from "@lib/logger";

const log = createLogger("connection-stats");

const POLL_INTERVAL_MS = 2000;

export type QualityLevel = "excellent" | "fair" | "poor" | "bad";

export interface ConnectionStats {
  readonly rtt: number;
  readonly quality: QualityLevel;
  readonly outRate: number;
  readonly inRate: number;
  readonly outPackets: number;
  readonly inPackets: number;
  readonly totalUp: number;
  readonly totalDown: number;
}

export interface ConnectionStatsPoller {
  start(): void;
  stop(): void;
  getStats(): ConnectionStats;
  onUpdate(cb: (stats: ConnectionStats) => void): () => void;
}

const EMPTY_STATS: ConnectionStats = {
  rtt: 0,
  quality: "excellent",
  outRate: 0,
  inRate: 0,
  outPackets: 0,
  inPackets: 0,
  totalUp: 0,
  totalDown: 0,
};

function qualityFromRtt(rtt: number): QualityLevel {
  if (rtt < 100) return "excellent";
  if (rtt < 200) return "fair";
  if (rtt < 400) return "poor";
  return "bad";
}

interface PrevSnapshot {
  readonly timestamp: number;
  readonly outBytes: number;
  readonly inBytes: number;
}

async function collectStats(
  room: Room,
): Promise<RTCStatsReport | null> {
  try {
    // Access pcManager which holds publisher and subscriber PeerConnections
    const engine = room.engine as unknown as Record<string, unknown>;
    const pcManager = engine.pcManager as
      | { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } }
      | undefined;

    const pc =
      pcManager?.publisher?.pc ?? pcManager?.subscriber?.pc ?? null;
    if (!pc) return null;

    return await pc.getStats();
  } catch {
    log.debug("Failed to access peer connection stats");
    return null;
  }
}

function extractMetrics(report: RTCStatsReport): {
  rtt: number;
  totalUp: number;
  totalDown: number;
  outPackets: number;
  inPackets: number;
  outBytes: number;
  inBytes: number;
} {
  let rtt = 0;
  let totalUp = 0;
  let totalDown = 0;
  let outPackets = 0;
  let inPackets = 0;
  let outBytes = 0;
  let inBytes = 0;

  report.forEach((entry: Record<string, unknown>) => {
    if (
      entry.type === "candidate-pair" &&
      (entry.state === "succeeded" || entry.nominated === true)
    ) {
      const rawRtt = entry.currentRoundTripTime;
      if (typeof rawRtt === "number" && rawRtt > 0) {
        rtt = rawRtt * 1000;
      }
      if (typeof entry.bytesSent === "number") totalUp = entry.bytesSent;
      if (typeof entry.bytesReceived === "number") totalDown = entry.bytesReceived;
    }

    if (entry.type === "outbound-rtp") {
      if (typeof entry.packetsSent === "number") outPackets += entry.packetsSent;
      if (typeof entry.bytesSent === "number") outBytes += entry.bytesSent;
    }

    if (entry.type === "inbound-rtp") {
      if (typeof entry.packetsReceived === "number") inPackets += entry.packetsReceived;
      if (typeof entry.bytesReceived === "number") inBytes += entry.bytesReceived;
    }
  });

  return { rtt, totalUp, totalDown, outPackets, inPackets, outBytes, inBytes };
}

export function createConnectionStatsPoller(
  getRoom: () => Room | null,
): ConnectionStatsPoller {
  let current: ConnectionStats = EMPTY_STATS;
  let prev: PrevSnapshot = { timestamp: Date.now(), outBytes: 0, inBytes: 0 };
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(stats: ConnectionStats) => void>();

  async function poll(): Promise<void> {
    const room = getRoom();
    if (!room) return;

    const report = await collectStats(room);
    if (!report) return;

    const metrics = extractMetrics(report);
    const now = Date.now();
    const elapsed = (now - prev.timestamp) / 1000;

    const outRate = elapsed > 0 ? (metrics.outBytes - prev.outBytes) / elapsed : 0;
    const inRate = elapsed > 0 ? (metrics.inBytes - prev.inBytes) / elapsed : 0;

    prev = { timestamp: now, outBytes: metrics.outBytes, inBytes: metrics.inBytes };

    current = {
      rtt: metrics.rtt,
      quality: qualityFromRtt(metrics.rtt),
      outRate: Math.max(0, outRate),
      inRate: Math.max(0, inRate),
      outPackets: metrics.outPackets,
      inPackets: metrics.inPackets,
      totalUp: metrics.totalUp,
      totalDown: metrics.totalDown,
    };

    listeners.forEach((cb) => cb(current));
  }

  function start(): void {
    if (intervalId !== null) return;
    log.info("Starting connection stats poller");
    prev = { timestamp: Date.now(), outBytes: 0, inBytes: 0 };
    current = EMPTY_STATS;
    intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  function stop(): void {
    if (intervalId === null) return;
    log.info("Stopping connection stats poller");
    clearInterval(intervalId);
    intervalId = null;
    current = EMPTY_STATS;
    prev = { timestamp: Date.now(), outBytes: 0, inBytes: 0 };
  }

  function getStats(): ConnectionStats {
    return current;
  }

  function onUpdate(cb: (stats: ConnectionStats) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return { start, stop, getStats, onUpdate };
}

// --- Formatting helpers ---

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(2)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}
