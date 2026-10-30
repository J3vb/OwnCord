/**
 * What your own screen share is actually sending, and why it falls short:
 * one sender stats sample read from the WebRTC sender, with a row per
 * encoder layer (screen-sharing pipeline plan, PR 2a).
 *
 * Rates come from counter deltas between two reads of the same sender, per
 * W3C webrtc-stats: a value that cannot be computed honestly (first read of
 * a layer without a browser rate, a counter that went backwards, a
 * non-positive interval) stays undefined rather than guessed.
 */

/** One encoder layer (a simulcast RID, or the single stream). */
export interface ShareLayerSample {
  readonly rid?: string;
  /** false: a simulcast layer dynacast paused; it keeps its last size. */
  readonly active: boolean;
  readonly width?: number;
  readonly height?: number;
  /** Frames handed to the network per second. */
  readonly sentFps?: number;
  /** Frames out of the encoder per second. */
  readonly encodedFps?: number;
  readonly bitrateBps?: number;
  readonly encodeMsPerFrame?: number;
  readonly limitation?: string;
  readonly encoder?: string;
  readonly codec?: string;
  readonly powerEfficient?: boolean;
}

/** One sample of your screen share's sender. */
export interface ShareSenderSample {
  /** The capture rate: measured where the browser reports a source, else
   *  the rate it was opened at (`getSettings().frameRate`). */
  readonly captureFps?: number;
  /** Where `captureFps` came from. */
  readonly captureFpsSource?: "measured" | "configured";
  /** The rate of the widest layer that is sending frames. */
  readonly sentFps?: number;
  /** The top layer's encoded size. */
  readonly width?: number;
  readonly height?: number;
  /** The top layer's `qualityLimitationReason`: none, cpu, bandwidth or other. */
  readonly limitation?: string;
  /** e.g. "libvpx", "NvEnc", "SimulcastEncoderAdapter (libvpx, libvpx)" */
  readonly encoder?: string;
  /** e.g. "video/VP8" */
  readonly codec?: string;
  /** Every layer, widest first. */
  readonly layers?: readonly ShareLayerSample[];
}

/** The fields read from an `outbound-rtp` (or livekit's VideoSenderStats). */
interface OutboundLayer {
  readonly id?: string;
  readonly timestamp?: number;
  readonly rid?: string;
  readonly mediaSourceId?: string;
  readonly framesPerSecond?: number;
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly framesEncoded?: number;
  readonly framesSent?: number;
  readonly bytesSent?: number;
  readonly totalEncodeTime?: number;
  readonly qualityLimitationReason?: string;
  readonly encoderImplementation?: string;
  readonly powerEfficientEncoder?: boolean;
  readonly codecId?: string;
  readonly active?: boolean;
}

/** A WebRTC stats entry, as far as this reads one. */
interface StatsEntry extends OutboundLayer {
  readonly type?: string;
  readonly kind?: string;
  readonly mimeType?: string;
  /** media-source: frames delivered by the capture so far. */
  readonly frames?: number;
}

/** The counters a later read needs to turn into rates, by stats id. */
interface Counters {
  readonly timestamp: number;
  readonly framesEncoded?: number;
  readonly framesSent?: number;
  readonly bytesSent?: number;
  readonly totalEncodeTime?: number;
  readonly frames?: number;
}

export type PreviousCounters = ReadonlyMap<string, Counters>;

function rounded(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? undefined : Math.round(n);
}

/** Δcounter / Δseconds, or undefined on a reset, gap or missing input. */
function perSecond(
  now: number | undefined,
  then: number | undefined,
  seconds: number,
): number | undefined {
  if (now === undefined || then === undefined || seconds <= 0 || now < then) return undefined;
  return (now - then) / seconds;
}

function countersOf(entry: StatsEntry): Counters | undefined {
  if (entry.timestamp === undefined) return undefined;
  return {
    timestamp: entry.timestamp,
    framesEncoded: entry.framesEncoded,
    framesSent: entry.framesSent,
    bytesSent: entry.bytesSent,
    totalEncodeTime: entry.totalEncodeTime,
    frames: entry.frames,
  };
}

/** Whether `now` continues `prev`: same object, time moved on, no counter
 *  went backwards. Anything else is a reset and yields no rates. */
function continues(now: Counters, prev: Counters | undefined): prev is Counters {
  if (prev === undefined || now.timestamp <= prev.timestamp) return false;
  const keys = ["framesEncoded", "framesSent", "bytesSent", "totalEncodeTime", "frames"] as const;
  return keys.every((k) => now[k] === undefined || prev[k] === undefined || now[k] >= prev[k]);
}

function layerSample(
  l: OutboundLayer,
  codecs: ReadonlyMap<string, string>,
  prev: PreviousCounters,
): ShareLayerSample {
  const now = l.id === undefined ? undefined : countersOf(l);
  const before = l.id === undefined ? undefined : prev.get(l.id);
  let sentFps: number | undefined;
  let encodedFps: number | undefined;
  let bitrateBps: number | undefined;
  let encodeMsPerFrame: number | undefined;
  if (now !== undefined && continues(now, before)) {
    const seconds = (now.timestamp - before.timestamp) / 1000;
    sentFps = perSecond(now.framesSent, before.framesSent, seconds) ?? l.framesPerSecond;
    encodedFps = perSecond(now.framesEncoded, before.framesEncoded, seconds);
    const bytes = perSecond(now.bytesSent, before.bytesSent, seconds);
    bitrateBps = bytes === undefined ? undefined : bytes * 8;
    const frames =
      now.framesEncoded !== undefined && before.framesEncoded !== undefined
        ? now.framesEncoded - before.framesEncoded
        : 0;
    if (frames > 0 && now.totalEncodeTime !== undefined && before.totalEncodeTime !== undefined) {
      encodeMsPerFrame = (1000 * (now.totalEncodeTime - before.totalEncodeTime)) / frames;
    }
  } else if (before === undefined) {
    // First read of this layer: the browser's own one-second rate.
    sentFps = l.framesPerSecond;
  }
  return {
    rid: l.rid,
    active: l.active !== false,
    width: l.frameWidth,
    height: l.frameHeight,
    sentFps: rounded(sentFps),
    encodedFps: rounded(encodedFps),
    bitrateBps: rounded(bitrateBps),
    encodeMsPerFrame:
      encodeMsPerFrame === undefined ? undefined : Math.round(encodeMsPerFrame * 10) / 10,
    limitation: l.qualityLimitationReason,
    encoder: l.encoderImplementation,
    codec: l.codecId === undefined ? undefined : codecs.get(l.codecId),
    powerEfficient: l.powerEfficientEncoder,
  };
}

/** livekit-client's simulcast RIDs, smallest to largest: the order when a
 *  layer has not reported its size yet. */
function ridRank(rid: string | undefined): number {
  return rid === undefined ? -1 : ["q", "h", "f"].indexOf(rid);
}

/** Fold the sender's layers into one sample: the summary is the top (widest)
 *  sending layer's, and a paused layer never counts towards it. */
export function senderSample(
  layers: readonly OutboundLayer[],
  codecs: ReadonlyMap<string, string>,
  captureFps: number | undefined,
  prev: PreviousCounters = new Map(),
  captureFpsSource: "measured" | "configured" = "configured",
): ShareSenderSample {
  const rows = layers
    .map((l) => layerSample(l, codecs, prev))
    .toSorted((a, b) => (b.width ?? 0) - (a.width ?? 0) || ridRank(b.rid) - ridRank(a.rid));
  // The widest layer actually reaching viewers; a layer that is up but has
  // not sent a frame yet does not stand in for the share's rate.
  const sending =
    rows.find((l) => l.active && l.sentFps !== undefined && l.sentFps > 0) ??
    rows.find((l) => l.active);
  // Only a paused layer: show its last size, but no rate.
  const top = sending ?? rows[0];
  const capture = rounded(captureFps);
  return {
    captureFps: capture,
    captureFpsSource: capture === undefined ? undefined : captureFpsSource,
    sentFps: sending?.sentFps,
    width: top?.width,
    height: top?.height,
    limitation: top?.limitation,
    encoder: top?.encoder,
    codec: top?.codec,
    layers: rows.length > 0 ? rows : undefined,
  };
}

/** Read a raw `RTCRtpSender.getStats()` report. The capture rate is the
 *  rate the layers' own `media-source` actually delivered (a 60 Hz monitor
 *  gives 60), else `fallbackCaptureFps`. Returns the counters the next read
 *  of the same sender needs. */
export function senderSampleFromReport(
  report: { forEach(cb: (entry: StatsEntry, id: string) => void): void },
  fallbackCaptureFps: number | undefined,
  prev: PreviousCounters = new Map(),
): { sample: ShareSenderSample; counters: PreviousCounters } {
  const layers: StatsEntry[] = [];
  const codecs = new Map<string, string>();
  const sources = new Map<string, StatsEntry>();
  const counters = new Map<string, Counters>();
  report.forEach((entry, id) => {
    const withId = entry.id === undefined ? { ...entry, id } : entry;
    if (entry.type === "outbound-rtp" && entry.kind !== "audio") layers.push(withId);
    else if (entry.type === "codec" && entry.mimeType !== undefined) codecs.set(id, entry.mimeType);
    else if (entry.type === "media-source" && entry.kind !== "audio") sources.set(id, withId);
    else return;
    const c = countersOf(withId);
    if (c !== undefined) counters.set(id, c);
  });
  // Join the layers to their source by id, never by report order; with no
  // id on the layers, a lone video source is still unambiguous.
  const sourceIds = new Set(layers.map((l) => l.mediaSourceId).filter((s) => s !== undefined));
  const source =
    sourceIds.size === 1
      ? sources.get([...sourceIds][0]!)
      : sourceIds.size === 0 && sources.size === 1
        ? [...sources.values()][0]
        : undefined;
  let measured: number | undefined;
  if (source !== undefined) {
    const now = countersOf(source);
    const before = source.id === undefined ? undefined : prev.get(source.id);
    if (now !== undefined && continues(now, before) && now.frames !== undefined) {
      measured = perSecond(now.frames, before.frames, (now.timestamp - before.timestamp) / 1000);
    }
    measured ??= source.framesPerSecond;
  }
  const sample =
    measured !== undefined
      ? senderSample(layers, codecs, measured, prev, "measured")
      : senderSample(layers, codecs, fallbackCaptureFps, prev, "configured");
  return { sample, counters };
}

/** What a sender-stats lookup needs of the published share track: the
 *  browser's RTCRtpSender, or (a native track) livekit-shaped sender stats. */
export interface SenderStatsTrack {
  readonly sender?: { getStats?(): Promise<RTCStatsReport> };
  readonly mediaStreamTrack?: { getSettings?(): MediaTrackSettings };
  getSenderStats?(): Promise<readonly OutboundLayer[]>;
}

/** The last counters per sender. A new share is a new sender, so it starts
 *  clean; a sender that goes away takes its entry with it. */
const lastCounters = new WeakMap<object, PreviousCounters>();

/** One sample of the track's sender, or null where it has none to read. */
export async function readSenderSample(
  track: SenderStatsTrack | undefined,
): Promise<ShareSenderSample | null> {
  if (track === undefined) return null;
  const sender = track.sender;
  if (sender !== undefined && typeof sender.getStats === "function") {
    const opened = track.mediaStreamTrack?.getSettings?.().frameRate;
    const { sample, counters } = senderSampleFromReport(
      await sender.getStats(),
      opened,
      lastCounters.get(sender),
    );
    lastCounters.set(sender, counters);
    return sample;
  }
  // A native track: its mediaStreamTrack is the preview canvas, whose rate
  // says nothing about the capture.
  if (typeof track.getSenderStats === "function") {
    return senderSample(await track.getSenderStats(), new Map(), undefined);
  }
  return null;
}
