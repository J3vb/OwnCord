// Voice remote-track surface — extracted from livekitSession.ts.
// Owns the remote-video callbacks the room event handlers fire, and the
// local/remote video stream lookups the UI polls. The stream implementations
// stay in screenShare.ts; the room is read from LiveKitSession on every call.
import { VideoQuality, type Room } from "livekit-client";
import {
  getLocalCameraStream as doGetLocalCameraStream,
  getLocalScreenshareStream as doGetLocalScreenshareStream,
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

export class RemoteTracks {
  onRemoteVideoCallback: RemoteVideoCallback | null = null;
  onRemoteVideoRemovedCallback: RemoteVideoRemovedCallback | null = null;
  /** The streams the viewer watches, as `${userId}:${type}`. */
  private readonly watched = new Set<string>();

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
  }

  isWatched(userId: number, type: "camera" | "screenshare"): boolean {
    return this.watched.has(`${userId}:${type}`);
  }

  /** Watch a user's camera or screen share (with its audio), or stop: the
   *  subscription follows. A stream not yet published is subscribed when it
   *  is (roomEventHandlers' handleTrackPublished asks isWatched). */
  watch(userId: number, type: "camera" | "screenshare", on: boolean): void {
    const key = `${userId}:${type}`;
    if (on) this.watched.add(key);
    else this.watched.delete(key);
    const sources =
      type === "screenshare" ? (["screenshare", "screen_share_audio"] as const) : [type];
    for (const source of sources) this.publication(userId, source)?.setSubscribed(on);
  }

  /** Forget watches whose stream the room does not publish. */
  dropUnpublishedWatches(): void {
    for (const key of this.watched) {
      const [userId, type] = key.split(":") as [string, "camera" | "screenshare"];
      if (this.publication(Number(userId), type) === undefined) this.watched.delete(key);
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
