// Remote video and the screen-share watch set: the callbacks the video grid
// registers, which remote streams this client watches (and tells the server
// about), and the receiver stats of each.
import type { StreamSample, VideoView } from "./remoteTracks";
import { RemoteTracks } from "./remoteTracks";
import { voiceStore } from "@stores/voice.store";
import { noteWatchSent } from "@lib/voice/watchRequest";
import type { RemoteVideoCallback, RemoteVideoRemovedCallback } from "./sessionState";
import { SessionCore } from "./sessionCore";

/** Most ids one voice_watch carries (the server's cap). */
const MAX_WATCH_IDS = 16;

/** How long to wait before re-sending a rate-limited voice_watch. */
const WATCH_RETRY_MS = 1000;

export abstract class SessionRemote extends SessionCore {
  /** Remote-video callbacks and the video stream lookups. */
  protected _remoteTracks = this.createRemoteTracks();
  /** True while leaveVoice clears the watch set: the server clears on leave,
   *  so the clear must not send a voice_watch of its own. */
  protected _leavingVoice = false;
  /** The pending retry after a rate-limited voice_watch. */
  protected _watchRetry: ReturnType<typeof setTimeout> | null = null;
  // Test-visibility proxies: the callbacks live on RemoteTracks.
  protected get onRemoteVideoCallback(): RemoteVideoCallback | null {
    return this._remoteTracks.onRemoteVideoCallback;
  }
  protected get onRemoteVideoRemovedCallback(): RemoteVideoRemovedCallback | null {
    return this._remoteTracks.onRemoteVideoRemovedCallback;
  }
  protected createRemoteTracks(): RemoteTracks {
    const tracks = new RemoteTracks(() => this._room);
    tracks.onWatchingChange = (ids) => {
      if (!this._leavingVoice) this.sendWatching(ids);
    };
    return tracks;
  }

  /** Tell the server whose screen shares we watch (voice_watch), while we are
   *  in a voice channel with the socket up. A re-send (no `ids`) always sends
   *  the current set, empty included, because the server keeps the old set
   *  across a resume; `skipEmpty` is for a fresh join, where the server just
   *  cleared it. A refusal (a server from before 6.6) is ignored by the
   *  dispatcher via watchRequest. */
  protected sendWatching(ids?: readonly number[], skipEmpty = false): void {
    // Deduped, sorted and within the server's cap of 16 (it counts the raw list).
    const current = [...new Set(ids ?? this._remoteTracks.watchedScreenshares())]
      .toSorted((a, b) => a - b)
      .slice(0, MAX_WATCH_IDS);
    if (skipEmpty && current.length === 0) return;
    if (this.ws === null || this.ws.getState() !== "connected") return;
    if (voiceStore.getState().currentChannelId === null) return;
    noteWatchSent(this.ws.send({ type: "voice_watch", payload: { user_ids: [...current] } }));
  }

  /** The socket resumed while in voice: re-send our own set (the server keeps
   *  it across a resume, but a change made while the socket was down was
   *  never sent). */
  resendWatching(): void {
    this.sendWatching();
  }

  /** The server rate-limited a voice_watch: send the current set once more
   *  after a second. leaveVoice clears the timer. */
  retryWatching(): void {
    if (this._watchRetry !== null) return;
    this._watchRetry = setTimeout(() => {
      this._watchRetry = null;
      this.sendWatching();
    }, WATCH_RETRY_MS);
  }

  setOnRemoteVideo(cb: RemoteVideoCallback): void {
    this._remoteTracks.setOnRemoteVideo(cb);
  }
  setOnRemoteVideoRemoved(cb: RemoteVideoRemovedCallback): void {
    this._remoteTracks.setOnRemoteVideoRemoved(cb);
  }

  clearOnRemoteVideo(): void {
    this._remoteTracks.clearOnRemoteVideo();
  }

  getLocalCameraStream(): MediaStream | null {
    return this._remoteTracks.getLocalCameraStream();
  }

  getLocalScreenshareStream(): MediaStream | null {
    return this._remoteTracks.getLocalScreenshareStream();
  }

  /** One receiver sample of a remote camera or screen share (video tile chip). */
  getRemoteVideoStats(
    userId: number,
    type: "camera" | "screenshare",
  ): Promise<StreamSample | null> {
    return this._remoteTracks.getRemoteVideoStats(userId, type);
  }

  /** Ask for only what a remote video tile shows. */
  setRemoteVideoView(userId: number, type: "camera" | "screenshare", view: VideoView): void {
    this._remoteTracks.setRemoteVideoView(userId, type, view);
  }

  /** Watch a remote camera or screen share, or stop: opt-in watching. */
  setRemoteVideoWatched(userId: number, type: "camera" | "screenshare", on: boolean): void {
    this._remoteTracks.watch(userId, type, on);
  }

  /** A remote stream ended: drop its watch without counting as Stop watching. */
  forgetRemoteVideoWatch(userId: number, type: "camera" | "screenshare"): void {
    this._remoteTracks.forgetWatch(userId, type);
  }
}
