// Voice remote-track surface — extracted from livekitSession.ts.
// Owns the remote-video callbacks the room event handlers fire, and the
// local/remote video stream lookups the UI polls. The stream implementations
// stay in screenShare.ts; the room is read from LiveKitSession on every call.
import { VideoQuality, type Room } from "livekit-client";
import {
  getLocalCameraStream as doGetLocalCameraStream,
  getLocalScreenshareStream as doGetLocalScreenshareStream,
  getLocalScreenshareStats as doGetLocalScreenshareStats,
} from "../../lib/screenShare";
import { parseUserId } from "./sessionState";
import { isUnencryptedPublication } from "./mediaEncryption";
import { autoPlayCameras } from "./autoPlayCameras";
import type { RemoteVideoCallback, RemoteVideoRemovedCallback } from "./sessionState";
import type { ShareSenderSample } from "./shareSenderStats";

/** One receiver sample of a remote video track (getReceiverStats plus
 *  currentBitrate), for a video tile's quality chip. */
export interface StreamSample {
  readonly frameWidth?: number;
  readonly frameHeight?: number;
  readonly framesDecoded?: number;
  /** ms */
  readonly timestamp: number;
  /** bits per second */
  readonly bitrate?: number;
  /** e.g. "video/VP8" */
  readonly codec?: string;
  readonly packetsLost?: number;
  readonly packetsReceived?: number;
  readonly framesDropped?: number;
  readonly framesReceived?: number;
  /** e.g. "ExternalDecoder", "libvpx" */
  readonly decoderImplementation?: string;
  /** Cumulative seconds frames spent in the jitter buffer. */
  readonly jitterBufferDelay?: number;
}

/** What a remote video tile shows: nothing, or its rendered device pixels
 *  (no size: the top layer, for the stream you are watching). */
export interface VideoView {
  readonly enabled: boolean;
  readonly size?: { readonly width: number; readonly height: number };
}

/** What a receiver-stats lookup needs of a subscribed remote video track. */
interface StatsTrack {
  readonly currentBitrate?: number;
  getReceiverStats?(): Promise<
    | {
        frameWidth?: number;
        frameHeight?: number;
        framesDecoded?: number;
        timestamp: number;
        mimeType?: string;
        packetsLost?: number;
        packetsReceived?: number;
        framesDropped?: number;
        framesReceived?: number;
        decoderImplementation?: string;
        jitterBufferDelay?: number;
      }
    | undefined
  >;
}

function streamKey(userId: number, isScreenshare: boolean): string {
  return `${userId}:${isScreenshare ? "screenshare" : "camera"}`;
}

export class RemoteTracks {
  onRemoteVideoCallback: RemoteVideoCallback | null = null;
  onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  /** The streams the viewer watches, as `${userId}:${type}`. */
  private readonly watched = new Set<string>();
  /** Cameras the viewer chose Stop watching for, kept until leave: with
   *  auto-play on, every other camera is watched. */
  private readonly stopped = new Set<string>();
  /** The remote streams the grid was handed a tile for, as
   *  `${userId}:${type}`, so a room swap can remove the ones that did not
   *  survive it. */
  private readonly offered = new Set<string>();

  /** Told the sorted user ids whose screen share is watched, whenever that
   *  set changes (a camera never counts). */
  onWatchingChange: ((userIds: number[]) => void) | null = null;
  /** The last set reported, to fire only on a real change. */
  private reportedWatching: readonly number[] = [];

  constructor(
    private readonly getRoom: () => Room | null,
    private readonly autoPlay: () => boolean = autoPlayCameras,
  ) {}

  setOnRemoteVideo(cb: RemoteVideoCallback): void {
    this.onRemoteVideoCallback = (userId, stream, isScreenshare) => {
      this.offered.add(streamKey(userId, isScreenshare));
      cb(userId, stream, isScreenshare);
    };
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
    this.onRemoteVideoRemovedCallback = (userId, isScreenshare) => {
      this.offered.delete(streamKey(userId, isScreenshare));
      cb(userId, isScreenshare);
    };
  }

  clearOnRemoteVideo(): void {
    this.onRemoteVideoCallback = null;
    this.onRemoteVideoRemovedCallback = null;
  }

  getLocalCameraStream(): MediaStream | null {
    return doGetLocalCameraStream(this.getRoom());
  }

  getLocalScreenshareStream(): MediaStream | null {
    return doGetLocalScreenshareStream(this.getRoom());
  }

  /** What your screen share is sending (its own tile's readout). */
  getLocalScreenshareStats(): Promise<ShareSenderSample | null> {
    return doGetLocalScreenshareStats(this.getRoom());
  }

  /** One receiver sample of a user's camera or screen share, for the video
   *  tile's quality chip; null where the track has no receiver stats (the
   *  Linux native room renders through a canvas track). */
  async getRemoteVideoStats(
    userId: number,
    type: "camera" | "screenshare",
  ): Promise<StreamSample | null> {
    const track: StatsTrack | undefined = this.publication(userId, type)?.track;
    if (typeof track?.getReceiverStats !== "function") return null;
    const stats = await track.getReceiverStats();
    if (stats === undefined) return null;
    return {
      frameWidth: stats.frameWidth,
      frameHeight: stats.frameHeight,
      framesDecoded: stats.framesDecoded,
      timestamp: stats.timestamp,
      bitrate: track.currentBitrate,
      codec: stats.mimeType,
      packetsLost: stats.packetsLost,
      packetsReceived: stats.packetsReceived,
      framesDropped: stats.framesDropped,
      framesReceived: stats.framesReceived,
      decoderImplementation: stats.decoderImplementation,
      jitterBufferDelay: stats.jitterBufferDelay,
    };
  }

  /** Ask the SFU for only what a user's stream shows (P3-07): the grid tile
   *  drives the layer because adaptiveStream is off (roomLifecycle.ts). The
   *  layer is set before enabling, so a re-shown tile resumes at its own
   *  size. */
  setRemoteVideoView(userId: number, type: "camera" | "screenshare", view: VideoView): void {
    const pub = this.publication(userId, type);
    // An unwatched stream is not subscribed: there is no layer to ask for.
    if (pub?.isSubscribed !== true) return;
    if (view.size !== undefined) pub.setVideoDimensions(view.size);
    else if (view.enabled) pub.setVideoQuality(VideoQuality.HIGH);
    pub.setEnabled(view.enabled);
  }

  clearWatched(): void {
    this.watched.clear();
    this.stopped.clear();
    this.offered.clear();
    this.reportWatching();
  }

  /** The user ids whose screen share is watched, sorted. */
  watchedScreenshares(): number[] {
    const ids: number[] = [];
    for (const key of this.watched) {
      const [userId, type] = key.split(":") as [string, string];
      if (type === "screenshare") ids.push(Number(userId));
    }
    return ids.toSorted((a, b) => a - b);
  }

  /** Fire onWatchingChange when the watched screen-share set changed. */
  private reportWatching(): void {
    const now = this.watchedScreenshares();
    const before = this.reportedWatching;
    if (now.length === before.length && now.every((id, i) => id === before[i])) return;
    this.reportedWatching = now;
    this.onWatchingChange?.([...now]);
  }

  /** A screen share only once watched; a camera too while auto-play is off,
   *  otherwise unless the viewer stopped it. */
  isWatched(userId: number, type: "camera" | "screenshare"): boolean {
    const key = `${userId}:${type}`;
    if (type === "camera" && this.autoPlay()) return !this.stopped.has(key);
    return this.watched.has(key);
  }

  /** Watch a user's camera or screen share (with its audio), or stop: the
   *  subscription follows. A stream not yet published is subscribed when it
   *  is (roomEventHandlers' handleTrackPublished asks isWatched). */
  watch(userId: number, type: "camera" | "screenshare", on: boolean): void {
    const key = `${userId}:${type}`;
    if (on) {
      this.watched.add(key);
      this.stopped.delete(key);
    } else {
      this.watched.delete(key);
      if (type === "camera") this.stopped.add(key);
    }
    const sources =
      type === "screenshare" ? (["screenshare", "screen_share_audio"] as const) : [type];
    for (const source of sources) {
      const pub = this.publication(userId, source);
      if (pub === undefined || (on && isUnencryptedPublication(pub))) continue;
      pub.setSubscribed(on);
    }
    this.reportWatching();
  }

  /** The stream ended (unpublished, its user left, or a channel change):
   *  drop its watch, so a new one starts from the default. A screen share is
   *  unwatched as before; a camera's Stop watching is kept until leave. A
   *  camera's publication is gone or being torn down here, so there is no
   *  subscription to drop. */
  forgetWatch(userId: number, type: "camera" | "screenshare"): void {
    if (type === "screenshare") this.watch(userId, type, false);
    else this.watched.delete(`${userId}:${type}`);
    this.reportWatching();
  }

  /** Forget watches whose stream the room does not publish. */
  dropUnpublishedWatches(): void {
    for (const key of this.watched) {
      const [userId, type] = key.split(":") as [string, "camera" | "screenshare"];
      if (this.publication(Number(userId), type) === undefined) this.watched.delete(key);
    }
    this.reportWatching();
  }

  /** Remove the tiles whose stream the room does not publish. A replaced
   *  room is detached before it disconnects, so it raises no unpublish for a
   *  stream that ended or a user who left while the call reconnected. */
  removeUnpublishedTiles(): void {
    for (const key of this.offered) {
      const [userId, type] = key.split(":") as [string, "camera" | "screenshare"];
      if (this.publication(Number(userId), type) !== undefined) continue;
      this.offered.delete(key);
      this.onRemoteVideoRemovedCallback?.(Number(userId), type === "screenshare");
    }
  }

  /** A user's publication of a source, or of the camera or screen share. */
  private publication(userId: number, source: "camera" | "screenshare" | "screen_share_audio") {
    const name = source === "screenshare" ? "screen_share" : source;
    for (const participant of this.getRoom()?.remoteParticipants.values() ?? []) {
      if (parseUserId(participant.identity) !== userId) continue;
      return participant.getTrackPublication(name as never);
    }
    return undefined;
  }
}
