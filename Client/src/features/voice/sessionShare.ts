// Screen-share diagnostics for the session: the recorder that times a share
// across a room session, and your own share's sender stats for the support
// bundle.
import { Track } from "livekit-client";
import type { ShareSenderSample } from "./shareSenderStats";
import {
  ShareDiagnosticsRecorder,
  type ShareDiagnosticsSnapshot,
} from "@lib/voice/shareDiagnostics";
import { getShareDiagnosticsEnabled, getShareMotionPolicy } from "@lib/voice/shareFlags";
import { Disposable } from "@lib/disposable";
import { isMusicPublication } from "@lib/voice/musicTrack";
import { isLinuxDesktop } from "./native/platform";
import { SessionRemote } from "./sessionRemote";
import { withServerLimit } from "./videoCapFollow";
import type { ScreenTrackState } from "./screenShare";

export abstract class SessionShare extends SessionRemote {
  protected abstract readonly _screenState: ScreenTrackState;
  /** Your screen share's last sender sample, for the support bundle. */
  protected _shareSender: ShareSenderSample | null = null;
  /** The screen-share timeline of the current (or last) room session, and
   *  the owner whose signal stops its polling when the session ends. */
  protected _shareDiag: ShareDiagnosticsRecorder | null = null;
  protected _shareDiagOwner: Disposable | null = null;
  /** One recorder per room session: a reconnect keeps it, leaveVoice stops
   *  it, and the next join starts a fresh one. */
  protected startShareDiagnostics(): void {
    if (this._shareDiagOwner !== null) return;
    const recorder = new ShareDiagnosticsRecorder({
      enabled: () => getShareDiagnosticsEnabled(),
      // The Linux native capture never applies the test switch.
      policy: () => (isLinuxDesktop() ? "legacy" : getShareMotionPolicy()),
      shareEpoch: () => this.localScreenshareTrack(),
      readSender: () => this._remoteTracks.getLocalScreenshareStats(),
      watchedShares: () => this._remoteTracks.watchedScreenshares(),
      readViewer: (id) => this._remoteTracks.getRemoteVideoStats(id, "screenshare"),
      now: () => performance.now(),
    });
    const owner = new Disposable();
    this._shareDiag = recorder;
    this._shareDiagOwner = owner;
    recorder.start(owner.signal);
  }

  /** Stops polling but keeps the timeline: a test usually ends by leaving
   *  the call and then saving the support bundle. */
  protected stopShareDiagnostics(): void {
    this._shareDiagOwner?.destroy();
    this._shareDiagOwner = null;
  }

  /** The recorded screen-share timeline, or null when nothing was recorded. */
  getShareDiagnostics(): ShareDiagnosticsSnapshot | null {
    const snapshot = this._shareDiag?.snapshot();
    return snapshot === undefined || snapshot.samples.length === 0 ? null : snapshot;
  }

  /** What your screen share is sending; the last sample also goes into diagnostics. */
  async getLocalScreenshareStats(): Promise<ShareSenderSample | null> {
    const shared = this.localScreenshareTrack();
    const sample = await this._remoteTracks.getLocalScreenshareStats();
    // A read that outlived its share says nothing about the one now live.
    if (this.localScreenshareTrack() !== shared) return null;
    this._shareSender = sample;
    return withServerLimit(sample, this._screenState);
  }

  protected localScreenshareTrack(): object | undefined {
    return this._room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  }

  /** Your screen share is publishing its audio too. */
  hasLocalScreenshareAudio(): boolean {
    const local = this._room?.localParticipant;
    const first = local?.getTrackPublication(Track.Source.ScreenShareAudio);
    if (first === undefined) return false;
    if (!isMusicPublication(first)) return true;
    // The first is the music share: another may be a screen share's sound.
    for (const pub of local?.trackPublications.values() ?? []) {
      if (pub.source === Track.Source.ScreenShareAudio && !isMusicPublication(pub)) return true;
    }
    return false;
  }
}
