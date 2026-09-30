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
  /** Inbound packet loss, percent. A low-RTT link that drops packets is not
   *  excellent, so quality weighs this alongside RTT (DP-41). */
  readonly loss: number;
  /** Interarrival jitter, milliseconds. */
  readonly jitter: number;
  /** False until a real sample has been extracted. The native Linux path has
   *  no browser peer connection (NativeRoom.engine.pcManager is undefined), so
   *  no sample ever arrives; the widget must render "not available" rather
   *  than its hardcoded initial "4 green bars, —" (voice #7). */
  readonly available: boolean;
}

export interface ConnectionStatsPoller {
  start(): void;
  stop(): void;
  getStats(): ConnectionStats;
  onUpdate(cb: (stats: ConnectionStats) => void): () => void;
  onQualityChanged(cb: (quality: QualityLevel, prevQuality: QualityLevel) => void): () => void;
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
  loss: 0,
  jitter: 0,
  available: false,
};

/** Score one signal on the same excellent/fair/poor/bad scale. */
function levelFromRtt(rtt: number): QualityLevel {
  if (rtt < 100) return "excellent";
  if (rtt < 200) return "fair";
  if (rtt < 400) return "poor";
  return "bad";
}

function levelFromLoss(loss: number): QualityLevel {
  if (loss < 1) return "excellent";
  if (loss < 5) return "fair";
  if (loss < 10) return "poor";
  return "bad";
}

function levelFromJitter(jitter: number): QualityLevel {
  if (jitter < 20) return "excellent";
  if (jitter < 50) return "fair";
  if (jitter < 100) return "poor";
  return "bad";
}

const QUALITY_ORDER: readonly QualityLevel[] = ["excellent", "fair", "poor", "bad"];

/** Connection quality is the worst of RTT, packet loss and jitter, so a lossy
 *  or jittery link can never read "excellent" on a good round trip (DP-41). */
export function qualityFromSignals(rtt: number, loss: number, jitter: number): QualityLevel {
  const signals = [levelFromRtt(rtt), levelFromLoss(loss), levelFromJitter(jitter)];
  return signals.reduce((worst, level) =>
    QUALITY_ORDER.indexOf(level) > QUALITY_ORDER.indexOf(worst) ? level : worst,
  );
}

interface PrevSnapshot {
  readonly timestamp: number;
  readonly outBytes: number;
  readonly inBytes: number;
}

/** Collect stats from both publisher and subscriber PeerConnections.
 *  RTT is typically on the subscriber PC in LiveKit's SFU model. */
async function collectAllStats(room: Room): Promise<RTCStatsReport[]> {
  try {
    // Use the SDK transport API: PCTransport owns a private _pc, not a
    // public `pc`. Keeping this typed makes SDK shape changes a build error.
    const pcManager = room.engine.pcManager;
    const reports: RTCStatsReport[] = [];
    for (const transport of [pcManager?.publisher, pcManager?.subscriber]) {
      // oxlint-disable-next-line no-await-in-loop -- two transports only: parallelising a two-element poll buys nothing and complicates the optional chaining
      const report = await transport?.getStats();
      if (report) reports.push(report);
    }
    return reports;
  } catch {
    log.warn("Failed to access peer connection stats — LiveKit SDK internals may have changed");
    return [];
  }
}

function extractMetrics(reports: RTCStatsReport[]): {
  rtt: number;
  totalUp: number;
  totalDown: number;
  outPackets: number;
  inPackets: number;
  outBytes: number;
  inBytes: number;
  loss: number;
  jitter: number;
} {
  let rtt = 0;
  let totalUp = 0;
  let totalDown = 0;
  let outPackets = 0;
  let inPackets = 0;
  let outBytes = 0;
  let inBytes = 0;
  // Inbound loss/jitter are accumulated from every inbound-rtp entry; the
  // remote-inbound-rtp report carries the fraction the far end lost on our
  // outbound stream. qualityFromSignals takes the worst, so the two loss
  // readings never need reconciling here.
  let packetsLost = 0;
  let packetsReceivedForLoss = 0;
  let remoteLossFraction = 0;
  let jitterMs = 0;

  for (const report of reports) {
    report.forEach((entry: Record<string, unknown>) => {
      // Look for candidate-pair with RTT — accept any state that has a valid RTT,
      // not just "succeeded", because LiveKit's subscriber PC may report "in-progress".
      if (entry.type === "candidate-pair") {
        const rawRtt = entry.currentRoundTripTime;
        if (typeof rawRtt === "number" && rawRtt > 0 && (rtt === 0 || rawRtt * 1000 < rtt)) {
          rtt = rawRtt * 1000;
        }
        // Use max across candidate-pairs (avoid double-counting across PCs)
        if (typeof entry.bytesSent === "number" && entry.bytesSent > totalUp)
          totalUp = entry.bytesSent;
        if (typeof entry.bytesReceived === "number" && entry.bytesReceived > totalDown)
          totalDown = entry.bytesReceived;
      }

      if (entry.type === "outbound-rtp") {
        if (typeof entry.packetsSent === "number") outPackets += entry.packetsSent;
        if (typeof entry.bytesSent === "number") outBytes += entry.bytesSent;
      }

      if (entry.type === "inbound-rtp") {
        if (typeof entry.packetsReceived === "number") inPackets += entry.packetsReceived;
        if (typeof entry.bytesReceived === "number") inBytes += entry.bytesReceived;
        if (typeof entry.packetsLost === "number") packetsLost += entry.packetsLost;
        if (typeof entry.packetsReceived === "number")
          packetsReceivedForLoss += entry.packetsReceived;
        // jitter is in seconds (WebRTC stats spec); keep the worst stream.
        if (typeof entry.jitter === "number" && entry.jitter * 1000 > jitterMs)
          jitterMs = entry.jitter * 1000;
      }

      if (entry.type === "remote-inbound-rtp") {
        if (typeof entry.fractionLost === "number" && entry.fractionLost > remoteLossFraction)
          remoteLossFraction = entry.fractionLost;
        if (typeof entry.jitter === "number" && entry.jitter * 1000 > jitterMs)
          jitterMs = entry.jitter * 1000;
      }
    });
  }

  const inboundLoss =
    packetsLost + packetsReceivedForLoss > 0
      ? (packetsLost / (packetsLost + packetsReceivedForLoss)) * 100
      : 0;
  const loss = Math.max(inboundLoss, remoteLossFraction * 100);

  return {
    rtt,
    totalUp,
    totalDown,
    outPackets,
    inPackets,
    outBytes,
    inBytes,
    loss,
    jitter: jitterMs,
  };
}

export function createConnectionStatsPoller(getRoom: () => Room | null): ConnectionStatsPoller {
  let current: ConnectionStats = EMPTY_STATS;
  let prev: PrevSnapshot = { timestamp: Date.now(), outBytes: 0, inBytes: 0 };
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(stats: ConnectionStats) => void>();
  const qualityChangeListeners = new Set<
    (quality: QualityLevel, prevQuality: QualityLevel) => void
  >();
  let lastQuality: QualityLevel = "excellent";
  let qualityDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const QUALITY_DEBOUNCE_MS = 3000;

  async function poll(): Promise<void> {
    const room = getRoom();
    if (!room) return;

    const reports = await collectAllStats(room);
    if (reports.length === 0) return;

    const metrics = extractMetrics(reports);
    const now = Date.now();
    const elapsed = (now - prev.timestamp) / 1000;

    const outRate = elapsed > 0 ? (metrics.outBytes - prev.outBytes) / elapsed : 0;
    const inRate = elapsed > 0 ? (metrics.inBytes - prev.inBytes) / elapsed : 0;

    prev = { timestamp: now, outBytes: metrics.outBytes, inBytes: metrics.inBytes };

    current = {
      rtt: metrics.rtt,
      quality: qualityFromSignals(metrics.rtt, metrics.loss, metrics.jitter),
      outRate: Math.max(0, outRate),
      inRate: Math.max(0, inRate),
      outPackets: metrics.outPackets,
      inPackets: metrics.inPackets,
      totalUp: metrics.totalUp,
      totalDown: metrics.totalDown,
      loss: metrics.loss,
      jitter: metrics.jitter,
      available: true,
    };

    listeners.forEach((cb) => cb(current));

    // Debounced quality change notification (prevents toast spam on flapping).
    // Only arm the timer when none is already pending — POLL_INTERVAL_MS (2000)
    // is shorter than QUALITY_DEBOUNCE_MS (3000), so re-arming on every poll
    // that still disagrees with lastQuality would push the deadline out
    // forever and the timer would never fire. If quality returns to
    // lastQuality before the timer elapses, cancel it instead.
    const newQuality = current.quality;
    if (newQuality !== lastQuality) {
      if (qualityDebounceTimer === null) {
        qualityDebounceTimer = setTimeout(() => {
          qualityDebounceTimer = null;
          if (current.quality !== lastQuality) {
            const prevQuality = lastQuality;
            lastQuality = current.quality;
            qualityChangeListeners.forEach((cb) => cb(current.quality, prevQuality));
          }
        }, QUALITY_DEBOUNCE_MS);
      }
    } else if (qualityDebounceTimer !== null) {
      clearTimeout(qualityDebounceTimer);
      qualityDebounceTimer = null;
    }
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
    // BUG-071B: Clear pending quality debounce timer to prevent it firing
    // after the poller is stopped (would call listeners against a dead room).
    if (qualityDebounceTimer !== null) {
      clearTimeout(qualityDebounceTimer);
      qualityDebounceTimer = null;
    }
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

  function onQualityChanged(
    cb: (quality: QualityLevel, prevQuality: QualityLevel) => void,
  ): () => void {
    qualityChangeListeners.add(cb);
    return () => {
      qualityChangeListeners.delete(cb);
    };
  }

  return { start, stop, getStats, onUpdate, onQualityChanged };
}

// --- Formatting helpers ---

/**
 * Format a byte count as `B` / `<kiloUnit>` / `MB`, switching units at
 * `base` and `base * base`. Shared by `formatBytes` here (base-1000, "kB")
 * and `formatFileSize` in components/message-list/attachments.ts
 * (base-1024, "KB") — those two disagreed on both the base and the unit
 * case before this was unified, so keep each call site's own `base`/
 * `kiloUnit`/`decimals` rather than picking one for both.
 */
export function formatByteSize(
  bytes: number,
  base: number,
  kiloUnit: string,
  decimals: number,
): string {
  if (bytes < base) return `${Math.round(bytes)} B`;
  if (bytes < base * base) return `${(bytes / base).toFixed(decimals)} ${kiloUnit}`;
  return `${(bytes / (base * base)).toFixed(decimals)} MB`;
}

export function formatBytes(bytes: number): string {
  return formatByteSize(bytes, 1000, "kB", 2);
}

/**
 * Compact transfer rate for the voice widget's stats pane: one unit, a
 * rounded value and no second Mbps figure, so a value never wraps at the
 * widget's narrow width (`331 kB/s`, not `331.25 kB/s (2.6 Mbps)`).
 */
export function formatRateCompact(bytesPerSec: number): string {
  const bytes = Math.max(0, bytesPerSec);
  if (Math.round(bytes) < 1000) return `${Math.round(bytes)} B/s`;
  const kb = bytes / 1000;
  if (Number(kb.toFixed(1)) < 100) return `${kb.toFixed(1)} kB/s`;
  if (Math.round(kb) < 1000) return `${Math.round(kb)} kB/s`;
  const mb = bytes / 1_000_000;
  return `${Number(mb.toFixed(1)) < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB/s`;
}
