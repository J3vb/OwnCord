/**
 * What your own screen share is actually sending, and why it falls short:
 * one sender stats sample read from the WebRTC sender (M-1).
 */

/** One sample of your screen share's sender. */
export interface ShareSenderSample {
  /** The rate the capture was opened at (`getSettings().frameRate`). */
  readonly captureFps?: number;
  /** The highest rate any layer is sending. */
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
}

/** The fields read from an `outbound-rtp` (or livekit's VideoSenderStats). */
interface OutboundLayer {
  readonly framesPerSecond?: number;
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly qualityLimitationReason?: string;
  readonly encoderImplementation?: string;
  readonly codecId?: string;
  /** false: a simulcast layer dynacast paused; it keeps its last size. */
  readonly active?: boolean;
}

/** A WebRTC stats entry, as far as this reads one. */
interface StatsEntry extends OutboundLayer {
  readonly type?: string;
  readonly mimeType?: string;
}

function rounded(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? undefined : Math.round(n);
}

/** Fold the sender's layers into one sample: the sent rate is the fastest
 *  layer's, everything else the top (widest) sending layer's. */
export function senderSample(
  layers: readonly OutboundLayer[],
  codecs: ReadonlyMap<string, string>,
  captureFps: number | undefined,
): ShareSenderSample {
  const sending = layers.filter((l) => l.active !== false);
  const top = (sending.length > 0 ? sending : layers).toSorted(
    (a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0),
  )[0];
  const rates = layers
    .map((l) => l.framesPerSecond)
    .filter((fps): fps is number => fps !== undefined);
  return {
    captureFps: rounded(captureFps),
    sentFps: rates.length > 0 ? Math.max(...rates) : undefined,
    width: top?.frameWidth,
    height: top?.frameHeight,
    limitation: top?.qualityLimitationReason,
    encoder: top?.encoderImplementation,
    codec: top?.codecId === undefined ? undefined : codecs.get(top.codecId),
  };
}

/** Read a raw `RTCRtpSender.getStats()` report. The capture rate is the
 *  `media-source` rate actually captured (a 60 Hz monitor gives 60), else
 *  `fallbackCaptureFps`. */
export function senderSampleFromReport(
  report: { forEach(cb: (entry: StatsEntry, id: string) => void): void },
  fallbackCaptureFps: number | undefined,
): ShareSenderSample {
  const layers: StatsEntry[] = [];
  const codecs = new Map<string, string>();
  let capturedFps: number | undefined;
  report.forEach((entry, id) => {
    if (entry.type === "outbound-rtp") layers.push(entry);
    else if (entry.type === "codec" && entry.mimeType !== undefined) codecs.set(id, entry.mimeType);
    else if (entry.type === "media-source") capturedFps ??= entry.framesPerSecond;
  });
  return senderSample(layers, codecs, capturedFps ?? fallbackCaptureFps);
}

/** What a sender-stats lookup needs of the published share track: the
 *  browser's RTCRtpSender, or (a native track) livekit-shaped sender stats. */
export interface SenderStatsTrack {
  readonly sender?: { getStats?(): Promise<RTCStatsReport> };
  readonly mediaStreamTrack?: { getSettings?(): MediaTrackSettings };
  getSenderStats?(): Promise<readonly OutboundLayer[]>;
}

/** One sample of the track's sender, or null where it has none to read. */
export async function readSenderSample(
  track: SenderStatsTrack | undefined,
): Promise<ShareSenderSample | null> {
  if (track === undefined) return null;
  if (typeof track.sender?.getStats === "function") {
    const opened = track.mediaStreamTrack?.getSettings?.().frameRate;
    return senderSampleFromReport(await track.sender.getStats(), opened);
  }
  // A native track: its mediaStreamTrack is the preview canvas, whose rate
  // says nothing about the capture.
  if (typeof track.getSenderStats === "function") {
    return senderSample(await track.getSenderStats(), new Map(), undefined);
  }
  return null;
}
