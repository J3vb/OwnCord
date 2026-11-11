// AudioElements — manages remote audio elements (mic + screenshare)
//
// Handles HTMLAudioElement lifecycle for remote participants' audio tracks,
// per-user volume, screenshare audio volume/mute, and output device routing.

import {
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";
import { parseUserId } from "../../features/voice/sessionState";
import { isUnencryptedPublication } from "../../features/voice/mediaEncryption";
import { onRoom } from "../../features/voice/releaseRoom";
import { voiceStore } from "@stores/voice.store";
import {
  announceLocalMute,
  clampPercent,
  getSavedUserVolume,
  MAX_GAIN,
  userLocalMuteKey,
  userVolumeKey,
} from "./audioVolumePrefs";
import {
  applySavedOutput,
  attachMicAudioElement,
  attachScreenshareAudio,
  detachScreenshareAudio,
} from "./audioTrackElements";
import { ScreenshareAudioState } from "./audioScreenshareState";
import type { VoiceRemoteParticipant, VoiceRoom } from "@lib/voice/voiceRoom";

export { setAudioVolumeHost } from "./audioVolumePrefs";

const log = createLogger("audioElements");

/** Where a remote voice track plays above 100%: its <audio> element stays
 *  attached (Chromium feeds a remote WebRTC track to Web Audio only while an
 *  element plays it) but muted, and the sound goes through this gain. At or
 *  below 100% the element plays it directly, as before. */
interface MicGraph {
  readonly userId: number;
  readonly audioEl: HTMLAudioElement;
  readonly source: MediaStreamAudioSourceNode;
  readonly gain: GainNode;
}

/** AudioContext.setSinkId is not in TypeScript's DOM lib yet; WKWebView has
 *  none at all. */
type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

/** The native room plays voice in its own mixer, which takes gains above 1. */
function hasNativePlayout(room: VoiceRoom | null): boolean {
  return room !== null && "nativePlayout" in room;
}

export class AudioElements extends ScreenshareAudioState {
  private room: VoiceRoom | null = null;

  /** Shared by the gain nodes of boosted voice tracks. Created the first time
   *  a gain above 1 is needed in a web room and closed on leave, so a call
   *  nobody boosts never opens one. */
  private audioCtx: SinkableContext | null = null;
  /** False while the context is not yet, or cannot be, on the output the
   *  elements use; boosted voice then stays on its element at 100% rather
   *  than play on another device. */
  private sinkReady = true;
  /** Bumped per sink switch, so only the latest switch's outcome counts. */
  private sinkRequest = 0;
  /** Gain graphs keyed by track SID. */
  private micGraphs = new Map<string, MicGraph>();
  /** Every subscribed remote voice track, so a gain crossing 1 or a context
   *  that starts or stops running can move them onto or off their gain nodes. */
  private micTracks = new Map<
    string,
    { track: RemoteTrack; userId: number; audioEl: HTMLAudioElement }
  >();

  /** Remote microphone audio elements keyed by track SID for cleanup on disconnect. */
  private remoteMicAudioElements = new Map<string, HTMLAudioElement>();

  protected isLocalDeafened(): boolean {
    return voiceStore.getState().localDeafened;
  }

  constructor() {
    super();
    this.outputVolumeMultiplier = clampPercent(loadPref<number>("outputVolume", 100)) / 100;
  }

  setRoom(room: VoiceRoom | null): void {
    if (room === this.room) return;
    this.room = room;
    if (room === null || hasNativePlayout(room)) {
      this.closeAudioContext();
      return;
    }
    if (typeof AudioContext === "undefined") return;
    // Every output switch (settings, hot-plug fallback, join) goes through
    // room.switchActiveDevice, which only moves the elements; the context
    // that actually plays follows it here. detachRoom removes the listener
    // when the room is released.
    onRoom(room, RoomEvent.ActiveDeviceChanged, (kind, deviceId) => {
      if (this.room === room && kind === "audiooutput") this.setContextSink(deviceId);
    });
  }

  private ensureAudioContext(): SinkableContext | null {
    if (this.audioCtx !== null) return this.audioCtx;
    if (typeof AudioContext === "undefined") return null;
    try {
      this.audioCtx = new AudioContext();
    } catch (err) {
      log.warn("AudioContext unavailable — voice volume stays at most 100%", err);
      return null;
    }
    const ctx = this.audioCtx;
    // The context is closed on leave, which ends the listener with it.
    ctx.addEventListener("statechange", () => this.onContextState(ctx));
    // The device the room's elements use now; a hot-plug fallback moves them
    // without changing the saved setting.
    const room = this.room;
    const active =
      room !== null && typeof room.getActiveDevice === "function"
        ? room.getActiveDevice("audiooutput")
        : undefined;
    this.setContextSink(active ?? loadPref<string>("audioOutputDevice", ""));
    this.audioCtx.resume().catch((err) => log.warn("AudioContext resume failed", err));
    return this.audioCtx;
  }

  /** A context that starts later (autoplay unlock) takes the tracks that
   *  played on their elements meanwhile; one that suspends or is interrupted
   *  hands them back to their elements so nobody goes silent. */
  private onContextState(ctx: SinkableContext): void {
    if (this.audioCtx !== ctx || ctx.state === "closed") return;
    if (ctx.state !== "running") {
      for (const sid of this.micGraphs.keys()) this.dropMicGraph(sid, true);
    }
    this.reapplyMicGains();
  }

  private reapplyMicGains(): void {
    const users = new Set<number>();
    for (const t of this.micTracks.values()) users.add(t.userId);
    for (const userId of users) this.applyGainOf(userId, this.getEffectiveVolume(userId));
  }

  /** Not ready hands the boosted tracks back to their elements; ready again
   *  (always async, after a sink switch) moves them back onto gain nodes. */
  private setSinkReady(ready: boolean): void {
    if (this.sinkReady === ready) return;
    this.sinkReady = ready;
    if (ready) {
      this.reapplyMicGains();
      return;
    }
    const users = new Set<number>();
    for (const [sid, graph] of this.micGraphs) {
      this.dropMicGraph(sid, true);
      users.add(graph.userId);
    }
    for (const userId of users) this.applyGainOf(userId, this.getEffectiveVolume(userId));
  }

  private setContextSink(deviceId: string): void {
    const ctx = this.audioCtx;
    if (ctx === null) return;
    // Web Audio has no "default" device id; the empty string is the default.
    const sinkId = deviceId === "default" ? "" : deviceId;
    const request = ++this.sinkRequest;
    if (typeof ctx.setSinkId !== "function") {
      this.setSinkReady(sinkId === "");
      return;
    }
    // The default output is where a context without a sink plays anyway.
    this.setSinkReady(sinkId === "");
    ctx.setSinkId(sinkId).then(
      () => {
        if (request === this.sinkRequest && this.audioCtx === ctx) this.setSinkReady(true);
      },
      (err: unknown) => {
        log.warn("Failed to set output device on the voice audio context", err);
        if (request === this.sinkRequest && this.audioCtx === ctx) this.setSinkReady(false);
      },
    );
  }

  /** Callers have already removed the tracks' elements (cleanup or a
   *  released room), so the graphs are dropped without handing back. */
  private closeAudioContext(): void {
    for (const sid of this.micGraphs.keys()) this.dropMicGraph(sid);
    this.micTracks.clear();
    const ctx = this.audioCtx;
    this.audioCtx = null;
    this.sinkReady = true;
    this.sinkRequest++;
    if (ctx !== null) {
      ctx.close().catch((err) => log.warn("AudioContext close failed", err));
    }
  }

  /** Route a remote voice track through a gain node. Null (the element plays
   *  it, at most 100%) when there is no running context or a step throws; a
   *  context that starts later brings it back through onContextState. */
  private buildMicGraph(
    sid: string,
    userId: number,
    track: RemoteTrack,
    audioEl: HTMLAudioElement,
  ): MicGraph | null {
    const ctx = this.ensureAudioContext();
    if (ctx === null || !this.sinkReady) return null;
    if (ctx.state !== "running") {
      ctx.resume().catch((err) => log.warn("AudioContext resume failed", err));
      return null;
    }
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(ctx.destination);
      // Both, as LiveKit's own Web Audio attach does: Room.startAudio()
      // unmutes every attached element, and volume 0 keeps this one silent.
      // The track still reaches the source node; only the element's inbound
      // audio level reads 0 while it plays here.
      audioEl.muted = true;
      audioEl.volume = 0;
      const graph = { userId, audioEl, source, gain };
      this.micGraphs.set(sid, graph);
      return graph;
    } catch (err) {
      log.warn("Voice gain node failed — voice volume stays at most 100%", err);
      return null;
    }
  }

  /** `restore` hands the track back to its element, whose volume the next
   *  applyUserGain sets. */
  private dropMicGraph(sid: string, restore = false): void {
    const graph = this.micGraphs.get(sid);
    if (graph === undefined) return;
    this.micGraphs.delete(sid);
    graph.source.disconnect();
    graph.gain.disconnect();
    if (restore) graph.audioEl.muted = false;
  }

  /** Play a participant's voice at `gain` (0-2). The native mixer takes it
   *  as is. On the web the element plays it up to 1, where LiveKit's
   *  setVolume must never see more; above 1 every one of their tracks moves
   *  to a gain node, or stays on its element at 1 while no context runs. */
  private applyUserGain(participant: VoiceRemoteParticipant, gain: number): void {
    if (hasNativePlayout(this.room)) {
      participant.setVolume(gain);
      return;
    }
    const userId = parseUserId(participant.identity);
    const graphs: MicGraph[] = [];
    let unrouted = false;
    for (const [sid, t] of this.micTracks) {
      if (t.userId !== userId) continue;
      if (gain <= 1) {
        this.dropMicGraph(sid, true);
        continue;
      }
      const graph = this.micGraphs.get(sid) ?? this.buildMicGraph(sid, userId, t.track, t.audioEl);
      if (graph === null) unrouted = true;
      else graphs.push(graph);
    }
    if (unrouted) {
      for (const [sid, graph] of this.micGraphs) {
        if (graph.userId === userId) this.dropMicGraph(sid, true);
      }
    } else if (graphs.length > 0) {
      for (const graph of graphs) graph.gain.gain.value = gain;
      return;
    }
    participant.setVolume(Math.min(1, gain));
  }

  /** Get the current output volume multiplier. */
  getOutputVolumeMultiplier(): number {
    return this.outputVolumeMultiplier;
  }

  /** Compute the effective gain for a participant: per-user volume * master
   *  output, capped at 2; 0 while the user is locally muted. */
  getEffectiveVolume(userId: number): number {
    if (userId <= 0) return this.gainOf(100, false);
    return this.gainOf(getSavedUserVolume(userId), this.getUserLocalMute(userId));
  }

  private gainOf(userVolumePercent: number, muted: boolean): number {
    if (muted) return 0;
    return Math.min(MAX_GAIN, (userVolumePercent / 100) * this.outputVolumeMultiplier);
  }

  // --- Track subscription handlers ---

  handleTrackSubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    // Guard: do not attach remote voice audio while locally deafened.
    // applyRemoteAudioSubscriptionState() only covers participants present at
    // the time of deafen — this guard catches participants who join afterward.
    // Stream audio stays subscribed and attaches muted instead (below), so
    // undeafen brings it back without a resubscribe.
    if (
      voiceStore.getState().localDeafened &&
      publication.source !== Track.Source.ScreenShareAudio
    ) {
      publication.setSubscribed(false);
      return;
    }

    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      const audioEl = attachScreenshareAudio(
        track,
        this.screenshareAudioElements,
        userId,
        this.getEffectiveScreenshareVolume(userId),
        this.isScreenshareSilenced(userId),
      );
      applySavedOutput(audioEl, "screenshare");
      log.debug("Screenshare audio track subscribed and attached", { userId, trackSid: track.sid });
    } else {
      // Microphone audio: LiveKit's setVolume (element volume, 0-1)
      // Detach any previous <audio> elements to prevent duplicate playback
      // on fast reconnects (new subscription fires before old unsubscription)
      const audioEl = attachMicAudioElement(track);
      // Track mic audio elements for cleanup on abnormal disconnect
      if (track.sid !== undefined) {
        this.remoteMicAudioElements.set(track.sid, audioEl);
        this.micTracks.set(track.sid, { track, userId, audioEl });
        this.dropMicGraph(track.sid);
      }
      this.applyUserGain(participant, this.getEffectiveVolume(userId));
      applySavedOutput(audioEl, "remote");
      log.debug("Remote audio track subscribed and attached", { userId, trackSid: track.sid });
    }
  }

  handleTrackUnsubscribedAudio(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const userId = parseUserId(participant.identity);
    if (publication.source === Track.Source.ScreenShareAudio) {
      detachScreenshareAudio(track, this.screenshareAudioElements, userId);
      log.debug("Screenshare audio track unsubscribed and detached", {
        userId,
        trackSid: track.sid,
      });
    } else {
      for (const el of track.detach()) el.remove();
      if (track.sid !== undefined) {
        this.remoteMicAudioElements.delete(track.sid);
        this.micTracks.delete(track.sid);
        this.dropMicGraph(track.sid);
      }
      log.debug("Remote audio track unsubscribed and detached", { userId, trackSid: track.sid });
    }
  }

  // --- Remote audio subscription state (deafen) ---

  applyRemoteAudioSubscriptionState(deafened: boolean): void {
    // Deafen silences stream audio too (Discord's rule) by muting its
    // elements, not unsubscribing, so undeafen restores each tile's own mute.
    for (const [userId, audioEls] of this.screenshareAudioElements) {
      const muted = deafened || this.getScreenshareAudioMuted(userId);
      for (const el of audioEls) el.muted = muted;
    }
    this.screenshareGainListener?.();
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.source === Track.Source.ScreenShareAudio) continue;
        if (isUnencryptedPublication(publication)) continue;
        publication.setSubscribed(!deafened);
      }
    }
  }

  // --- Volume control ---

  /** Apply effective volume to all remote participants. */
  applyAllVolumes(): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      const userId = parseUserId(participant.identity);
      this.applyUserGain(participant, this.getEffectiveVolume(userId));
    }
  }

  private applyGainOf(userId: number, gain: number): void {
    if (this.room === null) return;
    for (const participant of this.room.remoteParticipants.values()) {
      if (parseUserId(participant.identity) === userId) this.applyUserGain(participant, gain);
    }
  }

  setUserVolume(userId: number, volume: number): void {
    const clamped = clampPercent(volume);
    const wasSilent = getSavedUserVolume(userId) === 0;
    savePref(userVolumeKey(userId), clamped);
    this.applyGainOf(userId, this.gainOf(clamped, this.getUserLocalMute(userId)));
    // A level of 0 shows as muted too, so moving to or from it is announced.
    if (wasSilent !== (clamped === 0)) announceLocalMute(userId);
  }

  getUserVolume(userId: number): number {
    return getSavedUserVolume(userId);
  }

  /** The gain a participant's voice plays at right now (diagnostics): their
   *  gain node's when they have one, else LiveKit's element volume. */
  getPlayingVolume(participant: VoiceRemoteParticipant): number {
    const userId = parseUserId(participant.identity);
    for (const graph of this.micGraphs.values()) {
      if (graph.userId === userId) return graph.gain.gain.value;
    }
    return participant.getVolume() ?? 1;
  }

  /** Silence one user for this client only. Their volume is left as it was,
   *  so unmuting brings back the saved level. */
  setUserLocalMute(userId: number, muted: boolean): void {
    savePref(userLocalMuteKey(userId), muted);
    this.applyGainOf(userId, this.gainOf(getSavedUserVolume(userId), muted));
    announceLocalMute(userId);
  }

  getUserLocalMute(userId: number): boolean {
    return loadPref<boolean>(userLocalMuteKey(userId), false) === true;
  }

  setOutputVolume(volume: number): void {
    const clamped = clampPercent(volume);
    savePref("outputVolume", clamped);
    this.outputVolumeMultiplier = clamped / 100;
    this.applyAllVolumes();
    // Re-apply per-user screenshare volumes scaled by the new master value
    // (BUG: previously overwrote them with just the master multiplier).
    for (const [userId, audioEls] of this.screenshareAudioElements) {
      const effective = this.getEffectiveScreenshareVolume(userId);
      for (const audioEl of audioEls) {
        audioEl.volume = effective;
      }
    }
    this.screenshareGainListener?.();
  }

  // --- Screenshare audio ---

  // --- Cleanup ---

  /** Remove all remote audio elements from the DOM and clear tracking maps.
   *  Preserves screenshare mute state so reconnecting tracks inherit user intent. */
  cleanupAllAudioElements(): void {
    // Fully release audio elements — pause, clear srcObject, then remove.
    for (const el of this.remoteMicAudioElements.values()) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.remoteMicAudioElements.clear();
    this.micTracks.clear();
    for (const sid of this.micGraphs.keys()) this.dropMicGraph(sid);
    for (const audioEls of this.screenshareAudioElements.values()) {
      for (const el of audioEls) {
        el.pause();
        el.srcObject = null;
        el.remove();
      }
    }
    this.screenshareAudioElements.clear();
  }

  /** Full cleanup including screenshare mute/volume state — used on intentional leave. */
  cleanupAllAudioElementsFull(): void {
    this.cleanupAllAudioElements();
    this.closeAudioContext();
    this.screenshareAudioMutedByUser.clear();
    this.screenshareVolumeByUser.clear();
  }
}
