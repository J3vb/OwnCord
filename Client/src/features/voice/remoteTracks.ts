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
import type { RemoteVideoCallback, RemoteVideoRemovedCallback } from "./sessionState";

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
}
