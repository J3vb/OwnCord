// The native room's remote participant model: the members audioElements,
// remoteTracks and livekitDiagnostics read. Split from nativeRoom.ts; each
// class reaches back into the room only through NativeRoomOps.
import type { VideoQuality } from "livekit-client";
import type {
  NativeVoiceStats,
  NativeVoiceStatsEntry,
  NativeVoiceTrack,
  NativeVideoQuality,
} from "../../../platform/contracts/nativeVoice";
import type { NativeVideoRenderer } from "./videoRenderer";

/** What the participant model calls back on its room. */
export interface NativeRoomOps {
  setSubscribed(identity: string, sid: string, subscribed: boolean): void;
  setVideoView(
    identity: string,
    sid: string,
    enabled: boolean,
    quality: NativeVideoQuality,
  ): Promise<void>;
  setVolume(identity: string, volume: number): void;
  readStats(): Promise<NativeVoiceStats | null>;
}

// --- Participant model: the members audioElements/livekitDiagnostics read ---

/** A remote video track as the shared handlers read it: the renderer's
 *  canvas track stands in for the browser's decoded track. */
export class NativeRemoteVideoTrack {
  readonly kind = "video";
  private disposed = false;
  private last: { bytes: number; atMs: number } | null = null;
  /** bits/s from the last two distinct samples' byte deltas; undefined until
   *  two exist (what the tile chip reads on the web path). */
  currentBitrate: number | undefined = undefined;
  constructor(
    readonly sid: string,
    readonly source: string,
    private readonly renderer: NativeVideoRenderer,
    private readonly stats: () => Promise<NativeVoiceStats | null> = () => Promise.resolve(null),
  ) {}
  /** The tile chip's receiver sample (`remoteTracks.getRemoteVideoStats`),
   *  from the host's shared stats tick. Undefined when the host has no sample
   *  for this track, so the chip falls back to the element's size. */
  async getReceiverStats(): Promise<
    | {
        frameWidth: number;
        frameHeight: number;
        framesDecoded: number;
        timestamp: number;
        mimeType?: string;
        packetsLost: number;
        packetsReceived: number;
      }
    | undefined
  > {
    const reply = await this.stats();
    const s = this.disposed ? undefined : reply?.remoteVideo[this.sid];
    if (reply == null || s === undefined) return undefined;
    if (this.last !== null && reply.atMs > this.last.atMs) {
      this.currentBitrate =
        s.bytesReceived >= this.last.bytes
          ? ((s.bytesReceived - this.last.bytes) * 8 * 1000) / (reply.atMs - this.last.atMs)
          : undefined;
    }
    if (this.last === null || reply.atMs > this.last.atMs) {
      this.last = { bytes: s.bytesReceived, atMs: reply.atMs };
    }
    return {
      frameWidth: s.frameWidth,
      frameHeight: s.frameHeight,
      framesDecoded: s.framesDecoded,
      timestamp: reply.atMs,
      mimeType: s.mimeType,
      packetsLost: s.packetsLost,
      packetsReceived: s.packetsReceived,
    };
  }
  get mediaStreamTrack(): MediaStreamTrack {
    return this.renderer.mediaStreamTrack;
  }
  /** The tiles own their elements; nothing is attached here. */
  detach(): HTMLMediaElement[] {
    return [];
  }
  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}

export class NativeRemotePublication {
  readonly trackSid: string;
  readonly kind: string;
  readonly source: string;
  /** The track's name; a music share's is "music". Empty from an older host. */
  readonly trackName: string;
  isSubscribed = true;
  /** Video: whether the SFU sends it, and at which layer. A fresh
   *  subscription comes at the top one. */
  isEnabled = true;
  private quality: NativeVideoQuality = "high";
  /** The host's last view update: the next one waits for it. */
  private viewSent: Promise<void> = Promise.resolve();
  isMuted: boolean;
  /** livekit-client's shape for the server's encryption report (`Encryption_Type`:
   *  0 none, 1 GCM), so the web path's refusal of unencrypted media applies here. */
  readonly trackInfo: { encryption: number };
  /** Video only, while subscribed. Audio has none: playout is native. */
  track: NativeRemoteVideoTrack | undefined = undefined;
  constructor(
    private readonly room: NativeRoomOps,
    private readonly identity: string,
    info: NativeVoiceTrack,
  ) {
    this.trackSid = info.sid;
    this.kind = info.kind;
    this.source = info.source;
    this.trackName = info.name ?? "";
    this.isMuted = info.muted;
    this.trackInfo = { encryption: info.encrypted ? 1 : 0 };
  }
  setSubscribed(subscribed: boolean): void {
    if (this.isSubscribed === subscribed) return;
    this.isSubscribed = subscribed;
    this.room.setSubscribed(this.identity, this.trackSid, subscribed);
  }
  /** livekit-client's layer controls, which RemoteTracks drives: the layer
   *  first, then whether it is sent. */
  setEnabled(enabled: boolean): void {
    this.setVideoView(enabled, this.quality);
  }
  setVideoQuality(quality: VideoQuality): void {
    this.setVideoView(this.isEnabled, (["low", "medium", "high"] as const)[quality] ?? "high");
  }
  /** Maps the size to a quality by choice (livekit 0.10.0's
   *  update_video_dimensions exists but is not used): the smallest of the
   *  usual 180p/360p/720p layers that covers the tile. */
  setVideoDimensions({ width, height }: { width: number; height: number }): void {
    const side = Math.max(width, height);
    this.setVideoView(this.isEnabled, side <= 320 ? "low" : side <= 640 ? "medium" : "high");
  }
  /** A new subscription starts enabled at the top layer again. */
  resetVideoView(): void {
    this.isEnabled = true;
    this.quality = "high";
  }
  /** A layer asked for while hidden goes out with the enable. */
  private setVideoView(enabled: boolean, quality: NativeVideoQuality): void {
    if (enabled === this.isEnabled && quality === this.quality) return;
    const send = enabled || this.isEnabled;
    this.isEnabled = enabled;
    this.quality = quality;
    if (!send) return;
    this.viewSent = this.viewSent.then(() =>
      this.room.setVideoView(this.identity, this.trackSid, enabled, quality),
    );
  }
}

export class NativeRemoteParticipant {
  readonly trackPublications = new Map<string, NativeRemotePublication>();
  private volume = 1;
  constructor(
    readonly identity: string,
    private readonly room: NativeRoomOps,
  ) {}
  get audioTrackPublications(): Map<string, NativeRemotePublication> {
    const audio = new Map<string, NativeRemotePublication>();
    for (const [sid, pub] of this.trackPublications) if (pub.kind === "audio") audio.set(sid, pub);
    return audio;
  }
  getTrackPublication(source: string): NativeRemotePublication | undefined {
    for (const pub of this.trackPublications.values()) if (pub.source === source) return pub;
    return undefined;
  }
  /** The microphone's playout gain, as livekit-client's (1 is unity). */
  getVolume(): number {
    return this.volume;
  }
  setVolume(volume: number): void {
    this.volume = volume;
    this.room.setVolume(this.identity, volume);
  }
}

/** Stands in for livekit-client's `PCTransport` where connectionStats and
 *  livekitDiagnostics read it. */
export class NativeStatsTransport {
  constructor(
    private readonly room: NativeRoomOps,
    private readonly side: "publisher" | "subscriber",
  ) {}
  /** undefined (not an empty report) when there is nothing: the poller must
   *  see "no transports" and keep reading unavailable, never a 4-bar
   *  "excellent" with rtt 0. */
  async getStats(): Promise<ReadonlyMap<string, NativeVoiceStatsEntry> | undefined> {
    const entries = (await this.room.readStats())?.[this.side];
    return entries === undefined || entries.length === 0
      ? undefined
      : new Map(entries.map((e) => [e.id, e]));
  }
  /** The backend does not report ICE state to the webview; livekitDiagnostics
   *  logs these. */
  getICEConnectionState(): string {
    return "unknown";
  }
  getConnectionState(): string {
    return "unknown";
  }
  getSignallingState(): string {
    return "unknown";
  }
}
