// The remote half of the Linux native room: the event emitter, the shared
// host stats reply, the roster of remote participants and their tracks, and the
// roster events the backend sends. Split from nativeRoom.ts; NativeRoom extends
// it and adds the local participant, the microphone, the captures and the
// session lifecycle. Everything stays one object per room.
import { RoomEvent } from "livekit-client";
import { createLogger } from "../../../lib/logger";
import { voiceStore } from "../../../stores/voice.store";
import { desktop } from "../../../platform/desktop";
import type {
  NativeVoiceEvent,
  NativeVoiceParticipant,
  NativeVoiceStats,
  NativeVoiceTrack,
  NativeVideoQuality,
} from "../../../platform/contracts/nativeVoice";
import {
  NativeRemoteParticipant,
  NativeRemotePublication,
  NativeRemoteVideoTrack,
  type NativeRoomOps,
} from "./nativeRoomModel";
import { NativeVideoRenderer } from "./videoRenderer";

/** How often a remote participant whose frames stopped decrypting
 *  is re-reported — the web E2EE worker's cadence, so the shared streak grace
 *  in `lib/voice/roomEventHandlers.ts` applies to the native path
 *  unchanged. Unlike the web worker's, these reports are not rate-limited, so
 *  the native room recovers after the short quiet gap (`isNativeRoom`). */
const DECRYPT_REPORT_MS = 1000;

/** How long callers share one host stats reply: the poller, a watched tile
 *  and your own share all poll every 2 s, so their ticks collapse into one
 *  IPC; the poller alone always gets a fresh one. */
const STATS_SHARE_MS = 1500;

const log = createLogger("nativeRoom");

type Listener = (...args: unknown[]) => void;

export abstract class NativeRoomRemote implements NativeRoomOps {
  /** Set by NativeRoom: the local participant, whose identity tells an
   *  encryption report about us from one about a peer. */
  abstract readonly localParticipant: { identity: string };
  /** Dispose every renderer and the local tracks without raising events. */
  protected abstract releaseVideo(): void;

  /** `volumeOf` is the saved volume a participant starts at: the web path
   *  applies it on the audio `TrackSubscribed`, which native never raises.
   *  `screenshareVolumeOf` is their screen-share audio's, which the web path
   *  sets on its audio element; `applyScreenshareVolumes` re-reads it. */
  constructor(
    protected readonly volumeOf: (identity: string) => number = () => 1,
    protected readonly screenshareVolumeOf: (identity: string) => number = () => 1,
  ) {}

  state: "disconnected" | "connecting" | "connected" | "reconnecting" = "disconnected";

  protected statsTick: {
    session: number;
    at: number;
    reply: Promise<NativeVoiceStats | null>;
  } | null = null;

  /** @internal The adapter's own readers only: the stats transports, the
   *  remote video tracks and the screen track. One host call per tick. */
  readStats(): Promise<NativeVoiceStats | null> {
    const session = this.sessionId;
    if (session === null || this.state !== "connected") return Promise.resolve(null);
    const now = performance.now();
    const tick = this.statsTick;
    if (tick !== null && tick.session === session && now - tick.at < STATS_SHARE_MS) {
      return tick.reply;
    }
    const reply = desktop.nativeVoice
      .getStats(session)
      .catch(() => null)
      .then((r) => (this.sessionId === session ? r : null));
    this.statsTick = { session, at: now, reply };
    return reply;
  }

  /** connectionDiagnostics asks this instead of `engine.client.ws`: the
   *  backend's signaling is up exactly while the room reads "connected"
   *  (it reports "reconnecting" and "disconnected" as they happen). */
  isSignalingConnected(): boolean {
    return this.state === "connected";
  }

  readonly remoteParticipants = new Map<string, NativeRemoteParticipant>();

  /** One re-report per remote identity whose frames stopped
   *  decrypting; cleared when they decrypt again or the peer leaves. */
  protected readonly decryptTimers = new Map<string, ReturnType<typeof setInterval>>();

  protected sessionId: number | null = null;

  /** The session's frame-socket base URL (token included); never logged. */
  protected frames = "";

  private readonly listeners = new Map<string, Set<Listener>>();

  protected announcing = false;

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (set === undefined) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  protected emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  // --- Room surface ---

  /** A subscribed remote video track: open its renderer and raise it the way
   *  livekit-client does. A resubscribe replaces the old renderer. */
  protected subscribeVideo(identity: string, pub: NativeRemotePublication): void {
    this.unsubscribeVideo(identity, pub);
    const renderer = new NativeVideoRenderer(`${this.frames}/remote/${pub.trackSid}`);
    pub.resetVideoView();
    pub.track = new NativeRemoteVideoTrack(pub.trackSid, pub.source, renderer, () =>
      this.readStats(),
    );
    this.emit(RoomEvent.TrackSubscribed, pub.track, pub, this.participant(identity));
  }

  protected unsubscribeVideo(identity: string, pub: NativeRemotePublication | undefined): void {
    const track = pub?.track;
    if (pub === undefined || track === undefined) return;
    pub.track = undefined;
    track.dispose();
    this.emit(RoomEvent.TrackUnsubscribed, track, pub, this.participant(identity));
  }

  /** Deafen: forwarded from the publication model. */
  setSubscribed(identity: string, sid: string, subscribed: boolean): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setSubscribed(this.sessionId, identity, sid, subscribed)
      .catch((err) => log.warn("native setSubscribed failed", { identity, sid, subscribed, err }));
  }

  /** Video layer control: forwarded from the publication model. */
  async setVideoView(
    identity: string,
    sid: string,
    enabled: boolean,
    quality: NativeVideoQuality,
  ): Promise<void> {
    if (this.sessionId === null) return;
    await desktop.nativeVoice
      .setVideoView(this.sessionId, identity, sid, enabled, quality)
      .catch((err) => log.warn("native setVideoView failed", { identity, sid, enabled, err }));
  }

  /** Per-user volume: forwarded from the participant model. */
  setVolume(identity: string, volume: number): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setVolume(this.sessionId, identity, volume)
      .catch((err) => log.warn("native setVolume failed", { identity, volume, err }));
  }

  /** Screen-share audio volume (0 when muted). */
  protected setScreenshareVolume(identity: string, volume: number): void {
    if (this.sessionId === null) return;
    desktop.nativeVoice
      .setScreenshareVolume(this.sessionId, identity, volume)
      .catch((err) => log.warn("native setScreenshareVolume failed", { identity, volume, err }));
  }

  /** Re-read every participant's screen-share audio volume after a change
   *  to it, its mute or the output volume. */
  applyScreenshareVolumes(): void {
    for (const identity of this.remoteParticipants.keys())
      this.setScreenshareVolume(identity, this.screenshareVolumeOf(identity));
  }

  protected participant(identity: string): NativeRemoteParticipant {
    let p = this.remoteParticipants.get(identity);
    if (p === undefined) {
      this.remoteParticipants.set(identity, (p = new NativeRemoteParticipant(identity, this)));
      p.setVolume(this.volumeOf(identity));
      this.setScreenshareVolume(identity, this.screenshareVolumeOf(identity));
    }
    return p;
  }

  /** The backend auto-subscribes every track, so a voice track that appears
   *  while deafened is unsubscribed here — the native counterpart of
   *  AudioElements.handleTrackSubscribedAudio's guard, which never runs on
   *  Linux because no TrackSubscribed is raised. Stream audio stays
   *  subscribed; deafen silences it through its gain instead. */
  protected addPublication(identity: string, track: NativeVoiceTrack): void {
    const p = this.participant(identity);
    if (p.trackPublications.has(track.sid)) return;
    const pub = new NativeRemotePublication(this, identity, track);
    p.trackPublications.set(track.sid, pub);
    if (
      pub.kind === "audio" &&
      pub.source !== "screen_share_audio" &&
      voiceStore.getState().localDeafened
    )
      pub.setSubscribed(false);
    // shortcut: the backend auto-subscribes, so an unwatched stream flows until
    // this event's handler unsubscribes it (opt-in watching); connect the native
    // session with auto_subscribe off if that first moment of video matters.
    if (this.announcing) this.emit(RoomEvent.TrackPublished, pub, p);
  }

  protected clearDecryptTimer(identity: string): void {
    clearInterval(this.decryptTimers.get(identity));
    this.decryptTimers.delete(identity);
  }

  protected clearDecryptTimers(): void {
    for (const timer of this.decryptTimers.values()) clearInterval(timer);
    this.decryptTimers.clear();
  }

  /** People and their tracks. False for any other event. */
  protected applyRosterEvent(event: NativeVoiceEvent): boolean {
    switch (event.type) {
      case "connected":
        this.onConnected(event.participants);
        return true;
      case "participantConnected":
        this.emit(RoomEvent.ParticipantConnected, this.participant(event.identity));
        return true;
      case "participantDisconnected":
        this.onParticipantDisconnected(event.identity);
        return true;
      case "trackPublished":
        this.addPublication(event.identity, event.track);
        return true;
      case "trackSubscribed":
        this.onTrackSubscribed(event.identity, event.track);
        return true;
      case "trackUnpublished":
        this.onTrackUnpublished(event.identity, event.sid);
        return true;
      case "trackUnsubscribed":
        this.unsubscribeVideo(
          event.identity,
          this.remoteParticipants.get(event.identity)?.trackPublications.get(event.sid),
        );
        return true;
      case "trackMuted":
        this.onTrackMuted(event.identity, event.sid, event.muted);
        return true;
      default:
        return false;
    }
  }

  protected onConnected(participants: NativeVoiceParticipant[]): void {
    this.releaseVideo();
    this.clearDecryptTimers();
    this.remoteParticipants.clear();
    for (const info of participants) {
      this.participant(info.identity);
      for (const t of info.tracks) this.addPublication(info.identity, t);
    }
    this.emit(RoomEvent.Connected);
  }

  protected onParticipantDisconnected(identity: string): void {
    const p = this.remoteParticipants.get(identity);
    // livekit-client raises the track unsubscriptions before the leave.
    for (const pub of p?.trackPublications.values() ?? []) {
      this.unsubscribeVideo(identity, pub);
      this.emit(RoomEvent.TrackUnpublished, pub, p);
    }
    this.remoteParticipants.delete(identity);
    this.clearDecryptTimer(identity);
    if (p !== undefined) this.emit(RoomEvent.ParticipantDisconnected, p);
  }

  protected onTrackSubscribed(identity: string, track: NativeVoiceTrack): void {
    this.addPublication(identity, track);
    const pub = this.participant(identity).trackPublications.get(track.sid)!;
    // The backend auto-subscribes: one already unsubscribed (not watched)
    // was on its way, and raises nothing.
    if (pub.kind === "video" && pub.isSubscribed) this.subscribeVideo(identity, pub);
  }

  protected onTrackUnpublished(identity: string, sid: string): void {
    const p = this.remoteParticipants.get(identity);
    const pub = p?.trackPublications.get(sid);
    this.unsubscribeVideo(identity, pub);
    p?.trackPublications.delete(sid);
    if (pub !== undefined) this.emit(RoomEvent.TrackUnpublished, pub, p);
  }

  protected onTrackMuted(identity: string, sid: string, muted: boolean): void {
    const p = this.remoteParticipants.get(identity);
    const pub = p?.trackPublications.get(sid);
    if (pub === undefined) return;
    pub.isMuted = muted;
    if (muted) this.emit(RoomEvent.TrackMuted, pub, p);
  }

  protected onEncryptionStatus(identity: string, encrypted: boolean): void {
    if (identity === this.localParticipant.identity) {
      // The backend's only signal that frames are not being protected —
      // surface it the way the web path surfaces a dead E2EE worker.
      if (!encrypted)
        // i18n-exempt: internal E2EE state guard, never rendered
        this.emit(RoomEvent.EncryptionError, new Error("native E2EE not active"));
      return;
    }
    // A remote peer's frames stopped (or resumed) decrypting.
    // The backend reports each transition once; re-report the failure the
    // way the web worker does (an InvalidKey decrypt error once a second)
    // until the peer decrypts again, so the shared streak grace degrades
    // a failure that persists and the quiet gap after `encrypted` clears
    // it. Tracked per identity, so a peer whose audio decrypts while its
    // camera does not reads as decrypting.
    this.clearDecryptTimer(identity);
    if (encrypted) return;
    const report = (): void => {
      const p = this.remoteParticipants.get(identity);
      // i18n-exempt: the web worker's decrypt error, matched by prefix, never rendered
      const error = new Error("InvalidKey: native decrypt failure");
      if (p !== undefined) this.emit(RoomEvent.EncryptionError, error, p);
    };
    report();
    this.decryptTimers.set(identity, setInterval(report, DECRYPT_REPORT_MS));
  }
}
