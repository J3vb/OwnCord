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

/** Lifetime counters of one audio stream. For an inbound stream `received`
 *  is packetsReceived; for our outbound stream as the far end reports it
 *  (remote-inbound-rtp), it is packetsSent less the far end's packetsLost. */
interface AudioCounters {
  readonly lost: number;
  readonly received: number;
  /** Interarrival jitter, milliseconds. */
  readonly jitter: number;
}

type AudioStreams = ReadonlyMap<string, AudioCounters>;

interface AudioSnapshot {
  readonly inbound: AudioStreams;
  readonly remote: AudioStreams;
}

interface PrevSnapshot {
  readonly timestamp: number;
  readonly outBytes: number;
  readonly inBytes: number;
  /** Audio counters from the last LOSS_HISTORY_POLLS polls, oldest first, so
   *  loss covers the recent past rather than the whole call. */
  readonly audioHistory: readonly AudioSnapshot[];
}

const EMPTY_SNAPSHOT: Omit<PrevSnapshot, "timestamp"> = {
  outBytes: 0,
  inBytes: 0,
  audioHistory: [{ inbound: new Map(), remote: new Map() }],
};

/** Fewest audio packets a loss percentage is judged over, so a single lost
 *  packet reads below the 1% "excellent" line. With Opus DTX a silent stream
 *  sends about 5 packets per poll, where one loss would read as ~17%. */
const LOSS_SAMPLE_FLOOR = 200;

/** How many past polls loss may reach back over. When the streams carry fewer
 *  than LOSS_SAMPLE_FLOOR packets in that span (a muted or departed peer),
 *  loss reads 0 rather than a stale figure. */
const LOSS_HISTORY_POLLS = 5;

function packetsSince(before: AudioCounters | undefined, now: AudioCounters): number {
  return now.lost + now.received - ((before?.lost ?? 0) + (before?.received ?? 0));
}

/** Loss percent over the most recent stretch of history that spans at least
 *  LOSS_SAMPLE_FLOOR packets, or 0 when none does. A stream seen for the first
 *  time counts from zero; negative deltas (duplicates lowering packetsLost)
 *  clamp to zero. */
function recentLoss(history: readonly AudioStreams[], next: AudioStreams): number {
  for (let i = history.length - 1; i >= 0; i--) {
    let lost = 0;
    let total = 0;
    for (const [id, counters] of next) {
      const before = history[i]!.get(id);
      const lostDelta = Math.max(0, counters.lost - (before?.lost ?? 0));
      lost += lostDelta;
      total += lostDelta + Math.max(0, counters.received - (before?.received ?? 0));
    }
    if (total >= LOSS_SAMPLE_FLOOR) return (lost / total) * 100;
  }
  return 0;
}

/** Worst jitter among streams that carried packets since the last poll, so a
 *  muted stream's last estimate does not linger. */
function activeJitter(prev: AudioStreams, next: AudioStreams): number {
  let jitter = 0;
  for (const [id, counters] of next) {
    if (packetsSince(prev.get(id), counters) > 0 && counters.jitter > jitter)
      jitter = counters.jitter;
  }
  return jitter;
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
  audio: AudioSnapshot;
} {
  let rtt = 0;
  let totalUp = 0;
  let totalDown = 0;
  let outPackets = 0;
  let inPackets = 0;
  let outBytes = 0;
  let inBytes = 0;
  // Loss and jitter come from audio streams only: call quality is about
  // voice, and video jitter runs high on a healthy link because a frame's
  // packets share one RTP timestamp. inbound-rtp covers what we receive;
  // remote-inbound-rtp, matched to its outbound-rtp by localId, covers what
  // the far end receives from us. The poller takes the worst of the two.
  const inbound = new Map<string, AudioCounters>();
  const audioSentById = new Map<string, number>();
  const remoteAudio: Array<Record<string, unknown>> = [];

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
        if (entry.kind === "audio" && typeof entry.packetsSent === "number")
          audioSentById.set(String(entry.id), entry.packetsSent);
      }

      if (entry.type === "inbound-rtp") {
        if (typeof entry.packetsReceived === "number") inPackets += entry.packetsReceived;
        if (typeof entry.bytesReceived === "number") inBytes += entry.bytesReceived;
      }

      if (entry.type === "inbound-rtp" && entry.kind === "audio") {
        inbound.set(String(entry.id), {
          lost: typeof entry.packetsLost === "number" ? entry.packetsLost : 0,
          received: typeof entry.packetsReceived === "number" ? entry.packetsReceived : 0,
          jitter: jitterMs(entry),
        });
      }

      if (entry.type === "remote-inbound-rtp" && entry.kind === "audio") remoteAudio.push(entry);
    });
  }

  const remote = new Map<string, AudioCounters>();
  for (const entry of remoteAudio) {
    const sent = audioSentById.get(String(entry.localId));
    if (sent === undefined) continue;
    const lost = typeof entry.packetsLost === "number" ? entry.packetsLost : 0;
    remote.set(String(entry.id), {
      lost,
      received: Math.max(0, sent - lost),
      jitter: jitterMs(entry),
    });
  }

  return {
    rtt,
    totalUp,
    totalDown,
    outPackets,
    inPackets,
    outBytes,
    inBytes,
    audio: { inbound, remote },
  };
}

/** jitter is in seconds in the WebRTC stats spec. */
function jitterMs(entry: Record<string, unknown>): number {
  return typeof entry.jitter === "number" ? entry.jitter * 1000 : 0;
}

export function createConnectionStatsPoller(getRoom: () => Room | null): ConnectionStatsPoller {
  let current: ConnectionStats = EMPTY_STATS;
  let prev: PrevSnapshot = { timestamp: Date.now(), ...EMPTY_SNAPSHOT };
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

    const history = prev.audioHistory;
    const last = history[history.length - 1]!;
    const { audio } = metrics;
    const loss = Math.max(
      recentLoss(
        history.map((h) => h.inbound),
        audio.inbound,
      ),
      recentLoss(
        history.map((h) => h.remote),
        audio.remote,
      ),
    );
    const jitter = Math.max(
      activeJitter(last.inbound, audio.inbound),
      activeJitter(last.remote, audio.remote),
    );

    prev = {
      timestamp: now,
      outBytes: metrics.outBytes,
      inBytes: metrics.inBytes,
      audioHistory: [...history, audio].slice(-LOSS_HISTORY_POLLS),
    };

    current = {
      rtt: metrics.rtt,
      quality: qualityFromSignals(metrics.rtt, loss, jitter),
      outRate: Math.max(0, outRate),
      inRate: Math.max(0, inRate),
      outPackets: metrics.outPackets,
      inPackets: metrics.inPackets,
      totalUp: metrics.totalUp,
      totalDown: metrics.totalDown,
      loss,
      jitter,
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
    prev = { timestamp: Date.now(), ...EMPTY_SNAPSHOT };
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
    prev = { timestamp: Date.now(), ...EMPTY_SNAPSHOT };
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
