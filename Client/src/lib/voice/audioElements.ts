// AudioElements — manages remote audio elements (mic + screenshare)
//
// Handles HTMLAudioElement lifecycle for remote participants' audio tracks,
// per-user volume, screenshare audio volume/mute, and output device routing.

import {
  RoomEvent,
  Track,
  type Room,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { loadPref, savePref, STORAGE_PREFIX } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";
import { migrateLegacyValue } from "@lib/net/legacyKeyMigration";
import { parseUserId } from "../../features/voice/sessionState";
import { isUnencryptedPublication } from "../../features/voice/mediaEncryption";
import { onRoom } from "../../features/voice/releaseRoom";
import { voiceStore } from "@stores/voice.store";
import { USER_LOCAL_MUTE_CHANGED } from "@lib/constants";

const log = createLogger("audioElements");

/**
 * Server host the per-user volume prefs below belong to. Mirrors
 * channel-mutes.ts's currentHost — the client is multi-server (one webview
 * origin means one localStorage) and userId is only unique per server, so
 * without a host component a volume set for user 7 on one server would
 * silence user 7 on every other server too. `setAudioVolumeHost` is always
 * called with a real host before any volume is read (see MainPage.ts), so
 * the `null` startup default is not what protects a pre-scoping install's
 * saved volumes — `getSavedUserVolume` does that below by reading through to
 * the original unscoped key on a miss at the scoped one.
 */
let currentHost: string | null = null;

/** Point per-user volume reads/writes at a specific server. Call on connect
 *  and on server switch — mirroring channel-mutes.ts's setChannelMutesHost. */
export function setAudioVolumeHost(host: string | null): void {
  currentHost = host;
}

function userVolumeKey(userId: number): string {
  // i18n-exempt: localStorage key, not display text
  return currentHost === null ? `userVolume_${userId}` : `userVolume_${userId}:${currentHost}`;
}

function userLocalMuteKey(userId: number): string {
  const key = `userLocalMute_${userId}`;
  // i18n-exempt: localStorage key, not display text
  return currentHost === null ? key : `${key}:${currentHost}`;
}

function announceLocalMute(userId: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(USER_LOCAL_MUTE_CHANGED, { detail: { userId } }));
}

// setUserVolume always clamps to 0-200, so -1 is safe as a "nothing saved" sentinel.
const VOLUME_NOT_SET = -1;

/** Per-user and output volume sliders go to 200%. Above 100% a voice track
 *  needs its gain node: LiveKit's web setVolume writes HTMLMediaElement.volume,
 *  which throws above 1 and failed voice joins. */
const MAX_VOLUME_PERCENT = 200;

/** Per-user volume times output volume never plays louder than double. */
const MAX_GAIN = 2;

/** Clamp a stored or requested percentage into 0-200 (NaN reads as 100). */
function clampPercent(v: number): number {
  return Number.isNaN(v) ? 100 : Math.max(0, Math.min(MAX_VOLUME_PERCENT, v));
}

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
function hasNativePlayout(room: Room | null): boolean {
  return room !== null && "nativePlayout" in room;
}

/** Get saved per-user volume (0-200 range, default 100; a larger value reads
 *  as 200). On a miss at the host-scoped key, migrates
 *  the pre-scoping unscoped value through `migrateLegacyValue`, which moves
 *  it under the scoped key of the FIRST host that misses and no other. User
 *  ids are per-server autoincrement integers: a legacy value left readable
 *  would let every later brand-new host miss its own scoped key, read
 *  through to it and silence the unrelated user N there too — the
 *  shape channel-mutes.ts fixed for the same leak. */
function getSavedUserVolume(userId: number): number {
  return clampPercent(readSavedUserVolume(userId));
}

function readSavedUserVolume(userId: number): number {
  const scopedKey = userVolumeKey(userId);
  if (currentHost === null) return loadPref<number>(scopedKey, 100);

  const scoped = loadPref<number>(scopedKey, VOLUME_NOT_SET);
  if (scoped !== VOLUME_NOT_SET) return scoped;

  const legacy = migrateLegacyValue(
    `${STORAGE_PREFIX}userVolume_${userId}`,
    STORAGE_PREFIX + scopedKey,
  );
  if (legacy !== null) {
    const parsed = parseStoredVolume(legacy);
    if (parsed !== null) return parsed;
  }
  return loadPref<number>(scopedKey, 100);
}

/** The stored form is loadPref's JSON; anything but a number is corrupt. */
function parseStoredVolume(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export class AudioElements {
  private room: Room | null = null;

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
  /** Screenshare audio elements keyed by userId — separate from mic audio pipeline. */
  private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
  /** Persisted mute state for screenshare audio so replacement tracks inherit UI state. */
  private screenshareAudioMutedByUser = new Map<number, boolean>();
  /** Per-user screenshare volume (0-1, default 1) — kept independent of the
   *  element map so a volume chosen before the track attaches still applies. */
  private screenshareVolumeByUser = new Map<number, number>();

  /** Told after a screen-share volume, mute or the output volume changes, for
   *  a room that plays screen-share audio itself rather than through the
   *  elements here (the Linux native room). */
  private screenshareGainListener: (() => void) | null = null;

  /** Master output volume multiplier (0-1.0). Per-user volumes are scaled by this. */
  private outputVolumeMultiplier: number;

  constructor() {
    this.outputVolumeMultiplier = clampPercent(loadPref<number>("outputVolume", 100)) / 100;
  }

  setRoom(room: Room | null): void {
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
  private applyUserGain(participant: RemoteParticipant, gain: number): void {
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

  /** Effective element volume for a user's screenshare audio: per-user volume
   *  scaled by the master output multiplier, clamped to the 0-1 range that
   *  HTMLAudioElement.volume supports. */
  private getEffectiveScreenshareVolume(userId: number): number {
    const userVol = this.screenshareVolumeByUser.get(userId) ?? 1;
    return Math.max(0, Math.min(1, userVol * this.outputVolumeMultiplier));
  }

  /** The gain a user's screen-share audio plays at: its effective volume, or
   *  0 while muted. */
  getScreenshareGain(userId: number): number {
    return this.isScreenshareSilenced(userId) ? 0 : this.getEffectiveScreenshareVolume(userId);
  }

  /** Stream audio is silent while its own tile mute is on or while deafened.
   *  Deafen leaves the tile mute untouched, so undeafen restores it as it was. */
  private isScreenshareSilenced(userId: number): boolean {
    return voiceStore.getState().localDeafened || this.getScreenshareAudioMuted(userId);
  }

  setScreenshareGainListener(listener: (() => void) | null): void {
    this.screenshareGainListener = listener;
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
      // Screenshare audio: manage via HTMLAudioElement volume (not participant.setVolume)
      // Look up the tracking set before detaching so a fast re-subscribe
      // (new TrackSubscribed before the old TrackUnsubscribed lands) drops
      // the stale element from the set instead of leaking it forever — same
      // hygiene as handleTrackUnsubscribedAudio below.
      let audioEls = this.screenshareAudioElements.get(userId);
      for (const el of track.detach()) {
        el.remove();
        audioEls?.delete(el);
      }
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioEl.volume = this.getEffectiveScreenshareVolume(userId);
      audioEl.muted = this.isScreenshareSilenced(userId);
      if (audioEls === undefined) {
        audioEls = new Set();
        this.screenshareAudioElements.set(userId, audioEls);
      }
      audioEls.add(audioEl);
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on screenshare audio", err);
        });
      }
      log.debug("Screenshare audio track subscribed and attached", { userId, trackSid: track.sid });
    } else {
      // Microphone audio: LiveKit's setVolume (element volume, 0-1)
      // Detach any previous <audio> elements to prevent duplicate playback
      // on fast reconnects (new subscription fires before old unsubscription)
      for (const el of track.detach()) el.remove();
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      // Track mic audio elements for cleanup on abnormal disconnect
      if (track.sid !== undefined) {
        this.remoteMicAudioElements.set(track.sid, audioEl);
        this.micTracks.set(track.sid, { track, userId, audioEl });
        this.dropMicGraph(track.sid);
      }
      this.applyUserGain(participant, this.getEffectiveVolume(userId));
      const savedOutput = loadPref<string>("audioOutputDevice", "");
      if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(savedOutput).catch((err) => {
          log.warn("Failed to set output device on remote audio", err);
        });
      }
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
      const detachedEls = track.detach() as HTMLAudioElement[];
      for (const el of detachedEls) el.remove();
      const audioEls = this.screenshareAudioElements.get(userId);
      if (audioEls !== undefined) {
        for (const el of detachedEls) audioEls.delete(el);
        if (audioEls.size === 0) this.screenshareAudioElements.delete(userId);
      }
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
  getPlayingVolume(participant: RemoteParticipant): number {
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

  setScreenshareAudioVolume(userId: number, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    // Always store, even before the audio track attaches — the stored value
    // is applied in handleTrackSubscribedAudio when the element appears.
    this.screenshareVolumeByUser.set(userId, clamped);
    this.screenshareGainListener?.();
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    const effective = this.getEffectiveScreenshareVolume(userId);
    for (const el of audioEls) el.volume = effective;
  }

  /** Stored per-user screenshare volume (0-1, default 1) for slider init. */
  getScreenshareAudioVolume(userId: number): number {
    return this.screenshareVolumeByUser.get(userId) ?? 1;
  }

  muteScreenshareAudio(userId: number, muted: boolean): void {
    this.screenshareAudioMutedByUser.set(userId, muted);
    this.screenshareGainListener?.();
    const audioEls = this.screenshareAudioElements.get(userId);
    if (audioEls === undefined) return;
    for (const el of audioEls) el.muted = muted || voiceStore.getState().localDeafened;
  }

  /** The tile's own stream mute. Not the element's muted flag: deafen mutes
   *  the element too, and must not read back as the user's choice. */
  getScreenshareAudioMuted(userId: number): boolean {
    return this.screenshareAudioMutedByUser.get(userId) ?? false;
  }

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
