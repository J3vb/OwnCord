// Voice remote-track surface — extracted from livekitSession.ts.
// Owns the remote-video callbacks the room event handlers fire, and the
// local/remote video stream lookups the UI polls. The stream implementations
// stay in screenShare.ts; the room is read from LiveKitSession on every call.
import { VideoQuality, type Room } from "livekit-client";
import {
  getLocalCameraStream as doGetLocalCameraStream,
  getLocalScreenshareStream as doGetLocalScreenshareStream,
  getRemoteVideoStream as doGetRemoteVideoStream,
} from "../../lib/screenShare";
import { parseUserId } from "./sessionState";
import type { RemoteVideoCallback, RemoteVideoRemovedCallback } from "./sessionState";

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
      }
    | undefined
  >;
}

/** The view that shows the more of a stream; either may be unset. */
function larger(a: VideoView | undefined, b: VideoView | undefined): VideoView | undefined {
  if (a?.enabled !== true) return b ?? a;
  if (b?.enabled !== true) return a;
  if (a.size === undefined || b.size === undefined) return { enabled: true };
  return a.size.width >= b.size.width ? a : b;
}

export class RemoteTracks {
  onRemoteVideoCallback: RemoteVideoCallback | null = null;
  onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  /** The grid tile's and the open hover preview's views, by `type:userId`. */
  private readonly gridViews = new Map<string, VideoView>();
  private readonly previews = new Map<string, VideoView>();

  constructor(private readonly getRoom: () => Room | null) {}

  setOnRemoteVideo(cb: RemoteVideoCallback): void {
    this.onRemoteVideoCallback = cb;
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
    this.onRemoteVideoRemovedCallback = cb;
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

  /** Get a remote participant's video MediaStream by userId and track type. Returns null if not available. */
  getRemoteVideoStream(userId: number, type: "camera" | "screenshare"): MediaStream | null {
    return doGetRemoteVideoStream(this.getRoom(), userId, type);
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
    };
  }

  /** Ask the SFU for only what a user's stream shows (P3-07): the grid tile
   *  drives the layer because adaptiveStream is off (roomLifecycle.ts), and
   *  the sidebar's hover preview (`preview`, `{ enabled: false }` once it
   *  closes) plays the same track, so while it is open the stream gets the
   *  larger of the two. The layer is set before enabling, so a re-shown tile
   *  resumes at its own size. */
  setRemoteVideoView(
    userId: number,
    type: "camera" | "screenshare",
    view: VideoView,
    preview = false,
  ): void {
    const key = `${type}:${userId}`;
    if (!preview) this.gridViews.set(key, view);
    else if (view.enabled) this.previews.set(key, view);
    else this.previews.delete(key);
    const wanted = larger(this.gridViews.get(key), this.previews.get(key));
    const pub = this.publication(userId, type);
    if (wanted === undefined || pub === undefined) return;
    if (wanted.size !== undefined) pub.setVideoDimensions(wanted.size);
    else if (wanted.enabled) pub.setVideoQuality(VideoQuality.HIGH);
    pub.setEnabled(wanted.enabled);
  }

  private publication(userId: number, type: "camera" | "screenshare") {
    for (const participant of this.getRoom()?.remoteParticipants.values() ?? []) {
      if (parseUserId(participant.identity) !== userId) continue;
      return participant.getTrackPublication(
        (type === "screenshare" ? "screen_share" : "camera") as never,
      );
    }
    return undefined;
  }
}
