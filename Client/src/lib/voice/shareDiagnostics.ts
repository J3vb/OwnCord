/**
 * A bounded, local recorder of the screen-share timeline (screen-sharing
 * pipeline plan, PR 2b): once a second, your own share's sender sample and a
 * receiver sample for each share you watch, kept in a ring of at most 180
 * samples and 2 MiB. It runs only while "Record screen-share details" is on,
 * records nothing but numbers and codec/encoder names, and never leaves the
 * computer except through the support bundle.
 */

import { setOwnedTimeout } from "../dom";
import { createLogger } from "../logger";
import type { StreamSample } from "../../features/voice/remoteTracks";
import { SHARE_POLICY_VERSION } from "./shareFlags";
import type { ShareSenderSample } from "../../features/voice/shareSenderStats";

const log = createLogger("shareDiagnostics");

export const SHARE_POLL_MS = 1000;
export const SHARE_RING_MAX_SAMPLES = 180;
export const SHARE_RING_MAX_BYTES = 2 * 1024 * 1024;

export interface RecorderDeps {
  /** shareDiagnosticsV2 */
  enabled(): boolean;
  /** The current shareMotionPolicy value. */
  policy(): string;
  /** Identity of the live local share track; undefined when not sharing. */
  shareEpoch(): object | undefined;
  readSender(): Promise<ShareSenderSample | null>;
  /** Remote user ids whose screen share is watched. */
  watchedShares(): number[];
  readViewer(userId: number): Promise<StreamSample | null>;
  /** performance.now()-like milliseconds. */
  now(): number;
}

export interface ShareViewerSample {
  readonly userId: number;
  readonly sample: StreamSample;
}

export interface ShareDiagnosticsRecord {
  /** Milliseconds since the recorder started (monotonic). */
  readonly t: number;
  /** Counts each distinct local share track seen since the recorder started. */
  readonly shareGeneration: number;
  readonly policy: string;
  readonly policyVersion: string;
  readonly sender: ShareSenderSample | null;
  readonly viewers: readonly ShareViewerSample[];
}

export interface ShareDiagnosticsSnapshot {
  readonly policy: string;
  readonly policyVersion: string;
  readonly startedAt: string;
  readonly dropped: number;
  readonly samples: readonly ShareDiagnosticsRecord[];
}

/** Only these receiver fields are recorded, whatever the track returns. */
function pickViewerSample(s: StreamSample): StreamSample {
  return {
    frameWidth: s.frameWidth,
    frameHeight: s.frameHeight,
    framesDecoded: s.framesDecoded,
    timestamp: s.timestamp,
    bitrate: s.bitrate,
    codec: s.codec,
    packetsLost: s.packetsLost,
    packetsReceived: s.packetsReceived,
    framesDropped: s.framesDropped,
    framesReceived: s.framesReceived,
    decoderImplementation: s.decoderImplementation,
    jitterBufferDelay: s.jitterBufferDelay,
  };
}

export class ShareDiagnosticsRecorder {
  private samples: ShareDiagnosticsRecord[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private dropped = 0;
  private startedAt = new Date().toISOString();
  private startMs = 0;
  private started = false;
  private lastEpoch: object | undefined;
  private generation = 0;
  /** The test mode the live share was published under: read once when the
   *  share first shows up, since a change only applies to the next share. */
  private sharePolicy: string | undefined;

  constructor(private readonly deps: RecorderDeps) {}

  /** Poll once a second until `signal` aborts. At most one poll is in flight:
   *  the next is armed only after the previous one finished. */
  start(signal: AbortSignal): void {
    if (this.started || signal.aborted) return;
    this.started = true;
    this.startMs = this.deps.now();
    this.startedAt = new Date().toISOString();
    const tick = (): void => {
      void this.poll(signal).finally(() => {
        setOwnedTimeout(signal, tick, SHARE_POLL_MS);
      });
    };
    setOwnedTimeout(signal, tick, SHARE_POLL_MS);
  }

  snapshot(): ShareDiagnosticsSnapshot {
    return {
      policy: this.sharePolicy ?? this.deps.policy(),
      policyVersion: SHARE_POLICY_VERSION,
      startedAt: this.startedAt,
      dropped: this.dropped,
      samples: [...this.samples],
    };
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.samples = [];
    this.sizes = [];
    this.bytes = 0;
    this.dropped = 0;
    // `t` and `startedAt` share one origin.
    this.startMs = this.deps.now();
    this.startedAt = new Date().toISOString();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted || !this.deps.enabled()) return;
      const epoch = this.deps.shareEpoch();
      const watched = this.deps.watchedShares();
      if (epoch === undefined && watched.length === 0) return;
      if (epoch !== undefined && epoch !== this.lastEpoch) {
        this.generation += 1;
        this.sharePolicy = this.deps.policy();
      }
      this.lastEpoch = epoch;
      const generation = this.generation;
      const policy = (epoch !== undefined ? this.sharePolicy : undefined) ?? this.deps.policy();

      const [sender, viewers] = await Promise.all([
        epoch === undefined ? null : this.safe("sender", () => this.deps.readSender()),
        Promise.all(
          watched.map(async (userId) => ({
            userId,
            sample: await this.safe("viewer", () => this.deps.readViewer(userId)),
          })),
        ),
      ]);
      if (signal.aborted) return;
      // A read that resolves under a newer share must not be filed under it.
      const senderCurrent = this.deps.shareEpoch() === epoch;
      const t = this.deps.now() - this.startMs;
      this.push({
        t,
        shareGeneration: generation,
        policy,
        policyVersion: SHARE_POLICY_VERSION,
        sender: senderCurrent ? sender : null,
        viewers: viewers.flatMap(({ userId, sample }) =>
          sample === null ? [] : [{ userId, sample: pickViewerSample(sample) }],
        ),
      });
    } catch (err) {
      log.debug("share diagnostics poll failed", { err });
    }
  }

  private async safe<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      log.debug("share diagnostics read failed", { what, err });
      return null;
    }
  }

  private push(record: ShareDiagnosticsRecord): void {
    const size = JSON.stringify(record).length;
    this.samples.push(record);
    this.sizes.push(size);
    this.bytes += size;
    while (
      this.samples.length > 0 &&
      (this.samples.length > SHARE_RING_MAX_SAMPLES || this.bytes > SHARE_RING_MAX_BYTES)
    ) {
      this.samples.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.dropped += 1;
    }
  }
}
