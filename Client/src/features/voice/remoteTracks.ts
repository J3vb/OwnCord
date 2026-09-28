// Voice remote-track surface — extracted from livekitSession.ts.
// Owns the remote-video callbacks the room event handlers fire, and the
// local/remote video stream lookups the UI polls. The stream implementations
// stay in screenShare.ts; the room is read from LiveKitSession on every call.
import type { Room } from "livekit-client";
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
    const room = this.getRoom();
    if (room === null) return null;
    const source = type === "screenshare" ? "screen_share" : "camera";
    let track: StatsTrack | undefined;
    for (const participant of room.remoteParticipants.values()) {
      if (parseUserId(participant.identity) !== userId) continue;
      track = participant.getTrackPublication(source as never)?.track;
      break;
    }
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
}
